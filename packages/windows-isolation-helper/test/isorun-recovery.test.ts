/**
 * CL-16A3 MEGA-1 §5 — recovery for isolated runs, and the liveness matrix.
 *
 * The rule this whole file defends is that RECOVERY INFERS NOTHING. It came out
 * of a real defect: P4c briefly shared the old sweep's journal namespace, and
 * because the old folder could not read the new events it treated every isolated
 * run as incomplete, GUESSED the profile name from the runId, and deleted the
 * AppContainer of a running run. Every case below is one step of that failure,
 * made impossible and then checked.
 *
 * The liveness half is a matrix rather than a single case because "is this run
 * still going?" has four answers and three of them are not "yes" or "no":
 *
 *   live host + abandoned run   -> the host is fine, the run is not: AMBIGUOUS
 *   dead host + live child      -> nothing owns it, but a process is USING it
 *   pid reuse                   -> the pid answers, but for the wrong process
 *   stale lease, everything gone-> the only case that may actually be reclaimed
 *
 * A clock is injected throughout, because a test that proves expiry by sleeping
 * for thirty seconds is a test nobody will keep running.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { REQUIRED_PROTOCOL_VERSION, type HelperResponse } from "../src/helper-runner"
import { assessLiveness, foldIsolatedRun, reclaimBeforeBootstrap, recoverIsolatedRuns, scanIsolatedRuns, type IsolatedRunProjection } from "../src/isorun-recovery"
import { acquireRunLease, DEFAULT_LEASE_TTL_MS, newOperationId, releaseRunLease, renewRunLease, runLeaseAggregateId, leaseIsExpired, assertMayMutate, StaleLeaseHolder, ResidueNotProven, type ResidueProof } from "../src/run-lease"
import { RunLifecycle } from "../src/run-lifecycle-events"
import { RunGrantEvents } from "../src/run-scope"
import { JobEvents } from "../src/job-identity"

let scratch = ""

beforeAll(() => {
  // `bun test test/ -t protocol` imports every test module even when this
  // module has no matching test. Keep import side-effect free so a filtered
  // gate cannot create an owned world it will never use or tear down.
  scratch = mkdtempSync(join(tmpdir(), "abdo-isorec-"))
})

afterAll(async () => {
  if (!scratch) return
  // A multi-file Bun run once removed every SQLite file but left the empty
  // world behind. Require stable absence after Windows has released late file
  // handles; cleanup success is a postcondition, not a best-effort call.
  for (let attempt = 0; attempt < 5; attempt++) {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    await Bun.sleep(100)
    if (!existsSync(scratch)) return
  }
  throw new Error(`owned recovery scratch survived teardown: ${scratch}`)
})

/** A run that genuinely left nothing. Release demands one of these. */
const CLEAN: ResidueProof = { clean: true, checkedAt: 0, aclPathsClean: [], aclPathsDirty: [], profileAbsent: "never_created", runRootAbsent: "never_created", childProcessGone: "never_started" }
const store = (name: string) => new SqliteEventStore(join(scratch, `${name}.sqlite`))
const OWNED = "abdo-winiso-run_aaaaaaaaaaaaaaaaaaaaaaaaaa"
const SID = "S-1-15-2-1-2-3"
const RUNPATH = String.raw`C:\ProgramData\Abdo\Execution\v1\S_1_5_21\runs\run_aaaaaaaaaaaaaaaaaaaaaaaaaa`

/** A helper whose process-liveness answers are scripted per pid. */
function helperWith(alive: Record<number, { alive: boolean; pidReused?: boolean }>, opts: { aclAfterRestore?: string; pathExists?: boolean } = {}) {
  const calls: string[][] = []
  const helper = async ({ argv }: { argv: readonly string[] }): Promise<HelperResponse> => {
    calls.push([...argv])
    const base = { protocolVersion: REQUIRED_PROTOCOL_VERSION, elevated: false as const, ok: true }
    const argOf = (f: string) => {
      const i = argv.indexOf(f)
      return i >= 0 ? String(argv[i + 1] ?? "") : ""
    }
    switch (argv[0]) {
      case "inspect-process": {
        const pid = Number(argOf("--pid"))
        const a = alive[pid] ?? { alive: false }
        return { ...base, pid, alive: a.alive, pidReused: a.pidReused ?? false }
      }
      case "inspect-acl":
        return { ...base, sddl: opts.aclAfterRestore ?? "D:P(A;OICI;FA;;;S-1-5-21-owner)" }
      case "inspect-dir":
        return { ...base, pathExists: opts.pathExists ?? false }
      case "restore-acl":
        return base
      case "delete-profile":
        return { ...base, existedBefore: true, profileExists: false }
      default:
        return base
    }
  }
  return { helper, calls }
}

/** Seed one isolated run's journal: intent, a grant, a lease. */
async function seedRun(
  s: SqliteEventStore,
  runId: string,
  o: {
    ownerPid: number
    ownerStartTime?: string
    heldAt: number
    ttlMs?: number
    released?: boolean
    profileName?: string | null
    withGrant?: boolean
    childPid?: number
    childStartTime?: string
    completed?: boolean
    /**
     * P5c/P5c2. The job this run recorded, and WHO IS HOLDING ITS NAME OPEN.
     *
     * `keeperPid`/`keeperStartTime` are separate from the rest so a test can
     * seed a run that recorded a job but NO keeper — which is what a run written
     * by the P5c helper looks like, and which must not be treated as reclaimable
     * just because a name is present.
     */
    job?: { jobName: string; sessionId?: number; operationId?: string; fencingToken?: number; keeperPid?: number; keeperStartTime?: string }
  },
): Promise<void> {
  const agg = runLeaseAggregateId(runId)
  const append = (type: string, data: Record<string, unknown>) => s.append({ aggregateKind: "project", aggregateId: agg, type, version: 1, data })
  await append(RunLifecycle.Requested, {
    runId,
    hostPid: o.ownerPid,
    hostStartTime: o.ownerStartTime ?? "",
    ...(o.profileName === null ? {} : { profileName: o.profileName ?? OWNED }),
  })
  await append(RunLifecycle.RootReady, { runId, runPath: RUNPATH })
  const ttlMs = o.ttlMs ?? DEFAULT_LEASE_TTL_MS
  const opId = newOperationId()
  const lease = await acquireRunLease({ store: s, now: () => o.heldAt }, { runId, operationId: opId, ownerPid: o.ownerPid, ownerStartTime: o.ownerStartTime ?? "" }, ttlMs)
  if (o.withGrant) {
    await append(RunGrantEvents.GrantsMutating, { runId, path: RUNPATH, purpose: "ancestor_traverse", sid: SID, originalSddl: "D:P(A;OICI;FA;;;S-1-5-21-owner)", originalSddlHash: "h" })
    await append(RunGrantEvents.GrantObserved, { runId, path: RUNPATH, sid: SID, originalSddl: "D:P(A;OICI;FA;;;S-1-5-21-owner)", grantedSddl: `D:P(A;OICI;FA;;;S-1-5-21-owner)(A;;0x1200a9;;;${SID})` })
  }
  if (o.job) {
    // THE INTENT EVENT, exactly as the driver writes it: before the helper runs,
    // carrying the name and the identity the terminate verb will demand back.
    await append(JobEvents.CreateRequested, {
      runId,
      jobName: o.job.jobName,
      sessionId: o.job.sessionId ?? 1,
      operationId: o.job.operationId ?? "op_seed",
      fencingToken: o.job.fencingToken ?? 1,
    })
    if (o.job.keeperPid) {
      await append(JobEvents.KeeperReady, {
        runId,
        jobName: o.job.jobName,
        sessionId: o.job.sessionId ?? 1,
        keeperPid: o.job.keeperPid,
        keeperStartTime: o.job.keeperStartTime ?? "999",
      })
    }
  }
  if (o.childPid) await append(RunLifecycle.ProcessStarted, { runId, pid: o.childPid, startTime: o.childStartTime ?? "" })
  if (o.completed) {
    await append(RunLifecycle.RevocationVerified, { runId })
    await append(RunLifecycle.Cleaned, { runId })
    await append(RunLifecycle.Completed, { runId })
  }
  if (o.released) await releaseRunLease({ store: s, now: () => o.heldAt + 10 }, lease, "completed", CLEAN)
}

