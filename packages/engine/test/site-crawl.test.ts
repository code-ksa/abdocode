import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { CdpBrowser } from "@abdo/browser"
import { stripChildEnv } from "@abdo/tools/env-strip"
import { bridgeFreeText, isLocalUrl } from "../src/browser-actions-args"
import { BRIDGE_TOOLS, ChromeBridge, downloadTargetPath, fitLinks } from "../src/mcp-servers/chrome-bridge"
import { Mcp } from "../src/mind/mcp"
import { IMAGE_FIND_SOURCE, LINKS_SOURCE } from "../src/page-scripts"
import { crawlCandidate, parseCrawlArgs, parseRobots, robotsAllows, sitemapMarkdown } from "../src/site-crawl"

// 10-12 (مشروعٌ مثل ClickUp)، و«حلّ الفشل اللي واجهه»
// (chrome.shot full رُفض، wait 20 طابق رقماً، find وaudit غيرُ متاحين عبر الإضافة، صفحةُ المشروع استبدلت تبويبَ بريد المستخدم).

const ROOT = resolve(import.meta.dir, "..")
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/gu, "\n")

describe("زاحفُ الموقع — أيُّ رابطٍ يُزار", () => {
  test("الأصلُ نفسُه فقط، بلا # ولا معاملات تتبّع، لا ملفّات ولا روابطَ أفعال", () => {
    const o = "https://app.example.com"
    expect(crawlCandidate("https://app.example.com/tasks?utm_source=x&view=list#top", o)).toBe("https://app.example.com/tasks?view=list")
    expect(crawlCandidate("https://other.com/tasks", o)).toBeUndefined()
    expect(crawlCandidate("http://app.example.com/tasks", o)).toBeUndefined()
    expect(crawlCandidate("mailto:a@b.co", o)).toBeUndefined()
    for (const action of ["/logout", "/auth/sign-out", "/settings/delete", "/list/remove/5", "/email/unsubscribe", "/x?action=delete", "/x?logout=1"]) {
      expect(crawlCandidate(`${o}${action}`, o)).toBeUndefined()
    }
    for (const file of ["/a.pdf", "/b.zip", "/c.png", "/d.css", "/e.js"]) expect(crawlCandidate(`${o}${file}`, o)).toBeUndefined()
    expect(crawlCandidate(`${o}/settings/profile`, o)).toBe(`${o}/settings/profile`)
  })
  test("robots.txt: قواعدُ * وحدها، أطولُ مطابقةٍ تحكم، Allow تغلب عند التساوي، وCrawl-delay", () => {
    const robots = parseRobots("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nDisallow: /*.json$\nAllow: /private/public\nCrawl-delay: 2\n")
    expect(robots.delayMs).toBe(2000)
    expect(robotsAllows(robots, "/")).toBe(true)
    expect(robotsAllows(robots, "/private/x")).toBe(false)
    expect(robotsAllows(robots, "/private/public/page")).toBe(true)
    expect(robotsAllows(robots, "/data.json")).toBe(false)
    expect(robotsAllows(robots, "/data.json?x")).toBe(true)
    expect(robotsAllows(parseRobots(""), "/anything")).toBe(true)
    expect(parseRobots("User-agent: *\nCrawl-delay: 999").delayMs).toBe(30_000)
  })
  test("الصيغة: رابطٌ إلزاميّ، 20 افتراضاً والسقف 60، والحفظُ افتراضاً", () => {
    expect(parseCrawlArgs("https://clickup.com max 5")).toEqual({ ok: true, url: "https://clickup.com", max: 5, save: true, shots: false })
    expect(parseCrawlArgs("https://a.b 500 nosave shots")).toEqual({ ok: true, url: "https://a.b", max: 60, save: false, shots: true })
    expect(parseCrawlArgs("https://a.b")).toMatchObject({ ok: true, max: 20 })
    expect(parseCrawlArgs("clickup").ok).toBe(false)
  })
  test("الخريطة: كلُّ صفحةٍ بعنوانها وعناوينها ونسختها، والمتعذّرةُ بسببها", () => {
    const md = sitemapMarkdown("https://a.b/", "متصفّح عبدو كود", [
      { url: "https://a.b/", title: "Home", headings: ["h1 Welcome"], links: 7, saved: ".abdo/reference/a.b/home" },
      { url: "https://a.b/x?y=1", error: "رُفض" },
    ], { robots: 2, limit: 3 })
    expect(md).toContain("## 1. / — Home")
    expect(md).toContain("- h1 Welcome")
    expect(md).toContain("روابط: 7 · النسخة: .abdo/reference/a.b/home")
    expect(md).toContain("## 2. /x?y=1")
    expect(md).toContain("- تعذّر: رُفض")
    expect(md).toContain("تُخطّيت بـrobots.txt: 2 · بقيت فوق الحدّ: 3")
  })
})

