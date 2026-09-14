/**
 * RC4 §3 — can a MEDIUM token move a directory's owner at all, and to what?
 *
 * `execution-root-toctou.test.ts` creates its ownership drift with
 * `protect-dir --owner-sid S-1-5-32-544`, and its own comment says "this shell is
 * elevated, so it can hand the directory to Administrators". At medium it is not.
 * Rather than assume which SIDs are reachable, this measures them.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDirect } from "../test/harness"

const hostSid = String(runDirect(["known-folder", "--id", "ProgramData"]).hostUserSid ?? "")
console.log(`host user SID: ${hostSid}`)

const candidates: [string, string][] = [
  ["Administrators", "S-1-5-32-544"],
  ["Users", "S-1-5-32-545"],
  ["Authenticated Users", "S-1-5-11"],
  ["Everyone", "S-1-1-0"],
  ["SYSTEM", "S-1-5-18"],
  ["the host user itself (control)", hostSid],
]

for (const [label, sid] of candidates) {
  const dir = mkdtempSync(join(tmpdir(), "abdo-owner-"))
  try {
    const before = String(runDirect(["inspect-acl", "--path", dir]).ownerSid ?? "")
    const r = runDirect(["protect-dir", "--path", dir, "--owner-sid", sid, "--dacl-sddl", `D:P(A;OICI;FA;;;${hostSid})`])
    const after = String(runDirect(["inspect-acl", "--path", dir]).ownerSid ?? "")
    console.log(
      JSON.stringify({
        label,
        sid,
        callOk: r.ok === true,
        stage: r.stage ?? null,
        errorCode: r.errorCode ?? null,
        ownerBefore: before,
        ownerAfter: after,
        ownerActuallyChanged: after !== before,
        ownerIsWhatWeAsked: after.toUpperCase() === sid.toUpperCase(),
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
