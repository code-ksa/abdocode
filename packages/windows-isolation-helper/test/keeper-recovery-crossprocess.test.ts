/**
 * MS1 P6 slice S6 — XP-05, XP-06, XP-09: KEEPER OWNERSHIP, CONCURRENT RECOVERY
 * AND CONCURRENT OWNED-TREE REMOVAL, ACROSS REAL OS PROCESSES.
 *
 * XP-05 — THE SECOND KEEPER IS NEVER SPAWNED. The matrix imagines two keepers
 * racing for one job name and leaves the refusal code undetermined. Production
 * makes the race unreachable one step earlier: a keeper does not create the job
 * and has no creation path at all — the HOST creates the named job
 * (`create_protected_named_job`, before any process exists) and only then
 * spawns the keeper, handing it the handle by inheritance. A second host
 * presenting the same name is refused with `named_job_collision` BEFORE it
 * creates a target or a keeper, so exactly one keeper holds the name at every
 * instant. Against one of our own protected jobs the collision surfaces as
 * ACCESS_DENIED with no handle returned, because the protected descriptor
 * denies the ALL_ACCESS open `CreateJobObjectW` performs on an existing name.
 *
 * XP-06 — RECOVERY IS IDEMPOTENT, NOT ONCE-ONLY, AND GENERATIONS ARE DISTINCT.
 * The matrix's "exactly one reclaims, neither throws" is not what production
 * implements. Each pass takes its OWN reclaim lease through the CAS, so the
 * safety property is that reclaim generations are distinct and strictly
 * increasing — and `recoverIsolatedRuns` asks the fencing guard immediately
 * after acquiring, so a pass superseded in between legitimately surfaces
 * `StaleLeaseHolder`. A pass can ALSO be superseded LATE — after its reclaim is
 * durably recorded but before its own release — in which case the release is
 * refused by the same guard and the pass reports `releaseSuperseded` on a
 * completed reclaim (B6/XP-06: this third shape used to surface as a pass
 * reporting `refused` for work it had finished). All shapes are admissible;
 * the assertions below are the invariants that hold under every one, and the
 * shape observed on this run is logged rather than asserted. A final,
 * sequential pass then proves the documented idempotency deterministically.
 *
 * XP-09 — REMOVAL REPORTS, IT DOES NOT THROW. `removeOwnedDirectoryTree` is
 * synchronous and returns `{removed, code?}`, deliberately surfacing the errno
 * rather than swallowing it. What is guaranteed is that nothing throws, the
 * path is gone, and removing an already-absent path succeeds; whether BOTH
 * racers report `removed:true` is a property of the filesystem race, so it is
 * recorded, not asserted as universal.
 *
 * Every actor is a real OS process; identities are pid + creation time read
 * from Win32_Process while the actor is provably alive; every wait has an exit
 * condition and a bounded deadline; the recovery clock is production's own
 * injectable `now`.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { IsoRecoveryEvents } from "../src/isorun-recovery"
import { jobNamePrefixFor } from "../src/job-identity"
import { RunLeaseEvents, runLeaseAggregateId } from "../src/run-lease"
import { barrier, waitForFile } from "./barrier"
import { HELPER, harnessHelperRunner, helperBuilt, queueDir, runDirect } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const RECOVERY_CHILD = join(import.meta.dir, "fixtures", "recovery-race-child.ts")
const ZOMBIE_CHILD = join(import.meta.dir, "fixtures", "run-lease-zombie-child.ts")
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const TASKKILL = "C:\\Windows\\System32\\taskkill.exe"
const CMD = "C:\\Windows\\System32\\cmd.exe"
const PING = "C:\\Windows\\System32\\ping.exe"
const T = 300_000

const scratch: string[] = []
afterAll(() => {
  for (const d of scratch) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* the residue census is the guard, never a masked failure */
    }
  }
})

function ps(script: string): string {
  return Bun.spawnSync([PS, "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe", timeout: 60_000 }).stdout.toString().trim()
}

interface OsIdentity {
  pid: number
  created: string
}

/**
 * Identities read from Windows while the actors are provably alive.
 *
 * Returned IN THE ORDER ASKED, not in the order CIM happened to enumerate:
 * matching by position silently pairs one actor's pid with another's creation
 * time, which is exactly the identity confusion these tests exist to catch.
 */
