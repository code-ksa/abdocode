import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { browserFromUserAgent, ChromeBridge, KEY_SHAPE, loginHint, maskSecrets } from "../src/mcp-servers/chrome-bridge"
import { cleanCopiedHtml, referenceDir } from "../src/reference-save"

// 10-10 . مقيسٌ قبلها: الإضافةُ الثانية تُردّ 409،
// والحقلُ المعبّأ بحفظ المتصفّح (autofilled) كانت عقدتُه تسقط من الشجرة كلّها، و`key` لا يقبل Control+a، ولا نسخَ صفحةٍ ولا كونسول.

type Ext = { name: string; received: { action: string; args: Record<string, unknown> }[]; ws: WebSocket; send: (frame: object) => void; close: () => void }

const connectExt = async (port: number, token: string, name: string, reply: (action: string, args: Record<string, unknown>) => unknown = () => true): Promise<Ext> => {
  const received: Ext["received"] = []
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`)
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("refused")) })
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data)) as { id?: number; action: string; args: Record<string, unknown> }
    if (typeof m.id !== "number") return
    received.push({ action: m.action, args: m.args })
    ws.send(JSON.stringify({ id: m.id, ok: true, result: reply(m.action, m.args) }))
  }
  const send = (frame: object) => ws.send(JSON.stringify(frame))
  send({ kind: "hello", browser: name, version: "0.7.0" })
  await Bun.sleep(30)
  return { name, received, ws, send, close: () => ws.close() }
}

const withBridge = async (run: (bridge: ChromeBridge, port: number, dir: string) => Promise<void>, staleMs = 45_000) => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-multi-"))
  const project = join(dir, "project"); mkdirSync(project)
  const settings = join(dir, "engine-settings.json")
  writeFileSync(settings, JSON.stringify({ project }))
  const bridge = new ChromeBridge({ port: 0, token: "multi-token-xxxxxxxxxxxx", stateDir: dir, settingsFile: settings, pairingWindowMs: 0, staleMs, announce: () => {} })
  const port = bridge.start()
  try { await run(bridge, port, dir) } finally { bridge.stop(); rmSync(dir, { recursive: true, force: true }) }
}

describe("كروم وإيدج موصولان معاً", () => {
  test("كلاهما يتّصل، الأفعالُ تذهب إلى آخر من ركّز عليه المستخدم، browsers use يثبّت، والتبديلُ يُبطل المراجع", async () => {
    await withBridge(async (bridge, port) => {
      const tree = (who: string) => [{ ref: "r1", role: "button", name: `Go ${who}` }]
      const chrome = await connectExt(port, bridge.token, "chrome", (a) => a === "page" ? tree("chrome") : true)
      const edge = await connectExt(port, bridge.token, "edge", (a) => a === "page" ? tree("edge") : true)
      expect(bridge.browsers.map((b) => b.browser).sort()).toEqual(["chrome", "edge"])
      const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { connected: boolean; browsers: string[] }
      expect(health.connected).toBe(true); expect(health.browsers.sort()).toEqual(["chrome", "edge"])
      // بلا تركيز: آخرُ من اتّصل (إيدج)
      expect(await bridge.run("page", {})).toContain("Go edge")
      // المستخدمُ ركّز على كروم ⇦ الفعلُ التالي هناك، ومراجعُ إيدج بطلت قبل أن يصل الطلب
      chrome.send({ kind: "focus", at: Date.now() }); await Bun.sleep(30)
      expect(await bridge.run("tap", { ref: "r1" })).toContain("مرجعٌ غير معروف")
      expect(edge.received.filter((r) => r.action === "tap")).toEqual([])
      expect(await bridge.run("page", {})).toContain("Go chrome")
      expect(await bridge.run("tap", { ref: "r1" })).toContain("نقرتُ «Go chrome»")
      expect(chrome.received.map((r) => r.action)).toEqual(["page", "tap"])
      // التثبيت يغلب التركيز حتى auto
      expect(await bridge.run("browsers", { op: "use", target: "edge" })).toContain("ثبّتُّ الأفعالَ على edge")
      chrome.send({ kind: "focus", at: Date.now() }); await Bun.sleep(30)
      expect(await bridge.run("page", {})).toContain("Go edge")
      expect(await bridge.run("browsers", { op: "list" })).toContain("● edge")
      expect(await bridge.run("browsers", { op: "use", target: "safari" })).toContain("لا متصفّحَ موصولاً باسم")
      await bridge.run("browsers", { op: "use", target: "auto" })
      expect(await bridge.run("page", {})).toContain("Go chrome")
      // إغلاقُ إيدج لا يمسّ كروم (كان إغلاقُ مقبسٍ يمحو الحقلَ الواحد ولو لم يكن هو)
      edge.close(); await Bun.sleep(50)
      expect(bridge.browsers.map((b) => b.browser)).toEqual(["chrome"])
      expect(await bridge.run("page", {})).toContain("Go chrome")
      chrome.close()
    })
  })

  test("اسمان متماثلان يُميَّزان (ملفّا كروم)، والاسمُ من User-Agent قبل hello", async () => {
    expect(browserFromUserAgent("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0")).toBe("edge")
    expect(browserFromUserAgent("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36")).toBe("chrome")
    expect(browserFromUserAgent("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18 Safari/605.1.15")).toBe("safari")
    await withBridge(async (bridge, port) => {
      const a = await connectExt(port, bridge.token, "chrome")
      const b = await connectExt(port, bridge.token, "chrome")
      expect(bridge.browsers.map((x) => x.browser).sort()).toEqual(["chrome", "chrome-2"])
      a.close(); b.close()
    })
  })

  test("الصامتُ وحده يسقط: المتصفّحُ النابض يبقى", async () => {
    await withBridge(async (bridge, port) => {
      const quiet = await connectExt(port, bridge.token, "chrome")
      const alive = await connectExt(port, bridge.token, "edge")
      for (let i = 0; i < 4; i++) { await Bun.sleep(100); alive.send({ kind: "ping", at: Date.now() }) }
      expect(bridge.browsers.map((x) => x.browser)).toEqual(["edge"])
      expect(bridge.connected).toBe(true)
      quiet.close(); alive.close()
    }, 250)
  })
})

describe("الحقلُ المعبّأ بحفظ المتصفّح لا يسقط من الشجرة", () => {
  test("autofilled تبقى عقدةً ويظهر تلميحُ الدخول «اضغط الزرّ» — وكانت تُحذف فلا تلميحَ أصلاً", async () => {
    await withBridge(async (bridge, port) => {
      const ext = await connectExt(port, bridge.token, "chrome", (a) => a === "page" ? [{ ref: "r1", role: "textbox", name: "Email", state: "autofilled" }, { ref: "r2", role: "textbox:password", name: "Password", state: "autofilled" }, { ref: "r3", role: "button", name: "Sign in" }] : true)
      const page = await bridge.run("page", {})
      expect(page).toContain("[r2] textbox:password: Password (معبّأ بحفظ المتصفّح)")
      expect(page).toContain("اضغط [r3] «Sign in»")
      expect(bridge.refs.length).toBe(3)
      ext.close()
    })
    expect(loginHint([{ ref: "r2", role: "textbox:password", name: "Password", state: "autofilled" }])).toContain("مخفيّةٌ عن السكربت")
  })
})

describe("أدواتٌ أقوى", () => {
  test("key يقبل المُعدِّلات والحروف وF1–F12، ويرفض ما سواها قبل الإرسال", async () => {
    for (const ok of ["Enter", "Control+a", "Shift+Tab", "Control+Shift+K", "F5", "a", "7", "Meta+Enter", "ArrowDown"]) expect(KEY_SHAPE.test(ok)).toBe(true)
    for (const bad of ["Control+", "Hyper+a", "F13", "ab+c", "Enter; rm", "Control+Alt+Shift+Meta+a"]) expect(KEY_SHAPE.test(bad)).toBe(false)
    await withBridge(async (bridge, port) => {
      const ext = await connectExt(port, bridge.token, "edge", () => ({ mode: "trusted" }))
      expect(await bridge.run("key", { key: "Control+a" })).toContain("ضغطتُ Control+a")
      expect(await bridge.run("key", { key: "Hyper+a" })).toContain("الصيغة")
      expect(ext.received).toEqual([{ action: "key", args: { key: "Control+a" } }])
      ext.close()
    })
  })

  test("save يكتب HTML والأنماط والسكربتات وmeta تحت <المشروع>/.abdo/reference/<الموقع>/<الصفحة> — والقرصُ هو الحكم", async () => {
    await withBridge(async (bridge, port, dir) => {
      const copy = { url: "https://n8n.io/pricing/", title: "Pricing", viewport: { width: 1280, height: 800 },
        html: '<!DOCTYPE html>\n<html lang="en" data-abdo-seq="9"><body><a data-abdo-ref="r1" href="/x">Plans</a></body></html>',
        styles: [{ href: "https://n8n.io/_nuxt/entry.css", media: "", text: ".plan{color:#ea4b71}" }, { href: null, media: "", text: ".x{margin:0}" }, { href: "https://cdn.test/blocked.css", media: "", error: "HTTP 403" }],
        scripts: [{ src: "https://n8n.io/_nuxt/app.js", type: "module", text: "window.app=1" }, { src: null, type: "", text: "window.__inline=1" }] }
      const ext = await connectExt(port, bridge.token, "chrome", (a) => a === "save" ? copy : true)
      const said = await bridge.run("save", {})
      const out = join(dir, "project", ".abdo", "reference", "n8n.io", "pricing")
      expect(said).toContain(".abdo/reference/n8n.io/pricing/")
      const html = readFileSync(join(out, "page.html"), "utf8")
      expect(html.startsWith('<!DOCTYPE html>\n<html lang="en">')).toBe(true)
      expect(html).not.toContain("data-abdo-")
      expect(readdirSync(join(out, "styles")).sort()).toEqual(["01-entry.css", "02-inline-2.css"])
      expect(readdirSync(join(out, "scripts")).sort()).toEqual(["01-app.js", "02-inline-2.js"])
      const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"))
      expect(meta.styles[2].error).toBe("HTTP 403"); expect(meta.how).toContain("browser extension (chrome)")
      // مجلّدٌ قصير يوضع تحت .abdo/reference (مقيس 10-10: كان يكتب في جذر المشروع)، والمطلقُ و«..» يُرفضان بلا كتابة
      await bridge.run("save", { dir: "n8n/pricing-v2" })
      expect(existsSync(join(dir, "project", ".abdo", "reference", "n8n", "pricing-v2", "page.html"))).toBe(true)
      expect(existsSync(join(dir, "project", "n8n"))).toBe(false)
      expect(await bridge.run("save", { dir: "../../escape" })).toContain("مجلّدٌ غيرُ مقبول")
      expect(await bridge.run("save", { dir: "C:/Windows/x" })).toContain("مجلّدٌ غيرُ مقبول")
      expect(existsSync(join(dir, "escape"))).toBe(false)
      ext.close()
    })
  })

  test("devtools يعيد الكونسولَ والشبكةَ سطوراً، والرموزُ في الروابط والرسائل محجوبة قبل أن تصل النموذج", async () => {
    await withBridge(async (bridge, port) => {
      const ext = await connectExt(port, bridge.token, "edge", (a, args) => a !== "devtools" ? true : args.what === "console"
        ? { started: true, url: "https://app.test/", entries: [{ level: "error", text: "Uncaught TypeError: x is undefined", at: "https://app.test/app.js:12" }, { level: "log", text: "auth Bearer abcdefghijklmnopqrstuvwxyz0123" }] }
        : { started: true, url: "https://app.test/", entries: [{ method: "GET", url: "https://api.test/me?access_token=SECRET123456&x=1", status: 401, type: "Fetch", ms: 41.6, bytes: 120 }, { method: "POST", url: "https://api.test/save", failed: "net::ERR_FAILED", type: "XHR" }] })
      const con = await bridge.run("devtools", { what: "console" })
      expect(con).toContain("[error] Uncaught TypeError: x is undefined — https://app.test/app.js:12")
      expect(con).toContain("Bearer «محجوب»"); expect(con).not.toContain("abcdefghijklmnop")
      const net = await bridge.run("devtools", { what: "network" })
      expect(net).toContain("GET 401 Fetch https://api.test/me?access_token=«محجوب»&x=1 42ms 120B")
      expect(net).toContain("POST ✕ net::ERR_FAILED XHR https://api.test/save")
      expect(net).toContain("بدأ التسجيلُ الآن"); expect(net).not.toContain("SECRET123456")
      expect(await bridge.run("devtools", { what: "cookies" })).toContain("الصيغة")
      ext.close()
    })
    // التوأم: نصٌّ بلا أسرار لا يُمسّ
    expect(maskSecrets("GET https://n8n.io/pricing?plan=pro 200")).toBe("GET https://n8n.io/pricing?plan=pro 200")
  })

  test("shot full يطلب الصفحةَ كاملةً ويُحفظ باسم المتصفّح", async () => {
    await withBridge(async (bridge, port, dir) => {
      const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
      const ext = await connectExt(port, bridge.token, "edge", (a) => a === "shot" ? png : true)
      const said = await bridge.run("shot", { full: true })
      expect(said).toContain("لقطةُ الصفحة كاملةً")
      expect(ext.received).toEqual([{ action: "shot", args: { full: true } }])
      expect(readdirSync(join(dir, "chrome-shots")).some((f) => f.startsWith("edge-full-"))).toBe(true)
      ext.close()
    })
  })
})

describe("reference-save — بابٌ واحد للمتصفّحين", () => {
  test("المجلّد: الافتراضُ الموقع/الصفحة، والقصيرُ تحت .abdo/reference، والمطلقُ و«..» مرفوضان", () => {
    expect(referenceDir("", "https://n8n.io/")).toEqual({ ok: true, dir: ".abdo/reference/n8n.io/home" })
    expect(referenceDir("", "https://n8n.io/integrations/slack/")).toEqual({ ok: true, dir: ".abdo/reference/n8n.io/integrations-slack" })
    expect(referenceDir("n8n.io/home", "https://n8n.io/")).toEqual({ ok: true, dir: ".abdo/reference/n8n.io/home" })
    expect(referenceDir(".abdo/reference/x", "https://n8n.io/")).toEqual({ ok: true, dir: ".abdo/reference/x" })
    expect(referenceDir("./a\\b/", "https://n8n.io/")).toEqual({ ok: true, dir: ".abdo/reference/a/b" })
    for (const bad of ["../x", "a/../../b", "/etc", "C:/x", "a//b"]) expect(referenceDir(bad, "https://n8n.io/").ok).toBe(false)
    expect(referenceDir("", "not a url").ok).toBe(false)
  })
  test("HTML المنسوخ بلا سمات عبدو كود، وDOCTYPE يُضاف إن غاب", () => {
    expect(cleanCopiedHtml('<html data-abdo-seq="4"><a data-abdo-ref="r12">x</a></html>')).toBe('<!DOCTYPE html>\n<html><a>x</a></html>')
    expect(cleanCopiedHtml('<!doctype html><html lang="en"></html>')).toBe('<!doctype html><html lang="en"></html>')
  })
})
