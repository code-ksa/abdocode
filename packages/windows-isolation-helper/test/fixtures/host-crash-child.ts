/**
 * CL-16A2-D-R §5 — a host that can be KILLED for real, at a precise point.
 *
 * The previous crash matrix threw `HostCrashed` inside the test process and then
 * ran recovery against the same in-RAM store. Nothing died and nothing had to
 * survive, so it proved the reconciliation logic and nothing about durability.
 *
 * This process is the host. It:
 *   1. opens a REAL SQLite event store on disk,
 *   2. runs the lifecycle until it reaches the requested point,
 *   3. writes a marker saying "I am exactly here",
 *   4. blocks for ever.
 *
 * The parent then kills it with `taskkill /F /T` — no exit hooks, no unwinding,
 * no flush — and re-opens the same database FROM A DIFFERENT PROCESS. Anything
 * the journal cannot show at that point is genuinely lost, which is the only way
 * to find out whether it was ever really durable.
 *
 * It borrows the parent's de-elevated helper queue (ABDO_HARNESS_QUEUE) instead
 * of starting its own server, because a process that is about to be killed can
 * never clean one up.
 *
 *   bun host-crash-child.ts <dbPath> <runId> <crashPoint> <markerPath> <scratch>
 */
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { executeRun, type HostCrashPoint } from "../../src/lifecycle"
import { REQUIRED_PROTOCOL_VERSION } from "../../src/helper-runner"
import { harnessHelperRunner, helperBinaryHash } from "../harness"

const [dbPath, runId, point, markerPath, scratch] = process.argv.slice(2)
if (!dbPath || !runId || !point || !markerPath) {
  console.error("usage: host-crash-child.ts <dbPath> <runId> <crashPoint> <markerPath> [scratch]")
  process.exit(2)
}

const CMD = "C:\\Windows\\System32\\cmd.exe"
const store = new SqliteEventStore(dbPath)

try {
  await executeRun(
    {
      store,
      helper: harnessHelperRunner(),
      helperBinaryHash: helperBinaryHash(),
      helperProtocolVersion: REQUIRED_PROTOCOL_VERSION,
    },
    {
      runId,
      argv: [CMD, "/c", "echo", "x"],
      grants: scratch ? [{ path: scratch, rights: "rx" }] : [],
      timeoutMs: 20_000,
      onPoint: async (reached: HostCrashPoint) => {
        if (reached !== point) return
        // Tell the parent WHERE we are, then stop being a process that makes
        // progress. Everything the journal is going to have, it has now.
        await Bun.write(markerPath, `${reached} ${process.pid}`)
        await new Promise(() => {})
      },
    },
  )
  // Reaching here means the point was never hit: the parent must be told, or it
  // would wait out its timeout and report a harness failure it cannot explain.
  await Bun.write(`${markerPath}.missed`, `never reached ${point}`)
} catch (e) {
  await Bun.write(`${markerPath}.error`, e instanceof Error ? `${e.name}: ${e.message}` : String(e))
} finally {
  store.close()
}
