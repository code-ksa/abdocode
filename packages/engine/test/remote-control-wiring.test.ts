// م5 — أسلاكُ عبدو ريموت كونترول في المحرّك والعقد والواجهة: المفتاحُ في قائمة السماح، البثُّ من emit، الطابورُ مدموجٌ مع stdin،
// الأُطرُ الجديدة في العقد، وصفحةُ الإعدادات تحمل المفتاحَ والرمز.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { validateShellFrame } from "../../transport-contracts/src/shell-protocol"

const cli = readFileSync(resolve(import.meta.dir, "../src/cli.ts"), "utf8")
const surfaces = readFileSync(resolve(import.meta.dir, "../../desktop/ui/native-settings-surfaces.js"), "utf8")

describe("remote control wiring", () => {
  test("engine: setting key + validator, emit broadcasts, stdin merged with the remote queue, start on hello and on settings-set", () => {
    expect(cli).toContain('"updateCheckEnabled", "remoteControlEnabled", "memorySearchEnabled"')
    expect(cli).toContain('typeof value.remoteControlEnabled !== "boolean") return "remoteControlEnabled يحتاج قيمة منطقية"')
    expect(cli).toMatch(/const emit = \(frame: object\) => \{\r?\n\s+if \(framedStdio\)[^\n]*\r?\n\s+else console\.log[^\n]*\r?\n\s+remote\?\.broadcast\(frame as Record<string, unknown>\)/u)
    expect(cli).toContain("for await (const incoming of mergeFrames(shellInputFrames(), remoteQueue)) {")
    expect(cli).toContain("if (loadSettings().remoteControlEnabled === true) void syncRemoteControl(true)")
    expect(cli).toContain('if (Object.prototype.hasOwnProperty.call(patch, "remoteControlEnabled")) void syncRemoteControl(next.remoteControlEnabled === true)')
    expect(cli).toContain('if (frame.kind === "remote-control-get" || frame.kind === "remote-control-regenerate") {')
    // الطابورُ يُدفع إليه من onFrame وحده — لا مسارَ آخر يُدخل إطاراً من الشبكة
    expect(cli.match(/remoteQueue\.push\(/gu)?.length).toBe(1)
  })
  test("protocol: the two inbound frames validate and the outbound status frame is owned", () => {
    expect(validateShellFrame({ kind: "remote-control-get" })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "remote-control-get", requestId: "r-1" })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "remote-control-get", requestId: "bad id!" }).ok).toBe(false)
    expect(validateShellFrame({ kind: "remote-control-regenerate" })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "remote-control-regenerate", extra: 1 }).ok).toBe(false)
  })
  test("desktop settings: a Remote control panel with the toggle, the code, a regenerate action and status intake", () => {
    expect(surfaces).toContain("addPanel('nss-remote'")
    expect(surfaces).toContain("applyRuntimeSettings({remoteControlEnabled:")
    expect(surfaces).toContain("kind:'remote-control-get'")
    expect(surfaces).toContain("kind:'remote-control-regenerate'")
    expect(surfaces).toMatch(/f\?\.kind==='remote-control'/u)
  })
})
