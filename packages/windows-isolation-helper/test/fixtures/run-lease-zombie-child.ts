/**
 * MS1 P6 S5 — one real host process for the zombie/crash/recovery scenarios
 * (XP-04, XP-08, XP-10).
 *
 * WHY THIS IS A NEW FIXTURE. `run-lease-race-child.ts` proves the ACQUIRE →
 * MUTATE race and nothing else; these scenarios need verbs it deliberately does
 * not have — `renewRunLease`, `releaseRunLease`, an ALIVE-BUT-NOT-RENEWING
 * parking window (the observable a suspended host actually presents), and a
 * REAL owner identity. That last one matters most: recovery's dead-owner proof
 * is `inspect-process --pid … --expect-start …`, so a lease whose
 * `ownerStartTime` is a made-up string can never be assessed. This child asks
 * the REAL helper for its own creation time and acquires with it, which is what
 * lets a recovery pass in another process measure this process honestly.
 *
 * The parking windows are parent-gated files, not sleeps: `ready.<me>` is
 * written before anything acquires (so the parent can read OS identities while
 * the child is provably alive and idle), and every later step waits for an
 * explicit `go`/`resume`/`mutate`/`finish` file. A gate that never opens is a
 * loud bounded failure (`waitForFile` deadline), never a hang.
 *
 * argv: --db <path> --log <jsonl> --gates <dir> --run <runId> --me <label>
 *       --role sleeper|adopter|releaser|mutator [--after-renew exit|park]
 *
 * Roles (each acquires with its real identity after `go.<me>`):
 *   sleeper  — acquire, park alive WITHOUT renewing (`resume.<me>` gates the
 *              wake-up), then renew once and log granted/refused. With
 *              `--after-renew park` it parks again afterwards and waits to be
 *              killed by the parent (XP-10's real death).
 *   adopter  — acquire and exit: the newer generation whose token fences the
 *              sleeper (XP-04).
 *   releaser — acquire, park, then attempt `releaseRunLease(completed, …)` and
 *              log granted/refused (XP-08's zombie).
 *   mutator  — acquire, park, `assertMayMutate` on command, park inside the
 *              open mutation window, then release its own lease (XP-08's
 *              current holder).
 *
 * The release proof states only what is true: this child creates NO resource,
 * so every field is `never_created`/`never_started` and the machine is clean.
 */
import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { StaleLeaseHolder, acquireRunLease, assertMayMutate, newOperationId, releaseRunLease, renewRunLease, type ResidueProof } from "../../src/run-lease"
import { waitForFile } from "../barrier"
import { harnessHelperRunner } from "../harness"

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? (process.argv[i + 1] ?? "") : ""
}
const dbPath = arg("db")
const logPath = arg("log")
const gates = arg("gates")
const runId = arg("run")
const me = arg("me")
const role = arg("role")
const afterRenew = arg("after-renew") || "exit"

const log = (line: Record<string, unknown>) => appendFileSync(logPath, `${JSON.stringify({ me, pid: process.pid, ...line })}\n`, "utf8")
const mark = (name: string) => writeFileSync(join(gates, `${name}.${me}`), String(Date.now()), "utf8")
const gate = async (name: string) => {
  if (!(await waitForFile(join(gates, `${name}.${me}`)))) throw new Error(`gate ${name}.${me} never opened`)
}

const NOTHING_CREATED: ResidueProof = {
  clean: true,
  checkedAt: Date.now(),
  aclPathsClean: [],
  aclPathsDirty: [],
  profileAbsent: "never_created",
  runRootAbsent: "never_created",
  childProcessGone: "never_started",
}

const store = new SqliteEventStore(dbPath)
try {
  // Parked and provably alive: the parent reads this child's OS identity now.
  mark("ready")
  await gate("go")

  // THE REAL IDENTITY, from the REAL helper — the exact value a recovery pass
  // in another process will present back to `inspect-process --expect-start`.
  const self = await harnessHelperRunner()({ argv: ["inspect-process", "--pid", String(process.pid)] })
  const ownerStartTime = String(self.startTime ?? "")
  if (!ownerStartTime) throw new Error(`helper returned no startTime for own pid ${process.pid}`)
  log({ event: "identity", ownerStartTime })

  const operationId = newOperationId()
  const lease = await acquireRunLease({ store }, { runId, operationId, ownerPid: process.pid, ownerStartTime })
  log({ event: "acquired", operationId, fencingToken: lease.fencingToken, ownerStartTime, acquiredAt: Date.now() })
  mark("acquired")

  if (role === "adopter") {
    process.exit(0)
  }

  if (role === "sleeper") {
    // ALIVE, NOT RENEWING — the suspended-host observable. Nothing beats.
    await gate("resume")
    try {
      const renewed = await renewRunLease({ store }, lease)
      log({ event: "renew", outcome: "granted", fencingToken: renewed.fencingToken, renewals: renewed.renewals, renewedAt: Date.now() })
      if (afterRenew === "park") {
        // Stay alive holding the current generation until the parent KILLS this
        // process — XP-10's death is real, never represented by a boolean.
        mark("renewed")
        await gate("final")
      }
    } catch (e) {
      if (!(e instanceof StaleLeaseHolder)) throw e
      log({ event: "renew", outcome: "refused", fencingToken: lease.fencingToken, reasonCode: e.reasonCode, heldToken: e.heldToken, currentToken: e.currentToken, message: e.message })
    }
    process.exit(0)
  }

  if (role === "releaser") {
    await gate("resume")
    try {
      await releaseRunLease({ store }, lease, "completed", NOTHING_CREATED)
      log({ event: "release", outcome: "granted", operationId, fencingToken: lease.fencingToken })
    } catch (e) {
      if (!(e instanceof StaleLeaseHolder)) throw e
      log({ event: "release", outcome: "refused", operationId, fencingToken: lease.fencingToken, reasonCode: e.reasonCode, heldToken: e.heldToken, currentToken: e.currentToken, message: e.message })
    }
    process.exit(0)
  }

  if (role === "mutator") {
    await gate("mutate")
    await assertMayMutate({ store }, lease, "delete the run root")
    log({ event: "mutate", outcome: "granted", operationId, fencingToken: lease.fencingToken, mutateStartedAt: Date.now() })
    // The mutation window stays OPEN here: this process is alive and current
    // while the parent lets the zombie attempt its stale release.
    mark("mutated")
    await gate("finish")
    const released = await releaseRunLease({ store }, lease, "completed", NOTHING_CREATED)
    log({ event: "release", outcome: "granted", operationId, fencingToken: released.fencingToken, releasedAt: Date.now() })
    process.exit(0)
  }

  throw new Error(`unknown role: ${role}`)
} catch (e) {
  log({ event: "error", error: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 400) : String(e) })
  process.exit(1)
} finally {
  store.close()
}