const projectionOf = async (s: SqliteEventStore, runId: string): Promise<IsolatedRunProjection> => (await scanIsolatedRuns(s)).find((r) => r.runId === runId)!

describe("the lease makes liveness a fact about the RUN, not about its host", () => {
  test("a held, unexpired lease means the run is live — and the host is never asked", async () => {
    const s = store("live")
    await seedRun(s, "run_a", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000 })
    const { helper, calls } = helperWith({ 4242: { alive: true } })
    const v = await assessLiveness({ helper, now: () => 5_000 }, await projectionOf(s, "run_a"))
    expect(v.verdict).toBe("live")
    // THE POINT: liveness came from the lease. No process was interrogated.
    expect(calls.map((c) => c[0])).not.toContain("inspect-process")
    s.close()
  })

  test("LIVE HOST + ABANDONED RUN is a contradiction, not a licence to delete", async () => {
    // The host is perfectly healthy — it is a long-lived process that serves many
    // runs — but THIS run stopped heartbeating. Keying recovery on host liveness
    // would skip it forever; treating the expired lease alone as permission would
    // delete resources under a process that may simply be stalled.
    const s = store("abandoned")
    await seedRun(s, "run_b", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, ttlMs: 1_000 })
    const { helper } = helperWith({ 4242: { alive: true } })
    const v = await assessLiveness({ helper, now: () => 900_000 }, await projectionOf(s, "run_b"))
    expect(v.verdict).toBe("unknown")
    expect(v.why).toContain("still running")
    s.close()
  })

  test("DEAD HOST + LIVE CHILD is deferred: its ACEs are in use right now", async () => {
    const s = store("livechild")
    await seedRun(s, "run_c", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, ttlMs: 1_000, childPid: 777, childStartTime: "222" })
    const { helper } = helperWith({ 4242: { alive: false }, 777: { alive: true } })
    const v = await assessLiveness({ helper, now: () => 900_000 }, await projectionOf(s, "run_c"))
    expect(v.verdict).toBe("unknown")
    expect(v.why).toContain("STILL RUNNING")
    s.close()
  })

  // ── P5c2. THE THREE STATES A LIVE CHILD CAN BE IN, once a job name exists.
  //
  // P5c could only distinguish two of them, because the process holding the job
  // name open WAS the target: "the holder is gone" and "the tree is gone" were
  // the same observation. With a trusted keeper they are different processes and
  // therefore different questions, and each gets its own answer below.

  const JOB = String.raw`Local\Abdo-IsolatedRun-abc123-run_k-op_k-1-nonce`

  test("DEAD HOST + LIVE CHILD + a LIVE KEEPER is reclaimable: the tree is still reachable by name", async () => {
    const s = store("keeper-live")
    await seedRun(s, "run_kl", {
      ownerPid: 4242,
      ownerStartTime: "111",
      heldAt: 1_000,
      ttlMs: 1_000,
      childPid: 777,
      childStartTime: "222",
      job: { jobName: JOB, keeperPid: 555, keeperStartTime: "999" },
    })
    const { helper, calls } = helperWith({ 4242: { alive: false }, 777: { alive: true }, 555: { alive: true } })
    const v = await assessLiveness({ helper, now: () => 900_000 }, await projectionOf(s, "run_kl"))
    expect(v.verdict).toBe("reclaimable")
    // NON-VACUITY: the keeper was actually interrogated, by pid AND creation
    // time. A verdict reached without asking is the failure this file exists for.
    const asked = calls.filter((c) => c[0] === "inspect-process" && c.includes("555"))
    expect(asked.length).toBeGreaterThan(0)
    expect(asked[0]).toContain("--expect-start")
    expect(asked[0]).toContain("999")
    s.close()
  })

  test("DEAD HOST + LIVE CHILD + a DEAD KEEPER is NOT reclaimable: the name has already been dropped", async () => {
    // THE STATE P5c CREATED AND COULD NOT SEE. The tree is running; the process
    // that held its job's name open is gone; the object manager removed the name
    // when its last handle closed. `terminate-process-tree` would answer
    // `terminate_job_absent` — correctly refusing to claim `treeGone`, but the
    // sweep would have had no idea WHY, and a live tree with no route to it is
    // not something to keep retrying automatically.
    const s = store("keeper-dead")
    await seedRun(s, "run_kd", {
      ownerPid: 4242,
      ownerStartTime: "111",
      heldAt: 1_000,
      ttlMs: 1_000,
      childPid: 777,
      childStartTime: "222",
      job: { jobName: JOB, keeperPid: 555, keeperStartTime: "999" },
    })
    const { helper } = helperWith({ 4242: { alive: false }, 777: { alive: true }, 555: { alive: false } })
    const v = await assessLiveness({ helper, now: () => 900_000 }, await projectionOf(s, "run_kd"))
    expect(v.verdict).toBe("unknown")
    expect(v.why).toContain("keeper")
    expect(v.why).toContain("no longer openable")
    s.close()
  })

  test("a run that recorded a job but NO keeper is not reclaimable on the strength of the name alone", async () => {
    // What a run written by the P5c helper looks like. A name with nothing known
    // to be holding it is a name that may already have stopped resolving, and
    // the sweep must not treat its presence as reachability.
    const s = store("keeper-absent")
    await seedRun(s, "run_ka", {
      ownerPid: 4242,
      ownerStartTime: "111",
      heldAt: 1_000,
      ttlMs: 1_000,
      childPid: 777,
      childStartTime: "222",
      job: { jobName: JOB },
    })
    const { helper } = helperWith({ 4242: { alive: false }, 777: { alive: true } })
    const v = await assessLiveness({ helper, now: () => 900_000 }, await projectionOf(s, "run_ka"))
    expect(v.verdict).toBe("unknown")
    expect(v.why).toContain("no keeper identity")
    s.close()
  })

  test("the keeper's identity is folded from the journal as a PAIR, or not at all", async () => {
    // A pid without a creation time is not an identity: pids are recycled, and a
    // sweep that accepted one would eventually decide a stranger was the keeper
    // and then trust a job name on the strength of it.
    const s = store("keeper-halfid")
    const agg = runLeaseAggregateId("run_kh")
    await s.append({ aggregateKind: "project", aggregateId: agg, type: RunLifecycle.Requested, version: 1, data: { runId: "run_kh", hostPid: 1, profileName: OWNED } })
    await s.append({ aggregateKind: "project", aggregateId: agg, type: JobEvents.KeeperReady, version: 1, data: { runId: "run_kh", jobName: JOB, keeperPid: 555 } })
    const p = await projectionOf(s, "run_kh")
    expect(p.jobKeeperPid).toBeUndefined()
    expect(p.jobKeeperStartTime).toBeUndefined()
    s.close()
  })

  test("PID REUSE does not resurrect a dead run", async () => {
    // The owner's pid now belongs to something else entirely. `--expect-start`
    // is what turns "is 4242 alive?" into "is THAT process alive?" — measured on
    // this machine to return alive:false, pidReused:true.
    const s = store("reuse")
    await seedRun(s, "run_d", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, ttlMs: 1_000 })
    const { helper, calls } = helperWith({ 4242: { alive: false, pidReused: true } })
    const v = await assessLiveness({ helper, now: () => 900_000 }, await projectionOf(s, "run_d"))
    expect(v.verdict).toBe("reclaimable")
    // The creation time was actually passed — without it the answer is worthless.
    expect(calls.find((c) => c[0] === "inspect-process")).toContain("--expect-start")
    s.close()
  })

  test("a lease with a pid but NO creation time is not a usable identity", async () => {
    const s = store("nostart")
    await seedRun(s, "run_e", { ownerPid: 4242, heldAt: 1_000, ttlMs: 1_000 })
    const { helper, calls } = helperWith({ 4242: { alive: false } })
    const v = await assessLiveness({ helper, now: () => 900_000 }, await projectionOf(s, "run_e"))
    expect(v.verdict).toBe("unknown")
    expect(v.why).toContain("no creation time")
    // It refused to ask a question whose answer it could not trust.
    expect(calls.map((c) => c[0])).not.toContain("inspect-process")
    s.close()
  })

  test("a STALE lease whose owner is gone and whose child never started is reclaimable", async () => {
    const s = store("stale")
    await seedRun(s, "run_f", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, ttlMs: 1_000 })
    const { helper } = helperWith({ 4242: { alive: false } })
    expect((await assessLiveness({ helper, now: () => 900_000 }, await projectionOf(s, "run_f"))).verdict).toBe("reclaimable")
    s.close()
  })

  test("a released lease is finished, and a run with NO lease at all is unknown", async () => {
    const s = store("released")
    await seedRun(s, "run_g", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, released: true })
    const { helper } = helperWith({ 4242: { alive: false } })
    expect((await assessLiveness({ helper, now: () => 900_000 }, await projectionOf(s, "run_g"))).verdict).toBe("finished")

    // A run whose journal has no lease event establishes nothing about liveness.
    const noLease = foldIsolatedRun("run_h", [{ type: RunLifecycle.Requested, data: { runId: "run_h" } }])
    expect((await assessLiveness({ helper, now: () => 1 }, noLease)).verdict).toBe("unknown")
    s.close()
  })

  test("renewal moves expiry, which is the whole mechanism", async () => {
    const s = store("renew")
    const lease = await acquireRunLease({ store: s, now: () => 1_000 }, { runId: "run_i", operationId: "op_1", ownerPid: 1, ownerStartTime: "1" }, 1_000)
    expect(leaseIsExpired(lease, 2_500)).toBe(true)
    const renewed = await renewRunLease({ store: s, now: () => 2_400 }, lease)
    expect(leaseIsExpired(renewed, 2_500)).toBe(false)
    expect(renewed.renewals).toBe(1)
    s.close()
  })
})

