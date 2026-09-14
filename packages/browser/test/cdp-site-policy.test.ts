import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CdpBrowser } from "../src/cdp"
import { stripChildEnv } from "@abdo/tools/env-strip"
import { browserSiteAllowed } from "../../engine/src/browser-site-policy"

const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync)
test.skipIf(!edge)("real Edge enforces saved policy for link, form, redirect, iframe, popup and block-all navigation", async () => {
  const home = mkdtempSync(join(tmpdir(), "abdo-cdp-policy-")), settings = join(home, "engine-settings.json"), policy = join(home, "workspace-v1.json")
  const requests: string[] = [], checked: string[] = []
  const server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch(request): Response {
    const url = new URL(request.url); requests.push(request.method + " " + request.url)
    if (url.pathname === "/positive-popup") return new Response("<script>window.close()</script>",{headers:{"Content-Type":"text/html"}})
    if (url.pathname === "/redirect") return Response.redirect(`http://localhost:${server.port}/denied-redirect`, 302)
    return new Response(`<script>addEventListener("message",event=>{if(event.data==="navigate-child")location.href="http://localhost:${server.port}/denied-oopif"})</script><title>Allowed fixture</title><button id="popup" onclick="window.open(this.dataset.url,'_blank')" data-url="http://localhost:${server.port}/positive-popup">Open popup</button><h1>Allowed page</h1><a id="link" href="http://localhost:${server.port}/denied-link">Blocked link</a><form id="form" action="http://localhost:${server.port}/denied-form" method="post"><input name="message" value="fixture"><button>Submit</button></form>`, { headers: { "Content-Type": "text/html" } })
  } })
  const lease = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }), port = lease.port; lease.stop(true)
  const child = Bun.spawn([edge!, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--no-proxy-server", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${join(home, "browser")}`, "about:blank"], { env: stripChildEnv(process.env).env, stdout: "ignore", stderr: "ignore" })
  let ownedEndpoint = ""
  const browser = new CdpBrowser(port!, url => { checked.push(url); return browserSiteAllowed(settings, url) }, endpoint => endpoint === ownedEndpoint)
  const wait = async (predicate: () => boolean) => { const end = Date.now() + 6000; while (!predicate()) { if (Date.now() > end) throw Error("Browser fixture condition timed out"); await Bun.sleep(20) } }
  const save = (permission: string, sites: string[]) => writeFileSync(policy, JSON.stringify({ preferences: { browserDefaultPermission: permission, blockedSites: sites } }))
  const allowed = `http://127.0.0.1:${server.port}`
  try {
    const baseline = new CdpBrowser(port!)
    for (let i = 0;; i++) { try { await baseline.attach(); break } catch (e) { if (i > 40) throw e; await Bun.sleep(100) } }
    ownedEndpoint = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as {webSocketDebuggerUrl:string}).webSocketDebuggerUrl
    await baseline.navigate(allowed)
    const popupRef = (await baseline.readPage()).find(node=>node.name==='Open popup')!.ref
    const popupPoint = (await baseline.locate(popupRef))!
    await baseline.clickAt(popupPoint.x,popupPoint.y)
    await wait(()=>requests.some(url=>url.includes('/positive-popup')))
    expect(requests.filter(url=>url.includes('/positive-popup')).length).toBe(1)
    baseline.close()
    await Bun.sleep(100)
    await browser.attach(/127\.0\.0\.1/u)
    save("allow", [])
    await browser.navigate(`http://localhost:${server.port}/positive`)
    expect(requests.some(url => url.includes("/positive"))).toBe(true)
    await browser.navigate(allowed)
    await browser.evalForTest(`(()=>{const frame=document.createElement('iframe');frame.id='child';frame.src='http://localhost:${server.port}/positive-child';document.body.append(frame);return 'added'})()`)
    await wait(() => requests.some(url => url.includes('/positive-child')))
    await Bun.sleep(200)
    save("allow", ["localhost"])
    await browser.evalForTest("document.getElementById('child').contentWindow.postMessage('navigate-child','*'); 'sent'")
    await wait(() => checked.some(url => url.endsWith('/denied-oopif')))
    expect(requests.filter(url => url.includes('/denied-oopif'))).toEqual([])
    for (const url of ['data:text/html,fixture', 'file:///fixture.html', 'javascript:alert(1)', 'blob:https://allowed.test/fixture']) await expect(browser.navigate(url)).rejects.toThrow("blocked")
    await expect(browser.navigate(`http://localhost:${server.port}/denied-direct`)).rejects.toThrow("blocked")
    await browser.navigate(allowed)
    await browser.evalForTest(`document.getElementById('popup').dataset.url='http://localhost:${server.port}/denied-popup'; 'ready'`)
    const guardedPopup = (await browser.readPage()).find(node=>node.name==='Open popup')!.ref
    const point = (await browser.locate(guardedPopup))!
    await browser.clickAt(point.x,point.y)
    await Bun.sleep(300)
    expect(requests.filter(url=>url.includes('/denied-popup'))).toEqual([])
    await browser.evalForTest(`document.getElementById('popup').dataset.url='${allowed}/positive-popup'; 'ready'`)
    await browser.clickAt(point.x,point.y)
    await wait(()=>requests.filter(url=>url.includes('/positive-popup')).length===2)
    expect(requests.filter(url=>url.includes('/positive-popup')).length).toBe(2)
    expect((await browser.readPage()).some(node => node.name === "Allowed page")).toBe(true)
    const link = (await browser.readPage()).find(node => node.name === "Blocked link")!
    await browser.click(link.ref)
    await wait(() => checked.some(url => url.endsWith("/denied-link")))
    await browser.navigate(allowed)
    await browser.evalForTest("document.getElementById('form').submit(); 'submitted'")
    await wait(() => checked.some(url => url.endsWith("/denied-form")))
    await expect(browser.navigate(allowed + "/redirect")).rejects.toThrow()
    await wait(() => checked.some(url => url.endsWith("/denied-redirect")))
    await browser.navigate(allowed)
    await browser.evalForTest(`(()=>{const frame=document.createElement('iframe');frame.src='http://localhost:${server.port}/denied-frame';document.body.append(frame);return 'added'})()`)
    await wait(() => checked.some(url => url.endsWith("/denied-frame")))
    expect(requests.filter(url => url.includes("/denied-"))).toEqual([])
    save("block", [])
    await expect(browser.readPage()).rejects.toThrow("blocked")
    await expect(browser.navigate(allowed + "/denied-all")).rejects.toThrow("blocked")
    // A link initiated inside an already loaded page is intercepted too.
    await browser.evalForTest(`location.href='${allowed}/denied-internal-all'; 'requested'`)
    await wait(() => checked.some(url => url.endsWith("/denied-internal-all")))
    expect(requests.filter(url => url.includes("/denied-"))).toEqual([])
    save("allow", [])
    await browser.navigate(`http://localhost:${server.port}/positive-after-change`)
    expect(requests.some(url => url.includes("/positive-after-change"))).toBe(true)
    writeFileSync(policy, "{")
    await expect(browser.navigate(allowed)).rejects.toThrow("blocked")
  } finally {
    browser.close()
    if(ownedEndpoint) {
      const socket=new WebSocket(ownedEndpoint)
      await new Promise<void>(resolve=>{const timer=setTimeout(resolve,2000);socket.addEventListener('open',()=>socket.send(JSON.stringify({id:1,method:'Browser.close'})));socket.addEventListener('close',()=>{clearTimeout(timer);resolve()});socket.addEventListener('error',()=>{clearTimeout(timer);resolve()})})
      socket.close()
    }
    child.kill(); await child.exited; server.stop(true)
    // Edge's owned subprocesses may need a moment to release profile files.
    for (let i = 0; i < 20; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await Bun.sleep(100) } }
  }
}, 30000)

