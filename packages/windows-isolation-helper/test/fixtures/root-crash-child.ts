/**
 * CL-16A3-B2B-ROOT-FIX §4 — a bootstrap that can be KILLED for real, at a
 * precise point between the beats.
 *
 * Throwing inside the test process would prove only that the code unwinds. This
 * is a separate process holding a REAL SQLite store on disk; it runs until the
 * requested point, announces WHICH stage it reached, and then stops making
 * progress. The parent kills it with `taskkill /F /T` — no exit hook, no flush,
 * no unwinding — and re-opens the same database from a DIFFERENT process.
 *
 * The stage name is written INTO the announcement rather than merely "I am
 * here", so the parent can prove the child stopped where the test intended and
 * not somewhere else that happens to leave similar state behind.
 *
 * It borrows the parent's de-elevated helper queue, because production refuses an
 * elevated host and a process about to be killed can never clean up a server.
 *
 *   bun root-crash-child.ts <dbPath> <crashPoint> <markerPath>
 */
import { renameSync } from "node:fs"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RIGHTS_MODEL_VERSION } from "@abdo/tools/windows-acl-matrix"
import { bootstrapExecutionRoot } from "../../src/execution-root"
import { REQUIRED_PROTOCOL_VERSION } from "../../src/helper-runner"
import { harnessHelperRunner, helperBinaryHash } from "../harness"

const [dbPath, point, markerPath] = process.argv.slice(2)
if (!dbPath || !point || !markerPath) {
  console.error("usage: root-crash-child.ts <dbPath> <crashPoint> <markerPath>")
  process.exit(2)
}

/**
 * ATOMIC announce: write beside the target, then rename into place. The parent
 * polls for the target NAME, so it can never observe a half-written file — a
 * measured qual-1 failure caught the parent parsing the marker between this
 * process's create and write (empty file, JSON EOF).
 */
async function announce(path: string, content: string): Promise<void> {
  await Bun.write(`${path}.tmp`, content)
  renameSync(`${path}.tmp`, path)
}

const store = new SqliteEventStore(dbPath)
const reached: string[] = []
try {
  await bootstrapExecutionRoot({
    store,
    helper: harnessHelperRunner(),
    helperProtocol: REQUIRED_PROTOCOL_VERSION,
    helperHash: helperBinaryHash(),
    profileInventory: { complete: true, hash: "test-inventory", roots: [{ path: process.env.USERPROFILE ?? "C:\\Users\\nobody" }] },
    rightsModelVersion: RIGHTS_MODEL_VERSION,
    onPoint: async (r) => {
      reached.push(r)
      if (r !== point) return
      // Name the stage and the whole path taken to it, then stop being a process
      // that makes progress. Everything the journal is going to have, it has now.
      await announce(markerPath, JSON.stringify({ stage: r, pid: process.pid, path: reached }))
      await new Promise(() => {})
    },
  })
  // Reaching here means the point was never hit. The parent has to be told, or
  // it waits out its timeout and reports a harness failure it cannot explain.
  await announce(`${markerPath}.missed`, JSON.stringify({ wanted: point, reached }))
} catch (e) {
  await announce(`${markerPath}.error`, e instanceof Error ? `${e.name}: ${e.message}` : String(e))
} finally {
  store.close()
}