describe("أدواتُ الجسر بنصٍّ حرّ — كما يكتبها النموذج (مقيس في دور مستخدم)", () => {
  test("shot full / scroll bottom / inspect assets / browsers use chrome / devtools / key / look", () => {
    expect(bridgeFreeText("shot", "full", "C:/p")).toBe('{"full":true}')
    expect(JSON.parse(bridgeFreeText("scroll", "bottom", "C:/p"))).toEqual({ direction: "down", count: 10 })
    expect(JSON.parse(bridgeFreeText("scroll", "up 2", "C:/p"))).toEqual({ direction: "up", count: 2 })
    expect(JSON.parse(bridgeFreeText("inspect", "dom r3", "C:/p"))).toEqual({ mode: "dom", target: "r3" })
    expect(JSON.parse(bridgeFreeText("browsers", "use chrome", "C:/p"))).toEqual({ op: "use", target: "chrome" })
    expect(JSON.parse(bridgeFreeText("devtools", "network reload", "C:/p"))).toEqual({ what: "network", reload: true, clear: false })
    expect(JSON.parse(bridgeFreeText("key", "Enter", "C:/p"))).toEqual({ key: "Enter" })
    expect(JSON.parse(bridgeFreeText("tap", "[r5]", "C:/p"))).toEqual({ ref: "r5" })
    expect(JSON.parse(bridgeFreeText("fill", "r3 hello world", "C:/p"))).toEqual({ ref: "r3", text: "hello world" })
    expect(bridgeFreeText("shot", '{"full":false}', "C:/p")).toBe('{"full":false}')
    expect(bridgeFreeText("open", "https://a.b", "C:/p")).toBe("https://a.b")
  })
  test("صفحاتُ المشروع المحلّيّة تُعرف — ولا يُخدع المضيفُ بلاحقة", () => {
    for (const url of ["http://127.0.0.1:3001/abdo-code", "http://localhost", "http://app.localhost:5173/x", "http://[::1]:8080/"]) expect(isLocalUrl(url)).toBe(true)
    for (const url of ["https://gemini.google.com/app", "http://127.0.0.1.evil.com/", "http://localhost.evil.com/"]) expect(isLocalUrl(url)).toBe(false)
  })
})