describe("recovery reads facts; it never reconstructs them", () => {
  test("a run with NO recorded profile name is deferred — and delete-profile is never called", async () => {
    // THE DEFECT THIS PINS: the old sweep, unable to fold the new events, fell
    // back to `profileNameFor(runId)`. The guess happened to be right, so an
    // inference became a deletion. There is no safe version of that fallback.
    const s = store("noprofile")
    await seedRun(s, "run_j", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, ttlMs: 1_000, profileName: null, withGrant: true })
    const { helper, calls } = helperWith({ 4242: { alive: false } })
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(out[0]?.action).toBe("reclaimed")
    // It reclaimed the ACL (which WAS recorded) and touched no profile at all.
    expect(calls.map((c) => c[0])).not.toContain("delete-profile")
    s.close()
  })

  test("a grant with no recorded original descriptor is deferred, never guessed at", async () => {
    const s = store("nosddl")
    const runId = "run_k"
    const agg = runLeaseAggregateId(runId)
    await s.append({ aggregateKind: "project", aggregateId: agg, type: RunLifecycle.Requested, version: 1, data: { runId, profileName: OWNED } })
    // A grant recorded WITHOUT its original descriptor — the exact state the
    // journal was in before `originalSddl` was made durable.
    await s.append({ aggregateKind: "project", aggregateId: agg, type: RunGrantEvents.GrantsMutating, version: 1, data: { runId, path: RUNPATH, sid: SID } })
    await acquireRunLease({ store: s, now: () => 1_000 }, { runId, operationId: "op_x", ownerPid: 4242, ownerStartTime: "111" }, 1_000)
    const { helper, calls } = helperWith({ 4242: { alive: false } })
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(out[0]?.action).toBe("manual_intervention_required")
    expect(out[0]?.detail).toContain("originalSddl")
    // NOTHING was mutated on the strength of a missing fact.
    for (const verb of ["restore-acl", "delete-profile"]) expect(calls.map((c) => c[0])).not.toContain(verb)
    s.close()
  })

  test("a completed run is left alone entirely", async () => {
    const s = store("done")
    await seedRun(s, "run_l", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, released: true, completed: true })
    const { helper, calls } = helperWith({ 4242: { alive: false } })
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(out[0]?.action).toBe("nothing_to_do")
    for (const verb of ["restore-acl", "delete-profile"]) expect(calls.map((c) => c[0])).not.toContain(verb)
    s.close()
  })

  test("a live run is skipped, and nothing about it is touched", async () => {
    const s = store("skiplive")
    await seedRun(s, "run_m", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, withGrant: true })
    const { helper, calls } = helperWith({ 4242: { alive: true } })
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 5_000 })
    expect(out[0]?.action).toBe("skipped_live")
    for (const verb of ["restore-acl", "delete-profile"]) expect(calls.map((c) => c[0])).not.toContain(verb)
    s.close()
  })

  test("an abandoned run IS reclaimed: descriptor restored, profile deleted, both re-read", async () => {
    const s = store("reclaim")
    await seedRun(s, "run_n", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, ttlMs: 1_000, withGrant: true })
    const { helper, calls } = helperWith({ 4242: { alive: false } })
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(out[0]?.action).toBe("reclaimed")
    expect(out[0]?.restored).toEqual([RUNPATH])
    expect(out[0]?.profileDeleted).toBe(true)
    // The ORIGINAL descriptor came from the journal and was actually passed.
    const restore = calls.find((c) => c[0] === "restore-acl")!
    expect(restore).toContain("--original-sddl")
    expect(restore[restore.indexOf("--original-sddl") + 1]).toBe("D:P(A;OICI;FA;;;S-1-5-21-owner)")
    // And `--expect-granted-sddl`, so it refuses an object someone else changed.
    expect(restore).toContain("--expect-granted-sddl")
    s.close()
  })

  test("reclamation is IDEMPOTENT — running it twice changes nothing the second time", async () => {
    const s = store("twice")
    await seedRun(s, "run_o", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, ttlMs: 1_000, withGrant: true })
    const { helper } = helperWith({ 4242: { alive: false } })
    const first = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    const second = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(first[0]?.action).toBe("reclaimed")
    expect(second[0]?.action).toBe("reclaimed")
    expect(second[0]?.unproven).toEqual([])
    s.close()
  })

  test("an ACE that is STILL THERE after a restore is reported unproven, not as success", async () => {
    // NON-VACUITY for every "reclaimed" above: if the object still carries the
    // container's ACE, the sweep must refuse to call it clean.
    const s = store("stubborn")
    await seedRun(s, "run_p", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, ttlMs: 1_000, withGrant: true })
    const { helper } = helperWith({ 4242: { alive: false } }, { aclAfterRestore: `D:P(A;;0x1200a9;;;${SID})`, pathExists: true })
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(out[0]?.action).toBe("manual_intervention_required")
    expect(out[0]?.unproven).toContain(RUNPATH)
    s.close()
  })
})

