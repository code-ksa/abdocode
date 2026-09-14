import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CdpBrowser } from "../src/cdp"
import { stripChildEnv } from "@abdo/tools/env-strip"

// ذ9هـ — التقاطُ طرفيّة الصفحة على **إيدج حقيقيّ**: رسائلُ console.* والأخطاءُ غير الملتقَطة تصل الحلقةَ منذ الوصل،
// والفارغُ يبقى فارغاً حقّاً قبل أن تنطق الصفحة (الفحصُ السالب الذي يمنع «التقاطاً» يُخترع من العدم).

const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync)

test.skipIf(!edge)("real Edge: the console ring starts empty, then holds the page's own messages and its uncaught error", async () => {
  const home = mkdtempSync(join(tmpdir(), "abdo-cdp-console-"))
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request): Response {
    const url = new URL(request.url)
    if (url.pathname === "/talk") {
      return new Response(
        "<title>talker</title><script>console.log('مرحبا من الصفحة');console.warn('تحذيرٌ مقصود');setTimeout(()=>{throw new Error('عطبٌ مقصود')},10)</script>",
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      )
    }
    return new Response("<title>quiet</title><p>لا شيء</p>", { headers: { "Content-Type": "text/html; charset=utf-8" } })
  } })
  const lease = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }), port = lease.port; lease.stop(true)
  const child = Bun.spawn([edge!, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${join(home, "profile")}`, `http://127.0.0.1:${server.port}/quiet`], { env: stripChildEnv(process.env) as unknown as Record<string, string | undefined>, stdout: "ignore", stderr: "ignore" })
  const browser = new CdpBrowser(port!)
  try {
    for (let i = 0; ; i++) { try { await browser.attach(); break } catch (error) { if (i > 40) throw error; await Bun.sleep(100) } }
    // الصفحةُ الصامتة: لا رسائلَ تُخترع
    expect(browser.consoleTail()).toHaveLength(0)
    await browser.navigate(`http://127.0.0.1:${server.port}/talk`)
    const deadline = Date.now() + 8000
    while (browser.consoleTail().length < 3 && Date.now() < deadline) await Bun.sleep(50)
    const messages = browser.consoleTail()
    const text = messages.map((m) => `${m.level}:${m.text}`).join("\n")
    expect(text).toContain("مرحبا من الصفحة")
    expect(text).toContain("تحذيرٌ مقصود")
    expect(text).toContain("عطبٌ مقصود")
    // الأحدثُ آخراً، وكلُّ رسالةٍ بمستواها ومصدرها وزمنها
    expect(messages.every((m) => m.at > 0 && m.level.length > 0 && m.source.length > 0)).toBe(true)
    expect(messages.some((m) => m.level === "error")).toBe(true)
    // والسقفُ يُحترم: الطلبُ بعددٍ يعيد الأحدثَ فقط
    expect(browser.consoleTail(1)).toHaveLength(1)
    expect(browser.consoleTail(1)[0]).toEqual(messages.at(-1)!)
  } finally {
    browser.close(); child.kill(); await child.exited; server.stop(true)
    for (let i = 0; i < 20; i += 1) { try { rmSync(home, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
  }
}, 120_000)

test.skipIf(!edge)("real Edge: the network ring holds the page's own requests with method, status and url — and never a header or a body", async () => {
  const home = mkdtempSync(join(tmpdir(), "abdo-cdp-net-"))
  const seen: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request): Response {
    const url = new URL(request.url)
    seen.push(request.method + " " + url.pathname)
    if (url.pathname === "/data.json") return new Response(JSON.stringify({ secret: "لا يُلتقط جسماً" }), { headers: { "Content-Type": "application/json; charset=utf-8", "x-secret-header": "never-captured" } })
    if (url.pathname === "/missing") return new Response("no", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } })
    return new Response("<title>net</title><script>fetch('/data.json').then(()=>fetch('/missing'))</script>", { headers: { "Content-Type": "text/html; charset=utf-8" } })
  } })
  const lease = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }), port = lease.port; lease.stop(true)
  const child = Bun.spawn([edge!, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${join(home, "profile")}`, "about:blank"], { env: stripChildEnv(process.env) as unknown as Record<string, string | undefined>, stdout: "ignore", stderr: "ignore" })
  const browser = new CdpBrowser(port!)
  try {
    for (let i = 0; ; i++) { try { await browser.attach(); break } catch (error) { if (i > 40) throw error; await Bun.sleep(100) } }
    // قبل أيّ تنقّل: الحلقةُ فارغةٌ حقّاً
    expect(browser.networkTail()).toHaveLength(0)
    await browser.navigate(`http://127.0.0.1:${server.port}/page`)
    const deadline = Date.now() + 10_000
    while (browser.networkTail().length < 3 && Date.now() < deadline) await Bun.sleep(50)
    const events = browser.networkTail()
    const line = events.map((e) => `${e.method} ${e.status ?? e.failure ?? "?"} ${e.url}`).join("\n")
    expect(line).toContain("/page")
    expect(line).toContain("/data.json")
    expect(line).toContain("/missing")
    expect(events.some((e) => e.status === 200)).toBe(true)
    expect(events.some((e) => e.status === 404)).toBe(true)
    // والعقدُ الذي يمنع التسرّب: لا ترويسةَ ولا جسمَ في أيّ حقلٍ ملتقَط
    const serialised = JSON.stringify(events)
    expect(serialised).not.toContain("never-captured")
    expect(serialised).not.toContain("لا يُلتقط جسماً")
    expect(Object.keys(events[0]!).sort()).toEqual(["at", "method", "status", "type", "url"])
    expect(seen.some((s) => s.includes("/data.json"))).toBe(true) // الطلبُ وقع فعلاً
  } finally {
    browser.close(); child.kill(); await child.exited; server.stop(true)
    for (let i = 0; i < 20; i += 1) { try { rmSync(home, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
  }
}, 120_000)