describe("الإضافة 0.8.0 والجسر — links وdownload", () => {
  const background = read("..", "browser-bridge", "extension", "background.js")
  test("سكربتا الصفحة نسخةٌ حرفيّة في المحرّك (متصفّح عبدو كود يقرأ ما تقرؤه الإضافة)", () => {
    expect(background).toContain(`const LINKS = ${LINKS_SOURCE}\n`)
    expect(background).toContain(`const IMAGE_FIND = ${IMAGE_FIND_SOURCE}\n`)
  })
  test("الصلاحيّةُ downloads في كروم/إيدج/فايرفوكس لا سفاري، والإصدار 0.8.0", () => {
    const manifest = JSON.parse(read("..", "browser-bridge", "extension", "manifest.json"))
    expect(manifest.version).toBe("0.8.0")
    expect(manifest.permissions).toContain("downloads")
    expect(read("..", "browser-bridge", "scripts", "pack.mjs")).toContain('p !== "sidePanel" && p !== "downloads"')
    expect(background).toContain('case "links": return inPage(tab.id, LINKS)')
    expect(background).toContain('const done = (items || []).find((d) => d.state === "complete" && d.filename && Date.parse(d.startTime) >= since)')
  })
  test("downloadTargetPath: داخل المشروع، بامتداد، لا ملفّ اعتماد ولا تنفيذيّ", () => {
    const root = resolve(tmpdir(), "proj-d")
    expect(downloadTargetPath(root, "public/images/hero-full.png")).toEqual({ ok: true, abs: resolve(root, "public/images/hero-full.png"), rel: "public/images/hero-full.png" })
    expect(downloadTargetPath(root, "../x.png").ok).toBe(false)
    expect(downloadTargetPath(root, "tools/setup.exe").ok).toBe(false)
    expect(downloadTargetPath(root, "scripts/run.ps1").ok).toBe(false)
    expect(downloadTargetPath(root, ".env").ok).toBe(false)
    expect(downloadTargetPath(root, "docs/README").ok).toBe(false)
  })
  test("الجسر: links JSON، وdownload ينسخ التنزيلَ الذي بدأ بعد النقرة إلى المشروع ويُبقي الأصل، ويرفض التنفيذيّ، ويُسمّي الإضافةَ القديمة", async () => {
    expect(BRIDGE_TOOLS.find((t) => t.name === "download")!.inputSchema.required).toEqual(["path"])
    const dir = mkdtempSync(join(tmpdir(), "abdo-bridge-dl-"))
    const project = join(dir, "project"), downloads = join(dir, "Downloads")
    mkdirSync(project); mkdirSync(downloads)
    writeFileSync(join(downloads, "Gemini_Generated.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"))
    writeFileSync(join(downloads, "evil.exe"), "MZ")
    const settings = join(dir, "settings.json")
    writeFileSync(settings, JSON.stringify({ project }))
    const bridge = new ChromeBridge({ port: 0, token: "t", settingsFile: settings, stateDir: dir, announce: () => {} })
    const port = bridge.start()
    const received: { action: string; args: Record<string, unknown> }[] = []
    const replies: Record<string, unknown[]> = {
      links: [{ url: "https://a.b/", title: "A", headings: ["h1 A"], links: [{ href: "https://a.b/x", text: "x" }] }],
      download: [{ filename: join(downloads, "Gemini_Generated.png"), bytes: 69 }, null, { filename: join(downloads, "evil.exe") }],
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=t`)
    await new Promise<void>((done) => { ws.onopen = () => done() })
    ws.onmessage = (event) => {
      const m = JSON.parse(String(event.data)) as { id: number; action: string; args: Record<string, unknown> }
      received.push({ action: m.action, args: m.args })
      if (m.action === "page") { ws.send(JSON.stringify({ id: m.id, ok: true, result: [{ ref: "r1", role: "button", name: "Download full size image" }] })); return }
      if (m.action === "tap") { ws.send(JSON.stringify({ id: m.id, ok: true, result: { x: 1, y: 1 } })); return }
      ws.send(JSON.stringify({ id: m.id, ok: true, result: (replies[m.action] ?? []).shift() ?? null }))
    }
    try {
      await Bun.sleep(50)
      expect(JSON.parse(await bridge.run("links", {}))).toMatchObject({ title: "A", links: [{ href: "https://a.b/x" }] })
      await bridge.run("page", {})
      const beforeTap = Date.now()
      await bridge.run("tap", { ref: "r1" })
      await Bun.sleep(1_200) // التنزيلُ يُطلب بعد النقرة بزمن: «منذ» تُحسب من النقرة لا من لحظة الطلب
      const copied = await bridge.run("download", { path: "public/images/hero-full.png wait=5" })
      expect(copied).toContain("نُسخ التنزيلُ Gemini_Generated.png")
      expect(copied).toContain("public/images/hero-full.png")
      expect(existsSync(join(project, "public/images/hero-full.png"))).toBe(true)
      expect(existsSync(join(downloads, "Gemini_Generated.png"))).toBe(true)
      const dl = received.find((r) => r.action === "download")!
      expect(dl.args.wait).toBe(5)
      expect(Number(dl.args.since)).toBeGreaterThanOrEqual(beforeTap - 5_000)
      expect(Number(dl.args.since)).toBeLessThanOrEqual(beforeTap - 4_000)
      expect(await bridge.run("download", { path: "public/a.png", wait: 0 })).toContain("لم يكتمل تنزيلٌ جديد")
      expect(await bridge.run("download", { path: "public/tool.bin" })).toContain("ملفٌّ تنفيذيّ")
      expect(existsSync(join(project, "public/tool.bin"))).toBe(false)
    } finally { ws.close(); bridge.stop(); rmSync(dir, { recursive: true, force: true }) }
  })
})

const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync)

test.skipIf(!edge)("LINKS على صفحةٍ حقيقيّة في إيدج بلا واجهة: روابطُ http فريدة، وعناوين، وعنوانُ الصفحة", async () => {
  const home = mkdtempSync(join(tmpdir(), "abdo-links-"))
  const page = `<title>Board</title><h1>Tasks</h1><h2>List</h2><a href="/a">A</a><a href="/a">A again</a><a href="https://other.test/x">X</a><a href="mailto:a@b.co">mail</a><a href="#top">top</a>`
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } }) })
  const lease = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }), port = lease.port; lease.stop(true)
  const child = Bun.spawn([edge!, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${join(home, "profile")}`, "about:blank"], { env: stripChildEnv(process.env).env, stdout: "ignore", stderr: "ignore" })
  const browser = new CdpBrowser(port!)
  try {
    for (let i = 0; ; i++) { try { await browser.attach(); break } catch (error) { if (i > 60) throw error; await Bun.sleep(100) } }
    await browser.navigate(`http://127.0.0.1:${server.port}/`)
    const info = JSON.parse(await browser.evaluateAsync(`JSON.stringify((${LINKS_SOURCE})())`)) as { title: string; headings: string[]; links: { href: string }[] }
    expect(info.title).toBe("Board")
    expect(info.headings).toEqual(["h1 Tasks", "h2 List"])
    const hrefs = info.links.map((l) => l.href)
    expect(hrefs).toContain(`http://127.0.0.1:${server.port}/a`)
    expect(hrefs).toContain("https://other.test/x")
    expect(hrefs.filter((h) => h.endsWith("/a"))).toHaveLength(1)
    expect(hrefs.some((h) => h.startsWith("mailto:"))).toBe(false)
  } finally {
    browser.close(); child.kill(); await child.exited; server.stop(true)
    for (let i = 0; i < 20; i += 1) { try { rmSync(home, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
  }
}, 120_000)

describe("المحرّك: التوجيهُ في دور متصفّح المستخدم، وcrawl وpage image في المتصفّحين", () => {
  const cli = read("src", "cli.ts")
  test("صفحةُ المشروع المحلّيّة ⇦ متصفّح عبدو كود، وقياسُها هناك أبداً؛ وغيرُها ⇦ كروم المستخدم", () => {
    expect(cli).toContain('if (navUrl !== undefined) surfaceTarget = isLocalUrl(navUrl) ? "owned" : "extension"')
    expect(cli).toContain('surfaceTarget === "extension" && !["audit", "seo", "compare", "release-check"].includes(name)) {')
    expect(cli).toContain('surfaceTarget = "extension"\n      const userBrowser = isUserBrowserTask(turn.body)')
  })
  test("find عبر الإضافة، وwait برقمٍ مهلة، وأدواتُ الجسر بنصٍّ حرّ", () => {
    expect(cli).toContain("على تبويب المستخدم — جرّب page لقراءة الشجرة")
    expect(cli).toContain('if (/^\\d{1,3}$/u.test(needle) && m?.[2] === undefined) {')
    expect(cli).toContain("bridgeTool === undefined ? rest0 : bridgeFreeText(bridgeTool, rest0, PROJECT_DIR)")
  })
  test("crawl وpage image وpage save يتبعون المتصفّحَ الذي يعمل فيه الدور", () => {
    expect(cli).toContain('if (spec.name === "crawl") return surfaced(await runCrawl(rest, turnId, hooks))')
    expect(cli).toContain('if (onUserBrowser()) info = JSON.parse(await bridgeCall("links", "{}", turnId))')
    expect(cli).toContain("info = JSON.parse(await surface.evaluateAsync(`JSON.stringify((${LINKS_SOURCE})())`))")
    expect(cli).toContain('const receipt = onUserBrowser() ? await bridgeCall("save", JSON.stringify({ dir: "" }), turnId) : await runPageSave("", turnId, hooks)')
    expect(cli).toContain('if (onUserBrowser()) return bridgeCall("image", JSON.stringify({ path: text }), turnId)')
    expect(cli).toContain('onUserBrowser() ? await bridgeCall("save", JSON.stringify({ dir: rest.trim().slice(4).trim() }), turnId) : await runPageSave(')
    expect(cli).toContain("if (!robotsAllows(robots, new URL(url).pathname + new URL(url).search)) { skipped.robots += 1; continue }")
    expect(cli).toContain("const delay = Math.max(1_000, robots.delayMs)")
  })
})

describe("سقفُ نصّ MCP — مقيس 10-12: 4000 حرف قصّت روابطَ ClickUp فسقط الزاحفُ بعد صفحةٍ واحدة «Unterminated string»", () => {
  test("fitLinks: JSON صالحٌ دائماً تحت السقف — تُسقط النصوصُ ثمّ يقلّ العدد", () => {
    const page = { url: "https://clickup.com/", title: "ClickUp", headings: ["h1 One app"], links: Array.from({ length: 400 }, (_, i) => ({ href: `https://clickup.com/p/${i}`, text: "x".repeat(300) })) }
    expect(JSON.parse(fitLinks(page, 1_000_000)).links[0].text).toHaveLength(300)
    const bare = JSON.parse(fitLinks(page, 20_000))
    expect(bare.links[0].text).toBeUndefined()
    expect(bare.links).toHaveLength(400)
    const fewer = fitLinks(page, 5_000)
    expect(fewer.length).toBeLessThanOrEqual(5_000)
    expect(JSON.parse(fewer).links.length).toBeGreaterThan(0)
    expect(JSON.parse(fewer).links.length).toBeLessThan(400)
  })
  test("McpSession.call: النموذجُ يرى 4000 حرف، والمحرّكُ يطلب النصَّ كاملاً بـmaxText — خادم MCP حقيقيّ طفلاً", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-mcp-max-"))
    const server = join(dir, "big.ts")
    writeFileSync(server, [
      'for await (const line of console) {',
      '  const m = JSON.parse(line)',
      '  if (m.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "big", version: "1" } } }))',
      '  else if (m.method === "tools/list") console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "big", description: "big", inputSchema: { type: "object", properties: {} } }] } }))',
      '  else if (m.method === "tools/call") console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "a".repeat(10000) }] } }))',
      '}',
    ].join("\n"))
    const session = new Mcp.McpSession({ id: "big", command: [process.execPath, server] })
    try {
      expect((await session.handshake()).map((t) => t.name)).toEqual(["big.big"])
      expect((await session.call("big.big", "")).text).toHaveLength(4000)
      expect((await session.call("big.big", "", 60_000, 20_000)).text).toHaveLength(10000)
    } finally { session.close(); for (let i = 0; i < 10; i += 1) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await Bun.sleep(200) } } }
  }, 60_000)
  test("المحرّك يرفع السقفَ لروابط الزاحف ولشجرة المواصفة، ومهلاتُ الحفظ والصورة أطولُ من دقيقة", () => {
    const cli = read("src", "cli.ts")
    expect(cli).toContain('const r = await session.call(`${bridge.id}.${tool}`, args, timeoutMs, tool === "links" ? 200_000 : 8_000)')
    expect(cli).toContain('const timeoutMs = tool === "save" || tool === "download" ? 150_000 : tool === "image" ? 170_000 : tool === "shot" ? 90_000 : 60_000')
    expect(cli).toContain('JSON.stringify({ mode: "spec", target: ref }), 60_000, 700_000)')
  })
})
