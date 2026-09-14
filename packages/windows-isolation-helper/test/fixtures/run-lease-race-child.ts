/**
 * MS1 P6 / XP-03 — one independent host process racing for a run lease and then
 * asking the fencing guard whether it may still touch the machine.
 *
 * WHY A SEPARATE PROCESS IS THE ENTIRE POINT. The fencing guarantee is asserted
 * today only INSIDE one process (`isorun-crash.test.ts`, `isorun-recovery.test.ts`),
 * where a single JavaScript event loop arbitrates every interleaving — two
 * `await`s cannot actually overlap, so the guard is never asked a question it
 * could get wrong. The claim being relied upon in production is different: that
 * SQLite's write lock serialises appends from genuinely concurrent OS processes,
 * and that the token relation it establishes is what decides who may mutate. That
 * can only be measured with real processes on one real database file.
 *
 * WHAT THIS CHILD DOES NOT ASSUME. `acquireRunLease` does not refuse anybody —
 * it is a CAS retry loop, and two racing hosts BOTH come away holding a lease
 * with distinct, strictly increasing tokens (see the header of `src/run-lease.ts`:
 * "There is no contention check here, and that is deliberate"). So this child
 * never expects to lose at acquire time. The winner/loser appears one step later,
 * at `assertMayMutate`, and that step is what the parent measures.
 *
 * THE TWO BARRIERS, and neither is a sleep:
 *   - "start"  — the parent joins this one, so it can record each child's real OS
 *                identity (pid + creation time) while the child is provably still
 *                alive rather than racing a process that may already have exited.
 *   - "mutate" — every child has FINISHED acquiring before any child asks the
 *                guard. Without it a fast child could be granted simply because
 *                the slow one had not appended yet, and the test would pass for a
 *                reason that has nothing to do with fencing.
 *
 * argv: --db <path> --run <runId> --me <label> --barrier <dir> --peers <n>
 *       --start-peers <n> --log <jsonl> [--op <operationId>]
 *
 * `--op` exists for XP-12 ONLY: production generates a fresh operationId per
 * attempt (`newOperationId()`, and both real call sites do exactly that), so the
 * deliberate-duplicate scenario cannot arise through the production path. When
 * the flag is absent this child behaves exactly as before — a fresh CSPRNG id.
 */
import { appendFileSync } from "node:fs"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { assertMayMutate, acquireRunLease, newOperationId, StaleLeaseHolder } from "../../src/run-lease"
import { barrier } from "../barrier"

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? (process.argv[i + 1] ?? "") : ""
}
const dbPath = arg("db")
const runId = arg("run")
const me = arg("me")
const barrierDir = arg("barrier")
const logPath = arg("log")
const peers = Number(arg("peers") || "2")
const startPeers = Number(arg("start-peers") || String(peers + 1))

const log = (line: Record<string, unknown>) => appendFileSync(logPath, `${JSON.stringify({ me, pid: process.pid, ...line })}\n`, "utf8")

const store = new SqliteEventStore(dbPath)
try {
  const operationId = arg("op") || newOperationId()

  // The parent is a participant here, and it arrives only after it has recorded
  // both children's OS identities. Nothing below can start early.
  await barrier(barrierDir, "start", me, startPeers)

  const lease = await acquireRunLease(
    { store },
    { runId, operationId, ownerPid: process.pid, ownerStartTime: `start-${process.pid}` },
  )
  const acquiredAt = Date.now()
  log({ event: "acquired", operationId, fencingToken: lease.fencingToken, acquiredAt })

  // EVERY lease exists before ANY guard runs. This is the ordering the parent
  // re-derives from the timestamps below, so a barrier that silently stopped
  // blocking would be caught rather than quietly turning the test vacuous.
  await barrier(barrierDir, "mutate", me, peers)

  const mutateStartedAt = Date.now()
  try {
    // A real mutation verb, not a probe: this is the exact guard every OS
    // mutation in the lifecycle routes through.
    await assertMayMutate({ store }, lease, "delete the run root")
    log({ event: "mutate", outcome: "granted", operationId, fencingToken: lease.fencingToken, mutateStartedAt })
  } catch (e) {
    if (!(e instanceof StaleLeaseHolder)) throw e
    log({
      event: "mutate",
      outcome: "refused",
      operationId,
      fencingToken: lease.fencingToken,
      mutateStartedAt,
      reasonCode: e.reasonCode,
      heldToken: e.heldToken,
      currentToken: e.currentToken,
      message: e.message,
    })
  }
  process.exit(0)
} catch (e) {
  log({ event: "error", error: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 400) : String(e) })
  process.exit(1)
} finally {
  store.close()
}
