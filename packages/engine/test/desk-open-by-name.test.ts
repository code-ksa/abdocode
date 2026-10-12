/**
 * 10-12 (مقيس على المثبَّت 4.0.145: «ما مهاراتك في الكمبيوتر يوز تقدر تفتح انتي جرافيتي و تديله اوامر مثل كلود» ⇦ «أدوات معروضة 44/91
 * (الأساسيّة)» بلا desk، ولو عُرضت لفشل «desk open Antigravity»: ليس في PATH). .
 */
import { expect, test } from "bun:test"
import { desktopScript } from "../src/desktop-control"
import { familiesFor } from "../src/tool-exposure"

test("computer-use requests open the desktop tools — Arabic and English, by the words people actually use", () => {
  for (const ask of ["ما مهاراتك في الكمبيوتر يوز تقدر تفتح انتي جرافيتي و تديله اوامر مثل كلود", "افتح برنامج كورسير", "open the app Antigravity", "use computer use to open VS Code", "شغّل البرنامج واكتب فيه"]) {
    expect(familiesFor(ask).has("desktop"), ask).toBe(true)
  }
})

test("the twin: a plain coding request does not open the desktop tools", () => {
  expect(familiesFor("أصلح خطأ البناء في server.js").has("desktop")).toBe(false)
})

test("desk open: an app that is not on PATH is launched by its Start-menu name (shell:AppsFolder), and its window is matched by that name", () => {
  const s = desktopScript({ kind: "open", app: "Antigravity" }, "")
  const fallback = s.indexOf("if ($err.Length -gt 0 -and $app -notmatch '[\\\\/]') {")
  expect(fallback).toBeGreaterThan(0)
  expect(s).toContain("$apps = @(Get-StartApps)")
  expect(s).toContain("Start-Process ('shell:AppsFolder\\' + $found.AppID)")
  expect(s).toContain("$wantApp = ($app -replace '\\.exe$', '').ToLowerInvariant()")
  expect(s.indexOf("Out-Json @{ ok = $false; error = ('could not start: ' + $err) }")).toBeGreaterThan(fallback)
  expect(s).toContain("$needle = if ($startName.Length -gt 0) { $startName.ToLowerInvariant() }")
})

// 10-12 (مقيس على Antigravity IDE): القراءةُ الأولى لنافذة Electron 13 عنصراً بلا مربّع الدردشة (Chromium لم يبنِ شجرتَه بعد)، والثانيةُ 212 فيها
// «Message input» و«Send message» — فكتب عبدو كود الطلبَ في Gemini وأرسله. نافذةُ Chromium بشجرةٍ ضئيلة تُقرأ ثانيةً بعد أن تستيقظ.
test("desk ui re-reads a Chromium/Electron window whose first tree is nearly empty", () => {
  const s = desktopScript({ kind: "ui", depth: 14 }, "", { hwnd: 7, title: "Antigravity IDE", left: 0, top: 0, right: 800, bottom: 600 })
  const first = s.indexOf("Walk-Ui $rootEl 1 14 ")
  const wake = s.indexOf("if ($items.Count -lt 40 -and $rootClass.ToString() -like 'Chrome_WidgetWin*') { [void][AbdoDesk]::WakeChromium($want); Start-Sleep -Milliseconds 1800; $depthUsed = 14; $items.Clear(); Walk-Ui $rootEl 1 $depthUsed ")
  expect(first).toBeGreaterThan(0)
  expect(wake).toBeGreaterThan(first)
  expect(s).toContain("woke = $woke")
})

test("the twin: a tree read never crashes on an element that vanishes mid-walk — it keeps its place as Unavailable", () => {
  const s = desktopScript({ kind: "ui", depth: 8 }, "", { hwnd: 7, title: "x", left: 0, top: 0, right: 800, bottom: 600 })
  expect(s).toContain("try { return (Describe-UiCore $el $i $wr) } catch { return @{ ref = $i; type = 'Unavailable'")
  expect(s).toContain("try { $c = $walker.GetNextSibling($c) } catch { $c = $null }")
})