// ───────────────────────────────────────────── fencing: a stale owner cannot act

describe("fencing tokens stop a stale owner from touching anything", () => {
  const acquire = (s: SqliteEventStore, runId: string, op: string, at = 1_000) =>
    acquireRunLease({ store: s, now: () => at }, { runId, operationId: op, ownerPid: 4242, ownerStartTime: "111" }, 1_000)

  test("every acquisition gets a STRICTLY HIGHER token", async () => {
    const s = store("fencemono")
    const a = await acquire(s, "run_f1", "op_a")
    const b = await acquire(s, "run_f1", "op_b")
    const c = await acquire(s, "run_f1", "op_c")
    expect(a.fencingToken).toBe(1)
    expect(b.fencingToken).toBe(2)
    expect(c.fencingToken).toBe(3)
    s.close()
  })

  test("a STALE operation cannot renew", async () => {
    const s = store("fencerenew")
    const old = await acquire(s, "run_f2", "op_old")
    await acquire(s, "run_f2", "op_new")
    // The old holder wakes up from a pause and tries to keep its claim alive.
    await expect(renewRunLease({ store: s, now: () => 2_000 }, old)).rejects.toThrow(StaleLeaseHolder)
    s.close()
  })

  test("a STALE operation cannot RELEASE — it would mark someone else's run clean", async () => {
    const s = store("fencerelease")
    const old = await acquire(s, "run_f3", "op_old")
    await acquire(s, "run_f3", "op_new")
    await expect(releaseRunLease({ store: s, now: () => 2_000 }, old, "completed", CLEAN)).rejects.toThrow(StaleLeaseHolder)
    s.close()
  })

  test("THE DANGEROUS ONE: an old owner cannot mutate after a newer acquisition", async () => {
    // This is the distributed-systems classic. The original process pauses, its
    // lease expires, recovery legitimately hands the run to a new attempt, and
    // then the original wakes and finishes the revoke/delete it was part-way
    // through — destroying resources that now belong to somebody else.
    const s = store("fencemutate")
    const old = await acquire(s, "run_f4", "op_old")
    await acquire(s, "run_f4", "op_new")
    for (const what of ["revoke ACL grants", "delete the profile", "launch a process"]) {
      await expect(assertMayMutate({ store: s }, old, what)).rejects.toThrow(StaleLeaseHolder)
    }
    // And the message names the operation it refused, so an operator can see
    // WHAT the zombie was about to do.
    await expect(assertMayMutate({ store: s }, old, "revoke ACL grants")).rejects.toThrow(/revoke ACL grants/)
    s.close()
  })

  test("the CURRENT holder is still allowed to act, so the guard is not simply always-refuse", async () => {
    const s = store("fenceok")
    const current = await acquire(s, "run_f5", "op_only")
    await assertMayMutate({ store: s }, current, "apply ACL grants")
    const renewed = await renewRunLease({ store: s, now: () => 1_500 }, current)
    expect(renewed.renewals).toBe(1)
    await releaseRunLease({ store: s, now: () => 1_600 }, renewed, "completed", CLEAN)
    s.close()
  })

  test("a DUPLICATE release is a safe no-op, not an error", async () => {
    const s = store("duprelease")
    const l = await acquire(s, "run_f6", "op_one")
    await releaseRunLease({ store: s, now: () => 1_500 }, l, "completed", CLEAN)
    await releaseRunLease({ store: s, now: () => 1_600 }, l, "completed", CLEAN)
    const released = (await s.read("project", runLeaseAggregateId("run_f6"))).filter((e) => e.type === "isorun.lease_released")
    // The idempotency key collapsed the second write.
    expect(released.length).toBe(1)
    s.close()
  })

  test("a retry gets a NEW operationId and a HIGHER token, and the old one is then fenced", async () => {
    const s = store("retry")
    const first = await acquire(s, "run_f7", newOperationId())
    const retry = await acquire(s, "run_f7", newOperationId())
    expect(retry.operationId).not.toBe(first.operationId)
    expect(retry.fencingToken).toBeGreaterThan(first.fencingToken)
    await expect(assertMayMutate({ store: s }, first, "do anything")).rejects.toThrow(StaleLeaseHolder)
    await assertMayMutate({ store: s }, retry, "do anything")
    s.close()
  })
})

