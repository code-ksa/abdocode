/**
 * 10-11 (مقيس: desk-uia-live يسقط حين يسرق «Claude» المقدّمةَ وسطَ الكتابة — الحروفُ الباقية تذهب إلى النافذة الأخرى، والحقلُ لا يتغيّر).
 *  • حقلُ تحريرٍ أصليٌّ مركَّز يُكتب برسالةٍ إليه مباشرةً (EM_REPLACESEL / WM_SETTEXT) — المقدّمةُ لا تغيّرها.
 *  • وغيرُه بمفاتيح محروسة تتوقّف لحظةَ تحرّك المقدّمة، ويُقال كم حرفاً وصل — لا حرفَ في النافذة الأخرى.
 *  • النقرةُ داخل مستطيل النافذة قد تقع على نافذةِ تطبيقٍ آخر يغطّيها — تُرفض باسمه؛ والنقرةُ الناجحة تقول ما أصابت.
 */
import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { desktopScript, hitLabel, runDesktop, type DesktopBound, type DesktopRunner } from "../src/desktop-control"

const BOUND: DesktopBound = { hwnd: 42, title: "Notes app", left: 0, top: 0, right: 800, bottom: 600 }
const body = (s: string) => s.slice(s.indexOf("function Out-Json"))
const answer = (json: Record<string, unknown>): DesktopRunner => ({ async run(script) {
  if (script.includes("$released = [AbdoDesk]::ReleaseHeld()")) return { code: 0, stdout: JSON.stringify({ ok: true, released: "" }), stderr: "" }
  return { code: 0, stdout: JSON.stringify(json), stderr: "" }
} })
const shots = () => mkdtempSync(join(tmpdir(), "abdo-desk-focus-"))

test("type: a focused native edit gets the text by message; anything else types with keys that stop when focus moves", () => {
  const s = body(desktopScript({ kind: "type", text: "سطر\nثانٍ" }, "", BOUND))
  const edit = s.indexOf("$edit = [AbdoDesk]::FocusedEdit($want)"), message = s.indexOf("SendMessageText($edit, 0x00C2"), keys = s.indexOf("[AbdoDesk]::TypeGuarded($want, $text)")
  expect(edit).toBeGreaterThan(0); expect(message).toBeGreaterThan(edit); expect(keys).toBeGreaterThan(message)
  expect(s).not.toContain("[AbdoDesk]::Unicode($ch)")
  const prelude = desktopScript({ kind: "type", text: "x" }, "", BOUND)
  expect(prelude).toContain("if (GetForegroundWindow() != want) return n;")
})

test("set: a native edit is replaced with WM_SETTEXT before any keystroke fallback", () => {
  const ui = { depth: 8, elements: [{ ref: 3, type: "Edit", name: "", id: "", x: 1, y: 1, w: 10, h: 10, patterns: [], enabled: true, password: false }] }
  const s = body(desktopScript({ kind: "set", ref: 3, text: "set by ref" }, "", BOUND, ui))
  const settext = s.indexOf("if ($nh -ne 0) { [void][AbdoDesk]::SendMessageText([IntPtr]$nh, 0x000C"), fallback = s.indexOf("[void][AbdoDesk]::TypeGuarded($want, $text); $how = 'typed'")
  expect(settext).toBeGreaterThan(0); expect(fallback).toBeGreaterThan(settext)
})

test("focus moved mid-typing: the receipt says how much landed and what is left, and that nothing went to the other window", async () => {
  const r = await runDesktop({ kind: "type", text: "hello world" }, { shotsDir: shots(), runner: answer({ ok: false, blocked: false, moved: true, chars: 11, typed: 4, how: "keys", foreground: "Claude" }), bound: BOUND, selfPids: [] })
  expect(r.ok).toBe(false)
  expect(r.text).toContain("كُتب 4 من 11 حرفاً")
  expect(r.text).toContain("لم يُكتب شيءٌ في النافذة الأخرى")
  expect(r.text).toContain("«o world»")
})

test("the twin: a full typing by message reports the whole text and how it was written", async () => {
  const r = await runDesktop({ kind: "type", text: "hello world" }, { shotsDir: shots(), runner: answer({ ok: true, blocked: false, moved: false, chars: 11, typed: 11, how: "edit-message", foreground: "Notes app" }), bound: BOUND, selfPids: [] })
  expect(r.ok, r.text).toBe(true)
  expect(r.text).toContain("كتبتُ 11 حرفاً")
  expect(r.text).toContain("برسالةٍ إلى الحقل المركَّز مباشرةً")
})

test("click: the pixel owner is checked before the cursor moves; a covered point is refused by the covering window's name", async () => {
  const s = body(desktopScript({ kind: "click", x: 10, y: 10, button: "left" }, "", BOUND))
  expect(s.indexOf("[AbdoDesk]::PidAt($sx, $sy) -ne $wantPid")).toBeGreaterThan(0)
  expect(s.indexOf("[AbdoDesk]::PidAt($sx, $sy) -ne $wantPid")).toBeLessThan(s.indexOf("[AbdoDesk]::SetCursorPos($sx, $sy)"))
  const r = await runDesktop({ kind: "click", x: 10, y: 10, button: "left" }, { shotsDir: shots(), runner: answer({ ok: false, error: "covered", cover: "Teams — call" }), bound: BOUND, selfPids: [] })
  expect(r.ok).toBe(false)
  expect(r.text).toContain("تغطّيها نافذةُ تطبيقٍ آخر «Teams — call»")
})

test("the twin: a clean click says what it hit", async () => {
  const r = await runDesktop({ kind: "click", x: 10, y: 10, button: "left" }, { shotsDir: shots(), runner: answer({ ok: true, blocked: false, moved: false, asked: 2, accepted: 2, foreground: "Notes app", hit: "WindowsForms10.BUTTON.app.0.1|Probe button" }), bound: BOUND, selfPids: [] })
  expect(r.ok, r.text).toBe(true)
  expect(r.text).toContain("أصابت [Button «Probe button»]")
  expect(hitLabel("")).toBe("")
})