// 10-12 (مقيس: «افتح برنامج Antigravity واكتب في مربّع محادثة Gemini … ثمّ أرسله» ⇦ موجِّهٌ على مجلّدٍ فارغ ثمّ «تقريرُ توجيه» من عدّة نداءاتٍ رُفض،
// ومضت 600 ث بلا desk واحد). طلبُ تشغيل تطبيقٍ أو الكتابةِ في برنامجٍ آخر يُوجَّه إلى طريق التحكّم مباشرةً.
test("a computer-use request is routed as one: no project orientation, and the operator path goes with the request", async () => {
  const { isDesktopDriveTask, DESKTOP_DRIVE_BRIEF } = await import("../src/tool-exposure")
  for (const ask of ["افتح برنامج Antigravity واكتب في مربّع محادثة Gemini هذا الطلب ثمّ أرسله: hi", "ما مهاراتك في الكمبيوتر يوز تقدر تفتح انتي جرافيتي", "اكتب لجيميناي: مرحبا", "open the app Cursor and send a prompt"]) expect(isDesktopDriveTask(ask), ask).toBe(true)
  expect(DESKTOP_DRIVE_BRIEF).toContain("desk open <اسم التطبيق>")
  expect(DESKTOP_DRIVE_BRIEF).toContain("desk press <مرجعُ زرّ الإرسال>")
  const cli = (await Bun.file(new URL("../src/cli.ts", import.meta.url)).text())
  expect(cli).toContain('const orientAgent = workAtTurn.orientationAgent && delegationOnNow && !isDesktopDriveTask(turn.body) ? findAgent(agentCatalogue(), "orient") : undefined')
  expect(cli).toContain('${teamBrief}${isDesktopDriveTask(turn.body) ? DESKTOP_DRIVE_BRIEF : ""}${turn.body}')
})

test("the twin: coding requests are not computer-use tasks", async () => {
  const { isDesktopDriveTask } = await import("../src/tool-exposure")
  for (const ask of ["ابنِ تطبيق مهام بـVite وTailwind", "أصلح خطأ البناء في server.js", "Build the tasks app described in README.md"]) expect(isDesktopDriveTask(ask), ask).toBe(false)
})

// 10-12 (مقيس: «desk open Antigravity» فتح نافذةً فارغةً جديدة ونافذةُ المشروع بلوحة Gemini مصغّرة خلفها؛ ثمّ desk ui رأى 14 عنصراً فقط).
test("desk open switches to an app's open window (restoring it, preferring the one with a project) before launching anything", () => {
  const s = desktopScript({ kind: "open", app: "Antigravity" }, "")
  const reuse = s.indexOf("$mine = @($list | Where-Object { $_.title.ToLowerInvariant().Contains($reuseNeedle) })")
  const launch = s.indexOf("Start-Process -FilePath $app -PassThru")
  expect(reuse).toBeGreaterThan(0); expect(launch).toBeGreaterThan(reuse)
  expect(s).toContain("  if ($mine.Count -gt 0) {\n    $pick = ")
  expect(s).toContain("[void][AbdoDesk]::ShowWindow([IntPtr]$pick.hwnd, 9)")
  expect(s).toContain("$frame.reused = $true")
})

test("the twin: an explicit path is launched as asked, never swapped for an open window", () => {
  const s = desktopScript({ kind: "open", app: "C:\Tools\app.exe" }, "")
  expect(s).toContain("if ($app -notmatch '[\\/]' -and $reuseNeedle.Length -ge 3) {")
})

test("desk ui wakes a Chromium window's accessibility (WM_GETOBJECT to its render widget) before re-reading", () => {
  const s = desktopScript({ kind: "ui", depth: 14 }, "", { hwnd: 7, title: "Antigravity IDE", left: 0, top: 0, right: 800, bottom: 600 })
  expect(s).toContain('if (c.ToString() == "Chrome_RenderWidgetHostHWND") { SendMessage(h, 0x003D, IntPtr.Zero, new IntPtr(-4));')
  expect(s.indexOf("[void][AbdoDesk]::WakeChromium($want); Start-Sleep -Milliseconds 1800")).toBeGreaterThan(s.indexOf("-like 'Chrome_WidgetWin*'"))
})

