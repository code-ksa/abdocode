/**
 * Fixture: append committed events to a real SQLite event log, then die BEFORE
 * any projection runs. Proves "crash after commit, before projection" leaves the
 * log intact and recoverable. Run via Bun.spawn by projector.test.ts.
 *
 *   bun projector-child.ts <dbFile>
 */
import { SqliteEventStore } from "../src/sqlite"

const [dbFile] = process.argv.slice(2)
if (!dbFile) process.exit(2)

const store = new SqliteEventStore(dbFile)
const emit = (runId: string, type: string) =>
  store.append({ aggregateKind: "session", aggregateId: "ses_1", type, data: { runId } })

await emit("run_1", "run.admitted")
await emit("run_1", "run.calling")
await emit("run_1", "run.streaming")
await emit("run_2", "run.admitted")
await emit("run_2", "run.executing_tool")

// Events are committed. Die before any projector processes them.
process.exit(137)
