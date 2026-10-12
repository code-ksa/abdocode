import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { CdpBrowser } from "@abdo/browser"
import { stripChildEnv } from "@abdo/tools/env-strip"
import { BRIDGE_TOOLS, ChromeBridge, imageArgs, imageTargetPath, placeImage, sniffImage } from "../src/mcp-servers/chrome-bridge"
import { isUserBrowserTask, namesChrome, userBrowserBrief, wantsWebImageGen } from "../src/tool-exposure"

// 10-12 — «ادخل سوي صفحة هبوط عن عبدوكود و ولد صورة مناسبة من جيميناي المفتوح في متصفحك»: فتح النموذجُ Gemini في المتصفّح المملوك
// المعزول (signed out) ورسم SVG بديلاً، والجسرُ لم يكن يعمل. الطلبُ يُعرف، والدورُ يذهب إلى متصفّح المستخدم، والصورةُ المولَّدة تُحفظ ملفّاً.

const OWNER = "ادخل سوي صفحة هبوط عن عبدوكود و ولد صورة مناسبة من جيميناي المفتوح في متصفحك و خليها هيرو ايميدج و ولد باقي صور الصفحة"
const ROOT = resolve(import.meta.dir, "..")
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/gu, "\n")

describe("طلبٌ في متصفّح المستخدم يُعرف — وما ليس كذلك لا يُسحب إليه", () => {
  test("جملةُ المستخدم: متصفّحُه وصورةٌ من Gemini", () => {
    expect(isUserBrowserTask(OWNER)).toBe(true)
    expect(wantsWebImageGen(OWNER)).toBe(true)
    for (const text of ["افتح متصفحي وشوف الإيميل", "generate an image with gemini for the hero", "open my browser and check gmail", "ادخل على حسابي المفتوح في جيميناي", "من الحساب المفتوح انسخ الرابط", "استعمل chatgpt المفتوح عندي"]) {
      expect(isUserBrowserTask(text)).toBe(true)
    }
  })
  test("مهامُّ تطويرٍ عاديّة تبقى على متصفّح الوكيل", () => {
    for (const text of ["اختبر الصفحة في المتصفح", "أضف صفحة حسابي للموقع", "ولد صورة للمنتج", "اعمل صفحة login وخلي المستخدم logged in", "صمّم صفحة هبوط بصورة بطل"]) {
      expect(isUserBrowserTask(text)).toBe(false)
    }
    expect(wantsWebImageGen("افتح متصفحي وشوف الإيميل")).toBe(false)
  })
  test("كروم يُسمّى فيُثبَّت", () => {
    expect(namesChrome("استعمل كروم مش ايدج")).toBe(true)
    expect(namesChrome("in chrome please")).toBe(true)
    expect(namesChrome(OWNER)).toBe(false)
  })
  test("المدخلُ يحمل الحالةَ المقيسة، وطريقَ Gemini ⇦ chrome.image حين تُطلب صورة — ويمنع البديلَ المرسوم", () => {
    const withImage = userBrowserBrief("متّصلة — chrome", true)
    expect(withImage).toContain("حالةُ الإضافة الآن: متّصلة — chrome")
    expect(withImage).toContain("tabs new https://gemini.google.com/app")
    expect(withImage).toContain("chrome.image")
    expect(withImage).toContain("لا ترسم SVG")
    const plain = userBrowserBrief("غير متّصلة", false)
    expect(plain).toContain("لا متصفّحُك المملوك")
    expect(plain).not.toContain("chrome.image")
  })
})

