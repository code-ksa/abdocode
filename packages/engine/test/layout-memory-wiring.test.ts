import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DESKTOP_USAGE, NEEDS_FOCUS, desktopScript, parseDesktopCommand, runDesktop, type DesktopBound, type DesktopRunner } from "../src/desktop-control"
import { linuxScript } from "../src/desktop-linux"
import { TOOLS } from "@abdo/tools/catalogue"

// S7/S8 (09-18) — مساميرُ الأسلاك (على نمط browser-tabs-history): اللاياوتُ والخريطةُ والدفترُ موصولةٌ في المُوزِّع والكتالوج
// والمشغّل، لا «مسجَّلةً غيرَ قابلةٍ للاستدعاء»؛ والمشغّلُ الزائف يثبت أنّ الإيصالات تحمل الإطارَ والعمليّة.

const read = (...parts: string[]) => readFileSync(join(import.meta.dir, "..", ...parts), "utf8")
const BOUND: DesktopBound = { hwnd: 4242, title: "Extensions - Google Chrome", left: 0, top: 0, right: 1176, bottom: 1530 }
const FRAME = { left: 0, top: 0, right: 1176, bottom: 1530, clientLeft: 8, clientTop: 31, clientWidth: 1160, clientHeight: 1491, scale: 1.25, maximized: false, monitor: "\\\\.\\DISPLAY1", monitorLeft: 0, monitorTop: 0, monitorWidth: 1920, monitorHeight: 1080, process: "chrome", pid: 777 }
const runnerWith = (json: Record<string, unknown>, seen: string[] = []): DesktopRunner => ({ async run(script) { seen.push(script); return { code: 0, stdout: `${JSON.stringify(json)}\n`, stderr: "" } } })

describe("S8 — السكربتات الجديدة والحدود", () => {
  test("rect وplace يحتاجان نافذةً مربوطة (الغيابُ رفض)، وlayout ليس فعلاً للقناة بل للمُوزِّع", async () => {
    expect(await runDesktop({ kind: "rect" }, { shotsDir: "", runner: runnerWith({ ok: true }) })).toEqual({ ok: false, text: NEEDS_FOCUS })
    expect(await runDesktop({ kind: "place", x: 0, y: 0, width: 10, height: 10, state: "normal" }, { shotsDir: "", runner: runnerWith({ ok: true }) })).toEqual({ ok: false, text: NEEDS_FOCUS })
    expect("error" in parseDesktopCommand("layout save")).toBe(true)
    expect(DESKTOP_USAGE).toContain("desk layout save [<اسم>] | desk layout list | desk layout forget <اسم>")
  })
  test("سكربتُ ويندوز: rect يقيس بالمسبار، وplace يستعيد من التكبير ثمّ SetWindowPos بلا تفعيل ثمّ يكبّر إن طُلب", () => {
    const rect = desktopScript({ kind: "rect" }, "", BOUND)
    for (const pin of ["function Win-Frame($h)", "GetClientRect", "ClientToScreen", "GetDpiForWindow", "IsZoomed", "[System.Windows.Forms.Screen]::FromHandle", "Get-Process -Id", "$want = [IntPtr]4242"]) expect(rect).toContain(pin)
    const place = desktopScript({ kind: "place", x: 10, y: 20, width: 800, height: 600, state: "normal" }, "", BOUND)
    expect(place).toContain("if ([AbdoDesk]::IsZoomed($want)) { [void][AbdoDesk]::ShowWindow($want, 9)")
    expect(place).toContain("SetWindowPos($want, [IntPtr]::Zero, 10, 20, 800, 600, 0x0014)")
    expect(place).not.toContain("ShowWindow($want, 3)")
    expect(desktopScript({ kind: "place", x: 0, y: 0, width: 1, height: 1, state: "maximized" }, "", BOUND)).toContain("ShowWindow($want, 3)")
    // اللقطةُ والتركيزُ والفتحُ يحملون المسبارَ كي يصل الإطارُ والعمليّةُ مع النتيجة
    expect(desktopScript({ kind: "shot", scope: "auto" }, "C:/x/desk-1.png", BOUND)).toContain("$frame = Win-Frame $want; $frame.ok = $true; $frame.scope = 'window'")
    expect(desktopScript({ kind: "focus", title: "x" }, "")).toContain("$frame = Win-Frame ([IntPtr]$hit.hwnd); $frame.ok = $true; $frame.hwnd = $hit.hwnd")
    expect(desktopScript({ kind: "open", app: "notepad" }, "")).toContain("$frame.launchedPid = $launchPid; $frame.others = $others")
    expect(desktopScript({ kind: "shot", scope: "screen" }, "C:/x/desk-2.png", BOUND)).not.toContain("Win-Frame")
  })
  test("القناةُ اللينكسيّة تحمل الفعلَ بالاسم فيُرفض هناك «unknown action» لا يُخمَّن", () => {
    const script = linuxScript({ kind: "place", x: 1, y: 2, width: 3, height: 4, state: "normal" }, "", BOUND)
    const args = JSON.parse(Buffer.from(/ARGS = "([^"]+)"/u.exec(script)![1]!, "base64").toString("utf8")) as { kind: string }
    expect(args.kind).toBe("place")
    expect(script).toContain('out({"ok": False, "error": "unknown action " + str(k)})')
  })
})