async function osIdentities(pids: readonly number[], timeoutMs = 60_000): Promise<OsIdentity[]> {
  const filter = pids.map((p) => `ProcessId=${p}`).join(" or ")
  const cmd = `@(Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId, @{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const out = Bun.spawnSync([PS, "-NoProfile", "-NonInteractive", "-Command", cmd], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()
    if (out) {
      const parsed = JSON.parse(out) as unknown
      const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { ProcessId: number; Created: string }[]
      if (rows.length === pids.length) {
        const byPid = new Map(rows.map((r) => [r.ProcessId, r.Created]))
        if (pids.every((p) => byPid.has(p))) return pids.map((p) => ({ pid: p, created: byPid.get(p)! }))
      }
    }
    await Bun.sleep(25)
  }
  throw new Error(`could not read OS identities for pids ${pids.join(", ")} within ${timeoutMs}ms`)
}

async function until(what: string, f: () => boolean, budgetMs = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < budgetMs) {
    if (f()) return
    await Bun.sleep(120)
  }
  throw new Error(`timed out waiting for: ${what}`)
}

interface LogLine {
  event: string
  me: string
  pid: number
  outcome?: string
  results?: { runId: string; action: string; liveness: string; detail: string; releaseSuperseded?: boolean }[]
  reasonCode?: string
  heldToken?: number
  currentToken?: number
  removed?: boolean
  code?: string
  ownerStartTime?: string
  fencingToken?: number
  error?: string
}

const readLog = (p: string): LogLine[] =>
  existsSync(p)
    ? readFileSync(p, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LogLine)
    : []

/**
 * One scratch world. `gates` and `race` are SEPARATE directories on purpose:
 * `test/barrier.ts` counts arrivals by filename prefix, so a one-off gate file
 * named `go.<something>` sitting in the same directory as a `go` barrier would
 * be counted as a participant and release the barrier early — a rendezvous that
 * silently stops blocking is how a contended test becomes a sequential one.
 */
function world(tag: string) {
  const dir = mkdtempSync(join(tmpdir(), `abdo-s6-${tag}-`))
  scratch.push(dir)
  const gates = join(dir, "gates")
  const race = join(dir, "race")
  mkdirSync(gates, { recursive: true })
  mkdirSync(race, { recursive: true })
  const log = join(dir, "events.jsonl")
  writeFileSync(log, "", "utf8")
  return { dir, gates, race, log }
}

// ─────────────────────────────────────────────── XP-05: keeper ownership

const hostSid = (): string => String(runDirect(["known-folder", "--id", "ProgramData"]).hostUserSid ?? "")
const sessionId = (): number => Number(runDirect(["version"]).sessionId ?? -1)

/** Every keeper holding ONE job name, as the OS sees it — the XP-05 observable. */
function keepersFor(name: string): number[] {
  const raw = ps(`Get-CimInstance Win32_Process -Filter "Name='abdo-winiso.exe'" | Where-Object { $_.CommandLine -like '*job-keeper*' -and $_.CommandLine -like '*${name}*' } | ForEach-Object { $_.ProcessId }`)
  return raw.length === 0 ? [] : raw.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => n > 0)
}

const RUN_ID = "run_s6"
const OP_ID = "op_s6"
const FENCE = 1
const identityArgs = (name: string) => ["--job-name", name, "--run-id", RUN_ID, "--operation-id", OP_ID, "--fencing-token", String(FENCE), "--expect-session-id", String(sessionId())]

describe.skipIf(!READY)("MS1 P6 XP-05 - one job name, one keeper: the second host is refused before it can spawn one", () => {
  test("a second host on the SAME job name is refused named_job_collision, and no second keeper is ever created", async () => {
    const name = `${jobNamePrefixFor(hostSid(), RUN_ID, OP_ID, FENCE)}s6x${process.pid}`

    // ── HOST A: a real detached host with a live tree in the named job. It
    //    creates the job, then spawns the keeper that holds the name open.
    const a = Bun.spawn([HELPER, "run", "--mode", "plain", ...identityArgs(name), "--timeout-ms", "120000", "--", CMD, "/c", `${PING} -n 90 127.0.0.1`], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    a.unref()
    let keeperPid = 0
    try {
      await until("host A's keeper to hold the named job", () => {
        const k = keepersFor(name)
        if (k.length === 0) return false
        keeperPid = k[0]!
        return true
      })

      // ── EXACTLY ONE keeper for this name, and its OS identity recorded while
      //    it is provably alive (a pid alone is not an identity).
      expect(keepersFor(name)).toHaveLength(1)
      const [keeperId, hostAId] = await osIdentities([keeperPid, a.pid])
      expect(keeperId!.pid).toBe(keeperPid)
      expect(hostAId!.pid).toBe(a.pid)
      expect(keeperId!.pid).not.toBe(hostAId!.pid) // keeper and host are different processes
      const pingsBefore = ps(`@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'").Count`)

      // ── HOST B: the SAME name and the same recorded identity. Production
      //    refuses in `create_protected_named_job`, BEFORE any process exists.
      const b = runDirect(["run", "--mode", "plain", ...identityArgs(name), "--timeout-ms", "10000", "--", CMD, "/c", "echo SHOULD-NOT-RUN"])
      expect(b.ok).toBe(false)
      expect(b.stage).toBe("named_job_collision")
      expect(b.pid ?? null).toBe(null) // the refusal PRECEDES the spawn
      expect(String(b.stdout ?? "")).not.toContain("SHOULD-NOT-RUN")
      // MEASURED: against one of OUR protected jobs the collision is
      // ACCESS_DENIED and no handle is ever returned.
      expect(b.collisionHandleReturned).toBe(false)
      expect(b.errorCode).toBe(5)
      // Host B reports NO keeper of its own: none was spawned.
      expect(b.keeperPid ?? null).toBe(null)
      expect(b.keeperReady ?? false).toBe(false)

      // ── THE CLAIM: still exactly one keeper for this name, and it is the SAME
      //    process — same pid AND same creation time, so a pid reused by
      //    anything else could not pass as the keeper.
      const after = keepersFor(name)
      expect(after).toEqual([keeperPid])
      const [keeperAfter] = await osIdentities([keeperPid])
      expect(`${keeperAfter!.pid}@${keeperAfter!.created}`).toBe(`${keeperId!.pid}@${keeperId!.created}`)
      // A's tree was neither adopted nor terminated.
      expect(ps(`@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'").Count`)).toBe(pingsBefore)
      expect(runDirect(["inspect-process", "--pid", String(a.pid)]).alive).toBe(true)

      // ── teardown through the RECORDED identity: the tree dies, and the keeper
      //    exits on its own once the OS confirms the job is empty.
      const killed = runDirect(["terminate-process-tree", ...identityArgs(name)])
      expect(killed.treeGone).toBe(true)
      await until("the keeper to exit once its job is empty", () => keepersFor(name).length === 0)
      expect(keepersFor(name)).toEqual([])

      console.log(`[gate] XP-05: keeper ${keeperId!.pid}@${keeperId!.created} held ${name} throughout; host B refused named_job_collision (errorCode 5, no handle, pid null, no keeper spawned); tree terminated, keeper reaped`)
    } finally {
      Bun.spawnSync([TASKKILL, "/F", "/T", "/PID", String(a.pid)], { stdout: "ignore", stderr: "ignore" })
      runDirect(["terminate-process-tree", ...identityArgs(name)])
    }
  }, T)
})

