import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { desktopScript, parseDesktopCommand, powershellRunner, pruneShots, runDesktop, timeoutFor, withinWindow, type DesktopBound, type DesktopRunner } from "../src/desktop-control"

// ب6 — كومبيوتر-يوس على النظام: المُحلِّل والسكربتُ والحدُّ نقيّةٌ وتُختبر بمشغّلٍ زائف؛ واللقطةُ والنوافذُ تُقاسان على ويندوز الحقيقيّ
// (PowerShell + Win32) بلا حقنِ إدخالٍ في جلسة المستخدم — والحقنُ نفسُه يُقاس بالأثر في `desk-window-live.test.ts` على نافذةٍ نملكها.
// ب6ب: الحدُّ صار **مقبضَ نافذةٍ يُتحقَّق منه داخل السكربت قبل أوّل حرف**، والإحداثيّاتُ من زاوية النافذة، وعائدُ SendInput يُقاس.

const BOUND: DesktopBound = { hwnd: 4242, title: "دفترٌ — Notepad", left: 100, top: 50, right: 900, bottom: 650 }

describe("مُحلِّلُ أوامر desk", () => {
  test("الأشكالُ الصحيحة", () => {
    expect(parseDesktopCommand("shot")).toEqual({ kind: "shot", scope: "auto" })
    expect(parseDesktopCommand("shot screen")).toEqual({ kind: "shot", scope: "screen" })
    expect(parseDesktopCommand("windows")).toEqual({ kind: "windows" })
    expect(parseDesktopCommand("focus Visual Studio Code")).toEqual({ kind: "focus", title: "Visual Studio Code" })
    expect(parseDesktopCommand("click 120 340")).toEqual({ kind: "click", x: 120, y: 340, button: "left" })
    expect(parseDesktopCommand("click 5 5 double")).toEqual({ kind: "click", x: 5, y: 5, button: "double" })
    expect(parseDesktopCommand("type مرحباً بالعالم")).toEqual({ kind: "type", text: "مرحباً بالعالم" })
    expect(parseDesktopCommand("key ctrl+s")).toEqual({ kind: "key", combo: "ctrl+s" })
    expect(parseDesktopCommand("key Alt + F4")).toEqual({ kind: "key", combo: "alt+f4" })
    expect(parseDesktopCommand("scroll down 5")).toEqual({ kind: "scroll", direction: "down", count: 5 })
  })
  test("المرفوض بسببٍ مسمّى", () => {
    for (const bad of ["", "dance", "click x y", "click -1 2", "key ctrl+meta", "scroll sideways", "type"]) expect("error" in parseDesktopCommand(bad)).toBe(true)
    expect((parseDesktopCommand("key ctrl+meta") as { error: string }).error).toContain("meta")
  })
  // ب6ب — النصُّ يُكتب كما وافق عليه المستخدم: ربطُ الكلمات كان يطوي الفراغات ويمنع السطر الجديد أصلاً.
  test("نصُّ type خامٌ: الفراغاتُ المتعدّدة تبقى، والسطرُ الجديد يصل", () => {
    expect(parseDesktopCommand("type a    b")).toEqual({ kind: "type", text: "a    b" })
    expect(parseDesktopCommand("type سطرٌ\nثانٍ")).toEqual({ kind: "type", text: "سطرٌ\nثانٍ" })
    expect(parseDesktopCommand("type  بادئةٌ مسبوقةٌ بفراغين")).toEqual({ kind: "type", text: "بادئةٌ مسبوقةٌ بفراغين" })
  })
})

