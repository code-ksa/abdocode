/**
 * MS1 P6 slice S5 — XP-04, XP-08, XP-10: ZOMBIE, CRASH AND RECOVERY, ACROSS
 * REAL OS PROCESSES MEASURED BY THE REAL HELPER.
 *
 * THE GAP THIS CLOSES. Every existing proof of these behaviors is in-process
 * with a STUBBED helper: the live-owner contradiction is asserted against fake
 * pid 4242 (`isorun-recovery.test.ts:159`), and the zombie refusals (C-32) are
 * exercised by the test process wielding a dead host's folded lease state. What
 * production actually claims is different: that recovery in one process can
 * measure the LIVE identity of another process through `inspect-process`
 * (pid + creation time) and refuse to act on the contradiction; and that a
 * live, superseded process attempting its own renew/release is refused by the
 * fencing guard. Those claims are only measurable with real processes whose
 * leases carry their REAL helper-reported creation identities.
 *
 * WHAT IS ACTUALLY BEING PROVED, per scenario:
 *
 * XP-04 (suspended-analog owner; corrected from the matrix):
 *   1. LAW 3, CROSS-PROCESS: recovery under an advanced clock finds an expired
 *      lease whose owner — a real, alive, identity-matched process — is STILL
 *      RUNNING, and DEFERS (`manual_intervention_required`, one
 *      `recovery_deferred(liveness_unknown)`, NO reclaim lease). The matrix's
 *      claim that recovery "reclaims" here contradicts production and is
 *      corrected: production never reclaims a live owner.
 *   2. Fencing still protects the run without recovery: a second real process
 *      acquires (token 2 — acquire refuses nobody), and the parked zombie's
 *      resumed `renewRunLease` throws `stale_lease_holder` (held 1, current 2).
 *
 * XP-08 (zombie release during the current holder's open mutation window):
 *   The zombie's `releaseRunLease(completed, clean-proof)` is refused by the
 *   guard — "refusing to release the lease" — WHILE the newer holder is alive
 *   inside its granted mutation window; the only `Released` event ever written
 *   is the current holder's own. A stale release marking clean a run a newer
 *   attempt is inside is exactly what the fence exists to stop.
 *
 * XP-10 (renew vs recovery; corrected from the matrix):
 *   Production does not arbitrate this race — it removes it with the
 *   dead-owner proof. Phase 1: with the owner alive and renewing, recovery
 *   defers (same contradiction) and the renewal SUCCEEDS — same generation,
 *   same token, `lease_renewed` lands. The matrix's "recovery lands first →
 *   renew throws" branch cannot occur against a live owner. Phase 2: after
 *   REAL death (taskkill of the recorded identity, death proven by the real
 *   helper against `--expect-start`), recovery reclaims exactly once: a
 *   reclaim lease with the next token owned by the RECOVERY PROCESS, then
 *   `recovery_requested` → `recovery_reclaimed` → `lease_released`.
 *
 * Identities are read from Win32_Process while children are parked at their
 * `ready` gates (concurrently alive by measurement); every wait is a bounded
 * `waitForFile`/deadline poll with an exit condition; the recovery clock is the
 * PRODUCTION `now` parameter ("Injectable so expiry can be tested without
 * waiting"), not a seam invented here.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { IsoRecoveryEvents, recoverIsolatedRuns } from "../src/isorun-recovery"
import { DEFAULT_LEASE_TTL_MS, RunLeaseEvents, runLeaseAggregateId } from "../src/run-lease"
import { waitForFile } from "./barrier"
import { harnessHelperRunner, helperBuilt, queueDir, runUnelevated } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const FIXTURE = join(import.meta.dir, "fixtures", "run-lease-zombie-child.ts")
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const TASKKILL = "C:\\Windows\\System32\\taskkill.exe"
const T = 300_000

/** The production recovery clock: far past every TTL, while real time stands still. */
const advanced = () => Date.now() + DEFAULT_LEASE_TTL_MS * 20

interface OsIdentity {
  pid: number
  name: string
  created: string
}

