/**
 * Fixture: one process appending `count` events to `sessionId` in a shared
 * SQLite event log. Several of these run concurrently to prove cross-process
 * sequence integrity (BEGIN IMMEDIATE + busy_timeout + UNIQUE(aggregate,seq)).
 *
 *   bun stress-child.ts <dbFile> <sessionId> <count> <tag>
 */
import { SqliteEventStore } from "../src/sqlite"

const [dbFile, sessionId, countStr, tag] = process.argv.slice(2)
if (!dbFile || !sessionId || !countStr) process.exit(2)
const count = Number(countStr)

const store = new SqliteEventStore(dbFile)
for (let i = 0; i < count; i++) {
  await store.append({ aggregateKind: "session", aggregateId: sessionId, type: "e", data: { tag, i } })
}
store.close()
process.exit(0)