describe("مكانُ الصورة وصيغتُها — من البايتات لا من الامتداد", () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
  test("sniffImage: png/jpg/gif/webp/avif، وصفحةُ HTML ليست صورة", () => {
    expect(sniffImage(PNG)).toBe("png")
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]))).toBe("jpg")
    expect(sniffImage(Buffer.from("GIF89a"))).toBe("gif")
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp")
    expect(sniffImage(Buffer.from("\0\0\0\x1cftypavif"))).toBe("avif")
    expect(sniffImage(Buffer.from("<!doctype html><html>"))).toBeUndefined()
    expect(sniffImage(new Uint8Array())).toBeUndefined()
  })
  test("imageTargetPath: داخل المشروع فقط، بامتداد صورة، لا ملفّ اعتماد", () => {
    const root = resolve(tmpdir(), "proj-x")
    const ok = imageTargetPath(root, "public/images/hero.png")
    expect(ok).toEqual({ ok: true, abs: resolve(root, "public/images/hero.png"), rel: "public/images/hero.png" })
    expect(imageTargetPath(root, "../outside.png").ok).toBe(false)
    expect(imageTargetPath(root, resolve(tmpdir(), "elsewhere.png")).ok).toBe(false)
    expect(imageTargetPath(root, resolve(root, "public/a.png")).ok).toBe(true)
    expect(imageTargetPath(root, "public/notes.txt").ok).toBe(false)
    expect(imageTargetPath(root, "").ok).toBe(false)
    expect(imageTargetPath(root, "keys/server.key").ok).toBe(false)
  })
  test("placeImage: طلبُ .png وبايتاتُ JPEG ⇒ .jpg ويُقال", () => {
    const target = { abs: resolve("p/public/hero.png"), rel: "public/hero.png" }
    expect(placeImage(target, "png")).toEqual({ ...target, renamed: false })
    expect(placeImage(target, "jpg")).toEqual({ abs: resolve("p/public/hero.jpg"), rel: "public/hero.jpg", renamed: true })
    expect(placeImage({ abs: resolve("p/a.jpeg"), rel: "a.jpeg" }, "jpg").renamed).toBe(false)
  })
})

describe("imageArgs — النموذجُ يكتب السطرَ نصّاً حرّاً (مقيس في دور مستخدم 10-12: «بلا امتداد صورة» أربعَ مرّات)", () => {
  test("المسارُ وwait بأيّ فاصل ومرجعُ rN من سطرٍ واحد، والحقولُ الصريحة تغلب", () => {
    expect(imageArgs({ path: "public/images/abdo-code/hero.png wait=90" })).toEqual({ path: "public/images/abdo-code/hero.png", ref: "", wait: 90 })
    expect(imageArgs({ path: "public/images/abdo-code/hero.png wait 90" }).wait).toBe(90)
    expect(imageArgs({ path: "public/images/abdo-code/hero.png r40" })).toEqual({ path: "public/images/abdo-code/hero.png", ref: "r40", wait: 0 })
    expect(imageArgs({ path: "public/hero.png wait=10", wait: 30, ref: "r2" })).toEqual({ path: "public/hero.png", ref: "r2", wait: 30 })
    expect(imageArgs({ path: "public/hero.png wait=999" }).wait).toBe(120)
    expect(imageArgs({ path: "«public/a.jpg»" }).path).toBe("public/a.jpg")
  })
})

describe("chrome.image عبر الجسر الحقيقيّ وإضافةٍ مزيّفة — الملفُّ على القرص هو الحَكَم", () => {
  const PNG64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  const JPG64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]).toString("base64")

  test("مُعلَنةٌ للمحرّك بمسارٍ إلزاميّ وانتظارٍ ≤120 ث", () => {
    const tool = BRIDGE_TOOLS.find((t) => t.name === "image")!
    expect(tool.inputSchema.required).toEqual(["path"])
    expect((tool.inputSchema.properties as Record<string, { maximum?: number }>).wait!.maximum).toBe(120)
  })

  test("تُحفظ في المشروع، والمحفوظةُ تُستثنى في الطلب التالي، والامتدادُ يُصحَّح، وغيرُ الصورة لا يُكتب", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-bridge-image-"))
    const project = join(dir, "project")
    const settings = join(dir, "settings.json")
    require("node:fs").mkdirSync(project)
    writeFileSync(settings, JSON.stringify({ project }))
    const bridge = new ChromeBridge({ port: 0, token: "t", settingsFile: settings, stateDir: dir, announce: () => {} })
    const port = bridge.start()
    const received: Record<string, unknown>[] = []
    const replies: unknown[] = [
      { data: PNG64, key: "https://lh3.example/one", src: "https://lh3.example/one", mime: "image/png", width: 1, height: 1 },
      null,
      { data: JPG64, key: "https://lh3.example/two", src: "https://lh3.example/two", mime: "image/jpeg", width: 1, height: 1 },
      { data: Buffer.from("<!doctype html>").toString("base64"), key: "x", src: "https://lh3.example/err", mime: "text/html" },
    ]
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=t`)
    await new Promise<void>((done) => { ws.onopen = () => done() })
    ws.onmessage = (event) => {
      const m = JSON.parse(String(event.data)) as { id: number; action: string; args: Record<string, unknown> }
      if (m.action !== "image") { ws.send(JSON.stringify({ id: m.id, ok: true, result: true })); return }
      received.push(m.args)
      ws.send(JSON.stringify({ id: m.id, ok: true, result: replies.shift() ?? null }))
    }
    try {
      await Bun.sleep(50)
      const first = await bridge.run("image", { path: "public/images/hero.png wait=5" })
      expect(first).toContain("حُفظت الصورة")
      expect(first).toContain("public/images/hero.png")
      expect(readFileSync(join(project, "public/images/hero.png")).toString("base64")).toBe(PNG64)
      expect(received[0]).toMatchObject({ wait: 5, exclude: [], minSide: 256 })

      const none = await bridge.run("image", { path: "public/images/two.png", wait: 0 })
      expect(none).toContain("لا صورةَ جديدة")
      expect(received[1]!.exclude).toEqual(["https://lh3.example/one"])
      expect(existsSync(join(project, "public/images/two.png"))).toBe(false)

      const renamed = await bridge.run("image", { path: "public/images/two.png", wait: 3 })
      expect(renamed).toContain("public/images/two.jpg")
      expect(renamed).toContain("صُحّح الامتداد")
      expect(existsSync(join(project, "public/images/two.jpg"))).toBe(true)
      expect(existsSync(join(project, "public/images/two.png"))).toBe(false)

      const html = await bridge.run("image", { path: "public/images/three.png" })
      expect(html).toContain("ليس صورة")
      expect(existsSync(join(project, "public/images/three.png"))).toBe(false)

      expect(await bridge.run("image", { path: "../escape.png" })).toContain("خارج المشروع")
      expect(received).toHaveLength(4)
    } finally { ws.close(); bridge.stop(); rmSync(dir, { recursive: true, force: true }) }
  })

  test("إضافةٌ أقدمُ من 0.7.1 تُسمّى بعمرها لا بـ«unknown action» عارياً", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-bridge-image-old-"))
    const bridge = new ChromeBridge({ port: 0, token: "t", stateDir: dir, announce: () => {} })
    const port = bridge.start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=t`)
    await new Promise<void>((done) => { ws.onopen = () => done() })
    ws.onmessage = (event) => { const m = JSON.parse(String(event.data)) as { id: number }; ws.send(JSON.stringify({ id: m.id, ok: false, error: "unknown action" })) }
    try {
      await Bun.sleep(50)
      expect(await bridge.run("image", { path: "hero.png" })).toContain("أقدمُ من 0.7.1")
    } finally { ws.close(); bridge.stop(); rmSync(dir, { recursive: true, force: true }) }
  })
})

