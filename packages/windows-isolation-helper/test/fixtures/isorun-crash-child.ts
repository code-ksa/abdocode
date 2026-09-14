/**
 * CL-16A3 MEGA-1 §5b — an ISOLATED-RUN host that can be killed for real.
 *
 * The same shape as `host-crash-child.ts`, for the new driver. It opens a real
 * SQLite store on disk, runs `executeIsolatedRun` until it reaches the requested
 * `RunLifecyclePoint`, writes a marker saying "I am exactly here", and then stops
 * making progress for ever. The parent kills it with `taskkill /F /T` — no exit
 * hooks, no unwinding, no flush — and inspects the journal FROM A DIFFERENT
 * PROCESS.
 *
 * WHY THIS CANNOT BE A THROWN EXCEPTION. An in-process `throw` unwinds; `finally`
 * blocks run, the heartbeat timer is cleared, handles close, and the store gets a
 * chance to flush. Every one of those is a thing a real crash does NOT do, and
 * every one of them is load-bearing here — the lease must be left UNRELEASED and
 * still ticking, exactly as it would be if the machine lost power.
 *
 * It borrows the parent's de-elevated helper queue (`ABDO_HARNESS_QUEUE`) rather
 * than starting its own server, because a process that is about to be killed can
 * never shut one down.
 *
 *   bun isorun-crash-child.ts <dbPath> <point> <markerPath> [leaseTtlMs]
 */
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RIGHTS_MODEL_VERSION } from "@abdo/tools/windows-acl-matrix"
import { bootstrapExecutionRoot } from "../../src/execution-root"
import { REQUIRED_PROTOCOL_VERSION } from "../../src/helper-runner"
import { executeIsolatedRun, type RunLifecyclePoint } from "../../src/run-lifecycle"
import { harnessHelperRunner, helperBinaryHash, runUnelevated } from "../harness"

const [dbPath, point, markerPath, ttl] = process.argv.slice(2)
if (!dbPath || !point || !markerPath) {
  console.error("usage: isorun-crash-child.ts <dbPath> <point> <markerPath> [leaseTtlMs]")
  process.exit(2)
}

const CMD = String.raw`C:\Windows\System32\cmd.exe`
const store = new SqliteEventStore(dbPath)

try {
  const kf = await runUnelevated(["known-folder", "--id", "ProgramData"])
  const hostSid = String(kf.hostUserSid ?? "")
  const helper = harnessHelperRunner()
  const inventory = { complete: true, hash: "crash-inventory", roots: [process.env.USERPROFILE ?? ""] }

  const root = await bootstrapExecutionRoot({
    store,
    helper,
    helperProtocol: REQUIRED_PROTOCOL_VERSION,
    helperHash: helperBinaryHash(),
    profileInventory: { complete: true, hash: inventory.hash, roots: [{ path: process.env.USERPROFILE ?? "" }] },
    rightsModelVersion: RIGHTS_MODEL_VERSION,
  })
  if (!root.ok) {
    await Bun.write(`${markerPath}.error`, `root bootstrap failed: ${root.reasonCode} ${root.detail}`)
    process.exit(3)
  }

  await executeIsolatedRun(
    {
      store,
      helper,
      helperProtocol: REQUIRED_PROTOCOL_VERSION,
      helperHash: helperBinaryHash(),
      executionRootPath: root.rootPath,
      executionRootFinalPath: root.finalPath,
      hostSid,
      profileInventory: inventory,
      rightsModelVersion: RIGHTS_MODEL_VERSION,
      stateEpoch: "crash-epoch",
      // A SHORT TTL so the parent does not wait thirty seconds for the lease of
      // a process it has already killed. The heartbeat renews at TTL/3, so this
      // still exercises real renewals before the kill.
      leaseTtlMs: Number(ttl ?? 3_000),
      onPoint: async (reached: RunLifecyclePoint) => {
        if (reached !== point) return
        // Tell the parent WHERE we are, then stop. Whatever the journal is going
        // to contain, it contains now.
        await Bun.write(markerPath, `${reached} ${process.pid}`)
        await new Promise(() => {})
      },
    },
    { executablePath: CMD, args: ["/c", "echo", "CRASH-CHILD"], dialect: "cmd", decisionId: "crash-dec", timeoutMs: 20_000 },
  )
  // Reaching here means the point was never hit. The parent has to be told, or
  // it waits out its timeout and reports a harness failure it cannot explain.
  await Bun.write(`${markerPath}.missed`, `never reached ${point}`)
} catch (e) {
  await Bun.write(`${markerPath}.error`, e instanceof Error ? `${e.name}: ${e.message}` : String(e))
} finally {
  store.close()
}