// 10-12 (مقيس: النموذجُ نادى «desk ui» بالعمق الافتراضيّ 8 فرأى 14 عنصراً — مربّعُ الدردشة أعمق — فخمّن إحداثيّاتٍ وكتب في المحرّر).
test("a Chromium window is re-read at full depth, the depth used comes back, and the engine keeps it for set/press", async () => {
  const s = desktopScript({ kind: "ui", depth: 8 }, "", { hwnd: 7, title: "Antigravity IDE", left: 0, top: 0, right: 800, bottom: 600 })
  expect(s).toContain("$depthUsed = 14; $items.Clear(); Walk-Ui $rootEl 1 $depthUsed ")
  expect(s).toContain("depth = $depthUsed;")
  const { runDesktop } = await import("../src/desktop-control")
  const runner = { async run() { return { code: 0, stdout: JSON.stringify({ ok: true, count: 1, capped: false, woke: true, depth: 14, width: 800, height: 600, elements: [{ ref: 1, type: "ComboBox", name: "Message input", id: "", x: 10, y: 10, w: 100, h: 30, patterns: ["Value"], enabled: true, password: false }] }), stderr: "" } } }
  const r = await runDesktop({ kind: "ui", depth: 8 }, { shotsDir: (await import("node:os")).tmpdir(), runner, bound: { hwnd: 7, title: "Antigravity IDE", left: 0, top: 0, right: 800, bottom: 600 }, selfPids: [] })
  expect(r.uiDepth).toBe(14)
  expect(r.text).toContain("أُوقظت شجرتُها وقُرئت بالعمق الكامل")
  expect(r.text).toContain("للكتابة: u1 [ComboBox] «Message input»")
  const cli = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()
  expect(cli).toContain('desktopUi = { depth: result.uiDepth ?? action.depth, elements: result.elements }')
})

// 10-12 (مقيس على Antigravity: «Message input» قرب آخر 219 عنصراً لم يصل النموذج فضغط «Toggle Agent» وأغلق اللوحة).
test("desk ui leads with the typing targets — the chat box first, the code editor and terminal marked — and the send buttons", async () => {
  const { uiTargets } = await import("../src/desktop-control")
  const el = (ref: number, type: string, name: string) => ({ ref, type, name, id: "", x: 10, y: 1, w: 50, h: 20, patterns: ["Value"], enabled: true, password: false })
  const out = uiTargets([el(148, "Edit", "The editor is not accessible at this time"), el(200, "ComboBox", "Message input"), el(213, "Edit", "Terminal 1, Antigravity Agent"), el(205, "Button", "Send message"), el(34, "CheckBox", "Toggle Agent")])
  expect(out.indexOf("u200 [ComboBox] «Message input»")).toBeGreaterThan(0)
  expect(out.indexOf("u200")).toBeLessThan(out.indexOf("u148"))
  expect(out).toContain("u148 [Edit] «The editor is not accessible at this time» @(10,1 50×20) {Value} (محرّرُ شيفرةٍ/طرفيّة — ليس مربّعَ دردشة)")
  expect(out).toContain("للإرسال: u205 [Button] «Send message»")
  expect(out).not.toContain("Toggle Agent")
})

test("the twin: a window with no inputs or send buttons adds no targets section", async () => {
  const { uiTargets } = await import("../src/desktop-control")
  expect(uiTargets([{ ref: 1, type: "Text", name: "hello", id: "", x: 1, y: 1, w: 9, h: 9, patterns: [], enabled: true, password: false }])).toBe("")
})

// 10-12 (مقيس على Antigravity: الكتابةُ أزاحت الشجرةَ عنصرين فرُفض «desk press u205» «the UI changed»، وأعاد النموذجُ desk ui ثمّ u203).
test("a reference whose element moved is found again by its type and name when exactly one element matches", () => {
  const ui = { depth: 14, elements: [{ ref: 205, type: "Button", name: "Send message", id: "", x: 1, y: 1, w: 9, h: 9, patterns: ["Invoke"], enabled: true, password: false }] }
  const s = desktopScript({ kind: "press", ref: 205 }, "", { hwnd: 7, title: "Antigravity IDE", left: 0, top: 0, right: 800, bottom: 600 }, ui)
  const relocate = s.indexOf("if ((Ui-Type $c2) -eq $expType -and [string]$c2.Name -eq $expName) { $alt += $j }")
  expect(relocate).toBeGreaterThan(0)
  expect(s.indexOf("  if ($alt.Count -eq 1) { $el = $items[$alt[0]]; $cur = $el.Current; $nowType = Ui-Type $cur }")).toBeGreaterThan(relocate)
})

test("the twin: no unique match (or a nameless element) still refuses with «run desk ui again»", () => {
  const ui = { depth: 14, elements: [{ ref: 3, type: "Edit", name: "", id: "", x: 1, y: 1, w: 9, h: 9, patterns: ["Value"], enabled: true, password: false }] }
  const s = desktopScript({ kind: "set", ref: 3, text: "x" }, "", { hwnd: 7, title: "x", left: 0, top: 0, right: 800, bottom: 600 }, ui)
  expect(s).toContain("$alt = @(); if ($expName.Length -gt 0) {")
  expect(s).toContain("else { Out-Json @{ ok = $false; error = 'the UI changed since desk ui - run desk ui again'")
})