describe("S7/S8 — الإيصالات من المشغّل الزائف", () => {
  test("لقطةُ النافذة تقول الوضعَ والإطارَ والمقياس وتعيد الإطارَ والقياس", async () => {
    const dir = mkdtempSync(join(tmpdir(), "desk-frame-"))
    try {
      const r = await runDesktop({ kind: "shot", scope: "auto" }, { shotsDir: dir, bound: BOUND, runner: runnerWith({ ok: true, scope: "window", width: 1176, height: 1530, title: BOUND.title, ...FRAME }) })
      expect(r.ok).toBe(true)
      expect(r.text).toContain("الوضع: نافذة، الإطار 1176×1530 @ (0,0)، العميل 1160×1491 @ (8,31)، المقياس 1.25.")
      expect(r.frame).toEqual({ mode: "windowed", window: { x: 0, y: 0, width: 1176, height: 1530 }, client: { x: 8, y: 31, width: 1160, height: 1491 }, scale: 1.25 })
      expect(r.measure?.process).toBe("chrome")
      const screen = await runDesktop({ kind: "shot", scope: "screen" }, { shotsDir: dir, runner: runnerWith({ ok: true, scope: "screen", width: 3840, height: 1080, left: -1920, top: 0 }) })
      expect(screen.text).toContain("الوضع: الشاشة كلُّها، الإطار 3840×1080 @ (-1920,0)")
      expect(screen.frame).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test("focus/open/rect يعيدون القياسَ (العمليّة، التكبير، الشاشة) والإطار؛ وplace يحدّث الحدَّ بالمستطيل المقيس", async () => {
    const focus = await runDesktop({ kind: "focus", title: "extensions" }, { shotsDir: "", runner: runnerWith({ ok: true, hwnd: 4242, title: BOUND.title, ...FRAME }) })
    expect(focus.bound).toEqual(BOUND)
    expect(focus.measure).toEqual({ left: 0, top: 0, right: 1176, bottom: 1530, maximized: false, monitor: "\\\\.\\DISPLAY1", process: "chrome" })
    expect(focus.frame?.mode).toBe("windowed")
    expect(focus.text).toContain("ركّزتُ نافذة «Extensions - Google Chrome» (1176×1530)")
    const open = await runDesktop({ kind: "open", app: "chrome" }, { shotsDir: "", runner: runnerWith({ ok: true, hwnd: 4242, title: BOUND.title, focused: true, existing: false, launchedPid: 777, others: [], ...FRAME }) })
    expect(open.measure?.process).toBe("chrome")
    expect(open.text).toContain("pid 777")
    const rect = await runDesktop({ kind: "rect" }, { shotsDir: "", bound: BOUND, runner: runnerWith({ ok: true, hwnd: 4242, title: BOUND.title, ...FRAME, maximized: true }) })
    expect(rect.measure?.maximized).toBe(true)
    expect(rect.text).toBe("نافذة «Extensions - Google Chrome» 1176×1530 @ (0,0) مكبَّرة على \\\\.\\DISPLAY1، العمليّة chrome — الوضع: نافذة، الإطار 1176×1530 @ (0,0)، العميل 1160×1491 @ (8,31)، المقياس 1.25")
    const placed = await runDesktop({ kind: "place", x: 100, y: 50, width: 800, height: 600, state: "normal" }, { shotsDir: "", bound: BOUND, runner: runnerWith({ ok: true, placed: true, hwnd: 4242, title: BOUND.title, ...FRAME, left: 100, top: 50, right: 900, bottom: 650 }) })
    expect(placed.ok).toBe(true)
    expect(placed.bound).toEqual({ ...BOUND, left: 100, top: 50, right: 900, bottom: 650 })
    expect(placed.text).toBe("نُقلت نافذة «Extensions - Google Chrome» إلى 800×600 @ (100,50).")
    const refused = await runDesktop({ kind: "place", x: 0, y: 0, width: 1, height: 1, state: "normal" }, { shotsDir: "", bound: BOUND, runner: runnerWith({ ok: false, placed: false, error: "SetWindowPos refused (elevated or system window?)" }) })
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain("فشل place: SetWindowPos refused")
  })
})

describe("S7/S8 — مساميرُ الأسلاك في المُوزِّع والكتالوج", () => {
  test("cli: layout save|list|forget قبل المُحلِّل، الاستعادةُ بعد open/focus، الدفترُ بعد desk ui وpage، والإطارُ في لقطة اللوحة، وui-book في القراءة", () => {
    const cli = read("src", "cli.ts")
    expect(cli).toContain('if (/^layout(?:\\s|$)/u.test(rest.trim())) {')
    expect(cli).toContain('const measured = await runDesktop({ kind: "rect" }, { shotsDir: join(STATE_ROOT, "desktop-shots"), bound: desktopBound })')
    expect(cli).toContain("layouts.saveLayouts(file, layouts.upsertLayout(layouts.loadLayouts(file), layout))")
    // الاستعادةُ لا تكتب في الملفّ: كلُّ كتابةٍ في cli تمرّ بـsaveLayouts، وهي في فرع save/forget وحده
    expect(cli.split("layouts.saveLayouts(").length - 1).toBe(2)
    expect(cli).toContain('if (result.ok && (action.kind === "open" || action.kind === "focus") && result.bound !== undefined && result.measure !== undefined && result.measure.process.length > 0) {')
    expect(cli).toContain('const placed = await runDesktop({ kind: "place", x: saved.x, y: saved.y, width: saved.width, height: saved.height, state: saved.state }')
    expect(cli).toContain("restoredLine = `\\n${layouts.restoreReceipt(saved, result.bound.title)}`")
    expect(cli).toContain("`${result.text}${restoredLine}`")
    expect(cli).toContain('if (result.ok && action.kind === "ui" && result.elements !== undefined && desktopBound !== undefined) {')
    expect(cli).toContain('source: "desk", app: desktopBoundProcess.length > 0 ? desktopBoundProcess : desktopBound.title')
    expect(cli).toContain("await paneBook(surfaceRefs)")
    expect(cli).toContain("if (json.length > 0) await paneBook(surfaceRefs, json)")
    expect(cli).toContain('source: "browser", app: url.host')
    expect(cli).toContain("const frame = await paneFrame()")
    expect(cli).toContain('if (word === "ui-book") {')
    // الترتيبُ جزءٌ من الميزة: الاستعادةُ بعد تحديث الحدّ، والدفترُ بعد تحديث الشجرة، وكلاهما قبل الإيصال النهائيّ
    expect(cli.indexOf("desktopBound = result.bound;")).toBeLessThan(cli.indexOf("let restoredLine = \"\""))
    expect(cli.indexOf("desktopUi = { depth: action.depth, elements: result.elements }")).toBeLessThan(cli.indexOf("book.treeFromDesk(result.elements)"))
    expect(cli.indexOf("book.treeFromDesk(result.elements)")).toBeLessThan(cli.indexOf("`${result.text}${restoredLine}`"))
  })
  test("الكتالوج: desk يعلن layout، وui-book أداةُ قراءةٍ بمنفّذ project-read", () => {
    const desk = TOOLS.find((t) => t.name === "desk")!
    expect(desk.usage).toContain("desk layout save [<اسم>] | desk layout list | desk layout forget <اسم>")
    const book = TOOLS.find((t) => t.name === "ui-book")!
    expect(book).toBeDefined()
    expect(book.effect).toBe("read")
    expect(book.runner).toBe("project-read")
    expect(book.usage).toBe("ui-book [list | show <تطبيق>/<شاشة>]")
    // مقاييسُ اللوحة تحمل العرضَ والمقياس (S7) — عقدُ CDP
    expect(read("..", "browser", "src", "cdp.ts")).toContain("viewportWidth: innerWidth, viewportHeight: innerHeight")
    expect(read("..", "browser", "src", "cdp.ts")).toContain("dpr: devicePixelRatio")
  })
})