test("CDP protocol errors and failed policy installation refuse attachment rather than silently proceeding", async () => {
  const methods: string[] = []
  const server = Bun.serve<{ unused?: boolean }>({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/json") return Response.json([{ id: "main", type: "page", url: "https://allowed.test", webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/cdp` }])
      if (new URL(request.url).pathname === "/json/version") return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/cdp` })
      if (server.upgrade(request, { data: {} })) return
      return new Response("missing", { status: 404 })
    }, websocket: { message(socket, message) {
      const frame = JSON.parse(String(message)); methods.push(frame.method)
      if (frame.method === "Target.autoAttachRelated") {
        socket.send(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "main-session", targetInfo: { targetId: "main", type: "page" } } }))
        socket.send(JSON.stringify({ id: frame.id, result: {} }))
      } else socket.send(JSON.stringify({ id: frame.id, error: { code: -32000, message: "fixture-private-protocol-detail" } }))
    } },
  })
  const browser = new CdpBrowser(server.port!, () => true)
  const unowned = new CdpBrowser(server.port!, () => true, () => false)
  try {
    await expect(unowned.attach()).rejects.toThrow("ownership could not be verified")
    expect(methods).toEqual([])
    await expect(browser.attach()).rejects.toThrow("Browser control command was refused")
    expect(methods).toEqual(["Target.autoAttachRelated", "Fetch.enable"])
    await expect(browser.navigate("https://allowed.test")).rejects.toThrow("القناة مغلقة")
  } finally { browser.close(); unowned.close(); server.stop(true) }
})