const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync)

describe("الإضافة 0.7.1 — IMAGE_FIND على صفحةٍ حقيقيّة في إيدج بلا واجهة (لا نافذةَ على الشاشة)", () => {
  const background = read("..", "browser-bridge", "extension", "background.js")
  const start = background.indexOf("const IMAGE_FIND = ")
  const source = background.slice(start + "const IMAGE_FIND = ".length, background.indexOf("\n}\n", start) + 2)

  test("المصدر: الحالةُ في perform، وhttp(s) يجلبه عاملُ الإضافة بسقف 15MB، والإصدار 0.7.1", () => {
    expect(start).toBeGreaterThan(0)
    expect(background).toContain('case "image": {')
    expect(background).toContain("await inPage(tab.id, IMAGE_FIND, [String(args.ref || \"\"), exclude, minSide])")
    expect(background).toContain('const response = await fetch(found.src, { credentials: "include" })')
    expect(background).toContain("if (buf.length > IMAGE_CAP) throw new Error(\"image larger than 15MB\")")
    expect(JSON.parse(read("..", "browser-bridge", "extension", "manifest.json")).version).toBe("0.8.0")
  })

  test.skipIf(!edge)("أحدثُ صورةٍ كبيرة ظاهرة، blob تُقرأ بايتاتٍ من الصفحة، والمستثناة تُتخطّى، والصغيرة لا تُحسب", async () => {
    const home = mkdtempSync(join(tmpdir(), "abdo-ext-image-"))
    const page = `<title>images</title><body><script>
      const make = (side, color) => { const c = document.createElement('canvas'); c.width = side; c.height = side; const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, side, side); return c }
      const add = (src, side) => new Promise((done) => { const i = new Image(); i.onload = () => done(); i.width = Math.min(side, 300); i.src = src; document.body.appendChild(i) })
      window.ready = (async () => {
        await add(make(32, 'red').toDataURL('image/png'), 32)
        await add(make(300, 'green').toDataURL('image/png'), 300)
        const blob = await new Promise((done) => make(400, 'blue').toBlob(done, 'image/png'))
        await add(URL.createObjectURL(blob), 400)
      })()
    </script></body>`
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } }) })
    const lease = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }), port = lease.port; lease.stop(true)
    const child = Bun.spawn([edge!, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--no-proxy-server", "--window-size=900,900", `--remote-debugging-port=${port}`, `--user-data-dir=${join(home, "profile")}`, "about:blank"], { env: stripChildEnv(process.env).env, stdout: "ignore", stderr: "ignore" })
    const browser = new CdpBrowser(port!)
    try {
      for (let i = 0; ; i++) { try { await browser.attach(); break } catch (error) { if (i > 60) throw error; await Bun.sleep(100) } }
      await browser.navigate(`http://127.0.0.1:${server.port}/`)
      await browser.evaluateAsync("window.ready.then(() => 1)")
      const find = async (exclude: string[]) => JSON.parse(await browser.evaluateAsync(`(${source})("", ${JSON.stringify(exclude)}, 256).then((r) => JSON.stringify(r))`)) as { src: string; key: string; width: number; height: number; mime?: string; data?: string } | null
      const newest = await find([])
      expect(newest).not.toBeNull()
      expect(newest!.width).toBe(400)
      expect(newest!.key.startsWith("blob:")).toBe(true)
      expect(newest!.mime).toBe("image/png")
      expect(sniffImage(Buffer.from(newest!.data!, "base64"))).toBe("png")
      const previous = await find([newest!.key])
      expect(previous!.width).toBe(300)
      expect(previous!.key.startsWith("data:image/png")).toBe(true)
      expect(previous!.src.length).toBeLessThanOrEqual(60)
      expect(sniffImage(Buffer.from(previous!.data!, "base64"))).toBe("png")
      expect(await find([newest!.key, previous!.key])).toBeNull()
    } finally {
      browser.close(); child.kill(); await child.exited; server.stop(true)
      for (let i = 0; i < 20; i += 1) { try { rmSync(home, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
    }
  }, 120_000)
})

describe("الإضافة 0.7.2 — «open» لا يستبدل تبويبَ المستخدم أبداً (مقيس 10-12: استُبدل تبويبُ بريد المستخدم)", () => {
  /** عاملُ الخدمة كما هو، فوق واجهة كرومٍ مزيّفة تسجّل ما يُطلب منها — perform يُستدعى مباشرةً. */
  const loadExtension = async () => {
    const source = read("..", "browser-bridge", "extension", "background.js")
    const calls: string[] = []
    let nextId = 100
    let active = { id: 7, windowId: 1, url: "https://mail.example.com/inbox/" }
    const updated: ((id: number, info: { status: string }) => void)[] = []
    // التحميلُ يكتمل بعد أن يبدأ الانتظار (كما في كروم) — لا قبله.
    const fire = (id: number) => setTimeout(() => { for (const fn of [...updated]) fn(id, { status: "complete" }) }, 30)
    const session: Record<string, unknown> = {}
    const stub: any = new Proxy(() => Promise.resolve(undefined), { get: (_t, key) => key === "then" ? undefined : key === "addListener" || key === "removeListener" ? () => {} : stub, apply: () => Promise.resolve(undefined) })
    const chrome = {
      ...{ runtime: stub, alarms: stub, debugger: stub, scripting: stub, action: stub, sidePanel: stub },
      storage: { local: { get: async (d: unknown) => d }, session: { get: async (d: Record<string, unknown>) => ({ ...d, ...session }), set: async (v: Record<string, unknown>) => { Object.assign(session, v) } }, onChanged: stub },
      tabs: {
        query: async () => [active],
        create: async (o: { url: string; active: boolean }) => { const tab = { id: nextId++, windowId: 1, url: o.url }; calls.push(`create ${o.url}`); active = tab; fire(tab.id); return tab },
        update: async (id: number, o: { url: string }) => { calls.push(`update ${id} ${o.url}`); fire(id); return { id } },
        onUpdated: { addListener: (fn: (id: number, info: { status: string }) => void) => updated.push(fn), removeListener: (fn: (id: number, info: { status: string }) => void) => { const i = updated.indexOf(fn); if (i >= 0) updated.splice(i, 1) } },
        onRemoved: stub, onActivated: stub,
      },
    }
    const vm = await import("node:vm")
    const context = vm.createContext({ chrome, navigator: { userAgent: "Chrome/140", userAgentData: { brands: [] } }, WebSocket: class { close() {} send() {} }, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, console, fetch: async () => new Response("{}"), URL, btoa, atob })
    vm.runInContext(`${source}\n;globalThis.__perform = perform`, context)
    return { perform: (context as unknown as { __perform: (a: string, b: object) => Promise<unknown> }).__perform, calls, setActive: (tab: { id: number; windowId: number; url: string }) => { active = tab } }
  }

  test("تبويبُ المستخدم ⇦ تبويبٌ جديد للرابط؛ تبويبُ الوكيل ⇦ يُبدَّل هو نفسُه؛ وtabs new يُحسب للوكيل", async () => {
    const ext = await loadExtension()
    expect(await ext.perform("open", { url: "http://127.0.0.1:3001/abdo-code" })).toEqual({ newTab: true, id: 100 })
    expect(ext.calls).toEqual(["create http://127.0.0.1:3001/abdo-code"])
    expect(await ext.perform("open", { url: "http://127.0.0.1:3001/other" })).toEqual({ newTab: false, id: 100 })
    expect(ext.calls.at(-1)).toBe("update 100 http://127.0.0.1:3001/other")
    ext.setActive({ id: 7, windowId: 1, url: "https://mail.google.com/" })
    expect((await ext.perform("open", { url: "https://gemini.google.com/app" }) as { newTab: boolean }).newTab).toBe(true)
    expect(ext.calls.some((c) => c.startsWith("update 7 "))).toBe(false)
    await ext.perform("tabs", { op: "new", url: "https://gemini.google.com/app" })
    expect((await ext.perform("open", { url: "https://gemini.google.com/app/x" }) as { newTab: boolean }).newTab).toBe(false)
  })

  test("الجسرُ يقول أين فتح", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-bridge-open-"))
    const bridge = new ChromeBridge({ port: 0, token: "t", stateDir: dir, announce: () => {} })
    const port = bridge.start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=t`)
    await new Promise<void>((done) => { ws.onopen = () => done() })
    ws.onmessage = (event) => { const m = JSON.parse(String(event.data)) as { id: number }; ws.send(JSON.stringify({ id: m.id, ok: true, result: { newTab: true, id: 9 } })) }
    try {
      await Bun.sleep(50)
      expect(await bridge.run("open", { url: "https://gemini.google.com/app" })).toContain("فتحتُه في تبويبٍ جديد (تبويبُ المستخدم لم يُستبدل)")
    } finally { ws.close(); bridge.stop(); rmSync(dir, { recursive: true, force: true }) }
  })
})

describe("المحرّك: الدورُ في متصفّح المستخدم يشغّل الجسرَ بنفسه ويرجع بعده إلى إعداده", () => {
  const cli = read("src", "cli.ts")
  test("الجسرُ يُشغَّل من باب «وصّل» نفسِه، ثمّ يُقرن، وكروم يُثبَّت إن سُمّي", () => {
    expect(cli).toContain('remoteQueue.push({ kind: "external-connect", id: bridge.id, command: bridge.command, protocol: "mcp" })')
    expect(cli).toContain("const outcome = await ensureExtensionPaired({ stateDir: STATE_ROOT, runningBrowsers: runningBrowsersWindows, launchBrowser: launchBrowserWindows })\n    let pinned")
    expect(cli).toContain('JSON.stringify({ op: "use", target: "chrome" })')
  })
  test("كلُّ قراءةٍ للخلفيّة تمرّ بمتصفّح الدور، والإعدادُ لا يُكتب", () => {
    expect(cli).toContain('const browserBackendNow = (): "owned" | "extension" | "off" => turnBrowserBackend ?? loadSettings().browserBackend ?? "owned"')
    expect(cli).toContain('const hideChrome = chromeBridgeId !== undefined && browserBackendNow() !== "extension"')
    expect(cli).toContain('word.startsWith(`${chromeBridgeId}.`) && browserBackendNow() !== "extension"')
    const redirect = cli.slice(cli.indexOf("const runSurfaceTool = async"), cli.indexOf('if (name === "surface") {', cli.indexOf("const runSurfaceTool = async")))
    expect(redirect).toContain("const backend = browserBackendNow()\n    if (backend === \"off\"")
    const prepare = cli.slice(cli.indexOf("const prepareUserBrowser = async"), cli.indexOf("const runSurfaceTool = async"))
    expect(prepare).not.toContain("saveSettings")
  })
  test("يُجهَّز قبل الحقبة الأولى ويدخلها، ولا يُخلط بطريق سطح المكتب، ويُرفع على مخرجَي الدور", () => {
    expect(cli).toContain("const userBrowser = isUserBrowserTask(turn.body)")
    expect(cli).toContain('${isDesktopDriveTask(turn.body) && !userBrowser ? DESKTOP_DRIVE_BRIEF : ""}${userBrowserNote}${turn.body}')
    expect(cli.split("projectCreatedInTurn = undefined\n      turnBrowserBackend = undefined\n      running = undefined").length - 1).toBe(2)
  })
})
