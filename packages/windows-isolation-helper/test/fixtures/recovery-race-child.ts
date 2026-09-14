/**
 * MS1 P6 S6 — one independent host process for the recovery/removal races
 * (XP-06, XP-09).
 *
 * WHY A SEPARATE FIXTURE. Both verbs are whole-process actions with no existing
 * child that performs them: `recoverIsolatedRuns` is a sweep a HOST runs, and
 * `removeOwnedDirectoryTree` is a synchronous filesystem primitive. The existing
 * fixtures acquire leases or bootstrap roots; neither can express either verb,
 * and an in-process `Promise.all` cannot exercise SQLite's cross-process write
 * lock or the filesystem's own arbitration — which is the entire claim.
 *
 * WHAT IS REPORTED, AND WHY IT IS REPORTED RATHER THAN THROWN. Production
 * recovery acquires a reclaim lease and immediately asks the fencing guard
 * whether it may act (`isorun-recovery.ts`), so a pass whose generation was
 * superseded between those two steps sees `StaleLeaseHolder` PROPAGATE OUT of
 * `recoverIsolatedRuns`. That is a real production outcome of a genuine race,
 * not a failure of this child, so it is caught and logged as a structured
 * outcome — the parent then asserts the invariants that hold whichever way the
 * interleaving fell. Nothing else is caught: any other error exits non-zero.
 *
 * `removeOwnedDirectoryTree` is synchronous and returns `{removed, code?}`; it
 * never throws by contract, so its result is logged exactly as returned,
 * including a `removed:false` with the errno the production comment insists is
 * surfaced rather than swallowed.
 *
 * argv: --log <jsonl> --gates <dir> --me <label> --role recover|remove-tree
 *       [--db <path>] [--path <dir>] [--peers <n>]
 */
import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { removeOwnedDirectoryTree } from "../../src/controlled-fs"
import { recoverIsolatedRuns } from "../../src/isorun-recovery"
import { DEFAULT_LEASE_TTL_MS, StaleLeaseHolder } from "../../src/run-lease"
import { barrier } from "../barrier"
import { harnessHelperRunner } from "../harness"

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? (process.argv[i + 1] ?? "") : ""
}
const logPath = arg("log")
const gates = arg("gates")
const me = arg("me")
const role = arg("role")
const dbPath = arg("db")
const targetPath = arg("path")
const peers = Number(arg("peers") || "0")

const log = (line: Record<string, unknown>) => appendFileSync(logPath, `${JSON.stringify({ me, pid: process.pid, ...line })}\n`, "utf8")

/** The production recovery clock: far past every TTL, while real time stands still. */
const advanced = () => Date.now() + DEFAULT_LEASE_TTL_MS * 20

try {
  writeFileSync(join(gates, `ready.${me}`), String(Date.now()), "utf8")
  // A count-based rendezvous when the parent wants simultaneity: the parent is
  // the last participant, so release is its decision and both children enter
  // the contended call together. `--peers 0` means "no rendezvous".
  if (peers > 0) await barrier(gates, "go", me, peers)

  if (role === "recover") {
    const store = new SqliteEventStore(dbPath)
    try {
      const startedAt = Date.now()
      try {
        const outcomes = await recoverIsolatedRuns({ store, helper: harnessHelperRunner(), now: advanced })
        log({ event: "recover", outcome: "completed", startedAt, finishedAt: Date.now(), results: outcomes.map((o) => ({ runId: o.runId, action: o.action, liveness: o.liveness, detail: o.detail.slice(0, 200), ...(o.releaseSuperseded ? { releaseSuperseded: true } : {}) })) })
      } catch (e) {
        if (!(e instanceof StaleLeaseHolder)) throw e
        // A REAL production outcome of a real race — see the header.
        log({ event: "recover", outcome: "refused", startedAt, finishedAt: Date.now(), reasonCode: e.reasonCode, heldToken: e.heldToken, currentToken: e.currentToken, message: e.message.slice(0, 200) })
      }
    } finally {
      store.close()
    }
    process.exit(0)
  }

  if (role === "remove-tree") {
    const result = removeOwnedDirectoryTree(targetPath)
    log({ event: "remove", path: targetPath, removed: result.removed, ...(result.code ? { code: result.code } : {}), at: Date.now() })
    process.exit(0)
  }

  throw new Error(`unknown role: ${role}`)
} catch (e) {
  log({ event: "error", error: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 400) : String(e) })
  process.exit(1)
}