describe("السكربتُ المُنتَج", () => {
  test("النقرةُ اليمنى وأزواجُ down/up، والمزدوجةُ مرّتان، والكتابةُ base64 بلا اقتباس", () => {
    // ب6ب: النقرُ يمرّ بـSendInput (MouseButton) لا mouse_event — كي يكون له عائدٌ يُقاس؛ والأعلامُ هي هي.
    const right = desktopScript({ kind: "click", x: 10, y: 20, button: "right" }, "", BOUND)
    expect(right).toContain("MouseButton(0x0008")
    expect(right).toContain("MouseButton(0x0010")
    expect(desktopScript({ kind: "click", x: 1, y: 1, button: "double" }, "", BOUND).match(/MouseButton\(0x0002/g)).toHaveLength(2)
    const typed = desktopScript({ kind: "type", text: "it's \"quoted\" $var `tick`" }, "", BOUND)
    expect(typed).not.toContain("$var")
    expect(typed).toContain("FromBase64String('")
    expect(typed).toContain("Unicode($ch)")
  })
  test("المفاتيح: المعدِّلات تُضغط أوّلاً وتُحرَّر آخراً بترتيبٍ معكوس", () => {
    const s = desktopScript({ kind: "key", combo: "ctrl+shift+s" }, "", BOUND)
    const order = [...s.matchAll(/Key(Down|Up)\((\d+)\)/g)].map((m) => `${m[1]}${m[2]}`)
    expect(order).toEqual(["Down17", "Down16", "Down83", "Up83", "Up16", "Up17"])
    expect(desktopScript({ kind: "key", combo: "enter" }, "", BOUND)).toContain("KeyDown(13)")
  })
  test("اللقطةُ تُحفظ في المسار المعطى والتمريرُ بعجلة ±120", () => {
    expect(desktopScript({ kind: "shot", scope: "auto" }, "C:/x/y's.png")).toContain("$bmp.Save('C:/x/y''s.png'")
    expect(desktopScript({ kind: "scroll", direction: "up", count: 2 }, "", BOUND)).toContain("Wheel(120)")
    expect(desktopScript({ kind: "scroll", direction: "down", count: 2 }, "", BOUND)).toContain("Wheel(-120)")
  })

  // ب6ب — **الترتيب جزءٌ من الميزة**: الحارسُ الذي يعمل بعد الحقن ليس حارساً.
  test("حارسُ المقدّمة يسبق كلَّ حقنٍ في السكربت نفسِه، ويخرج قبله", () => {
    for (const action of [
      { kind: "type", text: "س" },
      { kind: "key", combo: "enter" },
      { kind: "scroll", direction: "down", count: 1 },
      { kind: "click", x: 5, y: 5, button: "left" },
    ] as const) {
      // القياسُ على **جسم** السكربت لا على رأس Win32: أسماءُ الدوالّ تُعرَّف في الرأس قبل كلّ شيء، فالترتيبُ هناك لا يعني شيئاً.
      const whole = desktopScript(action, "", BOUND)
      const s = whole.slice(whole.indexOf("function Out-Json"))
      const guard = s.indexOf("GetForegroundWindow()")
      const exit = s.indexOf("error = 'focus moved'")
      const inject = Math.min(...["[AbdoDesk]::Unicode(", "[AbdoDesk]::KeyDown(", "[AbdoDesk]::Wheel(", "[AbdoDesk]::MouseButton(", "[AbdoDesk]::SetCursorPos("].map((m) => { const i = s.indexOf(m); return i < 0 ? Number.MAX_SAFE_INTEGER : i }))
      expect(`${action.kind}: guard ${guard > -1} inject ${inject < Number.MAX_SAFE_INTEGER}`).toBe(`${action.kind}: guard true inject true`)
      expect(guard).toBeLessThan(inject)
      expect(exit).toBeLessThan(inject)
      expect(s).toContain(`-ne ${BOUND.hwnd}`)
    }
  })
  test("النقرُ نسبيٌّ إلى زاوية النافذة ويُقاس مستطيلُها لحظتَه، والمؤشّرُ يُتحقَّق من وصوله", () => {
    const s = desktopScript({ kind: "click", x: 30, y: 40, button: "left" }, "", BOUND)
    expect(s).toContain("$sx = $r.Left + 30; $sy = $r.Top + 40")
    expect(s).toContain("GetWindowRect($want, [ref]$r)")
    expect(s).toContain("GetCursorPos([ref]$p)")
    expect(s).toContain("error = 'the cursor did not reach the point'")
    // لا إحداثيّةَ شاشةٍ مطلقةٌ تُحقن: الرقمُ الخام لا يصل SetCursorPos أبداً.
    expect(s).not.toContain("SetCursorPos(30, 40)")
  })
  test("اللقطةُ للنافذة المربوطة وحدها، و«screen» وحدها تُصوِّر سطح المكتب كلَّه", () => {
    const windowShot = desktopScript({ kind: "shot", scope: "auto" }, "C:/s.png", BOUND)
    expect(windowShot).toContain("scope = 'window'")
    expect(windowShot).toContain("CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)")
    expect(windowShot).not.toContain("VirtualScreen")
    const screenShot = desktopScript({ kind: "shot", scope: "screen" }, "C:/s.png", BOUND)
    expect(screenShot).toContain("VirtualScreen")
    expect(screenShot).toContain("scope = 'screen'")
  })
  test("التركيزُ يُتحقَّق من أنّه وقع: قفلُ المقدّمة يُقال رفضاً لا نجاحاً", () => {
    const s = desktopScript({ kind: "focus", title: "دفتر" }, "")
    expect(s).toContain("error = 'could not bring the window to the front'")
    expect(s.indexOf("SetForegroundWindow")).toBeLessThan(s.indexOf("could not bring the window"))
  })
  test("عائدُ SendInput يُجمَع فيُعرَف المحجوب", () => {
    const s = desktopScript({ kind: "type", text: "x" }, "", BOUND)
    expect(s).toContain("accepted += SendInput(")
    expect(s).toContain("blocked = [AbdoDesk]::Accepted() -lt [AbdoDesk]::Asked()")
  })
})

describe("runDesktop بمشغّلٍ زائف", () => {
  const fake = (stdout: string, code = 0): DesktopRunner => ({ run: async () => ({ code, stdout, stderr: "" }) })
  test("بلا نافذةٍ مربوطة لا يُحقن إدخالٌ أصلاً — الغيابُ رفضٌ لا إذن", async () => {
    for (const action of [
      { kind: "type", text: "سرّ" },
      { kind: "key", combo: "enter" },
      { kind: "scroll", direction: "down", count: 1 },
      { kind: "click", x: 5, y: 5, button: "left" },
    ] as const) {
      let ran = false
      const runner: DesktopRunner = { run: async () => { ran = true; return { code: 0, stdout: '{"ok":true}', stderr: "" } } }
      const out = await runDesktop(action, { shotsDir: tmpdir(), runner })
      expect(`${action.kind}: ${out.ok} ${ran}`).toBe(`${action.kind}: false false`)
      expect(out.text).toContain("desk focus")
    }
  })
  test("حدُّ النافذة يرفض النقرةَ خارجه قبل أيّ تنفيذ", async () => {
    let ran = false
    const runner: DesktopRunner = { run: async () => { ran = true; return { code: 0, stdout: '{"ok":true}', stderr: "" } } }
    const out = await runDesktop({ kind: "click", x: 900, y: 900, button: "left" }, { shotsDir: tmpdir(), runner, bound: BOUND })
    expect(out.ok).toBe(false); expect(out.text).toContain("خارج نافذة"); expect(ran).toBe(false)
    expect(withinWindow(50, 50, BOUND)).toBe(true)
    expect(withinWindow(799, 599, BOUND)).toBe(true)
    expect(withinWindow(800, 10, BOUND)).toBe(false)
  })
  test("النوافذُ تُقرأ من آخر سطر JSON، والفشلُ يُقال باسمه", async () => {
    const out = await runDesktop({ kind: "windows" }, { shotsDir: tmpdir(), runner: fake('noise\n{"ok":true,"windows":[{"hwnd":1,"pid":2,"title":"Notepad","left":0,"top":0,"right":10,"bottom":10}]}') })
    expect(out.ok).toBe(true); expect(out.windows).toHaveLength(1); expect(out.text).toContain("«Notepad»")
    const bad = await runDesktop({ kind: "focus", title: "x" }, { shotsDir: tmpdir(), runner: fake('{"ok":false,"error":"no window matches","count":3}') })
    expect(bad.ok).toBe(false); expect(bad.text).toContain("no window matches")
    const crash = await runDesktop({ kind: "scroll", direction: "up", count: 1 }, { shotsDir: tmpdir(), runner: fake("", 1), bound: BOUND })
    expect(crash.ok).toBe(false); expect(crash.text).toContain("exit 1")
  })
  // ب6ب — الأخضرُ الكاذب يُقتل: حقنٌ حجبه النظام، ومقدّمةٌ تحرّكت أثناءه، ومهلةٌ قطعته وسطَه.
  test("المحجوبُ والمتحرّكُ والمنقطعُ: ثلاثةُ أنواعِ فشلٍ تُقال بأسمائها لا «نجح»", async () => {
    const blocked = await runDesktop({ kind: "type", text: "npm run deploy" }, { shotsDir: tmpdir(), bound: BOUND, runner: fake('{"ok":false,"blocked":true,"moved":false,"asked":28,"accepted":0,"foreground":"Task Manager"}') })
    expect(blocked.ok).toBe(false); expect(blocked.text).toContain("حجب النظامُ الإدخال (0/28)"); expect(blocked.text).toContain("Task Manager")
    const moved = await runDesktop({ kind: "type", text: "سرّ" }, { shotsDir: tmpdir(), bound: BOUND, runner: fake('{"ok":false,"blocked":false,"moved":true,"asked":6,"accepted":6,"foreground":"WhatsApp"}') })
    expect(moved.ok).toBe(false); expect(moved.text).toContain("تحرّكت المقدّمة"); expect(moved.text).toContain("WhatsApp")
    const refused = await runDesktop({ kind: "key", combo: "enter" }, { shotsDir: tmpdir(), bound: BOUND, runner: fake('{"ok":false,"error":"focus moved","foreground":"Chrome"}') })
    expect(refused.ok).toBe(false); expect(refused.text).toContain("focus moved"); expect(refused.text).toContain("Chrome")
    const cut: DesktopRunner = { run: async () => ({ code: 1, stdout: "", stderr: "", timedOut: true }) }
    const timedOut = await runDesktop({ kind: "type", text: "نصٌّ طويل" }, { shotsDir: tmpdir(), bound: BOUND, runner: cut })
    expect(timedOut.ok).toBe(false); expect(timedOut.text).toContain("قد يكون جزءٌ من الإدخال وصل")
  })
  test("المهلةُ من حجم العمل: ألفا حرفٍ لا تُقطع عند العشرين ثانية", () => {
    expect(timeoutFor({ kind: "type", text: "x".repeat(2000) })).toBeGreaterThan(2000 * 8 + 20_000)
    expect(timeoutFor({ kind: "key", combo: "enter" })).toBe(20_000)
    expect(timeoutFor({ kind: "scroll", direction: "down", count: 20 })).toBeGreaterThan(20_000)
  })
  test("اللقطةُ تحمل نطاقَها، ولقطاتُ سطح المكتب لا تتراكم على القرص", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-shots-"))
    try {
      for (let i = 1; i <= 25; i += 1) writeFileSync(join(dir, `desk-${1000 + i}.png`), "x")
      writeFileSync(join(dir, "keep-me.txt"), "ليست لنا")
      expect(pruneShots(dir, 5)).toBe(20)
      expect(existsSync(join(dir, "keep-me.txt"))).toBe(true)
      expect(existsSync(join(dir, "desk-1025.png"))).toBe(true)
      expect(existsSync(join(dir, "desk-1001.png"))).toBe(false)
      const shot = await runDesktop({ kind: "shot", scope: "auto" }, { shotsDir: dir, bound: BOUND, runner: { run: async () => ({ code: 0, stdout: '{"ok":true,"scope":"window","width":800,"height":600,"left":100,"top":50,"title":"دفترٌ — Notepad"}', stderr: "" }) } })
      expect(shot.ok).toBe(true); expect(shot.shot?.scope).toBe("window"); expect(shot.text).toContain("زاوية الصورة العليا اليسرى")
      const screen = await runDesktop({ kind: "shot", scope: "screen" }, { shotsDir: dir, runner: { run: async () => ({ code: 0, stdout: '{"ok":true,"scope":"screen","width":1920,"height":1080,"left":0,"top":0}', stderr: "" }) } })
      expect(screen.shot?.scope).toBe("screen"); expect(screen.text).toContain("للنظر فقط")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe.skipIf(process.platform !== "win32")("ويندوز الحقيقيّ — قراءةٌ لا إدخال", () => {
  test("لقطةُ الشاشة ملفُّ PNG حقيقيّ، وقائمةُ النوافذ مصفوفةٌ صالحة", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-desk-"))
    try {
      const shot = await runDesktop({ kind: "shot", scope: "auto" }, { shotsDir: dir, runner: powershellRunner, timeoutMs: 40_000 })
      expect(`${shot.ok}: ${shot.text}`).toStartWith("true")
      expect(existsSync(shot.shot!.path)).toBe(true)
      expect(readFileSync(shot.shot!.path).subarray(1, 4).toString()).toBe("PNG")
      const windows = await runDesktop({ kind: "windows" }, { shotsDir: dir, runner: powershellRunner, timeoutMs: 40_000 })
      expect(`${windows.ok}: ${windows.text.slice(0, 80)}`).toStartWith("true")
      for (const w of windows.windows ?? []) { expect(typeof w.title).toBe("string"); expect(w.right).toBeGreaterThanOrEqual(w.left) }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 90_000)
})
