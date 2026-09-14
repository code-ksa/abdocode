/**
 * CL-16A3 MEGA-1 §4c — the driver, held to the contract and then run for real.
 *
 * Two halves, and the split is deliberate.
 *
 * The FAKE-HELPER half drives `executeIsolatedRun` against a scripted helper. It
 * is not a substitute for the real thing — it proves the SEQUENCING, which is
 * what this module is: that the gate is consulted before the spawn and not after,
 * that a refusal at any stage still takes back every ACE, that the recorded chain
 * is a legal prefix, and that a driver which skipped a stage would be caught. A
 * scripted helper can be made to fail on demand, which the OS cannot.
 *
 * The LIVE half creates a real execution root, a real AppContainer, real ACEs and
 * a real process, and asserts what Windows says afterwards. It is the only half
 * that can prove the container can actually reach its own working directory —
 * and that is exactly the sort of thing no amount of unit testing establishes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RIGHTS_MODEL_VERSION } from "@abdo/tools/windows-acl-matrix"
import { bootstrapExecutionRoot } from "../src/execution-root"
import { REQUIRED_PROTOCOL_VERSION, type HelperResponse } from "../src/helper-runner"
import { LIFECYCLE_ORDER, RunLifecycle, validateLifecycleSequence } from "../src/run-lifecycle-events"
import { JobEvents, isValidJobName } from "../src/job-identity"
import { recoverIsolatedRuns } from "../src/isorun-recovery"
import { foldRunLease } from "../src/run-lease"
import { scanRuns } from "../src/recovery"
import { executeIsolatedRun, readRunLifecycle, RUN_REFUSED, RUN_RESIDUE_UNPROVEN, runLifecycleAggregateId, type RunLifecycleDeps } from "../src/run-lifecycle"
import { harnessHelperRunner, helperBinaryHash, helperBuilt, runDirect, runUnelevated } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const T = 240_000
const CMD = String.raw`C:\Windows\System32\cmd.exe`

// ───────────────────────────────────────────── the sequencing, with a fake OS

/**
 * A scripted helper over a REAL directory tree in a temp folder.
 *
 * The directory half is genuine — `createRunDirectory` writes a marker file and
 * `removeOwnedDirectoryTree` deletes a tree with `node:fs`, not through the
 * helper, so a purely in-memory fake cannot drive it. (The first version of this
 * fake tried, and got `ENOENT` writing `run.marker` into a directory that only
 * existed in a `Set`. Worth recording: it means the driver's directory handling
 * is exercised for real here, and only ACLs, AppContainers and processes are
 * simulated.)
 *
 * The simulated half is what the OS cannot be asked to do on demand: fail a
 * `grant-acl` on the third object, or hand back a different SID at the gate.
 */
