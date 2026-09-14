/**
 * CL-16A3-B2B-ROOT-FIX — capture the live evidence the report must show.
 *
 * Performs ONE real bootstrap through the de-elevated measurement harness and
 * prints what Windows actually reports about the published root, then removes it.
 * Nothing here asserts; it only records, so the numbers in the report are read
 * off the machine rather than transcribed from a test name.
 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync } from "node:fs"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RIGHTS_MODEL_VERSION } from "@abdo/tools/windows-acl-matrix"
import { bootstrapExecutionRoot, isProtectedOwnerOnlyDacl, findForbiddenPrincipals } from "../src/execution-root"
import { REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import { harnessHelperRunner, helperBinaryHash, runDirect, runUnelevated, stopServer } from "../test/harness"

const dir = mkdtempSync(join(tmpdir(), "abdo-evidence-"))
const store = new SqliteEventStore(join(dir, "journal.sqlite"))

const kf = await runUnelevated(["known-folder", "--id", "ProgramData"])
console.log("--- ProgramData, via SHGetKnownFolderPath ---")
console.log(`lexical      : ${String(kf.lexicalPath)}`)
console.log(`final        : ${String(kf.pathFinalPath)}`)
console.log(`volume       : ${String(kf.pathVolumeSerial)}   fileId: ${String(kf.pathFileId)}`)
console.log(`reparse      : ${String(kf.pathIsReparsePoint)}   owner: ${String(kf.pathOwnerSid)}`)
console.log(`DACL before  : ${String(runDirect(["inspect-acl", "--path", String(kf.lexicalPath)]).sddl)}`)
console.log("")
console.log("--- the measuring host ---")
console.log(`elevated=${String(kf.elevated)}  integrity=${String(kf.integrity)}  integrityRid=0x${Number(kf.integrityRid).toString(16)}`)
console.log(`hostSid      : ${String(kf.hostUserSid)}`)
console.log("")

rmSync(join(String(kf.lexicalPath), "Abdo"), { recursive: true, force: true })
const res = await bootstrapExecutionRoot({
  store,
  helper: harnessHelperRunner(),
  helperProtocol: REQUIRED_PROTOCOL_VERSION,
  helperHash: helperBinaryHash(),
  profileInventory: { complete: true, hash: "test-inventory", roots: [{ path: process.env.USERPROFILE ?? "" }] },
  rightsModelVersion: RIGHTS_MODEL_VERSION,
})

if (!res.ok) {
  console.log(`BOOTSTRAP REFUSED: ${res.reasonCode} — ${res.detail}`)
} else {
  const hostSid = String(kf.hostUserSid)
  const sddl = String(runDirect(["inspect-acl", "--path", res.rootPath]).sddl ?? "")
  console.log("--- the published execution root ---")
  console.log(`path         : ${res.rootPath}`)
  console.log(`final        : ${res.finalPath}`)
  console.log(`volume       : ${res.volumeSerial}   fileId: ${res.fileId}`)
  console.log(`owner        : ${res.ownerSid}`)
  console.log(`DACL         : ${sddl}`)
  console.log(`protected form: ${isProtectedOwnerOnlyDacl(sddl, hostSid)}   forbidden principals: ${JSON.stringify(findForbiddenPrincipals(sddl, hostSid))}`)
  console.log(`inherited ACEs: ${(sddl.match(/\(([^)]*)\)/g) ?? []).filter((a) => (a.split(";")[1] ?? "").includes("ID")).length}`)
  console.log(`markerHash   : ${res.markerHash}`)
  console.log(`daclHash     : ${res.daclHash}`)
  console.log(`publishedByUs: ${res.publishedByUs}   observedExistingVerified: ${res.observedExistingVerified}`)
  console.log(`marker       : ${JSON.stringify(res.marker)}`)
  console.log("")
  console.log(`events       : ${(await store.read("project", "winiso:execution-root")).map((e) => e.type).join(" -> ")}`)
}

console.log("")
console.log(`--- ProgramData DACL after ---`)
console.log(String(runDirect(["inspect-acl", "--path", String(kf.lexicalPath)]).sddl))

store.close()
rmSync(join(String(kf.lexicalPath), "Abdo"), { recursive: true, force: true })
rmSync(dir, { recursive: true, force: true })
stopServer()
