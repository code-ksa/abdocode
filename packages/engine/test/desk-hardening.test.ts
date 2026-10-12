/**
 * 10-11 — تقويةُ التحكّم بالكمبيوتر بأفكار برنامج «Desktop Remote Control» (برنامجُ تحكّمٍ عن بُعد):
 *  • قائمةُ سماحٍ كاملة للوحة (F13–F24، لوحةُ الأرقام، الرموز، الوسائط) — كانت «ctrl+minus» و«ctrl+/» تُرفض «مفتاحٌ مجهول».
 *  • تنظيفُ نصّ الكتابة من محارف التحكّم الخفيّة قبل حقنه.
 * • releaseAll: حقنٌ قُطع بين الضغط والإفلات يترك Ctrl أو الزرَّ مضغوطاً على جهاز المستخدم — يُحرَّر ويُقال، وتركيبُ المفاتيح والسحبُ في try/finally.
 */
import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanTypedText, desktopScript, parseDesktopCommand, releaseHeldInput, RELEASE_HELD_SCRIPT, runDesktop, type DesktopBound, type DesktopRunner } from "../src/desktop-control"

const BOUND: DesktopBound = { hwnd: 42, title: "Notepad", left: 0, top: 0, right: 800, bottom: 600 }

test("the full key allowlist: symbols, numpad, F13–F24 and media keys parse; symbols map to their names", () => {
  expect(parseDesktopCommand("key ctrl+-")).toEqual({ kind: "key", combo: "ctrl+minus" })
  expect(parseDesktopCommand("key ctrl+/")).toEqual({ kind: "key", combo: "ctrl+slash" })
  expect(parseDesktopCommand("key ctrl+plus")).toEqual({ kind: "key", combo: "ctrl+plus" })
  for (const ok of ["key f13", "key numpad5", "key volumeup", "key shift+f24", "key ctrl+bracketleft", "key alt+backquote", "key mediaplaypause"]) expect("error" in parseDesktopCommand(ok)).toBe(false)
  const s = desktopScript({ kind: "key", combo: "ctrl+minus" }, "", BOUND)
  expect(s).toContain("[AbdoDesk]::KeyDown(189)")
})

test("the twin: an unknown key name is still refused by name", () => {
  for (const bad of ["key ctrl+meta", "key hyper", "key ctrl++"]) expect("error" in parseDesktopCommand(bad)).toBe(true)
})

test("typed text loses hidden control characters but keeps lines and tabs; a tab is pressed as the Tab key", () => {
  expect(cleanTypedText("a\u0000b\u0007c\u001bd\u007fe")).toBe("abcde")
  expect(cleanTypedText("line1\nline2\tcol")).toBe("line1\nline2\tcol")
  expect(parseDesktopCommand("type \u0000\u0007")).toEqual({ error: "desk type يحتاج نصّاً" })
  // 10-11 — المفاتيحُ في TypeGuarded (الرأس) تتوقّف إن تحرّكت المقدّمة؛ والجدولةُ مفتاحُ Tab فيه.
  const typeScript = desktopScript({ kind: "type", text: "a\tb" }, "", BOUND)
  expect(typeScript).toContain("[AbdoDesk]::TypeGuarded($want, $text)")
  expect(typeScript).toContain("else if (ch == (char)9) { KeyDown(9); KeyUp(9); }")
})

test("key combos and drags release what they press even when the injection throws midway (try/finally)", () => {
  const key = desktopScript({ kind: "key", combo: "ctrl+shift+s" }, "", BOUND)
  const open = key.indexOf("try { [AbdoDesk]::KeyDown(17)"), fin = key.indexOf("} finally { [AbdoDesk]::KeyUp(16); [AbdoDesk]::KeyUp(17)")
  expect(open).toBeGreaterThan(0); expect(fin).toBeGreaterThan(open)
  const drag = desktopScript({ kind: "drag", x1: 10, y1: 20, x2: 300, y2: 400 }, "", BOUND)
  expect(drag.indexOf("} finally { [AbdoDesk]::MouseButton(0x0004) }")).toBeGreaterThan(drag.indexOf("MouseButton(0x0002)"))
  expect(RELEASE_HELD_SCRIPT).toContain("[AbdoDesk]::ReleaseHeld()")
  expect(RELEASE_HELD_SCRIPT).toContain("GetAsyncKeyState")
})

function recorder(first: { stdout: string; timedOut?: boolean; code?: number }) {
  const scripts: string[] = []
  const runner: DesktopRunner = { async run(script) {
    scripts.push(script)
    if (script.includes("$released = [AbdoDesk]::ReleaseHeld()")) return { code: 0, stdout: JSON.stringify({ ok: true, released: "vk17,left" }), stderr: "" }
    return { code: first.code ?? 0, stdout: first.stdout, stderr: "", ...(first.timedOut === undefined ? {} : { timedOut: first.timedOut }) }
  } }
  return { runner, scripts }
}

test("an injection cut by its timeout releases whatever stayed pressed and says so", async () => {
  const { runner, scripts } = recorder({ stdout: "", timedOut: true, code: 1 })
  const r = await runDesktop({ kind: "key", combo: "ctrl+s" }, { shotsDir: mkdtempSync(join(tmpdir(), "abdo-desk-")), runner, bound: BOUND, selfPids: [] })
  expect(r.ok).toBe(false)
  expect(scripts.some((s) => s.includes("$released = [AbdoDesk]::ReleaseHeld()"))).toBe(true)
  expect(r.text).toContain("حُرِّر ما بقي مضغوطاً بعد الانقطاع: vk17,left")
})

test("the twin: a clean injection runs no release pass", async () => {
  const { runner, scripts } = recorder({ stdout: JSON.stringify({ ok: true, blocked: false, moved: false, asked: 4, accepted: 4, foreground: "Notepad", combo: "ctrl+s" }) })
  const r = await runDesktop({ kind: "key", combo: "ctrl+s" }, { shotsDir: mkdtempSync(join(tmpdir(), "abdo-desk-")), runner, bound: BOUND, selfPids: [] })
  expect(r.ok, r.text).toBe(true)
  expect(scripts.length).toBe(1)
  expect(await releaseHeldInput({ async run() { return { code: 0, stdout: JSON.stringify({ ok: true, released: "" }), stderr: "" } } })).toBe("")
})