function fakeHelper(root: string, opts: { fail?: (argv: readonly string[], nth: number) => HelperResponse | undefined } = {}) {
  const calls: string[][] = []
  const counts = new Map<string, number>()
  const acls = new Map<string, string>()
  const OWNER = "S-1-5-21-fake"
  const helper = async ({ argv }: { argv: readonly string[] }): Promise<HelperResponse> => {
    calls.push([...argv])
    const verb = argv[0] ?? ""
    const n = (counts.get(verb) ?? 0) + 1
    counts.set(verb, n)
    const forced = opts.fail?.(argv, n)
    if (forced) return { protocolVersion: REQUIRED_PROTOCOL_VERSION, elevated: false, ...forced }
    const argOf = (flag: string) => {
      const i = argv.indexOf(flag)
      return i >= 0 ? String(argv[i + 1] ?? "") : ""
    }
    const pathOf = () => argOf("--path")
    const base = { protocolVersion: REQUIRED_PROTOCOL_VERSION, elevated: false as const, ok: true }
    switch (verb) {
      case "version":
        return base
      case "inspect-dir": {
        const p = pathOf()
        const exists = existsSync(p)
        return {
          ...base,
          pathExists: exists,
          pathIsDirectory: exists && statSync(p).isDirectory(),
          pathIsReparsePoint: false,
          pathOwnerSid: OWNER,
          pathFinalPath: p,
          // A stable per-path identity: enough for the gate's drift comparison,
          // which is about a value CHANGING, not about its internal form.
          pathFileId: exists ? `fid-${p.toLowerCase()}` : "",
          pathVolumeSerial: exists ? "vol-1" : "",
        }
      }
      case "create-dir":
        mkdirSync(pathOf(), { recursive: true })
        return base
      case "protect-dir":
        acls.set(pathOf().toLowerCase(), `D:P(A;OICI;FA;;;${OWNER})`)
        return base
      case "inspect-acl":
        return { ...base, sddl: acls.get(pathOf().toLowerCase()) ?? `D:P(A;OICI;FA;;;${OWNER})`, fileIdentity: `fid-${pathOf().toLowerCase()}` }
      case "publish-dir": {
        const from = argOf("--from")
        const to = argOf("--to")
        // NO-REPLACE, exactly like `MoveFileExW` without MOVEFILE_REPLACE_EXISTING.
        if (existsSync(to)) return { ...base, ok: false, targetTaken: true }
        renameSync(from, to)
        acls.set(to.toLowerCase(), acls.get(from.toLowerCase()) ?? `D:P(A;OICI;FA;;;${OWNER})`)
        return base
      }
      case "ensure-profile":
        return { ...base, sid: FAKE_SID, created: true, existed: false, profileExists: true }
      case "derive-sid":
        return { ...base, sid: FAKE_SID }
      case "delete-profile":
        return { ...base, existedBefore: true, profileExists: false }
      case "grant-acl": {
        const p = pathOf().toLowerCase()
        acls.set(p, `${acls.get(p) ?? "D:P"}(A;;0x1200a9;;;${FAKE_SID})`)
        return { ...base, grantedMask: 0x1200a9 }
      }
      case "restore-acl": {
        acls.set(pathOf().toLowerCase(), argOf("--original-sddl"))
        return base
      }
      case "probe-exec-access":
        return { ...base, probeOnly: true, resumed: false, isAppContainer: true, sidMatches: true, imageMatches: true, processExited: true, pid: 4242, startTime: "133000000000000000", exitCode: 0 }
      case "launch-in-profile":
        return { ...base, pid: 9191, startTime: "133000000000000001", exitCode: 0, timedOut: false, stdout: "FAKE-OK", stderr: "", assignedToJob: true, isProcessInJob: true, resumed: true }
      case "inspect-process":
        return { ...base, startTime: "133000000000000002" }
      default:
        return base
    }
  }
  mkdirSync(root, { recursive: true })
  return { helper, calls }
}

const FAKE_SID = "S-1-15-2-1-2-3-4-5-6"

function fakeDeps(store: SqliteEventStore, helper: ReturnType<typeof fakeHelper>["helper"], root: string, over: Partial<RunLifecycleDeps> = {}): RunLifecycleDeps {
  return {
    store,
    helper,
    helperProtocol: REQUIRED_PROTOCOL_VERSION,
    helperHash: "fake-helper-hash",
    executionRootPath: root,
    executionRootFinalPath: root,
    hostSid: "S-1-5-21-fake",
    profileInventory: { complete: true, hash: "inv-1", roots: [String.raw`C:\Users\someone`] },
    rightsModelVersion: RIGHTS_MODEL_VERSION,
    stateEpoch: "epoch-1",
    ...over,
  }
}