describe("releasing the lease is a CLAIM, and it has to be earned", () => {
  test("release is REFUSED without a clean residue proof", async () => {
    const s = store("dirty")
    const l = await acquireRunLease({ store: s, now: () => 1_000 }, { runId: "run_r1", operationId: "op_1", ownerPid: 1, ownerStartTime: "1" }, 1_000)
    const dirty: ResidueProof = { clean: false, checkedAt: 1, aclPathsClean: [], aclPathsDirty: [RUNPATH], profileAbsent: false, runRootAbsent: false, childProcessGone: true }
    await expect(releaseRunLease({ store: s }, l, "completed", dirty)).rejects.toThrow(ResidueNotProven)
    // NOT RELEASED. The lease is left to expire, which is what hands the run to
    // recovery — the correct home for a run with residue it could not remove.
    const released = (await s.read("project", runLeaseAggregateId("run_r1"))).filter((e) => e.type === "isorun.lease_released")
    expect(released.length).toBe(0)
    s.close()
  })

  test("a RELEASED run with planted residue is NOT treated as finished", async () => {
    // The release said "I left nothing". The machine disagrees. Believing the
    // claim would hide this residue forever, because no later pass would look.
    const s = store("plantedresidue")
    await seedRun(s, "run_r2", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, released: true, completed: true, withGrant: true })
    // The run root is still there, and the ACE is still on it.
    const { helper } = helperWith({ 4242: { alive: false } }, { pathExists: true, aclAfterRestore: `D:P(A;;0x1200a9;;;${SID})` })
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(out[0]?.action).toBe("manual_intervention_required")
    expect(out[0]?.detail).toContain("A release is a claim, and this one is false")
    expect(out[0]?.unproven?.some((u) => u.startsWith("runPath:"))).toBe(true)
    s.close()
  })

  test("NON-VACUITY: a released run that really IS clean is still nothing_to_do", async () => {
    const s = store("trulyclean")
    await seedRun(s, "run_r3", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, released: true, completed: true, withGrant: true })
    const { helper } = helperWith({ 4242: { alive: false } }, { pathExists: false })
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(out[0]?.action).toBe("nothing_to_do")
    s.close()
  })
})

describe("concurrent acquisition across REAL processes", () => {
  test("eight processes racing for one run get eight DISTINCT, contiguous tokens", async () => {
    // The CAS guarantee is about processes, not about `await` points. Inside a
    // single event loop the runtime chooses the interleaving; across processes
    // SQLite does, and that is what the fencing token actually rests on. If the
    // read-modify-write were not atomic, two of these would come back holding the
    // same token — two live "current" holders, which is the exact state fencing
    // exists to make impossible.
    const db = join(scratch, "concurrent.sqlite")
    // Create the file first so eight processes are not also racing to create it.
    store("concurrent").close()

    const N = 8
    const script = join(import.meta.dir, "fixtures", "acquire-lease.ts")
    const procs = Array.from({ length: N }, (_, i) =>
      Bun.spawn(["bun", script, db, "run_concurrent", `op_${i}`], { stdout: "pipe", stderr: "pipe" }),
    )
    const results = await Promise.all(
      procs.map(async (p) => {
        const out = await new Response(p.stdout).text()
        const err = await new Response(p.stderr).text()
        try {
          return { ...(JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { ok?: boolean; fencingToken?: number; error?: string }), raw: out, err }
        } catch {
          return { ok: false as const, error: `unparseable output`, raw: out, err }
        }
      }),
    )

    // ASSERTED ON THE COUNT, not on a joined error string. The first version of
    // this check mapped failures to `.error` and compared the join to "" — so a
    // process whose output did not parse contributed `undefined`, the join was
    // still empty, and the assertion passed while a token came back missing. A
    // check that a broken case can satisfy is not a check.
    const ok = results.filter((r) => r.ok === true && typeof r.fencingToken === "number")
    expect(ok.length, `all ${N} must acquire; got: ${results.map((r) => r.raw?.trim() || r.err?.slice(0, 200) || "(no output)").join(" | ")}`).toBe(N)

    const tokens = results.map((r) => r.fencingToken!).sort((a, b) => a - b)
    // DISTINCT — no two processes believe they hold the same token...
    expect(new Set(tokens).size).toBe(N)
    // ...and contiguous from 1, so none was skipped or reused.
    expect(tokens).toEqual(Array.from({ length: N }, (_, i) => i + 1))
  }, 120_000)
})

