/**
 * CL-16A3-B2B-ROOT-FIX §8 — one independent process bootstrapping the root.
 *
 * Three of these run at once against ONE SQLite file, released together by a
 * barrier, so the first-ever bootstrap really is contended. Exactly one must
 * PUBLISH; the others must verify what was published and discard their own
 * staging — never adopt, never repair, never rewrite the marker.
 *
 * It borrows the parent's de-elevated helper queue, because production refuses
 * an elevated host and this session's shell is elevated.
 */
import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RIGHTS_MODEL_VERSION } from "@abdo/tools/windows-acl-matrix"
import { bootstrapExecutionRoot } from "../../src/execution-root"
import { REQUIRED_PROTOCOL_VERSION } from "../../src/helper-runner"
import { barrier, waitForFile } from "../barrier"
import { harnessHelperRunner, helperBinaryHash } from "../harness"

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? (process.argv[i + 1] ?? "") : ""
}
const dbPath = arg("db")
const logPath = arg("log")
const barrierDir = arg("barrier")
const me = arg("me")
const peers = Number(arg("peers") || "3")
// Test-only, both OPTIONAL and inert when absent (P6 S4):
//   --inventory-hash   this host's profileInventory hash (default: the canonical
//                      test hash every earlier caller compiled in)
//   --pause-at         a production `onPoint` name; on reaching it the child
//                      writes `pause.<me>` in the barrier dir and blocks until
//                      the parent writes `resume.<me>` — the deterministic
//                      mid-flight window XP-07/XP-11 park a peer in. The wait is
//                      bounded by waitForFile's deadline and FAILS LOUDLY: a
//                      vanished parent must never look like a completed pause.
const inventoryHash = arg("inventory-hash") || "test-inventory"
const pauseAt = arg("pause-at")

const store = new SqliteEventStore(dbPath)
try {
  await barrier(barrierDir, "bootstrap", me, peers)
  const res = await bootstrapExecutionRoot({
    store,
    helper: harnessHelperRunner(),
    helperProtocol: REQUIRED_PROTOCOL_VERSION,
    helperHash: helperBinaryHash(),
    profileInventory: { complete: true, hash: inventoryHash, roots: [{ path: process.env.USERPROFILE ?? "C:\\Users\\nobody" }] },
    rightsModelVersion: RIGHTS_MODEL_VERSION,
    ...(pauseAt
      ? {
          onPoint: async (point: string) => {
            if (point !== pauseAt) return
            writeFileSync(join(barrierDir, `pause.${me}`), String(Date.now()), "utf8")
            if (!(await waitForFile(join(barrierDir, `resume.${me}`)))) throw new Error(`paused at ${pauseAt} but resume.${me} never appeared`)
          },
        }
      : {}),
  })
  appendFileSync(
    logPath,
    `${JSON.stringify({
      me,
      pid: process.pid,
      ok: res.ok,
      ...(res.ok
        ? {
            rootPath: res.rootPath,
            fileId: res.fileId,
            markerHash: res.markerHash,
            daclHash: res.daclHash,
            createdAt: res.marker.createdAt,
            publishedByUs: res.publishedByUs,
            observedExistingVerified: res.observedExistingVerified,
            bootstrapId: res.bootstrapId,
            stagingPath: res.stagingPath,
          }
        : { reasonCode: res.reasonCode, detail: res.detail }),
    })}\n`,
    "utf8",
  )
  process.exit(0)
} catch (e) {
  appendFileSync(logPath, `${JSON.stringify({ me, pid: process.pid, ok: false, error: e instanceof Error ? e.message.slice(0, 300) : String(e) })}\n`, "utf8")
  process.exit(1)
} finally {
  store.close()
}