describe("the driver sequences the pieces under the contract", () => {
  let scratch = ""
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "abdo-runlc-"))
  })
  afterAll(() => {
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  const store = (name: string) => new SqliteEventStore(join(scratch, `${name}.sqlite`))

  test("a whole run records all seventeen events, in order", async () => {
    const s = store("happy")
    const root = join(scratch, "happy-root")
    const { helper } = fakeHelper(root)
    const r = await executeIsolatedRun(fakeDeps(s, helper, root), { executablePath: CMD, args: ["/c", "echo", "hi"], dialect: "cmd", decisionId: "dec-1" })
    expect(r.reasonCode).toBeUndefined()
    expect(r.ok).toBe(true)
    expect(r.lifecycle).toEqual([...LIFECYCLE_ORDER])

    const verdict = validateLifecycleSequence(await readRunLifecycle(s, r.runId))
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.complete).toBe(true)
    s.close()
  })

  test("stdout is returned to the caller and NEVER written to the journal", async () => {
    const s = store("secrets")
    const root = join(scratch, "secrets-root")
    const { helper } = fakeHelper(root)
    const r = await executeIsolatedRun(fakeDeps(s, helper, root), { executablePath: CMD, args: ["/c", "echo", "SECRET-VALUE"], dialect: "cmd", decisionId: "dec-1" })
    expect(r.output?.stdout).toBe("FAKE-OK")
    const all = JSON.stringify(await s.read("project", runLifecycleAggregateId(r.runId)))
    expect(all).not.toContain("FAKE-OK")
    // The command's arguments are hashed, not recorded.
    expect(all).not.toContain("SECRET-VALUE")
    s.close()
  })

  test("THE GATE IS BEFORE THE SPAWN: no process is launched until the SID is re-derived", async () => {
    const s = store("order")
    const root = join(scratch, "order-root")
    const { helper, calls } = fakeHelper(root)
    await executeIsolatedRun(fakeDeps(s, helper, root), { executablePath: CMD, dialect: "cmd", decisionId: "dec-1" })
    const verbs = calls.map((c) => c[0])
    const deriveAt = verbs.lastIndexOf("derive-sid")
    const launchAt = verbs.indexOf("launch-in-profile")
    expect(launchAt).toBeGreaterThan(-1)
    // The last SID derivation happens BEFORE the one and only launch.
    expect(deriveAt).toBeLessThan(launchAt)
    // And every grant landed before the launch, too.
    expect(verbs.lastIndexOf("grant-acl")).toBeLessThan(launchAt)
    s.close()
  })

  test("a SID that changes between the grants and the launch refuses, and NOTHING starts", async () => {
    const s = store("sidswap")
    const root = join(scratch, "sidswap-root")
    // `ensure-profile` gives one SID; the pre-launch `derive-sid` gives another.
    const { helper, calls } = fakeHelper(root, {
      fail: (argv) => (argv[0] === "derive-sid" ? { ok: true, sid: "S-1-15-2-DIFFERENT" } : undefined),
    })
    const r = await executeIsolatedRun(fakeDeps(s, helper, root), { executablePath: CMD, dialect: "cmd", decisionId: "dec-1" })
    expect(r.ok).toBe(false)
    expect(r.reasonCode).toBe("appcontainer_sid_mismatch")
    // THE POINT: no process was ever created.
    expect(calls.map((c) => c[0])).not.toContain("launch-in-profile")
    // The chain stopped at the gate, and stopping there is LEGAL — a prefix is
    // legal, because a run that refuses has told the truth about how far it got.
    expect(r.lifecycle).not.toContain(RunLifecycle.LaunchRequested)
    expect(validateLifecycleSequence(r.lifecycle).ok).toBe(true)
    s.close()
  })

  test("a refusal still takes back every ACE it applied", async () => {
    const s = store("revoke")
    const root = join(scratch, "revoke-root")
    const { helper, calls } = fakeHelper(root, { fail: (argv) => (argv[0] === "derive-sid" ? { ok: true, sid: "S-1-15-2-DIFFERENT" } : undefined) })
    const r = await executeIsolatedRun(fakeDeps(s, helper, root), { executablePath: CMD, dialect: "cmd", decisionId: "dec-1" })
    expect(r.ok).toBe(false)
    const granted = calls.filter((c) => c[0] === "grant-acl").length
    const restored = calls.filter((c) => c[0] === "restore-acl").length
    expect(granted).toBeGreaterThan(0)
    expect(restored).toBe(granted)
    expect(r.revoked?.unproven).toEqual([])
    // And the profile and directory are gone too.
    expect(r.profileDeleted).toBe(true)
    expect(r.runDirectoryRemoved).toBe(true)
    s.close()
  })

  test("a refusal records run.refused, which is deliberately NOT one of the seventeen", async () => {
    const s = store("refused")
    const root = join(scratch, "refused-root")
    const { helper } = fakeHelper(root, { fail: (argv) => (argv[0] === "derive-sid" ? { ok: true, sid: "S-1-15-2-DIFFERENT" } : undefined) })
    const r = await executeIsolatedRun(fakeDeps(s, helper, root), { executablePath: CMD, dialect: "cmd", decisionId: "dec-1" })
    const types = (await s.read("project", runLifecycleAggregateId(r.runId))).map((e) => e.type)
    expect(types).toContain(RUN_REFUSED)
    expect(LIFECYCLE_ORDER).not.toContain(RUN_REFUSED as never)
    // Writing the revocation stages here would claim a process ran. It did not.
    expect(types).not.toContain(RunLifecycle.RevocationRequested)
    s.close()
  })

  test("a grant that fails halfway refuses, revokes the partial set, and never launches", async () => {
    const s = store("partial")
    const root = join(scratch, "partial-root")
    const { helper, calls } = fakeHelper(root, { fail: (argv, nth) => (argv[0] === "grant-acl" && nth === 3 ? { ok: false, error: "denied", errorCode: 5 } : undefined) })
    const r = await executeIsolatedRun(fakeDeps(s, helper, root), { executablePath: CMD, dialect: "cmd", decisionId: "dec-1" })
    expect(r.ok).toBe(false)
    expect(r.reasonCode).toBe("acl_grant_failed")
    expect(calls.map((c) => c[0])).not.toContain("launch-in-profile")
    // Two landed before the failure, and both were taken back.
    expect(calls.filter((c) => c[0] === "restore-acl").length).toBe(2)
    expect(r.lifecycle).not.toContain(RunLifecycle.GrantsApplied)
    expect(validateLifecycleSequence(r.lifecycle).ok).toBe(true)
    s.close()
  })

  test("an unprovable image is refused before a profile grants anything", async () => {
    const s = store("noprobe")
    const root = join(scratch, "noprobe-root")
    const { helper, calls } = fakeHelper(root, {
      fail: (argv) => (argv[0] === "probe-exec-access" ? { ok: true, probeOnly: true, resumed: false, isAppContainer: true, sidMatches: false, imageMatches: true, processExited: true, stage: "probe_appcontainer_sid_mismatch" } : undefined),
    })
    const r = await executeIsolatedRun(fakeDeps(s, helper, root), { executablePath: CMD, dialect: "cmd", decisionId: "dec-1" })
    expect(r.ok).toBe(false)
    expect(r.reasonCode).toBe("executable_not_accessible_to_appcontainer")
    expect(calls.map((c) => c[0])).not.toContain("grant-acl")
    expect(calls.map((c) => c[0])).not.toContain("launch-in-profile")
    s.close()
  })

  test("an incomplete profile inventory refuses before a directory is even created", async () => {
    const s = store("inv")
    const root = join(scratch, "inv-root")
    const { helper, calls } = fakeHelper(root)
    const r = await executeIsolatedRun(fakeDeps(s, helper, root, { profileInventory: { complete: false, hash: "", roots: [] } }), { executablePath: CMD, dialect: "cmd", decisionId: "dec-1" })
    expect(r.ok).toBe(false)
    expect(r.reasonCode).toBe("profile_inventory_unknown")
    expect(calls.map((c) => c[0])).not.toContain("create-dir")
    expect(r.lifecycle).toEqual([RunLifecycle.Requested])
    s.close()
  })

  test("P11: an UNKNOWN dialect refuses before ANYTHING exists — no child, zero mutation, zero residue", async () => {
    const s = store("dialect-unknown")
    const root = join(scratch, "dialect-unknown-root")
    const { helper, calls } = fakeHelper(root)
    const r = await executeIsolatedRun(fakeDeps(s, helper, root), { executablePath: CMD, dialect: "fish", decisionId: "dec-1" })
    expect(r.ok).toBe(false)
    expect(r.reasonCode).toBe("dialect_unknown")
    // launched=false in every observable sense: no output, no child identity.
    expect(r.output).toBeUndefined()
    // ZERO machine mutation: the only helper call is the host's own intent
    // identity probe; nothing was created, granted, launched or published.
    for (const verb of ["create-dir", "publish-dir", "protect-dir", "ensure-profile", "derive-sid", "grant-acl", "restore-acl", "delete-profile", "launch-in-profile", "probe-exec-access"]) {
      expect(calls.map((c) => c[0]), verb).not.toContain(verb)
    }
    // The lifecycle stopped at intent, and the refusal is durable and typed.
    expect(r.lifecycle).toEqual([RunLifecycle.Requested])
    const refused = (await s.read("project", runLifecycleAggregateId(r.runId))).filter((e) => e.type === "run.refused")
    expect(refused).toHaveLength(1)
    expect((refused[0]!.data as { reasonCode: string }).reasonCode).toBe("dialect_unknown")
    // Zero residue, in the driver's own convention: PROVEN ABSENCE reads as
    // true — nothing was created (the calls assertion above is the proof of
    // that), and nothing is left.
    expect(r.profileDeleted).toBe(true)
    expect(r.runDirectoryRemoved).toBe(true)
    s.close()
  })

  test("P11: MSYS2 bash refuses as UNSUPPORTED — a startup failure is not enforcement, and there is no downgrade", async () => {
    const s = store("dialect-msys2")
    const root = join(scratch, "dialect-msys2-root")
    const { helper, calls } = fakeHelper(root)
    const r = await executeIsolatedRun(fakeDeps(s, helper, root), { executablePath: CMD, dialect: "msys2-bash", decisionId: "dec-1" })
    expect(r.ok).toBe(false)
    expect(r.reasonCode).toBe("dialect_unsupported")
    expect(r.detail).toContain("not an enforcement mechanism")
    expect(r.output).toBeUndefined()
    expect(calls.map((c) => c[0])).not.toContain("launch-in-profile")
    expect(calls.map((c) => c[0])).not.toContain("create-dir")
    // No warn-only path: the run is REFUSED, not completed-with-a-warning.
    expect(r.lifecycle).toEqual([RunLifecycle.Requested])
    s.close()
  })

  test("the OLD recovery sweep cannot see — and so cannot destroy — a MEGA-1 run", async () => {
    // THE REGRESSION THIS PINS was live-run corruption, not a naming nit.
    //
    // This driver first wrote to `winiso:run:<id>`, the namespace `scanRuns`
    // selects and `foldRun` interprets. `foldRun` knows no `run.*` event, so the
    // projection stayed `requested` and `isIncomplete` was true forever; the
    // folded `profileName` was empty, so recovery fell back to
    // `profileNameFor(runId)` — the very profile this driver creates — and both
    // liveness guards were bypassed, because this driver populates no
    // `inFlightRuns` entry and recorded no `hostPid`. A recovery pass running
    // beside a live run therefore deleted its profile and revoked its ACLs
    // mid-flight.
    const s = store("sweep")
    const root = join(scratch, "sweep-root")
    const { helper } = fakeHelper(root)
    const r = await executeIsolatedRun(fakeDeps(s, helper, root), { executablePath: CMD, dialect: "cmd", decisionId: "dec-1" })
    expect(r.ok).toBe(true)

    // The old sweep must find NOTHING to do, both while a run is in flight and
    // after it has completed.
    const seen = await scanRuns(s)
    expect(seen.map((x) => x.runId)).not.toContain(r.runId)
    expect(seen).toEqual([])
    s.close()
  })

  test("the run records its own host identity, which is what recovery needs to spare it", async () => {
    const s = store("hostid")
    const root = join(scratch, "hostid-root")
    const { helper } = fakeHelper(root)
    const r = await executeIsolatedRun(fakeDeps(s, helper, root), { executablePath: CMD, dialect: "cmd", decisionId: "dec-1" })
    const requested = (await s.read("project", runLifecycleAggregateId(r.runId))).find((e) => e.type === RunLifecycle.Requested)
    const d = (requested?.data ?? {}) as Record<string, unknown>
    // A pid AND a creation time. A pid alone is not an identity: Windows reuses
    // them, and a sweep asking about a recycled pid spares a run that is dead.
    expect(d.hostPid).toBe(process.pid)
    expect(String(d.hostStartTime ?? "")).not.toBe("")
    expect(String(d.profileName ?? "")).toContain("abdo-winiso-")
    s.close()
  })

  test("a run takes a lease and RELEASES it, so recovery leaves the finished run alone", async () => {
    const s = store("lease")
    const root = join(scratch, "lease-root")
    const { helper } = fakeHelper(root)
    const r = await executeIsolatedRun(fakeDeps(s, helper, root), { executablePath: CMD, dialect: "cmd", decisionId: "dec-1" })
    expect(r.ok).toBe(true)

    const lease = foldRunLease(await s.read("project", runLifecycleAggregateId(r.runId)))
    expect(lease?.operationId).toBe(r.operationId!)
    expect(lease?.ownerPid).toBe(process.pid)
    // A creation time, not just a pid: a pid alone is not an identity.
    expect(lease?.ownerStartTime).not.toBe("")
    expect(lease?.released, "a finished run must not keep asserting it is in flight").toBe(true)
    expect(lease?.releaseReason).toBe("completed")

    // And the sweep therefore has nothing to do, even long after expiry.
    const out = await recoverIsolatedRuns({ store: s, helper, now: () => Date.now() + 10_000_000 })
    expect(out.find((o) => o.runId === r.runId)?.action).toBe("nothing_to_do")
    s.close()
  })

  test("a REFUSED run releases its lease too — a refusal is not a hang", async () => {
    const s = store("leaserefused")
    const root = join(scratch, "leaserefused-root")
    const { helper } = fakeHelper(root, { fail: (argv) => (argv[0] === "derive-sid" ? { ok: true, sid: "S-1-15-2-DIFFERENT" } : undefined) })
    const r = await executeIsolatedRun(fakeDeps(s, helper, root), { executablePath: CMD, dialect: "cmd", decisionId: "dec-1" })
    expect(r.ok).toBe(false)
    const lease = foldRunLease(await s.read("project", runLifecycleAggregateId(r.runId)))
    // Released on the refusal path as well. Otherwise every refused run would
    // look live for a full TTL, and recovery could not tell it from a stall.
    expect(lease?.released).toBe(true)
    expect(lease?.releaseReason).toBe("refused")
    s.close()
  })

  test("REFUSAL BEFORE ANY MUTATION releases the lease immediately — there is nothing to roll back", async () => {
    const s = store("refusenomut")
    const root = join(scratch, "refusenomut-root")
    const { helper, calls } = fakeHelper(root)
    const r = await executeIsolatedRun(fakeDeps(s, helper, root, { profileInventory: { complete: false, hash: "", roots: [] } }), { executablePath: CMD, dialect: "cmd", decisionId: "dec-1" })
    expect(r.ok).toBe(false)
    expect(calls.map((c) => c[0])).not.toContain("create-dir")
    const lease = foldRunLease(await s.read("project", runLifecycleAggregateId(r.runId)))
    // Nothing was created, so "never_created" is the honest proof and the lease
    // can go immediately. Holding it would make recovery wait out a TTL for a
    // run that never touched the machine.
    expect(lease?.released).toBe(true)
    expect(lease?.releaseReason).toBe("refused")
    s.close()
  })

  test("CANCELLATION AFTER PARTIAL GRANTS releases only once the rollback is VERIFIED", async () => {
    const s = store("cancelpartial")
    const root = join(scratch, "cancelpartial-root")
    const { helper, calls } = fakeHelper(root, { fail: (argv, nth) => (argv[0] === "grant-acl" && nth === 3 ? { ok: false, error: "denied", errorCode: 5 } : undefined) })
    const r = await executeIsolatedRun(fakeDeps(s, helper, root), { executablePath: CMD, dialect: "cmd", decisionId: "dec-1" })
    expect(r.ok).toBe(false)
    // Two ACEs landed and both were taken back BEFORE the release.
    const order = calls.map((c) => c[0])
    expect(calls.filter((c) => c[0] === "restore-acl").length).toBe(2)
    const lease = foldRunLease(await s.read("project", runLifecycleAggregateId(r.runId)))
    expect(lease?.released).toBe(true)
    // And the run root really is gone — the proof re-read it rather than
    // trusting the teardown's return value.
    expect(r.runDirectoryRemoved).toBe(true)
    expect(order).not.toContain("launch-in-profile")
    s.close()
  })

  test("a run that CANNOT prove itself clean does NOT release its lease", async () => {
    // THE POINT OF THE PROOF. If the profile will not delete, the run must not
    // mark itself finished — that would hide the residue from recovery forever.
    // It is left to expire instead, which is exactly how recovery gets it.
    const s = store("dirtyexit")
    const root = join(scratch, "dirtyexit-root")
    // A profile DIRECTORY that survives its deletion. Injected at `inspect-dir`
    // because that is what the residue proof actually re-reads — trusting
    // `delete-profile`'s own return value is precisely what the proof exists to
    // avoid.
    const { helper } = fakeHelper(root, {
      fail: (argv) => (argv[0] === "inspect-dir" && String(argv[2] ?? "").includes("Packages") ? { ok: true, pathExists: true, pathIsDirectory: true } : undefined),
    })
    const r = await executeIsolatedRun(fakeDeps(s, helper, root), { executablePath: CMD, dialect: "cmd", decisionId: "dec-1" })
    expect(r.ok).toBe(false)
    expect(r.reasonCode).toBe("residue_unproven")
    const events = await s.read("project", runLifecycleAggregateId(r.runId))
    const lease = foldRunLease(events)
    expect(lease?.released, "a run with residue must NOT claim it is clean").toBe(false)
    expect(events.map((e) => e.type)).toContain(RUN_RESIDUE_UNPROVEN)
    // And it did NOT claim completion: the chain stops short, which is a legal
    // prefix and an honest one.
    expect(events.map((e) => e.type)).not.toContain(RunLifecycle.Completed)
    s.close()
  })

  test("NON-VACUITY: the contract would CATCH a driver that skipped a stage", () => {
    // If a future edit dropped the revocation bracket, this is what the recorded
    // chain would look like — and the validator must reject it. Without this,
    // every assertion above could pass against a validator that accepts anything.
    const skipped = LIFECYCLE_ORDER.filter((e) => e !== RunLifecycle.RevocationApplied)
    const v = validateLifecycleSequence(skipped)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.problems.join(" ")).toContain(RunLifecycle.RevocationApplied)
  })
})