/** Real OS identities, read while the children are provably parked and alive. */
async function osIdentities(pids: readonly number[], timeoutMs = 60_000): Promise<OsIdentity[]> {
  const filter = pids.map((p) => `ProcessId=${p}`).join(" or ")
  const cmd = `@(Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId, Name, @{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const out = Bun.spawnSync([PS, "-NoProfile", "-NonInteractive", "-Command", cmd], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()
    if (out) {
      const parsed = JSON.parse(out) as unknown
      const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { ProcessId: number; Name: string; Created: string }[]
      if (rows.length === pids.length) return rows.map((r) => ({ pid: r.ProcessId, name: r.Name, created: r.Created }))
    }
    await Bun.sleep(25)
  }
  throw new Error(`could not read OS identities for pids ${pids.join(", ")} within ${timeoutMs}ms`)
}

interface LogLine {
  event: string
  me: string
  pid: number
  operationId?: string
  fencingToken?: number
  ownerStartTime?: string
  outcome?: string
  reasonCode?: string
  heldToken?: number
  currentToken?: number
  message?: string
  renewals?: number
  error?: string
}

function world(tag: string) {
  const dir = mkdtempSync(join(tmpdir(), `abdo-zombie-${tag}-`))
  const db = join(dir, "journal.sqlite")
  new SqliteEventStore(db).close() // the HOST creates the store; children attach (WAL lesson)
  const log = join(dir, "events.jsonl")
  writeFileSync(log, "", "utf8")
  const gates = join(dir, "gates")
  mkdirSync(gates, { recursive: true })
  // Best-effort: a killed child can hold the db open for a moment, and an EBUSY
  // thrown from a `finally` would MASK the assertion that actually failed. The
  // residue census is what guards scratch leaks, not this rm.
  const dispose = () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* reported by the residue census, never allowed to shadow a failure */
    }
  }
  return { dir, db, log, gates, dispose }
}

const readLog = (p: string): LogLine[] =>
  existsSync(p)
    ? readFileSync(p, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LogLine)
    : []

function spawnChild(w: ReturnType<typeof world>, runId: string, me: string, role: string, extra: string[] = []) {
  return Bun.spawn([process.execPath, FIXTURE, "--db", w.db, "--log", w.log, "--gates", w.gates, "--run", runId, "--me", me, "--role", role, ...extra], {
    env: { ...process.env, ABDO_HARNESS_QUEUE: queueDir() },
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function expectChildOk(p: ReturnType<typeof spawnChild>, logPath: string) {
  const code = await p.exited
  if (code !== 0) {
    const errors = readLog(logPath).filter((l) => l.event === "error")
    throw new Error(`child exited ${code}\nlogged: ${JSON.stringify(errors)}\nstderr: ${(await new Response(p.stderr).text()).slice(0, 800)}`)
  }
}

/** Open a parent-controlled gate for one child. */
const open = (w: ReturnType<typeof world>, name: string) => writeFileSync(join(w.gates, name), String(Date.now()), "utf8")

const arrived = async (w: ReturnType<typeof world>, name: string) => {
  expect(await waitForFile(join(w.gates, name))).toBe(true)
}

/** The run journal as it landed on disk, read fresh by a non-participant handle. */
async function journal(db: string, runId: string) {
  const store = new SqliteEventStore(db)
  try {
    return await store.read("project", runLeaseAggregateId(runId))
  } finally {
    store.close()
  }
}

/** One production recovery pass, run by THIS process (a distinct real process). */
async function recoveryPass(db: string) {
  const store = new SqliteEventStore(db)
  try {
    return await recoverIsolatedRuns({ store, helper: harnessHelperRunner(), now: advanced })
  } finally {
    store.close()
  }
}

describe.skipIf(!READY)("MS1 P6 XP-04/XP-08/XP-10 - zombie, crash and recovery across real processes", () => {
  test("XP-04: recovery DEFERS on a live suspended-analog owner; a newer acquisition fences it; its renew is refused", async () => {
    const w = world("xp04")
    const runId = "run_xp04_zombie_adoption"
    try {
      await runUnelevated(["known-folder", "--id", "ProgramData"]) // warm the shared helper server
      const a = spawnChild(w, runId, "a", "sleeper")
      const b = spawnChild(w, runId, "b", "adopter")

      // ── both parked at `ready`; identities read while both provably alive.
      await arrived(w, "ready.a")
      await arrived(w, "ready.b")
      const identities = await osIdentities([a.pid, b.pid])
      expect(new Set(identities.map((i) => `${i.pid}@${i.created}`)).size).toBe(2)

      // ── A acquires with its REAL helper-reported identity, then parks alive
      //    WITHOUT renewing — the exact observable a suspended host presents.
      open(w, "go.a")
      await arrived(w, "acquired.a")
      const aAcq = readLog(w.log).find((l) => l.me === "a" && l.event === "acquired")!
      expect(aAcq.fencingToken).toBe(1)
      expect(aAcq.ownerStartTime).toBeTruthy()

      // ── LAW 3, CROSS-PROCESS: the lease is expired under the recovery clock,
      //    but the owner is a LIVE identity-matched real process — recovery
      //    must refuse to reclaim, and must say why.
      const pass1 = await recoveryPass(w.db)
      expect(pass1).toHaveLength(1)
      expect(pass1[0]!.action).toBe("manual_intervention_required")
      expect(pass1[0]!.liveness).toBe("unknown")
      expect(pass1[0]!.detail).toContain("still running")
      expect(pass1[0]!.detail).toContain(String(a.pid))
      let events = await journal(w.db, runId)
      expect(events.map((e) => e.type)).toEqual([RunLeaseEvents.Acquired, IsoRecoveryEvents.Deferred])
      expect((events[1]!.data as { reasonCode?: string }).reasonCode).toBe("liveness_unknown")

      // ── the newer generation: B acquires (acquire refuses nobody), token 2.
      open(w, "go.b")
      await expectChildOk(b, w.log)
      const bAcq = readLog(w.log).find((l) => l.me === "b" && l.event === "acquired")!
      expect(bAcq.fencingToken).toBe(2)
      expect(bAcq.operationId).not.toBe(aAcq.operationId)

      // ── the zombie wakes and tries to heartbeat: refused by the fence.
      open(w, "resume.a")
      await expectChildOk(a, w.log)
      const renew = readLog(w.log).find((l) => l.me === "a" && l.event === "renew")!
      expect(renew.outcome).toBe("refused")
      expect(renew.reasonCode).toBe("stale_lease_holder")
      expect(renew.heldToken).toBe(1)
      expect(renew.currentToken).toBe(2)
      expect(renew.message).toContain("a newer acquisition")

      // ── the journal: exactly [Acquired(A,1), Deferred, Acquired(B,2)] —
      //    gapless, no Renewed, no Released, no reclaim of any kind.
      events = await journal(w.db, runId)
      expect(events.map((e) => Number(e.sequence))).toEqual(events.map((_, i) => i))
      expect(events.map((e) => e.type)).toEqual([RunLeaseEvents.Acquired, IsoRecoveryEvents.Deferred, RunLeaseEvents.Acquired])
      const acq = events.filter((e) => e.type === RunLeaseEvents.Acquired).map((e) => e.data as { fencingToken: number; ownerPid: number; operationId: string })
      expect(acq.map((d) => d.fencingToken)).toEqual([1, 2])
      expect(acq.map((d) => d.ownerPid)).toEqual([a.pid, b.pid])
      expect([aAcq.pid, bAcq.pid].sort((x, y) => x - y)).toEqual(identities.map((i) => i.pid).sort((x, y) => x - y))

      console.log(`[gate] XP-04: pids ${identities.map((i) => `${i.pid}@${i.created}`).join(", ")} - recovery deferred on the LIVE owner (liveness_unknown), adoption fenced it (tokens 1,2), zombie renew refused stale_lease_holder 1->2`)
    } finally {
      w.dispose()
    }
  }, T)

  test("XP-08: a live zombie's releaseRunLease is refused DURING the current holder's open mutation window", async () => {
    const w = world("xp08")
    const runId = "run_xp08_zombie_release"
    try {
      await runUnelevated(["known-folder", "--id", "ProgramData"])
      const a = spawnChild(w, runId, "a", "releaser")
      const b = spawnChild(w, runId, "b", "mutator")

      await arrived(w, "ready.a")
      await arrived(w, "ready.b")
      const identities = await osIdentities([a.pid, b.pid])
      expect(new Set(identities.map((i) => `${i.pid}@${i.created}`)).size).toBe(2)

      // ── deterministic generations: A holds token 1, then B takes token 2.
      open(w, "go.a")
      await arrived(w, "acquired.a")
      open(w, "go.b")
      await arrived(w, "acquired.b")
      const aAcq = readLog(w.log).find((l) => l.me === "a" && l.event === "acquired")!
      const bAcq = readLog(w.log).find((l) => l.me === "b" && l.event === "acquired")!
      expect(aAcq.fencingToken).toBe(1)
      expect(bAcq.fencingToken).toBe(2)

      // ── B enters and HOLDS its mutation window: granted, alive, parked.
      open(w, "mutate.b")
      await arrived(w, "mutated.b")
      expect(readLog(w.log).find((l) => l.me === "b" && l.event === "mutate")!.outcome).toBe("granted")
      expect((await osIdentities([b.pid]))[0]!.pid).toBe(b.pid) // the window is open and its holder is alive

      // ── the zombie attempts to mark the run clean UNDER the live holder.
      open(w, "resume.a")
      await expectChildOk(a, w.log)
      const rel = readLog(w.log).find((l) => l.me === "a" && l.event === "release")!
      expect(rel.outcome).toBe("refused")
      expect(rel.reasonCode).toBe("stale_lease_holder")
      expect(rel.heldToken).toBe(1)
      expect(rel.currentToken).toBe(2)
      expect(rel.message).toContain("refusing to release the lease")
      // B is STILL alive and current after the refused stale release.
      expect((await osIdentities([b.pid]))[0]!.pid).toBe(b.pid)

      // ── the current holder finishes and releases ITS OWN lease: granted.
      open(w, "finish.b")
      await expectChildOk(b, w.log)
      const bRel = readLog(w.log).filter((l) => l.me === "b" && l.event === "release")
      expect(bRel).toHaveLength(1)
      expect(bRel[0]!.outcome).toBe("granted")

      // ── the journal: [Acquired(1), Acquired(2), Released(B)] — the ONLY
      //    Released is the current holder's; the zombie's refusal wrote nothing.
      const events = await journal(w.db, runId)
      expect(events.map((e) => Number(e.sequence))).toEqual(events.map((_, i) => i))
      expect(events.map((e) => e.type)).toEqual([RunLeaseEvents.Acquired, RunLeaseEvents.Acquired, RunLeaseEvents.Released])
      const released = events[2]!.data as { operationId: string; fencingToken: number; reason: string; ownerPid: number }
      expect(released.operationId).toBe(bAcq.operationId!)
      expect(released.fencingToken).toBe(2)
      expect(released.reason).toBe("completed")
      expect(released.ownerPid).toBe(b.pid)

      console.log(`[gate] XP-08: pids ${identities.map((i) => `${i.pid}@${i.created}`).join(", ")} - zombie release refused stale_lease_holder 1->2 inside the live holder's open window; exactly one Released (holder's own)`)
    } finally {
      w.dispose()
    }
  }, T)

  test("XP-10: recovery defers while the renewing owner LIVES (renew succeeds); after REAL death it reclaims exactly once", async () => {
    const w = world("xp10")
    const runId = "run_xp10_renew_vs_recovery"
    try {
      await runUnelevated(["known-folder", "--id", "ProgramData"])
      const a = spawnChild(w, runId, "a", "sleeper", ["--after-renew", "park"])

      await arrived(w, "ready.a")
      // The identity is recorded WHILE ALIVE — the scenario requires death
      // later, and this is the record termination is checked against.
      const [aId] = await osIdentities([a.pid])
      expect(aId!.pid).toBe(a.pid)

      open(w, "go.a")
      await arrived(w, "acquired.a")
      const aAcq = readLog(w.log).find((l) => l.event === "acquired")!
      expect(aAcq.fencingToken).toBe(1)
      const ownerStartTime = aAcq.ownerStartTime!

      // ── phase 1: recovery under the advanced clock vs a LIVE owner — defer.
      const pass1 = await recoveryPass(w.db)
      expect(pass1).toHaveLength(1)
      expect(pass1[0]!.action).toBe("manual_intervention_required")
      expect(pass1[0]!.detail).toContain("still running")

      // ── and the live generation simply continues: the renewal is GRANTED.
      //    (The matrix's "recovery lands first → renew throws" branch cannot
      //    happen: production never reclaims from a live owner.)
      open(w, "resume.a")
      await arrived(w, "renewed.a")
      const renew = readLog(w.log).find((l) => l.event === "renew")!
      expect(renew.outcome).toBe("granted")
      expect(renew.fencingToken).toBe(1)
      expect(renew.renewals).toBe(1)
      let events = await journal(w.db, runId)
      expect(events.map((e) => e.type)).toEqual([RunLeaseEvents.Acquired, IsoRecoveryEvents.Deferred, RunLeaseEvents.Renewed])

      // ── phase 2: REAL death. The parent kills the recorded identity, then
      //    proves the death through the REAL helper against --expect-start.
      const killed = Bun.spawnSync([TASKKILL, "/F", "/PID", String(a.pid)], { stdout: "pipe", stderr: "pipe" })
      expect(killed.exitCode).toBe(0)
      const exitCode = await a.exited
      expect(exitCode).not.toBe(0) // killed, not a clean exit
      const helper = harnessHelperRunner()
      const deadline = Date.now() + 60_000
      let dead = false
      while (Date.now() < deadline) {
        const probe = await helper({ argv: ["inspect-process", "--pid", String(a.pid), "--expect-start", ownerStartTime] })
        if (probe.alive !== true) {
          dead = true
          break
        }
        await Bun.sleep(50)
      }
      expect(dead).toBe(true)

      // ── now, and only now, recovery reclaims — exactly once, as its own
      //    operation with the next fencing token, owned by THIS process.
      const pass2 = await recoveryPass(w.db)
      expect(pass2).toHaveLength(1)
      expect(pass2[0]!.action).toBe("reclaimed")
      expect(pass2[0]!.liveness).toBe("reclaimable")
      expect(pass2[0]!.detail).toBe("restored 0 descriptor(s)")

      events = await journal(w.db, runId)
      expect(events.map((e) => Number(e.sequence))).toEqual(events.map((_, i) => i))
      expect(events.map((e) => e.type)).toEqual([
        RunLeaseEvents.Acquired,
        IsoRecoveryEvents.Deferred,
        RunLeaseEvents.Renewed,
        RunLeaseEvents.Acquired,
        IsoRecoveryEvents.Requested,
        IsoRecoveryEvents.Reclaimed,
        RunLeaseEvents.Released,
      ])
      const reclaim = events[3]!.data as { fencingToken: number; ownerPid: number; operationId: string; ownerStartTime: string }
      expect(reclaim.fencingToken).toBe(2)
      expect(reclaim.ownerPid).toBe(process.pid) // the recovery actor, a distinct real process
      expect(reclaim.ownerPid).not.toBe(a.pid)
      expect(reclaim.operationId).not.toBe(aAcq.operationId)
      expect(reclaim.ownerStartTime.startsWith("recovery-")).toBe(true)
      expect((events[4]!.data as { reclaimFencingToken?: number }).reclaimFencingToken).toBe(2)
      expect(events.filter((e) => e.type === IsoRecoveryEvents.Reclaimed)).toHaveLength(1)
      const released = events[6]!.data as { operationId: string; reason: string }
      expect(released.operationId).toBe(reclaim.operationId)
      expect(released.reason).toBe("completed")

      console.log(`[gate] XP-10: pid ${aId!.pid}@${aId!.created} - recovery deferred while alive (renew granted, token 1), real kill proven via --expect-start, then reclaimed exactly once (reclaim token 2 owned by pid ${process.pid})`)
    } finally {
      w.dispose()
    }
  }, T)
})