// ──────────────────────────── XP-06: concurrent recovery over one store

/** Seed a REAL crashed run: a live child acquires with its real identity, then dies. */
async function seedCrashedRun(w: ReturnType<typeof world>, db: string, runId: string): Promise<{ pid: number; created: string; ownerStartTime: string }> {
  const child = Bun.spawn([process.execPath, ZOMBIE_CHILD, "--db", db, "--log", w.log, "--gates", w.gates, "--run", runId, "--me", "seed", "--role", "sleeper"], {
    env: { ...process.env, ABDO_HARNESS_QUEUE: queueDir() },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await waitForFile(join(w.gates, "ready.seed"))).toBe(true)
  const [id] = await osIdentities([child.pid])
  writeFileSync(join(w.gates, "go.seed"), String(Date.now()), "utf8")
  expect(await waitForFile(join(w.gates, "acquired.seed"))).toBe(true)
  const acq = readLog(w.log).find((l) => l.me === "seed" && l.event === "acquired")!
  expect(acq.fencingToken).toBe(1)

  // REAL death, then PROVED death through the real helper against the identity
  // recorded while it was alive.
  expect(Bun.spawnSync([TASKKILL, "/F", "/PID", String(child.pid)], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0)
  expect(await child.exited).not.toBe(0)
  const helper = harnessHelperRunner()
  const deadline = Date.now() + 60_000
  let dead = false
  while (Date.now() < deadline) {
    if ((await helper({ argv: ["inspect-process", "--pid", String(child.pid), "--expect-start", acq.ownerStartTime!] })).alive !== true) {
      dead = true
      break
    }
    await Bun.sleep(50)
  }
  expect(dead).toBe(true)
  return { pid: child.pid, created: id!.created, ownerStartTime: acq.ownerStartTime! }
}

function spawnRecovery(w: ReturnType<typeof world>, db: string, me: string, peers: number) {
  return Bun.spawn([process.execPath, RECOVERY_CHILD, "--log", w.log, "--gates", w.race, "--me", me, "--role", "recover", "--db", db, "--peers", String(peers)], {
    env: { ...process.env, ABDO_HARNESS_QUEUE: queueDir() },
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function expectChildOk(p: Bun.Subprocess, logPath: string) {
  const code = await p.exited
  if (code !== 0) {
    throw new Error(`child exited ${code}\nlogged: ${JSON.stringify(readLog(logPath).filter((l) => l.event === "error"))}\nstderr: ${(await new Response(p.stderr as ReadableStream).text()).slice(0, 800)}`)
  }
}

describe.skipIf(!READY)("MS1 P6 XP-06 - two hosts recover one store: distinct generations, idempotent reclaim", () => {
  test("two concurrent recovery processes never share a generation, and a later pass reclaims again", async () => {
    const w = world("xp06")
    const db = join(w.dir, "journal.sqlite")
    new SqliteEventStore(db).close() // the HOST creates the store; children attach
    const runId = "run_xp06_concurrent_recovery"
    const dead = await seedCrashedRun(w, db, runId)

    // ── two REAL recovery processes, parked and released together (the parent
    //    is the third participant, so simultaneity is its decision).
    const a = spawnRecovery(w, db, "reca", 3)
    const b = spawnRecovery(w, db, "recb", 3)
    expect(await waitForFile(join(w.race, "ready.reca"))).toBe(true)
    expect(await waitForFile(join(w.race, "ready.recb"))).toBe(true)
    const ids = await osIdentities([a.pid, b.pid])
    expect(new Set(ids.map((i) => `${i.pid}@${i.created}`)).size).toBe(2)
    expect(ids.map((i) => i.pid)).not.toContain(dead.pid)
    await barrier(w.race, "go", "parent", 3)
    await expectChildOk(a, w.log)
    await expectChildOk(b, w.log)

    const passes = readLog(w.log).filter((l) => l.event === "recover")
    expect(passes).toHaveLength(2)
    expect(new Set(passes.map((p) => p.pid)).size).toBe(2)
    // NOTHING CRASHED: each pass either completed or surfaced the production
    // fencing refusal — both are real outcomes of a real race.
    for (const p of passes) expect(["completed", "refused"]).toContain(p.outcome!)
    const reclaimedPasses = passes.filter((p) => p.outcome === "completed" && p.results?.some((r) => r.runId === runId && r.action === "reclaimed"))
    expect(reclaimedPasses.length).toBeGreaterThanOrEqual(1)
    for (const p of passes.filter((x) => x.outcome === "refused")) expect(p.reasonCode).toBe("stale_lease_holder")

    const store = new SqliteEventStore(db)
    const eventsAfterRace = await store.read("project", runLeaseAggregateId(runId))
    store.close()
    // ── the SAFETY PROPERTY: every reclaim generation is distinct and strictly
    //    increasing, and the dead run's own generation (token 1) never reclaims.
    const acquires = eventsAfterRace.filter((e) => e.type === RunLeaseEvents.Acquired).map((e) => e.data as { fencingToken: number; ownerPid: number; operationId: string })
    expect(acquires[0]!.fencingToken).toBe(1)
    expect(acquires[0]!.ownerPid).toBe(dead.pid)
    const reclaimAcquires = acquires.slice(1)
    expect(reclaimAcquires.map((r) => r.fencingToken)).toEqual(reclaimAcquires.map((_, i) => i + 2))
    expect(new Set(reclaimAcquires.map((r) => r.fencingToken)).size).toBe(reclaimAcquires.length)
    expect(new Set(reclaimAcquires.map((r) => r.operationId)).size).toBe(reclaimAcquires.length)
    for (const r of reclaimAcquires) expect(r.ownerPid).not.toBe(dead.pid)
    // Each reclaim is announced by its OWN request carrying its own generation,
    // and every reclaimed event is preceded by that request: no duplicate
    // terminal event under one generation.
    const requests = eventsAfterRace.filter((e) => e.type === IsoRecoveryEvents.Requested).map((e) => e.data as { reclaimOperationId: string; reclaimFencingToken: number })
    const reclaims = eventsAfterRace.filter((e) => e.type === IsoRecoveryEvents.Reclaimed).map((e) => e.data as { reclaimOperationId: string })
    expect(new Set(requests.map((r) => r.reclaimFencingToken)).size).toBe(requests.length)
    expect(reclaims).toHaveLength(reclaimedPasses.length)
    for (const rc of reclaims) expect(requests.some((rq) => rq.reclaimOperationId === rc.reclaimOperationId)).toBe(true)
    expect(new Set(reclaims.map((r) => r.reclaimOperationId)).size).toBe(reclaims.length)
    expect(eventsAfterRace.map((e) => Number(e.sequence))).toEqual(eventsAfterRace.map((_, i) => i))

    // ── IDEMPOTENCY, deterministically: a THIRD real process sweeps the same
    //    store afterwards. Production documents reclaim as idempotent rather
    //    than once-only, and it reclaims again under a strictly higher token.
    const c = spawnRecovery(w, db, "recc", 0)
    await expectChildOk(c, w.log)
    const third = readLog(w.log).find((l) => l.me === "recc" && l.event === "recover")!
    expect(third.outcome).toBe("completed")
    expect(third.results?.find((r) => r.runId === runId)?.action).toBe("reclaimed")

    const store2 = new SqliteEventStore(db)
    const finalEvents = await store2.read("project", runLeaseAggregateId(runId))
    store2.close()
    expect(finalEvents.map((e) => Number(e.sequence))).toEqual(finalEvents.map((_, i) => i))
    const finalAcquires = finalEvents.filter((e) => e.type === RunLeaseEvents.Acquired).map((e) => Number((e.data as { fencingToken: number }).fencingToken))
    expect(finalAcquires).toEqual(finalAcquires.map((_, i) => i + 1)) // 1, 2, 3, … strictly increasing, no duplicates
    expect(finalAcquires[finalAcquires.length - 1]).toBeGreaterThan(acquires[acquires.length - 1]!.fencingToken)
    // Every reclaim either released its own lease, or was SUPERSEDED mid-pass
    // by a sibling's strictly higher generation — in which case the release is
    // refused by fencing (by design), the pass says so via `releaseSuperseded`,
    // and the stale lease is inert. B6 (XP-06): the unaccounted third shape —
    // a completed reclaim whose release the fencing guard refused — is exactly
    // what used to surface as a pass reporting `refused` AFTER its `Reclaimed`
    // event was durable. Every unreleased reclaim must now be explicitly owned
    // by a pass that reported the supersession; silence is still a failure.
    const releases = finalEvents.filter((e) => e.type === RunLeaseEvents.Released).map((e) => (e.data as { operationId: string }).operationId)
    const allReclaims = finalEvents.filter((e) => e.type === IsoRecoveryEvents.Reclaimed).map((e) => (e.data as { reclaimOperationId: string }).reclaimOperationId)
    const unreleased = allReclaims.filter((op) => !releases.includes(op))
    const supersededPasses = readLog(w.log).filter((l) => l.event === "recover" && l.results?.some((r) => r.runId === runId && r.action === "reclaimed" && r.releaseSuperseded === true))
    expect(unreleased.length).toBe(supersededPasses.length)
    // A supersession claim needs a superseder: strictly more generations than
    // reclaimed-and-released pairs alone would mint.
    if (unreleased.length > 0) expect(finalAcquires.length).toBeGreaterThan(allReclaims.length - unreleased.length + 1)

    console.log(`[gate] XP-06: pids ${ids.map((i) => `${i.pid}@${i.created}`).join(", ")} vs dead ${dead.pid} - race shape [${passes.map((p) => p.outcome).join(",")}], reclaim tokens ${finalAcquires.join(",")} distinct/increasing, ${allReclaims.length} idempotent reclaim(s), ${unreleased.length} release(s) superseded and owned`)
  }, T)
})

// ─────────────────────── XP-09: two hosts remove one owned tree at once

describe.skipIf(!READY)("MS1 P6 XP-09 - two hosts remove the same owned tree: reported, never thrown", () => {
  test("concurrent removeOwnedDirectoryTree leaves the path gone, reports structurally, and stays idempotent", async () => {
    const w = world("xp09")
    const target = join(w.dir, "owned-run-root")
    mkdirSync(join(target, "nested", "deeper"), { recursive: true })
    writeFileSync(join(target, "a.txt"), "a", "utf8")
    writeFileSync(join(target, "nested", "b.txt"), "b", "utf8")
    writeFileSync(join(target, "nested", "deeper", "c.txt"), "c", "utf8")
    expect(existsSync(target)).toBe(true)

    const spawnRemover = (me: string, peers: number) =>
      Bun.spawn([process.execPath, RECOVERY_CHILD, "--log", w.log, "--gates", w.race, "--me", me, "--role", "remove-tree", "--path", target, "--peers", String(peers)], {
        env: { ...process.env, ABDO_HARNESS_QUEUE: queueDir() },
        stdout: "pipe",
        stderr: "pipe",
      })

    const a = spawnRemover("rma", 3)
    const b = spawnRemover("rmb", 3)
    expect(await waitForFile(join(w.race, "ready.rma"))).toBe(true)
    expect(await waitForFile(join(w.race, "ready.rmb"))).toBe(true)
    const ids = await osIdentities([a.pid, b.pid])
    expect(new Set(ids.map((i) => `${i.pid}@${i.created}`)).size).toBe(2)
    // The tree is still intact while both are parked: neither started early.
    expect(existsSync(target)).toBe(true)
    await barrier(w.race, "go", "parent", 3)
    await expectChildOk(a, w.log)
    await expectChildOk(b, w.log)

    const removals = readLog(w.log).filter((l) => l.event === "remove")
    expect(removals).toHaveLength(2)
    expect(new Set(removals.map((r) => r.pid)).size).toBe(2)
    // NOTHING THREW (both exited 0) and every result is the production shape:
    // a boolean, plus an errno string whenever the removal did not happen.
    for (const r of removals) {
      expect(typeof r.removed).toBe("boolean")
      if (r.removed === false) expect(typeof r.code).toBe("string")
    }
    expect(removals.some((r) => r.removed === true)).toBe(true)

    // ── THE OUTCOME THAT MATTERS: the tree is gone, by Node and by the helper.
    expect(existsSync(target)).toBe(false)
    expect(runDirect(["inspect-dir", "--path", target]).pathExists).toBe(false)

    // ── IDEMPOTENCY, deterministically: a third real process removing the
    //    already-absent path succeeds with no errno.
    const c = spawnRemover("rmc", 0)
    await expectChildOk(c, w.log)
    const third = readLog(w.log).find((l) => l.me === "rmc" && l.event === "remove")!
    expect(third.removed).toBe(true)
    expect(third.code).toBeUndefined()
    expect(existsSync(target)).toBe(false)

    console.log(`[gate] XP-09: pids ${ids.map((i) => `${i.pid}@${i.created}`).join(", ")} - concurrent results [${removals.map((r) => `${r.removed}${r.code ? `:${r.code}` : ""}`).join(", ")}], tree gone, third removal idempotent true`)
  }, T)
})