// ─────────────────────────────────────────────────────── the real thing

describe.skipIf(!READY)("LIVE: one real run, end to end", () => {
  let scratch = ""
  let deps: RunLifecycleDeps
  let programData = ""
  let store: SqliteEventStore

  beforeAll(async () => {
    const kf = await runUnelevated(["known-folder", "--id", "ProgramData"])
    expect(kf.elevated, "every measurement must come from a medium-integrity process").toBe(false)
    programData = String(kf.lexicalPath ?? "")
    const hostSid = String(kf.hostUserSid ?? "")
    scratch = mkdtempSync(join(tmpdir(), "abdo-runlc-live-"))
    store = new SqliteEventStore(join(scratch, "journal.sqlite"))
    const helper = harnessHelperRunner()
    const root = await bootstrapExecutionRoot({
      store,
      helper,
      helperProtocol: REQUIRED_PROTOCOL_VERSION,
      helperHash: helperBinaryHash(),
      profileInventory: { complete: true, hash: "live-inventory", roots: [{ path: process.env.USERPROFILE ?? "" }] },
      rightsModelVersion: RIGHTS_MODEL_VERSION,
    })
    if (!root.ok) throw new Error(`the execution root would not bootstrap: ${root.reasonCode} — ${root.detail}`)
    deps = {
      store,
      helper,
      helperProtocol: REQUIRED_PROTOCOL_VERSION,
      helperHash: helperBinaryHash(),
      executionRootPath: root.rootPath,
      executionRootFinalPath: root.finalPath,
      hostSid,
      profileInventory: { complete: true, hash: "live-inventory", roots: [process.env.USERPROFILE ?? ""] },
      rightsModelVersion: RIGHTS_MODEL_VERSION,
      stateEpoch: "live-epoch",
    }
  }, T)

  afterAll(() => {
    try {
      store?.close()
    } catch {
      /* already closed */
    }
    for (const p of [join(programData, "Abdo"), scratch]) {
      try {
        rmSync(p, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  })

  test("a real command runs inside a real AppContainer and the chain is complete", async () => {
    const r = await executeIsolatedRun(deps, { executablePath: CMD, args: ["/c", "echo", "LIVE-OK"], dialect: "cmd", decisionId: "live-dec-1", timeoutMs: 30_000 })
    // The reason code is asserted FIRST: a bare `ok === true` failure tells you
    // nothing, and this run touches a dozen OS operations that can each refuse.
    expect(`${r.reasonCode ?? ""} ${r.detail ?? ""}`.trim()).toBe("")
    expect(r.ok).toBe(true)
    expect(r.output?.childStarted, "a pid and a creation time are what make this a measurement").toBe(true)
    expect(r.output?.stdout ?? "").toContain("LIVE-OK")
    expect(r.output?.exitCode).toBe(0)
    // OBSERVED containment, not assumed.
    expect(r.output?.isProcessInJob).toBe(true)
    expect(r.lifecycle).toEqual([...LIFECYCLE_ORDER])
    const v = validateLifecycleSequence(await readRunLifecycle(store, r.runId))
    expect(v.ok && v.complete).toBe(true)

    // P5c NON-VACUITY. Everything above passes just as well if the launch fell
    // back to an ANONYMOUS job, which is exactly the state finding 17 describes
    // and this phase exists to end. So the production path is held to having
    // really used a NAMED one, and to having recorded it where recovery reads.
    const events = await store.read("project", runLifecycleAggregateId(r.runId))
    const byType = new Map(events.map((e) => [e.type, e.data as Record<string, unknown>]))

    // The INTENT is durable, and it is written BEFORE the helper is invoked —
    // that ordering is the only reason an orphaned tree is reachable at all.
    const intent = byType.get(JobEvents.CreateRequested)
    expect(intent, "the job's name must be journalled before the process exists").toBeDefined()
    expect(isValidJobName(String(intent?.jobName ?? ""))).toBe(true)

    // The COMPLETIONS carry what the OS said, not what was asked for.
    const made = byType.get(JobEvents.Created)
    expect(made?.jobName).toBe(intent?.jobName)
    expect(made?.limitFlags, "no KILL_ON_JOB_CLOSE and no breakaway of any kind").toBe(0)

    const proc = byType.get(JobEvents.ProcessCreated)
    expect(proc?.jobName).toBe(intent?.jobName)
    expect(proc?.isProcessInJob, "membership is the OS answering, not the assign call").toBe(true)
    // The child really is inside the AppContainer the ACLs were written for —
    // a check that used to exist only on the probe path, never on a real launch.
    expect(String(proc?.appContainerSid ?? "")).toBe(String(r.appContainerSid ?? ""))

    // P5c2 NON-VACUITY. What lets the job's NAME outlive this helper is a
    // TRUSTED KEEPER, and the production path is held to having really started
    // one — recorded, with an identity, before the target existed.
    //
    // This replaces an assertion on `childKeepAliveHandle`, which said a job
    // handle had been duplicated into the TARGET. That was true and still
    // unsound: the target owned the handle and could close it, so the field
    // recorded an intention. These record an acknowledgement from a process the
    // target cannot reach.
    const keeper = byType.get(JobEvents.KeeperReady)
    expect(keeper, "the keeper's identity must be journalled before the process exists").toBeDefined()
    expect(keeper?.jobName).toBe(intent?.jobName)
    expect(Number(keeper?.keeperPid ?? 0)).toBeGreaterThan(0)
    // A pid alone is not an identity — the creation time travels with it, as
    // decimal digits in a STRING because a FILETIME exceeds 2^53.
    expect(String(keeper?.keeperStartTime ?? "")).toMatch(/^\d{15,}$/)

    // ORDERING, asserted rather than assumed: the keeper was ready BEFORE the
    // process was created. A keeper recorded afterwards would leave a window in
    // which a live target had no holder for its job's name.
    const order = events.map((e) => e.type)
    expect(order.indexOf(JobEvents.KeeperReady)).toBeLessThan(order.indexOf(JobEvents.ProcessCreated))

    // And the target was not resumed until the keeper acknowledged arming.
    expect(proc?.keeperArmed).toBe(true)
    expect(proc?.keeperPid).toBe(keeper?.keeperPid)
    // THE REPLACED FIELD IS GONE, not merely false.
    expect(proc?.childKeepAliveHandle).toBeUndefined()
  }, T)

  test("ZERO RESIDUE: the run directory, the profile and every ACE are gone afterwards", async () => {
    const r = await executeIsolatedRun(deps, { executablePath: CMD, args: ["/c", "echo", "RESIDUE-CHECK"], dialect: "cmd", decisionId: "live-dec-2", timeoutMs: 30_000 })
    expect(`${r.reasonCode ?? ""} ${r.detail ?? ""}`.trim()).toBe("")
    expect(r.revoked?.unproven).toEqual([])
    expect(r.profileDeleted).toBe(true)
    expect(r.runDirectoryRemoved).toBe(true)
    // What WINDOWS says, not what the driver returned.
    expect(runDirect(["inspect-dir", "--path", r.runPath!]).pathExists).toBe(false)
    // No ACE for this run's container survives anywhere in the execution root.
    const rootSddl = String(runDirect(["inspect-acl", "--path", deps.executionRootPath]).sddl ?? "")
    expect(rootSddl.toLowerCase()).not.toContain(r.appContainerSid!.toLowerCase())
  }, T)

  test("the container can WRITE to temp and CANNOT write to metadata", async () => {
    // `temp` is the only place a child may create freely; `metadata` is
    // host-written facts ABOUT the run and is deliberately never granted.
    //
    // THIS ASSERTS BOTH HALVES, and the first draft did not. It ran the two
    // writes in one `&&`/`||` chain and only checked for `METADATA-DENIED` —
    // which a container that could write NOTHING AT ALL would also produce,
    // since the `||` catches a failure anywhere in the chain. A denial test that
    // passes when everything is denied proves nothing about least privilege. So
    // the temp write is confirmed by reading the file back, and the metadata
    // branch reports which way it went rather than only its failure.
    const r = await executeIsolatedRun(deps, {
      executablePath: CMD,
      args: ["/c", String.raw`(echo TEMP-WRITE-OK> proof.txt) & (type proof.txt) & ((echo x> ..\metadata\sneak.txt) && echo METADATA-WRITABLE || echo METADATA-DENIED)`],
      dialect: "cmd",
      decisionId: "live-dec-3",
      timeoutMs: 30_000,
    })
    expect(`${r.reasonCode ?? ""} ${r.detail ?? ""}`.trim()).toBe("")
    const out = r.output?.stdout ?? ""
    // NON-VACUITY: temp really is writable, so the denial below is a denial and
    // not a symptom of a container that cannot do anything.
    expect(out, "temp must be writable, or the metadata denial proves nothing").toContain("TEMP-WRITE-OK")
    expect(out).toContain("METADATA-DENIED")
    expect(out).not.toContain("METADATA-WRITABLE")
  }, T)
})
