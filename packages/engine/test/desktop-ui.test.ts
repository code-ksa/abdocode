import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WIN32_PRELUDE, defaultSelfPids, desktopScript, parseDesktopCommand, renderUiElement, runDesktop, timeoutFor, uiElementWorthShowing, type DesktopBound, type DesktopRunner, type UiContext, type UiElement } from "../src/desktop-control"

// م6 (مقيس 2026-09-14 على شاشة 150٪): اللقطةُ كانت تلتقط المنطقةَ الخطأ لأنّ PowerShell غيرُ واعٍ بالـDPI، وعناوينُ النوافذ العربيّة تصل «????».
// م6ب: شجرةُ الواجهة بـUI Automation (ui/set/press) — الطريقُ الحتميّ قبل الرؤية على واجهةٍ لم يرها النموذج. الحيُّ في desk-uia-live.test.ts.

const BOUND: DesktopBound = { hwnd: 4242, title: "AbdoDeskProbe", left: 830, top: 449, right: 1730, bottom: 1079 }
const ELEMENTS: readonly UiElement[] = [
  { ref: 1, type: "Button", name: "Probe button", id: "5769140", x: 87, y: 121, w: 300, h: 90, patterns: [], enabled: true, password: false },
  { ref: 2, type: "Edit", name: "", id: "1901302", x: 87, y: 241, w: 720, h: 300, patterns: ["Text"], value: "hello", enabled: true, password: false },
  { ref: 3, type: "Pane", name: "", id: "", x: -1, y: -1, w: 0, h: 0, patterns: [], enabled: true, password: false },
  { ref: 4, type: "Edit", name: "Password", id: "pw", x: 1, y: 1, w: 10, h: 10, patterns: ["Value"], enabled: true, password: true },
]
const UI: UiContext = { depth: 8, elements: ELEMENTS }
const fake = (json: unknown): DesktopRunner => ({ run: async () => ({ code: 0, stdout: `noise\n${JSON.stringify(json)}\n`, stderr: "" }) })

describe("المُحلِّل — ui/set/press والتركيزُ بـpid", () => {
  test("الأشكالُ الصحيحة", () => {
    expect(parseDesktopCommand("ui")).toEqual({ kind: "ui", depth: 8 })
    expect(parseDesktopCommand("ui 3")).toEqual({ kind: "ui", depth: 3 })
    expect(parseDesktopCommand("ui 99")).toEqual({ kind: "ui", depth: 14 })
    expect(parseDesktopCommand("set u7 مرحباً  بالعالم")).toEqual({ kind: "set", ref: 7, text: "مرحباً  بالعالم" })
    expect(parseDesktopCommand("set 2 x")).toEqual({ kind: "set", ref: 2, text: "x" })
    expect(parseDesktopCommand("press u3")).toEqual({ kind: "press", ref: 3 })
    expect(parseDesktopCommand("focus pid:4352")).toEqual({ kind: "focus", title: "pid:4352" })
    expect(parseDesktopCommand("focus \"notepad - Notepad\"")).toEqual({ kind: "focus", title: "notepad - Notepad" })
    expect(parseDesktopCommand("focus «المفكرة»")).toEqual({ kind: "focus", title: "المفكرة" })
  })
  test("المرفوض بسببٍ مسمّى", () => {
    for (const bad of ["set", "set u0 x", "set u2", "press", "press zero"]) expect("error" in parseDesktopCommand(bad)).toBe(true)
  })
})