describe("a restore needs the full evidence set, not just a path", () => {
  test("an object whose IDENTITY MOVED is deferred, never restored", async () => {
    // The recorded descriptor belongs to a specific FILE. If the object now at
    // that path is a different one — a recreated directory, a reused name, a
    // different volume — restoring writes somebody else's ACL, which is worse
    // than leaving an ACE behind.
    const s = store("identitymoved")
    const runId = "run_idm"
    const agg = runLeaseAggregateId(runId)
    await s.append({ aggregateKind: "project", aggregateId: agg, type: RunLifecycle.Requested, version: 1, data: { runId, profileName: OWNED } })
    await s.append({
      aggregateKind: "project",
      aggregateId: agg,
      type: RunGrantEvents.GrantsMutating,
      version: 1,
      data: { runId, path: RUNPATH, sid: SID, originalSddl: "D:P(A;OICI;FA;;;S-1-5-21-owner)", fileId: "AAAA", volumeSerial: "vol-1" },
    })
    await acquireRunLease({ store: s, now: () => 1_000 }, { runId, operationId: "op_i", ownerPid: 4242, ownerStartTime: "111" }, 1_000)

    // The object exists but is a DIFFERENT file now.
    const calls: string[][] = []
    const helper = async ({ argv }: { argv: readonly string[] }) => {
      calls.push([...argv])
      if (argv[0] === "inspect-process") return { protocolVersion: REQUIRED_PROTOCOL_VERSION, elevated: false as const, ok: true, alive: false }
      if (argv[0] === "inspect-dir") return { protocolVersion: REQUIRED_PROTOCOL_VERSION, elevated: false as const, ok: true, pathExists: true, pathFileId: "BBBB", pathVolumeSerial: "vol-1" }
      if (argv[0] === "inspect-acl") return { protocolVersion: REQUIRED_PROTOCOL_VERSION, elevated: false as const, ok: true, sddl: "D:P(A;OICI;FA;;;S-1-5-21-owner)" }
      return { protocolVersion: REQUIRED_PROTOCOL_VERSION, elevated: false as const, ok: true, profileExists: false }
    }
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(out[0]?.action).toBe("manual_intervention_required")
    expect(out[0]?.unproven?.join(" ")).toContain("identity moved")
    // NOTHING was written onto the impostor.
    expect(calls.map((c) => c[0])).not.toContain("restore-acl")
    s.close()
  })

  test("a crash BEFORE grant_observed still leaves enough to undo the grant", async () => {
    // `grants_mutating` is written before the mutation and carries the original.
    // A host that died between the ACE landing and its observation therefore
    // still leaves the one value needed to reverse it — which is the whole
    // reason that event is intent-first.
    const s = store("beforeobserved")
    const runId = "run_bo"
    const agg = runLeaseAggregateId(runId)
    await s.append({ aggregateKind: "project", aggregateId: agg, type: RunLifecycle.Requested, version: 1, data: { runId, profileName: OWNED } })
    await s.append({
      aggregateKind: "project",
      aggregateId: agg,
      type: RunGrantEvents.GrantsMutating,
      version: 1,
      data: { runId, path: RUNPATH, sid: SID, originalSddl: "D:P(A;OICI;FA;;;S-1-5-21-owner)", fileId: "AAAA", volumeSerial: "vol-1" },
    })
    // NO grant_observed — the host died first.
    await acquireRunLease({ store: s, now: () => 1_000 }, { runId, operationId: "op_b", ownerPid: 4242, ownerStartTime: "111" }, 1_000)

    const calls: string[][] = []
    const helper = async ({ argv }: { argv: readonly string[] }) => {
      calls.push([...argv])
      if (argv[0] === "inspect-process") return { protocolVersion: REQUIRED_PROTOCOL_VERSION, elevated: false as const, ok: true, alive: false }
      if (argv[0] === "inspect-dir") return { protocolVersion: REQUIRED_PROTOCOL_VERSION, elevated: false as const, ok: true, pathExists: true, pathFileId: "AAAA", pathVolumeSerial: "vol-1" }
      if (argv[0] === "inspect-acl") return { protocolVersion: REQUIRED_PROTOCOL_VERSION, elevated: false as const, ok: true, sddl: "D:P(A;OICI;FA;;;S-1-5-21-owner)" }
      return { protocolVersion: REQUIRED_PROTOCOL_VERSION, elevated: false as const, ok: true, profileExists: false }
    }
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(out[0]?.action).toBe("reclaimed")
    const restore = calls.find((c) => c[0] === "restore-acl")!
    expect(restore[restore.indexOf("--original-sddl") + 1]).toBe("D:P(A;OICI;FA;;;S-1-5-21-owner)")
    // With no observation there is no granted descriptor to expect, and the
    // flag is correctly omitted rather than passed empty (which restore-acl
    // rejects).
    expect(restore).not.toContain("--expect-granted-sddl")
    s.close()
  })

  test("recovery TAKES OWNERSHIP: it mints a higher fencing token before mutating", async () => {
    const s = store("reclaimowns")
    await seedRun(s, "run_own", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, ttlMs: 1_000, withGrant: true })
    const { helper } = helperWith({ 4242: { alive: false } })
    const before = (await scanIsolatedRuns(s)).find((r) => r.runId === "run_own")!.lease!
    await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    const after = (await scanIsolatedRuns(s)).find((r) => r.runId === "run_own")!.lease!
    // A strictly higher token, so a zombie original owner is now fenced out of
    // every mutation — including its own release.
    expect(after.fencingToken).toBeGreaterThan(before.fencingToken)
    await expect(assertMayMutate({ store: s }, before, "finish my old revoke")).rejects.toThrow(StaleLeaseHolder)
    s.close()
  })
})

describe("recovery may run BEFORE bootstrap, but only inside a root it trusts", () => {
  const TRUSTED = String.raw`C:\ProgramData\Abdo\Execution\v1\S_1_5_21`

  test("a run inside the trusted root IS reclaimed", async () => {
    const s = store("beforeboot")
    await seedRun(s, "run_bb", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, ttlMs: 1_000, withGrant: true })
    const { helper } = helperWith({ 4242: { alive: false } })
    const out = await reclaimBeforeBootstrap({ store: s, helper, now: () => 900_000 }, TRUSTED)
    expect(out[0]?.action).toBe("reclaimed")
    s.close()
  })

  test("a run in ANOTHER root is deferred and NOTHING of it is touched", async () => {
    // THE POINT: a pre-bootstrap sweep runs before anything has been proved
    // about the machine. A run recorded under a different root may belong to
    // another host SID or a layout this build does not know, and repairing it
    // would be the sweep becoming the thing that breaks the machine.
    const s = store("otherroot")
    await seedRun(s, "run_or", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, ttlMs: 1_000, withGrant: true })
    const { helper, calls } = helperWith({ 4242: { alive: false } })
    const out = await reclaimBeforeBootstrap({ store: s, helper, now: () => 900_000 }, String.raw`C:\ProgramData\Abdo\Execution\v1\SOMEONE_ELSE`)
    expect(out[0]?.action).toBe("manual_intervention_required")
    expect(out[0]?.detail).toContain("not inside the execution root being adopted")
    for (const verb of ["restore-acl", "delete-profile"]) expect(calls.map((c) => c[0])).not.toContain(verb)
    s.close()
  })

  test("NON-VACUITY: without the scope the very same run WOULD be reclaimed", async () => {
    // Proves the deferral above comes from the trusted-root scope and not from
    // some other property of the fixture.
    const s = store("scopenonvac")
    await seedRun(s, "run_nv", { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, ttlMs: 1_000, withGrant: true })
    const { helper } = helperWith({ 4242: { alive: false } })
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(out[0]?.action).toBe("reclaimed")
    s.close()
  })
})

