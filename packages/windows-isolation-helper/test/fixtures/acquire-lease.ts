/**
 * A SEPARATE PROCESS that acquires one run lease and prints the token it got.
 *
 * It exists because the fencing guarantee is about concurrency ACROSS PROCESSES,
 * and that cannot be demonstrated inside one. Two `await`s in a single event loop
 * interleave at points the runtime chooses; two OS processes hitting the same
 * SQLite file interleave wherever the database says, which is the thing actually
 * being relied upon.
 *
 * argv: <dbPath> <runId> <operationId>
 */
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { acquireRunLease } from "../../src/run-lease"

const [dbPath, runId, operationId] = process.argv.slice(2)
if (!dbPath || !runId || !operationId) {
  console.log(JSON.stringify({ ok: false, error: "usage: acquire-lease <dbPath> <runId> <operationId>" }))
  process.exit(2)
}

const store = new SqliteEventStore(dbPath)
try {
  const lease = await acquireRunLease({ store }, { runId, operationId, ownerPid: process.pid, ownerStartTime: `start-${process.pid}` }, 60_000)
  console.log(JSON.stringify({ ok: true, fencingToken: lease.fencingToken, operationId, pid: process.pid }))
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e), operationId, pid: process.pid }))
} finally {
  store.close()
}