describe("السكربت — الوعيُ بالـDPI وUTF-8 وتحديدُ pid والشجرة", () => {
  test("كلُّ سكربتٍ يبدأ بترميز UTF-8 ويعلن الوعيَ بالـDPI قبل أوّل نداء Win32", () => {
    expect(WIN32_PRELUDE).toContain("[Console]::OutputEncoding = [Text.Encoding]::UTF8")
    expect(WIN32_PRELUDE).toContain("SetProcessDpiAwarenessContext((New-Object IntPtr (-4)))")
    expect(WIN32_PRELUDE).toContain("SetProcessDPIAware()")
    // الترتيب: الوعيُ بالـDPI بعد Add-Type مباشرةً وقبل أيّ GetWindowRect/CopyFromScreen
    const dpiAt = WIN32_PRELUDE.indexOf("SetProcessDpiAwarenessContext((New-Object")
    expect(dpiAt).toBeGreaterThan(WIN32_PRELUDE.indexOf("Add-Type -TypeDefinition"))
    expect(desktopScript({ kind: "shot", scope: "auto" }, "C:\\x.png", BOUND).indexOf("$g.CopyFromScreen(")).toBeGreaterThan(dpiAt)
  })
  test("التركيزُ بـpid يطابق الرقمَ لا العنوان", () => {
    const s = desktopScript({ kind: "focus", title: "pid:4352" })
    expect(s).toContain("$needle -match '^pid:(\\d+)$'")
    expect(s).toContain("$_.pid -eq $wantPid")
  })
  test("ui يمشي الشجرة بالعمق والسقف ويصنّف Pane القديمة بصنف النافذة", () => {
    const s = desktopScript({ kind: "ui", depth: 5 }, "", BOUND)
    expect(s).toContain("Walk-Ui $rootEl 1 5 400")
    expect(s).toContain("function Ui-Type")
    expect(s).toContain("if ($cn -match 'EDIT|RICHEDIT|TEXTBOX') { return 'Edit' }")
    expect(s).toContain("if (-not $cur.IsPassword)") // لا قيمةَ لكلمة مرور
  })
  test("set يستبدل لا يُلحق (EM_SETSEL للمقبض الأصليّ، Ctrl+A لغيره) ويقرأ راجعاً", () => {
    const s = desktopScript({ kind: "set", ref: 2, text: "abc" }, "", BOUND, UI)
    expect(s).toContain("$idx = 1")
    expect(s).toContain("SendMessage([IntPtr]$nh, 0x00B1, [IntPtr]::Zero, (New-Object IntPtr (-1)))")
    expect(s).toContain("[AbdoDesk]::KeyDown(17); [AbdoDesk]::KeyDown(65)")
    expect(s).toContain("$verified = ($null -ne $readback)")
    expect(s).toContain("$expType = 'Edit'")
  })
  test("press يفضّل أنماطَ النظام ويسقط إلى نقرةٍ في المركز", () => {
    const s = desktopScript({ kind: "press", ref: 1 }, "", BOUND, UI)
    expect(s).toContain("InvokePattern]::Pattern, [ref]$ip)) { $ip.Invoke(); $how = 'invoke' }")
    expect(s).toContain("$how = 'click-center'")
    expect(s).toContain("$expName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from("Probe button").toString("base64") + "'))")
  })
  test("حارسُ المقدّمة يرفع النافذةَ المربوطة حين يكون السارقُ تطبيقَنا نحن، ويرفض غيرَه — مقيس: «focus moved (AbdoCode)» بين نداءين", () => {
    const ours = desktopScript({ kind: "type", text: "x" }, "", BOUND, undefined, [4242, 9999])
    expect(ours).toContain("$selfPids = @(4242, 9999)")
    // ن7 (09-16): الرفعُ لأيّ سارقٍ مقصورٌ على اللقطة ($raiseAny)؛ للحقن يبقى شرطُ pid تطبيقِنا.
    expect(ours).toContain("if ($raiseAny -or ($selfPids -contains [int]$fpid)) { [void][AbdoDesk]::Focus($want)")
    expect(ours).toContain("$raiseAny = $false")
    expect(ours.indexOf("$selfPids -contains")).toBeLessThan(ours.indexOf("error = 'focus moved'"))
    const none = desktopScript({ kind: "type", text: "x" }, "", BOUND)
    expect(none).toContain("$selfPids = @()")
    // اللقطةُ المقيَّدة بالنافذة تمرّ بالحارس نفسِه لا بفحصٍ ثانٍ منسوخ
    expect(desktopScript({ kind: "shot", scope: "auto" }, "C:\\x.png", BOUND, undefined, [1])).toContain("$selfPids = @(1)")
    expect(defaultSelfPids()).toContain(process.pid)
  })
  test("ب1/ب2 — عقدُ القناة: ويندوز، ولينكس قناةٌ حيّة (09-16)، وWSLg من ويندوز بمتغيّر البيئة، وmacOS رفضٌ مسمّى لا سقوطٌ صامت", async () => {
    const { desktopBackendFor, windowsBackend } = await import("../src/desktop-control")
    expect(desktopBackendFor("win32", {})).toBe(windowsBackend)
    const linux = desktopBackendFor("linux", {})
    expect("error" in linux).toBe(false)
    if (!("error" in linux)) { expect(linux.id).toBe("linux-x11"); expect(linux.label).toContain("xdotool") }
    const wsl = desktopBackendFor("win32", { ABDO_DESKTOP_CHANNEL: "wsl:Ubuntu-24.04" })
    if (!("error" in wsl)) { expect(wsl.id).toBe("linux-x11"); expect(wsl.label).toContain("WSLg (Ubuntu-24.04)") } else throw new Error(wsl.error)
    expect(desktopBackendFor("win32", { ABDO_DESKTOP_CHANNEL: "wsl:bad name" })).toBe(windowsBackend) // قيمةٌ مشوَّهة لا تُصدَّق
    const mac = desktopBackendFor("darwin", {})
    expect("error" in mac && mac.error).toContain("darwin")
    const runner: DesktopRunner = { run: async () => ({ code: 0, stdout: JSON.stringify({ ok: true, windows: [] }), stderr: "" }) }
    const tmp = mkdtempSync(join(tmpdir(), "desk-backend-"))
    const r = await windowsBackend.run({ kind: "windows" }, { shotsDir: tmp, runner })
    rmSync(tmp, { recursive: true, force: true })
    expect(r.ok).toBe(true)
  })
  test("المهلُ من نوع العمل", () => {
    expect(timeoutFor({ kind: "ui", depth: 8 })).toBe(45_000)
    expect(timeoutFor({ kind: "set", ref: 1, text: "x".repeat(100) })).toBe(25_000 + 3000)
  })
})

describe("runDesktop — المراجعُ والصدق", () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-ui-"))
  test("set/press بلا شجرةٍ أو بمرجعٍ مجهول يُرفضان قبل أيّ سكربت", async () => {
    let ran = 0
    const runner: DesktopRunner = { run: async () => { ran += 1; return { code: 0, stdout: "{}", stderr: "" } } }
    expect((await runDesktop({ kind: "set", ref: 1, text: "x" }, { shotsDir: dir, runner, bound: BOUND })).text).toContain("desk ui")
    expect((await runDesktop({ kind: "press", ref: 99 }, { shotsDir: dir, runner, bound: BOUND, ui: UI })).text).toContain("u99")
    expect((await runDesktop({ kind: "ui", depth: 8 }, { shotsDir: dir, runner })).text).toContain("desk focus")
    expect(ran).toBe(0)
  })
  test("ui يعيد العناصرَ ويطوي الهيكليّ ويسمّي حقلَ كلمة المرور", async () => {
    const r = await runDesktop({ kind: "ui", depth: 8 }, { shotsDir: dir, runner: fake({ ok: true, count: 4, capped: false, width: 900, height: 630, elements: ELEMENTS.map((e) => ({ ...e })) }), bound: BOUND })
    expect(r.ok).toBe(true)
    expect(r.elements?.length).toBe(4)
    expect(r.text).toContain("u1 [Button] «Probe button»")
    expect(r.text).toContain('u2 [Edit] #1901302 = "hello"')
    expect(r.text).not.toContain("u3 [Pane]")
    expect(r.text).toContain("u4 [Edit] «Password» #pw @(1,1 10×10) {Value} (كلمة مرور — لا تُقرأ)")
    expect(ELEMENTS.filter(uiElementWorthShowing).map((e) => e.ref)).toEqual([1, 2, 4])
    expect(renderUiElement(ELEMENTS[2]!)).toContain("(خارج الشاشة)")
  })
  test("focus بلا مطابقة يحمل النوافذَ الظاهرة بدل «لا نافذة» وحدها — مقيس: النموذجُ خمّن العنوانَ ثلاثَ مرّات", async () => {
    const r = await runDesktop({ kind: "focus", title: "Untitled - Notepad" }, { shotsDir: dir, runner: fake({ ok: false, error: "no window matches", count: 12, windows: [{ title: "notepad - Notepad", pid: 24564 }, { title: "عبدو كود", pid: 15512 }] }) })
    expect(r.ok).toBe(false)
    expect(r.text).toContain("«notepad - Notepad» pid 24564")
    expect(r.text).toContain("«عبدو كود» pid 15512")
    expect(r.text).toContain("pid:")
    expect(desktopScript({ kind: "focus", title: "x" })).toContain("windows = $seen")
  })
  test("open — مقيس: «Pick an app» ظهرت بعد run notepad ولم يعرف النموذجُ بها: الإقلاعُ بـShellExecute، ربطُ النافذة، وتسميةُ ما ظهر معها", async () => {
    expect(parseDesktopCommand("open notepad")).toEqual({ kind: "open", app: "notepad" })
    expect(parseDesktopCommand("open \"C:\\Program Files\\App\\app.exe\"")).toEqual({ kind: "open", app: "C:\\Program Files\\App\\app.exe" })
    expect("error" in parseDesktopCommand("open notepad | calc")).toBe(true)
    const s = desktopScript({ kind: "open", app: "notepad" })
    expect(s).toContain("Start-Process -FilePath $app -PassThru")
    expect(s).toContain("Start-Process -FilePath ($app + '.exe')") // اسمٌ بلا لاحقة يُعاد بـ.exe
    expect(s).toContain("$fresh = @($list | Where-Object { -not $before.ContainsKey([string]$_.hwnd) })")
    expect(s).toContain("$existing = $true") // مفكرةُ ويندوز ١١ تفتح تبويباً في نافذتها القائمة
    const r = await runDesktop({ kind: "open", app: "notepad" }, { shotsDir: dir, runner: fake({ ok: true, focused: true, existing: false, hwnd: 77, title: "Untitled - Notepad", pid: 5, left: 0, top: 0, right: 900, bottom: 600, launchedPid: 5, others: [{ title: "Pick an app", pid: 9, hwnd: 78 }] }) })
    expect(r.ok).toBe(true)
    expect(r.bound?.hwnd).toBe(77)
    expect(r.text).toContain("«Pick an app» pid 9")
    expect(r.text).toContain("desk focus pid:")
    const gone = await runDesktop({ kind: "open", app: "nope" }, { shotsDir: dir, runner: fake({ ok: false, error: "could not start: not found" }) })
    expect(gone.ok).toBe(false)
  })
  test("windows يسمّي ما ظهر منذ آخر عدّ «جديدة»", async () => {
    const w = (hwnd: number, title: string) => ({ hwnd, pid: 1, title, left: 0, top: 0, right: 100, bottom: 50 })
    const r = await runDesktop({ kind: "windows" }, { shotsDir: dir, runner: fake({ ok: true, windows: [w(1, "Notepad"), w(2, "Pick an app")] }), knownHwnds: [1] })
    expect(r.text).toContain("«Pick an app» [100×50] pid 1 (جديدة)")
    expect(r.text).toContain("«Notepad» [100×50] pid 1\n")
    expect(r.text).toContain("منها 1 ظهرت منذ آخر عدّ")
    const first = await runDesktop({ kind: "windows" }, { shotsDir: dir, runner: fake({ ok: true, windows: [w(1, "Notepad")] }) })
    expect(first.text).not.toContain("جديدة")
  })
  test("شجرةٌ فارغة تُحيل إلى الرؤية بدل الادّعاء", async () => {
    const r = await runDesktop({ kind: "ui", depth: 8 }, { shotsDir: dir, runner: fake({ ok: true, count: 0, elements: [], width: 1, height: 1 }), bound: BOUND })
    expect(r.text).toContain("desk shot")
  })
  test("set: القراءةُ الراجعة غيرُ المطابقة فشلٌ مسمّى لا نجاحٌ مُجمَّل — والمطابقةُ نجاح", async () => {
    const bad = await runDesktop({ kind: "set", ref: 2, text: "abc" }, { shotsDir: dir, runner: fake({ ok: true, how: "typed", verified: false, readback: "helloabc", name: "", type: "Edit" }), bound: BOUND, ui: UI })
    expect(bad.ok).toBe(false)
    expect(bad.text).toContain("helloabc")
    const good = await runDesktop({ kind: "set", ref: 2, text: "abc" }, { shotsDir: dir, runner: fake({ ok: true, how: "value-pattern", verified: true, readback: "abc", name: "", type: "Edit" }), bound: BOUND, ui: UI })
    expect(good.ok).toBe(true)
    expect(good.text).toContain("مطابقة")
    const pw = await runDesktop({ kind: "set", ref: 4, text: "s3cret" }, { shotsDir: dir, runner: fake({ ok: true, how: "value-pattern", verified: false, readback: null, password: true, name: "Password", type: "Edit" }), bound: BOUND, ui: UI })
    expect(pw.ok).toBe(true)
    expect(pw.text).not.toContain("s3cret")
  })
  test("الواجهةُ التي تغيّرت منذ desk ui تُرفض باسمها", async () => {
    const r = await runDesktop({ kind: "press", ref: 1 }, { shotsDir: dir, runner: fake({ ok: false, error: "the UI changed since desk ui - run desk ui again", nowType: "Edit", nowName: "" }), bound: BOUND, ui: UI })
    expect(r.ok).toBe(false)
    expect(r.text).toContain("UI changed")
  })
  rmSync(dir, { recursive: true, force: true })
})