describe("adversarial evidence: the gate refuses what it cannot explain", () => {
  const seedGrantEvents = async (s: SqliteEventStore, runId: string, mutations: Record<string, unknown>[], observed?: Record<string, unknown>) => {
    const agg = runLeaseAggregateId(runId)
    await s.append({ aggregateKind: "project", aggregateId: agg, type: RunLifecycle.Requested, version: 1, data: { runId, profileName: OWNED } })
    await s.append({ aggregateKind: "project", aggregateId: agg, type: RunLifecycle.RootReady, version: 1, data: { runId, runPath: RUNPATH } })
    const lease = await acquireRunLease({ store: s, now: () => 1_000 }, { runId, operationId: "op_real", ownerPid: 4242, ownerStartTime: "111" }, 1_000)
    for (const m of mutations) await s.append({ aggregateKind: "project", aggregateId: agg, type: RunGrantEvents.GrantsMutating, version: 1, data: { runId, ...m } })
    if (observed) await s.append({ aggregateKind: "project", aggregateId: agg, type: RunGrantEvents.GrantObserved, version: 1, data: { runId, ...observed } })
    return lease
  }

  /**
   * A helper whose ACL answers are scripted, so a restore can "fail" on demand.
   *
   * The granted object is the ANCESTOR (the execution root), not the run
   * directory — which is both realistic and necessary. Ancestors get a traverse
   * ACE and SURVIVE the run directory's deletion, so they are the objects whose
   * restore actually has to be proved. An earlier version of this fixture
   * granted on the run path itself, where deletion makes every ACL check
   * trivially pass and the adversarial cases prove nothing.
   */
  const aclHelper = (sddlAfterRestore: string) => {
    const calls: string[][] = []
    const helper = async ({ argv }: { argv: readonly string[] }) => {
      calls.push([...argv])
      const base = { protocolVersion: REQUIRED_PROTOCOL_VERSION, elevated: false as const, ok: true }
      const i = argv.indexOf("--path")
      const path = i >= 0 ? String(argv[i + 1] ?? "") : ""
      if (argv[0] === "inspect-process") return { ...base, alive: false }
      if (argv[0] === "inspect-dir") {
        // The run directory is gone (cleanup removed it); the ancestor remains.
        const isRunDir = path.toLowerCase() === RUNPATH.toLowerCase()
        return { ...base, pathExists: !isRunDir, pathFileId: "AAAA", pathVolumeSerial: "vol-1" }
      }
      if (argv[0] === "inspect-acl") return { ...base, sddl: sddlAfterRestore }
      return { ...base, profileExists: false }
    }
    return { helper, calls }
  }

  const ANCESTOR = String.raw`C:\ProgramData\Abdo\Execution\v1\S_1_5_21`

  const ORIGINAL = "D:P(A;OICI;FA;;;S-1-5-21-owner)"

  test("a DUPLICATED ancestor with PARTIAL mutation is refused — chained originals are conflicting evidence", async () => {
    // Two mutations of one object, the second capturing an "original" that
    // already contains the first ACE. Restoring that would leave the container
    // on the object while the log said reclaimed.
    const s = store("dupancestor")
    await seedGrantEvents(s, "run_dup", [
      { path: ANCESTOR, sid: SID, originalSddl: ORIGINAL, fileId: "AAAA", volumeSerial: "vol-1", operationId: "op_real" },
      { path: ANCESTOR, sid: SID, originalSddl: `${ORIGINAL}(A;;0x1000a0;;;${SID})`, fileId: "AAAA", volumeSerial: "vol-1", operationId: "op_real" },
    ])
    const { helper, calls } = aclHelper(ORIGINAL)
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(out[0]?.action).toBe("manual_intervention_required")
    expect(out[0]?.detail).toContain("conflicting_originals")
    // NOTHING was written on the strength of an original we cannot identify.
    expect(calls.map((c) => c[0])).not.toContain("restore-acl")
    s.close()
  })

  test("a SEMANTICALLY SIMILAR but non-identical DACL still counts as unrestored", async () => {
    // The container's ACE is gone and the remaining ACE grants the same rights
    // to the same owner — but an extra principal is present. "Close enough" is
    // not restored.
    const s = store("semantic")
    await seedGrantEvents(s, "run_sem", [{ path: ANCESTOR, sid: SID, originalSddl: ORIGINAL, fileId: "AAAA", volumeSerial: "vol-1", operationId: "op_real" }])
    const { helper } = aclHelper(`${ORIGINAL}(A;OICI;FA;;;S-1-5-32-544)`)
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(out[0]?.action).toBe("manual_intervention_required")
    expect(out[0]?.unproven?.join(" ")).toContain("foreign principal survived")
    s.close()
  })

  test("a SURVIVING FOREIGN principal — another run's container — is reported, not ignored", async () => {
    const s = store("foreign")
    await seedGrantEvents(s, "run_for", [{ path: ANCESTOR, sid: SID, originalSddl: ORIGINAL, fileId: "AAAA", volumeSerial: "vol-1", operationId: "op_real" }])
    // Our SID is gone; a DIFFERENT AppContainer's ACE remains.
    const otherContainer = "S-1-15-2-9-9-9"
    const { helper } = aclHelper(`${ORIGINAL}(A;;0x1000a0;;;${otherContainer})`)
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(out[0]?.action).toBe("manual_intervention_required")
    expect(out[0]?.unproven?.join(" ").toLowerCase()).toContain(otherContainer.toLowerCase())
    s.close()
  })

  test("a FAILED restore must never report reclaimed — the re-read is the verdict", async () => {
    // `restore-acl` "succeeds"; the descriptor is unchanged and still carries
    // the container. A call returning is not a descriptor changing.
    const s = store("failedrestore")
    await seedGrantEvents(s, "run_fail", [{ path: ANCESTOR, sid: SID, originalSddl: ORIGINAL, fileId: "AAAA", volumeSerial: "vol-1", operationId: "op_real" }])
    const { helper } = aclHelper(`${ORIGINAL}(A;;0x1000a0;;;${SID})`)
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(out[0]?.action).toBe("manual_intervention_required")
    expect(out[0]?.restored ?? []).not.toContain(ANCESTOR)
    s.close()
  })

  test("a grant from an UNKNOWN operation is refused — provenance is part of the evidence", async () => {
    const s = store("unknownop")
    await seedGrantEvents(s, "run_unk", [{ path: ANCESTOR, sid: SID, originalSddl: ORIGINAL, fileId: "AAAA", volumeSerial: "vol-1", operationId: "op_ghost" }])
    const { helper, calls } = aclHelper(ORIGINAL)
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(out[0]?.action).toBe("manual_intervention_required")
    expect(out[0]?.detail).toContain("unknown_operation")
    expect(calls.map((c) => c[0])).not.toContain("restore-acl")
    s.close()
  })

  test("NON-VACUITY: clean, single-original, known-provenance evidence DOES reclaim", async () => {
    // Every refusal above must be caused by the defect it names, not by the
    // fixture being unreclaimable in general.
    const s = store("cleanevidence")
    await seedGrantEvents(s, "run_ok", [{ path: ANCESTOR, sid: SID, originalSddl: ORIGINAL, fileId: "AAAA", volumeSerial: "vol-1", operationId: "op_real" }])
    const { helper, calls } = aclHelper(ORIGINAL)
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(`${out[0]?.action}: ${out[0]?.detail}`).toContain("reclaimed")
    expect(out[0]?.restored).toContain(ANCESTOR)
    expect(calls.map((c) => c[0])).toContain("restore-acl")
    s.close()
  })
})

/**
 * B6 / XP-06 — THE SUPERSEDED RELEASE, DETERMINISTICALLY.
 *
 * The intermittent cross-process red proved this shape exists (~1 in 5 under
 * contention); qualification must not depend on winning that race. The store
 * is the injected seam, so the interleaving is FORCED: a decorator runs a hook
 * the moment a chosen event type lands, which is exactly "sibling B advances
 * the generation between A's durable Reclaimed and A's release" — no timing,
 * no luck. The preserved intermittent worlds remain diagnostic provenance;
 * these tests are the proof.
 */
