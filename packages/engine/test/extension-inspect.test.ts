// تكافؤُ أدوات الفحص عبر إضافة المتصفّح (09-14): page styles|dom|css|assets تصل الإضافةَ كـinspect، والإضافةُ تعطي الأرقامَ نفسَها
// التي يعطيها المتصفّحُ المملوك. التوأمُ الإيجابيّ: INSPECT تُنفَّذ في كروميوم حقيقيّ على صفحةٍ معروفة.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BRIDGE_TOOLS, ChromeBridge } from "../src/mcp-servers/chrome-bridge"

const background = readFileSync(resolve(import.meta.dir, "../../browser-bridge/extension/background.js"), "utf8")
const cli = readFileSync(resolve(import.meta.dir, "../src/cli.ts"), "utf8")
const inspectSource = (): string => {
  const start = background.indexOf("const INSPECT = (mode, target) => {")
  const end = background.indexOf("\nconst inPage = ")
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  return background.slice(start + "const INSPECT = ".length, end).trim()
}

describe("extension inspect parity — wiring", () => {
  test("the bridge advertises inspect, the extension answers it, and the engine forwards page styles/dom/css/assets as JSON", () => {
    expect(BRIDGE_TOOLS.some((t) => t.name === "inspect")).toBe(true)
    expect(background).toContain('case "inspect": return inPage(tab.id, INSPECT, [String(args.mode || "styles"), String(args.target || "")])')
    expect(cli).toContain('const inspect = name === "page" ? /^(styles?|dom|css|assets)\\b/u.exec(rest.trim()) : null')
    expect(cli).toContain('const target = inspect !== null ? "inspect" :')
    expect(cli).toContain("const r = await session.call(toolName, callArgs)")
    expect(JSON.parse(readFileSync(resolve(import.meta.dir, "../../browser-bridge/extension/manifest.json"), "utf8")).version).toBe("0.3.1")
  })

  test("bridge: dom with an unknown ref is refused before reaching the extension; styles reaches it with mode/target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-bridge-inspect-"))
    const bridge = new ChromeBridge({ port: 0, token: "tok", stateDir: dir, announce: () => {} })
    const port = bridge.start()
    const received: { action: string; args: Record<string, unknown> }[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=tok`)
    await new Promise<void>((ok) => { ws.onopen = () => ok() })
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id: number; action: string; args: Record<string, unknown> }
      received.push({ action: m.action, args: m.args })
      ws.send(JSON.stringify({ id: m.id, ok: true, result: m.action === "page" ? [{ ref: "r1", role: "button", name: "Go" }] : JSON.stringify({ mode: m.args.mode, colors: ["text rgb(1, 2, 3) · 9k px²"] }) }))
    }
    try {
      expect(await bridge.run("inspect", { mode: "dom", target: "r9" })).toContain("مرجعٌ غير معروف")
      expect(await bridge.run("inspect", { mode: "binary" })).toContain("الصيغة")
      expect(received).toEqual([])
      const styles = await bridge.run("inspect", { mode: "styles" })
      expect(styles).toContain("تصميمُ الصفحة"); expect(styles).toContain("rgb(1, 2, 3)")
      await bridge.run("page", {})
      const dom = await bridge.run("inspect", { mode: "dom", target: "r1" })
      expect(dom).toContain("عنصرُ r1")
      expect(received.map((r) => r.action)).toEqual(["inspect", "page", "inspect"])
      expect(received[0]!.args).toEqual({ mode: "styles", target: "" })
      expect(received[2]!.args).toEqual({ mode: "dom", target: "r1" })
    } finally { ws.close(); bridge.stop(); rmSync(dir, { recursive: true, force: true }) }
  })
})

describe("extension inspect parity — the injected function in a real page", () => {
  // مسارُ حزمة Playwright من البيئة لا من نصٍّ ثابت (بوّابةُ الحدود العامّة رفضت مساراً خاصّاً بجهاز المطوّر — مقيس 09-14 ظهراً)؛ غيابُه = التوأمُ يُتخطّى ويُقال.
  const playwrightPackage = process.env.ABDO_TEST_PLAYWRIGHT_PACKAGE ?? ""
  // الكروميوم الكامل المثبَّت لدى Playwright (لا قشرةَ headless-shell على هذا الجهاز) — القياسُ في متصفّحٍ حقيقيّ لا محاكاة.
  const chromeExe = ["1228", "1234"].map((v) => `${process.env.LOCALAPPDATA ?? ""}/ms-playwright/chromium-${v}/chrome-win64/chrome.exe`).find((p) => existsSync(p))
  const available = existsSync(playwrightPackage) && chromeExe !== undefined
  // مقيس 09-14: Playwright يعلّق تحت bun ويعمل تحت node (٧٨٨ms) — التوأمُ يُشغَّل طفلَ node ويعيد JSON.
  test.if(available)("styles/dom/css/assets read real numbers from a fixture page", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-inspect-twin-"))
    try {
      const fixture = `<!doctype html><html dir="rtl"><head><style>:root{--brand:#3355ff;--radius:12px}body{font-family:Tahoma;color:rgb(20,20,20);background:rgb(250,250,250)}
        .btn{background:rgb(51,85,255);color:#fff;border-radius:12px;padding:10px 20px}h1{font-size:32px}
        @media (min-width: 1px) { .btn { letter-spacing: 1px } }</style></head>
        <body><main class="container" style="width:600px"><h1>عنوان</h1><p style="height:200px;background:rgb(240,240,240)">نص</p>
        <button class="btn" data-abdo-ref="r1">اضغط</button><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="dot" width="30" height="30"></main></body></html>`
      writeFileSync(join(dir, "inspect.js"), inspectSource())
      writeFileSync(join(dir, "fixture.html"), fixture)
      writeFileSync(join(dir, "twin.mjs"), [
        'import { createRequire } from "node:module"', 'import { readFileSync } from "node:fs"',
        `const require = createRequire(${JSON.stringify(playwrightPackage)})`,
        'const { chromium } = require("playwright")',
        `const browser = await chromium.launch({ headless: true, executablePath: ${JSON.stringify(chromeExe)} })`,
        'const page = await browser.newPage()',
        `await page.setContent(readFileSync(${JSON.stringify(join(dir, "fixture.html"))}, "utf8"))`,
        `const src = readFileSync(${JSON.stringify(join(dir, "inspect.js"))}, "utf8")`,
        'const run = (mode, target = "") => page.evaluate(`(${src})(${JSON.stringify(mode)}, ${JSON.stringify(target)})`)',
        'const out = { styles: await run("styles"), dom: await run("dom", "r1"), missing: await run("dom", "r404"), css: await run("css", ".btn"), assets: await run("assets") }',
        'console.log(JSON.stringify(out))', 'await browser.close()',
      ].join("\n"))
      const child = Bun.spawnSync(["node", join(dir, "twin.mjs")], { stdout: "pipe", stderr: "pipe" })
      expect(child.exitCode, child.stderr.toString()).toBe(0)
      const out = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!) as { styles: string; dom: string; missing: string; css: string; assets: string }
      const styles = JSON.parse(out.styles) as { rootVars: Record<string, string>; colors: string[]; buttons: { background: string }[]; body: { containerWidth?: string }; dir: string }
      expect(styles.rootVars["--brand"]).toBe("#3355ff")
      expect(styles.dir).toBe("rtl")
      expect(styles.colors.some((c) => c.includes("rgb(240, 240, 240)"))).toBe(true)
      expect(styles.buttons[0]!.background).toBe("rgb(51, 85, 255)")
      expect(styles.body.containerWidth).toBe("600px")
      const dom = JSON.parse(out.dom) as { tag: string; styles: Record<string, string>; html: string }
      expect(dom.tag).toBe("button"); expect(dom.styles.borderRadius).toBe("12px"); expect(dom.html).not.toContain("data-abdo-ref")
      expect(out.missing).toBe("")
      const css = JSON.parse(out.css) as { matched: number; rules: string[] }
      // (#25ج) القاعدةُ داخل @media تُرى مسبوقةً بسياقها — كانت غيرَ مرئيّة
      expect(css.matched).toBe(2); expect(css.rules[0]).toContain("border-radius: 12px")
      expect(css.rules[1]).toMatch(/^@media \(min-width: 1px\) \{ \.btn \{ letter-spacing: 1px/u)
      const assets = JSON.parse(out.assets) as { images: { alt: string }[]; stylesheets: string[] }
      expect(assets.images).toHaveLength(0) // gif 1×1 أصغر من 24px — يُرشَّح كما في المملوك
      expect(assets.stylesheets[0]).toMatch(/^inline\(/u)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)
})
