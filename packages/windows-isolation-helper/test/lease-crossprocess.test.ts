/**
 * CL-16A2-D-L — cross-process lease and refcount proof.
 *
 * The one Outcome A criterion CL-16A2-D-R could not tick. The ledger was only
 * ever exercised inside ONE process over a `MemoryEventStore`, where
 * `expectedSequence` is arbitrated by a JavaScript event loop that cannot
 * interleave two appends anyway. The safety claim, though, rests on SQLite's
 * `BEGIN IMMEDIATE` write lock serialising real concurrent writers — so it had
 * never actually been tested.
 *
 * RULES OBSERVED HERE (§2, §3, §4 of the brief):
 *   - no `MemoryEventStore` anywhere in this file;
 *   - every participant is a separate OS process over ONE SQLite file;
 *   - interleaving is forced by BARRIERS, never by a sleep, so the contention
 *     is real on every run rather than on lucky ones.
 *
 * The lease exists for the SHARED-SID case: two runs that add the SAME ACE,
 * where whichever finishes first would otherwise revoke access from the other.
 * These tests construct that case directly — one profile, one SID, two runs —
 * because with the per-run profile names the lifecycle normally uses it cannot
 * arise, and a guard that is never exercised is not a guard.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { leaseAggregateId, leaseKey } from "../src/journal"
import { leaseHolders, releaseLease } from "../src/leases"
import { OWNERSHIP_PREFIX, helperBuilt, queueDir, runDirect, runUnelevated } from "./harness"
import { waitForFile } from "./barrier"

const READY = process.platform === "win32" && helperBuilt()
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const WORKER = join(import.meta.dir, "fixtures", "lease-worker.ts")
const T = 300_000

interface LogLine {
  event: string
  pid: number
  runId: string
  stateEpoch: number
  resourceIdentity: string
  leaseId?: string
  mustGrant?: boolean
  mustRevoke?: boolean
  wasHolder?: boolean
  holders?: number
  outcome?: string
  op?: string
  expectedSequence?: number
  observedSequence?: number
  ok?: boolean
  [k: string]: unknown
}

/** One scratch world per test: db, barrier dir, log. */
function world(tag: string) {
  const dir = mkdtempSync(join(tmpdir(), `abdo-lease-${tag}-`))
  const db = join(dir, "journal.sqlite")
  // CREATE THE DATABASE HERE, ONCE, BEFORE ANY WORKER OPENS IT.
  //
  // Three processes calling `new SqliteEventStore(path)` on a file that does not
  // exist yet all race to run `PRAGMA journal_mode = WAL` and the DDL, and the
  // WAL conversion needs a brief exclusive lock. Standalone that race was won
  // 20/20 times; under full-suite CPU load a worker lost it and exited 1, and
  // its two peers then sat at the barrier for the full 120s. The store is a
  // HOST-owned resource, so the host initialises it and the workers attach to
  // something that already exists — which is also how it is used in production.
  new SqliteEventStore(db).close()
  return {
    dir,
    db,
    barrier: join(dir, "barrier"),
    log: join(dir, "events.jsonl"),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Fail LOUDLY with the worker's own words, instead of just a non-zero code. */
async function expectWorkerOk(p: ReturnType<typeof spawnWorker>, logPath: string) {
  const code = await p.exited
  if (code !== 0) {
    const err = (await new Response(p.stderr).text()).slice(0, 800)
    const errors = readLog(logPath).filter((l) => l.event === "error")
    throw new Error(`worker exited ${code}\nlogged: ${JSON.stringify(errors)}\nstderr: ${err}`)
  }
}

const readLog = (p: string): LogLine[] =>
  existsSync(p)
    ? readFileSync(p, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LogLine)
    : []

interface WorkerOpts {
  db: string
  run: string
  identity: string
  sid: string
  barrier: string
  peers: number
  log: string
  mode?: string
  path?: string
  orig?: string
  dieAt?: string
  marker?: string
  rights?: string
  epoch?: number
  collide?: boolean
}

function spawnWorker(o: WorkerOpts) {
  const argv = [
    process.execPath, WORKER,
    "--db", o.db, "--run", o.run, "--identity", o.identity, "--sid", o.sid,
    "--barrier", o.barrier, "--peers", String(o.peers), "--log", o.log,
    "--mode", o.mode ?? "acquire-release", "--rights", o.rights ?? "rx", "--epoch", String(o.epoch ?? 0),
    ...(o.path ? ["--path", o.path] : []),
    ...(o.orig ? ["--orig", o.orig] : []),
    ...(o.dieAt ? ["--die-at", o.dieAt] : []),
    ...(o.marker ? ["--marker", o.marker] : []),
    ...(o.collide ? ["--collide"] : []),
  ]
  return Bun.spawn(argv, { env: { ...process.env, ABDO_HARNESS_QUEUE: queueDir() }, stdout: "pipe", stderr: "pipe" })
}

const hardKill = (pid: number) => Bun.spawnSync(["C:\\Windows\\System32\\taskkill.exe", "/PID", String(pid), "/F", "/T"], { stdout: "ignore", stderr: "ignore" })
const processGone = (pid: number) =>
  Bun.spawnSync([PS, "-NoProfile", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'ALIVE' } else { 'GONE' }`], { stdout: "pipe", stderr: "pipe" })
    .stdout.toString().trim() === "GONE"

/** A real AppContainer profile, so the SID and the ACL below are real. */
function makeProfile(tag: string) {
  const name = `${OWNERSHIP_PREFIX}${tag}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 64)
  const sid = String(runDirect(["ensure-profile", "--name", name]).sid)
  return { name, sid, dispose: () => runDirect(["delete-profile", "--name", name]) }
}
const sddlOf = (p: string) => String(runDirect(["inspect-acl", "--path", p]).sddl ?? "")
const identityOf = (p: string) => String(runDirect(["inspect-acl", "--path", p]).fileIdentity ?? "")

// ───────────────────────────────────────── the ledger under real contention

describe.skipIf(!READY)("CL-16A2-D-L - two and three processes on one SQLite file", () => {
  test("same resource + same SID: EXACTLY ONE process grants, EXACTLY ONE revokes", async () => {
    const w = world("same")
    try {
      const a = spawnWorker({ db: w.db, run: "runA", identity: "vol1:file1", sid: "S-1-15-2-shared", barrier: w.barrier, peers: 2, log: w.log })
      const b = spawnWorker({ db: w.db, run: "runB", identity: "vol1:file1", sid: "S-1-15-2-shared", barrier: w.barrier, peers: 2, log: w.log })
      await expectWorkerOk(a, w.log)
      await expectWorkerOk(b, w.log)

      const lines = readLog(w.log)
      const acquired = lines.filter((l) => l.event === "acquired")
      const released = lines.filter((l) => l.event === "released")
      expect(acquired).toHaveLength(2)
      expect(released).toHaveLength(2)
      // EXACTLY-ONCE, the whole point.
      expect(acquired.filter((l) => l.mustGrant === true)).toHaveLength(1)
      expect(released.filter((l) => l.mustRevoke === true)).toHaveLength(1)
      // Two DIFFERENT processes really did the work.
      expect(new Set(acquired.map((l) => l.pid)).size).toBe(2)
      // Both agree on one lease identity.
      expect(new Set(acquired.map((l) => l.leaseId)).size).toBe(1)

      // The ledger, re-read from disk, is empty of holders.
      const store = new SqliteEventStore(w.db)
      try {
        expect(await leaseHolders(store, leaseKey("vol1:file1", "S-1-15-2-shared", "rx"))).toEqual([])
      } finally {
        store.close()
      }
    } finally {
      w.dispose()
    }
  }, T)

  test("same resource, DIFFERENT SIDs: two independent leases, each grants", async () => {
    const w = world("diffsid")
    try {
      const a = spawnWorker({ db: w.db, run: "runA", identity: "vol1:file1", sid: "S-1-15-2-alpha", barrier: w.barrier, peers: 2, log: w.log })
      const b = spawnWorker({ db: w.db, run: "runB", identity: "vol1:file1", sid: "S-1-15-2-beta", barrier: w.barrier, peers: 2, log: w.log })
      await expectWorkerOk(a, w.log)
      await expectWorkerOk(b, w.log)
      const acquired = readLog(w.log).filter((l) => l.event === "acquired")
      // Different SIDs mean different ACEs, so neither depends on the other.
      expect(acquired.filter((l) => l.mustGrant === true)).toHaveLength(2)
      expect(new Set(acquired.map((l) => l.leaseId)).size).toBe(2)
    } finally {
      w.dispose()
    }
  }, T)

  test("THREE processes collide on expectedSequence, and the conflicts are visible", async () => {
    const w = world("collide")
    try {
      const ids = ["runA", "runB", "runC"]
      // --collide puts a barrier BETWEEN the read and the append, so the
      // conflict below is guaranteed rather than probable.
      const procs = ids.map((id) => spawnWorker({ db: w.db, run: id, identity: "vol9:file9", sid: "S-1-15-2-three", barrier: w.barrier, peers: 3, log: w.log, collide: true }))
      for (const p of procs) await expectWorkerOk(p, w.log)

      const lines = readLog(w.log)
      const acquired = lines.filter((l) => l.event === "acquired")
      expect(acquired).toHaveLength(3)
      expect(acquired.filter((l) => l.mustGrant === true)).toHaveLength(1)
      expect(lines.filter((l) => l.event === "released" && l.mustRevoke === true)).toHaveLength(1)

      // A CONFLICT MUST ACTUALLY HAVE HAPPENED. Three writers released from a
      // barrier onto one aggregate cannot all win the first append; if none of
      // them recorded a conflict, the barrier is not forcing contention and
      // this test would be proving nothing.
      // DETERMINISTIC: all three read the same sequence before any of them
      // wrote, so exactly one append won and the other two MUST have conflicted.
      const conflicts = lines.filter((l) => l.event === "lease_attempt" && l.outcome === "conflict")
      expect(conflicts.length).toBeGreaterThanOrEqual(2)
      for (const c of conflicts) {
        // The loser expected a sequence that the winner had already taken.
        expect(typeof c.expectedSequence).toBe("number")
        expect(typeof c.observedSequence).toBe("number")
        expect(c.observedSequence!).toBeGreaterThanOrEqual(c.expectedSequence! - 1)
      }
      console.log(`[gate] lease collisions: ${conflicts.length} conflict(s) across ${new Set(lines.map((l) => l.pid)).size} processes`)

      // RETRY AFTER CONFLICT IS NOT A SECOND LOGICAL ACQUISITION.
      const store = new SqliteEventStore(w.db)
      try {
        const events = await store.read("project", leaseAggregateId(leaseKey("vol9:file9", "S-1-15-2-three", "rx")))
        const acquires = events.filter((e) => e.type === "appcontainer.lease_acquired")
        expect(acquires).toHaveLength(3) // one per run, never more
        expect(new Set(acquires.map((e) => (e.data as { runId: string }).runId)).size).toBe(3)
        // Gapless sequences: SQLite arbitrated, nothing was lost or duplicated.
        // `Number(...)` drops the `EventSequence` brand so both sides are plain
        // numbers — a runtime no-op, and it needs no type assertion to say it.
        expect(events.map((e) => Number(e.sequence))).toEqual(events.map((_, i) => i))
        expect(await leaseHolders(store, leaseKey("vol9:file9", "S-1-15-2-three", "rx"))).toEqual([])
      } finally {
        store.close()
      }
    } finally {
      w.dispose()
    }
  }, T)

  test("a duplicate release is idempotent and never revokes twice", async () => {
    const w = world("dup")
    try {
      const a = spawnWorker({ db: w.db, run: "runA", identity: "vol2:file2", sid: "S-1-15-2-dup", barrier: w.barrier, peers: 1, log: w.log, mode: "double-release" })
      await expectWorkerOk(a, w.log)
      const d = readLog(w.log).find((l) => l.event === "double_release")!
      expect(d.firstMustRevoke).toBe(true)
      expect(d.secondMustRevoke).toBe(false) // the grant is already gone
      const store = new SqliteEventStore(w.db)
      try {
        const events = await store.read("project", leaseAggregateId(leaseKey("vol2:file2", "S-1-15-2-dup", "rx")))
        expect(events.filter((e) => e.type === "appcontainer.lease_released")).toHaveLength(1)
      } finally {
        store.close()
      }
    } finally {
      w.dispose()
    }
  }, T)

  test("a lease is NOT shared between resource identities that merely LOOK alike", async () => {
    const w = world("similar")
    try {
      // Textually adjacent, genuinely different objects.
      const a = spawnWorker({ db: w.db, run: "runA", identity: "vol1:file11", sid: "S-1-15-2-same", barrier: w.barrier, peers: 2, log: w.log })
      const b = spawnWorker({ db: w.db, run: "runB", identity: "vol1:file1", sid: "S-1-15-2-same", barrier: w.barrier, peers: 2, log: w.log })
      await expectWorkerOk(a, w.log)
      await expectWorkerOk(b, w.log)
      const acquired = readLog(w.log).filter((l) => l.event === "acquired")
      expect(acquired.filter((l) => l.mustGrant === true)).toHaveLength(2) // two separate leases
      expect(new Set(acquired.map((l) => l.leaseId)).size).toBe(2)
    } finally {
      w.dispose()
    }
  }, T)
})

// ───────────────────────────── the real ACL, held by two real processes

describe.skipIf(!READY)("CL-16A2-D-L - no premature ACL removal, on a real DACL", () => {
  // The workers ADOPT this process's de-elevated helper server rather than
  // starting their own, because a worker that is about to be killed could never
  // shut one down. Adoption requires the server to already exist, so it is
  // started here once, deliberately, instead of being an accident of whichever
  // test happened to run first.
  beforeAll(async () => {
    await runUnelevated(["run", "--name", `${OWNERSHIP_PREFIX}leasewarm-${process.pid}`, "--timeout-ms", "15000", "--", "C:\\Windows\\System32\\cmd.exe", "/c", "echo", "warm"])
    runDirect(["delete-profile", "--name", `${OWNERSHIP_PREFIX}leasewarm-${process.pid}`])
  })

  test("the first run finishing does NOT revoke the ACE the second still depends on", async () => {
    const w = world("acl")
    const scratch = mkdtempSync(join(tmpdir(), "abdo-lacl-"))
    writeFileSync(join(scratch, "f.txt"), "x", "utf8")
    const prof = makeProfile("lacl")
    const before = sddlOf(scratch)
    const identity = identityOf(scratch)
    try {
      // HOLDER stays in the lease across the peer's whole lifetime.
      const holder = spawnWorker({ db: w.db, run: "runHold", identity, sid: prof.sid, barrier: w.barrier, peers: 2, log: w.log, mode: "acquire-hold", path: scratch, orig: before })
      const leaver = spawnWorker({ db: w.db, run: "runLeave", identity, sid: prof.sid, barrier: w.barrier, peers: 2, log: w.log, mode: "acquire-hold", path: scratch, orig: before })
      await expectWorkerOk(holder, w.log)
      await expectWorkerOk(leaver, w.log)

      const lines = readLog(w.log)
      const acquired = lines.filter((l) => l.event === "acquired")
      const released = lines.filter((l) => l.event === "released")
      expect(acquired.filter((l) => l.mustGrant === true)).toHaveLength(1)
      // NON-VACUITY: the ACE was really applied by whoever the ledger elected.
      expect(lines.filter((l) => l.event === "granted" && l.ok === true)).toHaveLength(1)

      // Exactly one revoke, and it is the LAST one out.
      expect(released.filter((l) => l.mustRevoke === true)).toHaveLength(1)
      const revoked = lines.filter((l) => l.event === "revoked")
      expect(revoked).toHaveLength(1)

      // Ordering is the claim: the release that did NOT revoke happened before
      // the one that did, so for a real interval the ACE survived a holder
      // finishing.
      const nonRevoking = released.find((l) => l.mustRevoke === false)!
      const revoking = released.find((l) => l.mustRevoke === true)!
      expect(nonRevoking.at as number).toBeLessThanOrEqual(revoking.at as number)

      // And the world is back exactly as it started.
      expect(sddlOf(scratch)).toBe(before)
    } finally {
      prof.dispose()
      rmSync(scratch, { recursive: true, force: true })
      w.dispose()
    }
  }, T)

  test("a process KILLED after acquiring keeps its refcount, and the ACE stays", async () => {
    // The dangerous direction: if a dead holder silently vanished from the
    // ledger, the surviving run's access would be revoked underneath it.
    const w = world("killacq")
    const scratch = mkdtempSync(join(tmpdir(), "abdo-lkill-"))
    writeFileSync(join(scratch, "f.txt"), "x", "utf8")
    const prof = makeProfile("lkill")
    const before = sddlOf(scratch)
    const identity = identityOf(scratch)
    const marker = join(w.dir, "parked.marker")
    try {
      const dying = spawnWorker({ db: w.db, run: "runDies", identity, sid: prof.sid, barrier: w.barrier, peers: 1, log: w.log, path: scratch, orig: before, dieAt: "acquired", marker })
      expect(await waitForFile(marker)).toBe(true)
      hardKill(dying.pid)
      await Bun.sleep(300)
      expect(processGone(dying.pid)).toBe(true)

      // The ACE really is on disk, and the ledger still counts the dead run.
      expect(sddlOf(scratch)).not.toBe(before)
      const store = new SqliteEventStore(w.db)
      try {
        const holders = await leaseHolders(store, leaseKey(identity, prof.sid, "rx"))
        expect(holders).toEqual(["runDies"])

        // A THIRD process rebuilds the refcount from SQLite alone and releases
        // on the dead run's behalf; only then may the ACE go.
        const rel = await releaseLease(store, leaseKey(identity, prof.sid, "rx"), "runDies")
        expect(rel.mustRevoke).toBe(true)
        expect(await leaseHolders(store, leaseKey(identity, prof.sid, "rx"))).toEqual([])
      } finally {
        store.close()
      }
      await runUnelevated(["restore-acl", "--path", scratch, "--sid", prof.sid, "--expect-granted-sddl", "", "--original-sddl", before])
      expect(sddlOf(scratch)).toBe(before)
    } finally {
      prof.dispose()
      rmSync(scratch, { recursive: true, force: true })
      w.dispose()
    }
  }, T)

  test("a process KILLED after its release landed leaves an ACE a later pass still removes", async () => {
    // The other half: the ledger says nobody holds it, but the ACE is still
    // there because the process died between the two. Recovery must be able to
    // tell, and "no holders" is exactly the signal `releaseLease` reports as
    // `mustRevoke` for a non-holder.
    const w = world("killrel")
    const scratch = mkdtempSync(join(tmpdir(), "abdo-lrel-"))
    writeFileSync(join(scratch, "f.txt"), "x", "utf8")
    const prof = makeProfile("lrel")
    const before = sddlOf(scratch)
    const identity = identityOf(scratch)
    const marker = join(w.dir, "parked.marker")
    try {
      const dying = spawnWorker({ db: w.db, run: "runRel", identity, sid: prof.sid, barrier: w.barrier, peers: 1, log: w.log, path: scratch, orig: before, dieAt: "released", marker })
      expect(await waitForFile(marker)).toBe(true)
      hardKill(dying.pid)
      await Bun.sleep(300)
      expect(processGone(dying.pid)).toBe(true)

      // Released in the ledger, still granted on disk: the exact orphan.
      expect(sddlOf(scratch)).not.toBe(before)
      const store = new SqliteEventStore(w.db)
      try {
        expect(await leaseHolders(store, leaseKey(identity, prof.sid, "rx"))).toEqual([])
        // A later pass asks again. It is told it is not a holder and - because
        // this run's release DID land - that it is not the one to revoke; the
        // duplicate is idempotent.
        const rel = await releaseLease(store, leaseKey(identity, prof.sid, "rx"), "runRel")
        expect(rel.wasHolder).toBe(false)
        expect(rel.mustRevoke).toBe(false)
        // THE ORPHAN IS STILL RECLAIMED, and this is the assertion that matters:
        // cleanup does not consult `mustRevoke` to decide whether to restore. It
        // skips the restore only when OTHER HOLDERS exist, so "nobody holds it"
        // sends a released-then-died run down the normal restore path.
        expect(rel.holders).toHaveLength(0)
      } finally {
        store.close()
      }
      await runUnelevated(["restore-acl", "--path", scratch, "--sid", prof.sid, "--expect-granted-sddl", "", "--original-sddl", before])
      expect(sddlOf(scratch)).toBe(before)
    } finally {
      prof.dispose()
      rmSync(scratch, { recursive: true, force: true })
      w.dispose()
    }
  }, T)

  test("a live holder's ACE is never removed by a peer, and its profile is never deleted", async () => {
    const w = world("liveace")
    const scratch = mkdtempSync(join(tmpdir(), "abdo-llive-"))
    writeFileSync(join(scratch, "f.txt"), "x", "utf8")
    const prof = makeProfile("llive")
    const before = sddlOf(scratch)
    const identity = identityOf(scratch)
    const marker = join(w.dir, "parked.marker")
    try {
      const holder = spawnWorker({ db: w.db, run: "runLive", identity, sid: prof.sid, barrier: w.barrier, peers: 1, log: w.log, path: scratch, orig: before, dieAt: "acquired", marker })
      expect(await waitForFile(marker)).toBe(true) // it is holding, and parked

      // A peer asks whether IT may revoke. It must be told no.
      const store = new SqliteEventStore(w.db)
      try {
        const peer = await releaseLease(store, leaseKey(identity, prof.sid, "rx"), "someOtherRun")
        expect(peer.wasHolder).toBe(false)
        expect(peer.mustRevoke).toBe(false) // runLive still holds it
      } finally {
        store.close()
      }
      // The ACE is untouched and the profile still exists.
      expect(sddlOf(scratch)).not.toBe(before)
      expect(String(runDirect(["inspect-profile", "--name", prof.name]).profileExists)).toBe("true")

      hardKill(holder.pid)
      await Bun.sleep(300)
      await runUnelevated(["restore-acl", "--path", scratch, "--sid", prof.sid, "--expect-granted-sddl", "", "--original-sddl", before])
    } finally {
      prof.dispose()
      rmSync(scratch, { recursive: true, force: true })
      w.dispose()
    }
  }, T)
})