function withAfterAppend(s: SqliteEventStore, type: string, hook: () => Promise<void>): SqliteEventStore {
  let fired = false
  return new Proxy(s, {
    get(target, prop) {
      if (prop === "append") {
        return async (e: { type: string }) => {
          const r = await target.append(e as never)
          if (!fired && e.type === type) {
            fired = true
            await hook()
          }
          return r
        }
      }
      const v = Reflect.get(target, prop, target)
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  }) as SqliteEventStore
}

function withThrowOnAppend(s: SqliteEventStore, type: string, error: Error): SqliteEventStore {
  return new Proxy(s, {
    get(target, prop) {
      if (prop === "append") {
        return async (e: { type: string }) => {
          if (e.type === type) throw error
          return target.append(e as never)
        }
      }
      const v = Reflect.get(target, prop, target)
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  }) as SqliteEventStore
}

describe("B6/XP-06 — a completed reclaim survives a superseded release, truthfully", () => {
  test("supersession BETWEEN Reclaimed and release: action=reclaimed, releaseSuperseded=true, journal honest", async () => {
    const s = store("xp06det")
    const runId = "run_xp06_det"
    await seedRun(s, runId, { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, ttlMs: 1_000, withGrant: true })
    const { helper } = helperWith({ 4242: { alive: false } })
    // THE FORCED INTERLEAVING: the instant this pass's Reclaimed lands, the
    // sibling mints a strictly higher generation — before the pass can release.
    const decorated = withAfterAppend(s, "isorun.recovery_reclaimed", async () => {
      await acquireRunLease({ store: s, now: () => 900_001 }, { runId, operationId: newOperationId(), ownerPid: 77_777, ownerStartTime: "sibling" }, 1_000)
    })
    const out = await recoverIsolatedRuns({ store: decorated, helper, now: () => 900_000 })

    // The pass reports the TRUTH: the reclaim completed; only the release was
    // superseded. No refused result replaces finished work.
    expect(out).toHaveLength(1)
    expect(out[0]?.action).toBe("reclaimed")
    expect(out[0]?.releaseSuperseded).toBe(true)

    const events = await s.read("project", runLeaseAggregateId(runId))
    const reclaims = events.filter((e) => e.type === "isorun.recovery_reclaimed")
    const requests = events.filter((e) => e.type === "isorun.recovery_requested")
    const releases = events.filter((e) => e.type === "isorun.lease_released")
    const acquires = events.filter((e) => e.type === "isorun.lease_acquired").map((e) => Number((e.data as { fencingToken: number }).fencingToken))
    // Exactly ONE durable Reclaimed — never deleted, never duplicated — and it
    // is preceded by its own Requested under its own generation.
    expect(reclaims).toHaveLength(1)
    expect(requests).toHaveLength(1)
    expect((reclaims[0]!.data as { reclaimOperationId: string }).reclaimOperationId).toBe((requests[0]!.data as { reclaimOperationId: string }).reclaimOperationId)
    // The superseded release was REFUSED by fencing: no Released event exists.
    expect(releases).toHaveLength(0)
    // Generations stayed strictly increasing: seed 1, reclaimer 2, sibling 3.
    expect(acquires).toEqual([1, 2, 3])
    // THE SUPERSEDED HOLDER CANNOT MUTATE AGAIN: the current generation is the
    // sibling's, so any late mutation under token 2 is refused.
    const stale = { runId, operationId: (requests[0]!.data as { reclaimOperationId: string }).reclaimOperationId, ownerPid: process.pid, ownerStartTime: `recovery-${process.pid}`, fencingToken: 2, ttlMs: 1_000, heldAt: 900_000, expiresAt: 901_000, renewals: 0 }
    await expect(releaseRunLease({ store: s, now: () => 900_002 }, stale as never, "completed", CLEAN)).rejects.toBeInstanceOf(StaleLeaseHolder)
    s.close()
  })

  test("the ordinary case is untouched: successful release, releaseSuperseded absent", async () => {
    const s = store("xp06plain")
    const runId = "run_xp06_plain"
    await seedRun(s, runId, { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, ttlMs: 1_000, withGrant: true })
    const { helper } = helperWith({ 4242: { alive: false } })
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => 900_000 })
    expect(out[0]?.action).toBe("reclaimed")
    expect(out[0]?.releaseSuperseded).toBeUndefined()
    const events = await s.read("project", runLeaseAggregateId(runId))
    const reclaimOp = (events.find((e) => e.type === "isorun.recovery_reclaimed")!.data as { reclaimOperationId: string }).reclaimOperationId
    const releasedOps = events.filter((e) => e.type === "isorun.lease_released").map((e) => (e.data as { operationId: string }).operationId)
    expect(releasedOps).toContain(reclaimOp)
    s.close()
  })

  test("a NON-Stale release error still propagates — never converted into reclaimed success", async () => {
    const s = store("xp06err")
    const runId = "run_xp06_err"
    await seedRun(s, runId, { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, ttlMs: 1_000, withGrant: true })
    const { helper } = helperWith({ 4242: { alive: false } })
    const injected = new Error("disk full while appending the release")
    const decorated = withThrowOnAppend(s, "isorun.lease_released", injected)
    // The narrow catch is for StaleLeaseHolder ONLY: anything else escapes.
    await expect(recoverIsolatedRuns({ store: decorated, helper, now: () => 900_000 })).rejects.toBe(injected)
    s.close()
  })

  test("a StaleLeaseHolder BEFORE Reclaimed stays a refusal — it can never become reclaimed success", async () => {
    const s = store("xp06early")
    const runId = "run_xp06_early"
    await seedRun(s, runId, { ownerPid: 4242, ownerStartTime: "111", heldAt: 1_000, ttlMs: 1_000, withGrant: true })
    const { helper, calls } = helperWith({ 4242: { alive: false } })
    // The sibling mints its higher generation the instant THIS pass's own
    // acquisition lands — so the fencing check right after acquire refuses,
    // before Requested, before any mutation, before Reclaimed.
    const decorated = withAfterAppend(s, "isorun.lease_acquired", async () => {
      await acquireRunLease({ store: s, now: () => 900_001 }, { runId, operationId: newOperationId(), ownerPid: 77_777, ownerStartTime: "sibling" }, 1_000)
    })
    await expect(recoverIsolatedRuns({ store: decorated, helper, now: () => 900_000 })).rejects.toBeInstanceOf(StaleLeaseHolder)
    const events = await s.read("project", runLeaseAggregateId(runId))
    expect(events.filter((e) => e.type === "isorun.recovery_reclaimed")).toHaveLength(0)
    expect(events.filter((e) => e.type === "isorun.recovery_requested")).toHaveLength(0)
    // And nothing was mutated on the machine either.
    for (const verb of ["restore-acl", "delete-profile"]) expect(calls.map((c) => c[0])).not.toContain(verb)
    s.close()
  })
})
