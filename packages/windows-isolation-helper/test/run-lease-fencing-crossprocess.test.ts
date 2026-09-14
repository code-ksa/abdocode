/**
 * MS1 P6 slice S1 — XP-03: THE FENCING GUARD, ACROSS REAL OS PROCESSES.
 *
 * THE GAP THIS CLOSES. `assertMayMutate` is the single guard every OS mutation
 * in the run lifecycle routes through, and it is the reason a paused-then-woken
 * host cannot delete resources that recovery has already handed to a newer
 * attempt. Until this file, that guard was asserted ONLY in-process
 * (`isorun-crash.test.ts:302`, `isorun-recovery.test.ts:470`), where one event
 * loop arbitrates every interleaving and two holders can never truly overlap.
 * The production claim is about separate processes over one SQLite file, and
 * that had never been measured.
 *
 * WHAT IS ACTUALLY BEING PROVED, stated precisely so the assertions can be
 * checked against it:
 *
 *   1. Two hosts racing `acquireRunLease` on ONE runId BOTH acquire. There is no
 *      refusal at acquire time and there is not meant to be — `run-lease.ts` says
 *      so in its own header. What the CAS guarantees is that their tokens are
 *      DISTINCT and strictly increasing, never duplicated.
 *   2. The winner/loser is decided one step later, by `assertMayMutate`: exactly
 *      one holder — the highest token — may mutate; every other holder is refused
 *      with `StaleLeaseHolder`.
 *
 * These tests are DETERMINISTIC WITHOUT ANY TIMING ASSUMPTION. The outcome is
 * decided by the token relation SQLite established, not by who happened to run
 * first, so there is nothing here to make flaky. Interleaving is forced by
 * barriers (`test/barrier.ts`), never by a sleep — a sleep-forced race passes for
 * timing reasons and fails for timing reasons and tells you nothing either way.
 *
 * NO HELPER BINARY, NO ELEVATION, NO NEW DEPENDENCY. This file runs at medium
 * integrity exactly as the qualified configuration does, and it is therefore
 * unconditional: it must never appear in the Gate 8 expected-skip allowlist.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RunLeaseEvents, runLeaseAggregateId } from "../src/run-lease"
import { barrier } from "./barrier"

const CHILD = join(import.meta.dir, "fixtures", "run-lease-race-child.ts")
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const T = 180_000

interface LogLine {
  event: string
  me: string
  pid: number
  operationId?: string
  fencingToken?: number
  acquiredAt?: number
  mutateStartedAt?: number
  outcome?: string
  reasonCode?: string
  heldToken?: number
  currentToken?: number
  message?: string
  error?: string
}

/** One scratch world per test: db, barrier dir, log. */
function world(tag: string) {
  const dir = mkdtempSync(join(tmpdir(), `abdo-fence-${tag}-`))
  const db = join(dir, "journal.sqlite")
  // THE STORE IS A HOST-OWNED RESOURCE, created here once before any child opens
  // it. Several processes calling `new SqliteEventStore(path)` on a file that
  // does not exist yet all race the `PRAGMA journal_mode = WAL` conversion, which
  // needs a brief exclusive lock; a loser exits non-zero and its peers then sit
  // at the barrier until it times out. This is the same lesson already recorded
  // in `lease-crossprocess.test.ts`, and it is also how production uses it.
  new SqliteEventStore(db).close()
  return {
    dir,
    db,
    barrier: join(dir, "barrier"),
    log: join(dir, "events.jsonl"),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const readLog = (p: string): LogLine[] =>
  existsSync(p)
    ? readFileSync(p, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LogLine)
    : []

function spawnChild(o: { db: string; run: string; me: string; barrier: string; peers: number; startPeers: number; log: string; op?: string }) {
  return Bun.spawn(
    [
      process.execPath, CHILD,
      "--db", o.db, "--run", o.run, "--me", o.me,
      "--barrier", o.barrier, "--peers", String(o.peers), "--start-peers", String(o.startPeers),
      "--log", o.log,
      // XP-12 only: force the deliberate duplicate. Absent → the child mints its
      // own fresh operationId, exactly as before.
      ...(o.op ? ["--op", o.op] : []),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
}

/** Fail with the child's own words rather than just a number. */
async function expectChildOk(p: ReturnType<typeof spawnChild>, logPath: string) {
  const code = await p.exited
  if (code !== 0) {
    const err = (await new Response(p.stderr).text()).slice(0, 800)
    const errors = readLog(logPath).filter((l) => l.event === "error")
    throw new Error(`child exited ${code}\nlogged: ${JSON.stringify(errors)}\nstderr: ${err}`)
  }
}

interface OsIdentity {
  pid: number
  name: string
  created: string
}

/**
 * The REAL OS identity of each child, read from Windows while they are provably
 * still alive — they are parked at the "start" barrier waiting for this parent
 * to arrive, so this is not a race against a process that may already have exited.
 *
 * A pid alone is not an identity (Windows reuses them); the creation time is what
 * makes "these were two different processes" a fact rather than an inference.
 */
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

/**
 * Run `n` children against one runId, gated so the parent can measure them, and
 * return everything needed to assert on the outcome.
 */
async function race(w: ReturnType<typeof world>, runId: string, n: number, op?: string) {
  const labels = Array.from({ length: n }, (_, i) => `host${String.fromCharCode(65 + i)}`)
  const procs = labels.map((me) => spawnChild({ db: w.db, run: runId, me, barrier: w.barrier, peers: n, startPeers: n + 1, log: w.log, ...(op ? { op } : {}) }))
  const identities = await osIdentities(procs.map((p) => p.pid))
  // The parent is the (n+1)th participant. Only now may the children proceed.
  await barrier(w.barrier, "start", "parent", n + 1)
  for (const p of procs) await expectChildOk(p, w.log)

  const lines = readLog(w.log)
  const acquired = lines.filter((l) => l.event === "acquired")
  const mutate = lines.filter((l) => l.event === "mutate")
  return { labels, procs, identities, lines, acquired, mutate }
}

/** The lease events as they really landed on disk, re-read by a fresh reader. */
async function journal(db: string, runId: string) {
  const store = new SqliteEventStore(db)
  try {
    const events = await store.read("project", runLeaseAggregateId(runId))
    return {
      sequences: events.map((e) => Number(e.sequence)),
      acquires: events
        .filter((e) => e.type === RunLeaseEvents.Acquired)
        .map((e) => e.data as { operationId: string; fencingToken: number; ownerPid: number }),
    }
  } finally {
    store.close()
  }
}

// ───────────────────────────────── XP-03: exactly one holder may mutate

describe("MS1 P6 XP-03 - cross-process fencing enforcement", () => {
  test("two OS processes both acquire, and EXACTLY ONE may mutate", async () => {
    const w = world("xp03")
    const runId = "run_xp03_two_hosts"
    try {
      const { identities, acquired, mutate } = await race(w, runId, 2)

      // ── the race really was between two distinct OS processes
      expect(identities).toHaveLength(2)
      expect(new Set(identities.map((i) => i.pid)).size).toBe(2)
      expect(new Set(identities.map((i) => `${i.pid}@${i.created}`)).size).toBe(2)
      expect(new Set(acquired.map((l) => l.pid)).size).toBe(2)

      // ── BOTH acquired. `acquireRunLease` deliberately refuses nobody; the CAS
      //    guarantees only that the tokens are distinct and strictly increasing.
      expect(acquired).toHaveLength(2)
      expect(acquired.map((l) => l.fencingToken).sort((a, b) => a! - b!)).toEqual([1, 2])
      expect(new Set(acquired.map((l) => l.operationId)).size).toBe(2)

      // ── NON-VACUITY: no child asked the guard until BOTH leases existed. If the
      //    "mutate" barrier ever stopped blocking, a granted outcome could come
      //    from the peer not having appended yet — a pass for the wrong reason.
      const lastAcquire = Math.max(...acquired.map((l) => l.acquiredAt!))
      const firstMutate = Math.min(...mutate.map((l) => l.mutateStartedAt!))
      expect(firstMutate).toBeGreaterThanOrEqual(lastAcquire)

      // ── THE CLAIM: one mutator, one refusal, decided by the token relation.
      expect(mutate).toHaveLength(2)
      const granted = mutate.filter((l) => l.outcome === "granted")
      const refused = mutate.filter((l) => l.outcome === "refused")
      expect(granted).toHaveLength(1)
      expect(refused).toHaveLength(1)
      expect(granted[0]!.fencingToken).toBe(2) // the higher token, always
      expect(refused[0]!.fencingToken).toBe(1)
      expect(granted[0]!.pid).not.toBe(refused[0]!.pid)

      // ── the refusal is the real fencing error, carrying both tokens
      expect(refused[0]!.reasonCode).toBe("stale_lease_holder")
      expect(refused[0]!.heldToken).toBe(1)
      expect(refused[0]!.currentToken).toBe(2)
      // It came through the MUTATION guard, not a bare currency check: only
      // `assertMayMutate` prefixes the message with what it is refusing to do.
      expect(refused[0]!.message).toContain("refusing to delete the run root")

      // ── the journal on disk agrees, read by a process that was not in the race
      const j = await journal(w.db, runId)
      expect(j.acquires).toHaveLength(2)
      expect(j.acquires.map((a) => a.fencingToken).sort((a, b) => a - b)).toEqual([1, 2])
      expect(new Set(j.acquires.map((a) => a.operationId)).size).toBe(2)
      expect(new Set(j.acquires.map((a) => a.ownerPid)).size).toBe(2)
      // Gapless: SQLite arbitrated the appends; nothing was lost or duplicated.
      expect(j.sequences).toEqual(j.sequences.map((_, i) => i))

      console.log(`[gate] XP-03: pids ${identities.map((i) => i.pid).join(",")} - tokens ${acquired.map((l) => l.fencingToken).join(",")} - 1 granted, 1 refused (stale_lease_holder)`)
    } finally {
      w.dispose()
    }
  }, T)
})

// ──────────── XP-02 by-product: distinctness and single-mutator generalise

describe("MS1 P6 XP-02 - deterministic multi-host lease contention", () => {
  test("four OS processes released from one barrier get four DISTINCT tokens, and only the newest may mutate", async () => {
    // XP-02's remaining gap was that the existing 8-process proof
    // (`isorun-recovery.test.ts:549`) creates contention PROBABILISTICALLY and
    // never asserts the fencing consequence. Here the simultaneity is forced by
    // a barrier and the consequence is the assertion.
    //
    // STATED HONESTLY: `acquireRunLease` retries its CAS internally, so the
    // NUMBER of sequence conflicts is not observable from outside and is not
    // claimed. What is proven is that four genuinely simultaneous processes
    // received four distinct, contiguous tokens and that exactly one of them was
    // subsequently allowed to mutate.
    const w = world("xp02")
    const runId = "run_xp02_four_hosts"
    try {
      const { identities, acquired, mutate } = await race(w, runId, 4)

      expect(new Set(identities.map((i) => `${i.pid}@${i.created}`)).size).toBe(4)
      expect(acquired).toHaveLength(4)
      expect(new Set(acquired.map((l) => l.pid)).size).toBe(4)
      // Distinct AND contiguous: no duplicate token was ever issued.
      expect(acquired.map((l) => l.fencingToken).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4])
      expect(new Set(acquired.map((l) => l.operationId)).size).toBe(4)

      const lastAcquire = Math.max(...acquired.map((l) => l.acquiredAt!))
      const firstMutate = Math.min(...mutate.map((l) => l.mutateStartedAt!))
      expect(firstMutate).toBeGreaterThanOrEqual(lastAcquire)

      expect(mutate).toHaveLength(4)
      const granted = mutate.filter((l) => l.outcome === "granted")
      const refused = mutate.filter((l) => l.outcome === "refused")
      expect(granted).toHaveLength(1)
      expect(granted[0]!.fencingToken).toBe(4)
      expect(refused).toHaveLength(3)
      expect(refused.map((l) => l.fencingToken).sort((a, b) => a! - b!)).toEqual([1, 2, 3])
      // Every loser was told the SAME current holder, so they agree on who won.
      for (const r of refused) {
        expect(r.reasonCode).toBe("stale_lease_holder")
        expect(r.currentToken).toBe(4)
        expect(r.message).toContain("refusing to delete the run root")
      }

      const j = await journal(w.db, runId)
      expect(j.acquires).toHaveLength(4)
      expect(new Set(j.acquires.map((a) => a.ownerPid)).size).toBe(4)
      expect(j.sequences).toEqual(j.sequences.map((_, i) => i))

      console.log(`[gate] XP-02: 4 processes, tokens ${acquired.map((l) => l.fencingToken).sort((a, b) => a! - b!).join(",")}, 1 granted / 3 refused`)
    } finally {
      w.dispose()
    }
  }, T)
})

// ──────── XP-12: the SAME operationId in both processes — the TOKEN still fences

describe("MS1 P6 XP-12 - duplicate operationId is not refused, and does not confer fencing ownership", () => {
  test("two OS processes sharing ONE operationId both acquire distinct tokens, and EXACTLY the newest may mutate", async () => {
    // THE DRAFT ERROR THIS CORRECTS (T1 matrix row, classified DRAFT_ERROR in
    // the S1 closure decision §6): it claimed the second acquire is "refused as
    // a conflicting reuse". Production refuses nobody at acquire — the CAS loop
    // reads prior events only to compute max(token)+1 and never compares
    // operationIds. What XP-12 actually has to prove is sharper than XP-03:
    // the older holder here presents the SAME operationId as the current
    // holder, so `assertLeaseCurrent`'s operation clause would NOT refuse it —
    // the refusal can only come from the TOKEN relation. operationId is attempt
    // identity and audit correlation; the fencing token alone decides mutation.
    //
    // The duplicate is injected via the fixture's test-only `--op` flag because
    // production cannot produce one: both real call sites mint a fresh CSPRNG
    // id per attempt. This scenario pins the boundary DOWN, it does not relax it.
    const w = world("xp12")
    const runId = "run_xp12_shared_operation"
    // Production-shaped (`op_` + 24 hex), but a fixed literal: the test needs
    // the SAME id in both children, so it cannot be minted fresh anywhere.
    const sharedOp = "op_d0b1eca7ed0b1eca7ed0b1ec"
    try {
      const { identities, acquired, mutate } = await race(w, runId, 2, sharedOp)

      // ── two distinct, concurrently-alive OS processes (identities were read
      //    from Windows while both were parked at the "start" barrier)
      expect(identities).toHaveLength(2)
      expect(new Set(identities.map((i) => i.pid)).size).toBe(2)
      expect(new Set(identities.map((i) => `${i.pid}@${i.created}`)).size).toBe(2)
      expect(new Set(acquired.map((l) => l.pid)).size).toBe(2)

      // ── BOTH acquired under the duplicate operationId — no refusal at acquire —
      //    and the CAS still issued distinct, strictly increasing tokens.
      expect(acquired).toHaveLength(2)
      expect(acquired.map((l) => l.fencingToken).sort((a, b) => a! - b!)).toEqual([1, 2])
      expect(new Set(acquired.map((l) => l.operationId))).toEqual(new Set([sharedOp]))

      // ── NON-VACUITY: no child asked the guard until BOTH leases existed.
      const lastAcquire = Math.max(...acquired.map((l) => l.acquiredAt!))
      const firstMutate = Math.min(...mutate.map((l) => l.mutateStartedAt!))
      expect(firstMutate).toBeGreaterThanOrEqual(lastAcquire)

      // ── THE CLAIM: exactly one irreversible mutation-equivalent action was
      //    admitted, and the shared operationId did not tilt the decision.
      expect(mutate).toHaveLength(2)
      const granted = mutate.filter((l) => l.outcome === "granted")
      const refused = mutate.filter((l) => l.outcome === "refused")
      expect(granted).toHaveLength(1)
      expect(refused).toHaveLength(1)
      expect(granted[0]!.fencingToken).toBe(2) // newest token owns the mutation
      expect(refused[0]!.fencingToken).toBe(1)
      expect(granted[0]!.pid).not.toBe(refused[0]!.pid)

      // ── the refusal names the token generations, through the mutation guard.
      //    heldToken/currentToken are the stale and current generations; the
      //    detail proves the TOKEN clause fired (a "newer acquisition"), not the
      //    operation-mismatch clause — which could never fire here, since the
      //    refused holder's operationId IS the current holder's.
      expect(refused[0]!.reasonCode).toBe("stale_lease_holder")
      expect(refused[0]!.heldToken).toBe(1)
      expect(refused[0]!.currentToken).toBe(2)
      expect(refused[0]!.message).toContain("refusing to delete the run root")
      expect(refused[0]!.message).toContain("a newer acquisition")

      // ── the journal agrees, read by a process that was not in the race: two
      //    Acquired events, gapless, BOTH retaining the shared operationId.
      const j = await journal(w.db, runId)
      expect(j.acquires).toHaveLength(2)
      expect(j.acquires.map((a) => a.fencingToken).sort((a, b) => a - b)).toEqual([1, 2])
      expect(j.acquires.map((a) => a.operationId)).toEqual([sharedOp, sharedOp])
      expect(new Set(j.acquires.map((a) => a.ownerPid)).size).toBe(2)
      expect(j.sequences).toEqual(j.sequences.map((_, i) => i))

      console.log(`[gate] XP-12: pids ${identities.map((i) => i.pid).join(",")} - shared op accepted twice, tokens ${acquired.map((l) => l.fencingToken).sort((a, b) => a! - b!).join(",")} - 1 granted, 1 refused (stale_lease_holder)`)
    } finally {
      w.dispose()
    }
  }, T)
})
