import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { stripChildEnv } from "../../tools/src/env-strip"

// ن3 — select/upload/drag عبر الموزّع الحقيقيّ (serve) إلى فكستشر CDP يسجّل ما يصل المتصفّحَ: الاختيارُ يُقرأ راجعاً من القائمة
// (والمفقودُ يُقال بالخيارات، وما ليس select يُقال باسمه)، الرفعُ يصل DOM.setFileInputFiles بكائن الحقل وبالمسار المطلق داخل
// المشروع وحده (خارجُه وملفُّ الاعتماد يُرفضان **قبل** أن يصل المتصفّحَ أمرٌ)، والسحبُ ضغطٌ وحركةٌ وإفلاتٌ بالماوس الموثوق ثمّ أحداثُ HTML5.

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const NODES: Record<string, { role: string; name: string; x: number; y: number }> = {
  r1: { role: "textbox", name: "Full name", x: 10, y: 20 },
  r2: { role: "combobox", name: "City", x: 30, y: 40 },
  r3: { role: "listitem", name: "Task A", x: 50, y: 60 },
  r4: { role: "textbox:file", name: "Resume", x: 70, y: 80 },
  r5: { role: "listitem", name: "Done column", x: 90, y: 100 },
}
const TREE = JSON.stringify(Object.entries(NODES).map(([ref, n]) => ({ ref, role: n.role, name: n.name })))
const OPTIONS = ["Choose…", "Riyadh", "Jeddah"]

test("select reads the option back, upload reaches DOM.setFileInputFiles only for a project file, drag is press–move–release", async () => {
  const home = mkdtempSync(join(tmpdir(), "abdo-browser-sud-")), project = join(home, "proj"), settings = join(home, "engine-settings.json")
  writeFileSync(join(home, "outside.pdf"), "x")
  const { mkdirSync } = await import("node:fs")
  mkdirSync(project); writeFileSync(join(project, "cv.pdf"), "pdf-bytes"); writeFileSync(join(project, ".env"), "SECRET=1")
  let currentUrl = "about:blank"
  const cdp: { method: string; [k: string]: unknown }[] = []
  const server = Bun.serve<{}>({ hostname: "127.0.0.1", port: 0, fetch(request, srv) {
    const path = new URL(request.url).pathname
    if (path === "/json") return Response.json([{ id: "main", type: "page", url: currentUrl, webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/page/main` }])
    if (path === "/json/version") return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/01234567-89ab-cdef-0123-456789abcdef` })
    if (srv.upgrade(request, { data: {} })) return
    return new Response("missing", { status: 404 })
  }, websocket: { message(socket, message) {
    const f = JSON.parse(String(message)); let result: unknown = {}
    if (f.method === "Target.setAutoAttach" && !f.sessionId) socket.send(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "main-session", targetInfo: { targetId: "main", type: "page" } } }))
    if (f.method === "Runtime.evaluate") {
      const e = String(f.params.expression)
      const refOf = () => /data-abdo-ref="(r\d+)"/.exec(e)?.[1] ?? ""
      if (f.params.returnByValue === false) result = { result: { objectId: `obj-${refOf()}`, subtype: "node" } }
      else if (e === "document.title") result = { result: { value: "Fixture form" } }
      else if (e === "location.href") result = { result: { value: currentUrl } }
      else if (e.includes("data-abdo-seq")) result = { result: { value: TREE } }
      else if (e.includes("elementFromPoint")) { const n = NODES[refOf()]; result = { result: { value: n === undefined ? "" : JSON.stringify({ x: n.x, y: n.y, width: 80, height: 24, inView: true, hit: true, role: n.role, name: n.name, sensitive: false }) } } }
      else if (e.includes('el.tagName !== "SELECT"')) {
        const ref = refOf(); const want = /const want = "([^"]*)"/.exec(e)?.[1] ?? ""
        if (ref !== "r2") result = { result: { value: JSON.stringify({ ok: false, why: "not-select", role: "input", options: [] }) } }
        else { const idx = OPTIONS.findIndex((o) => o.toLowerCase() === want.toLowerCase()); result = { result: { value: JSON.stringify(idx < 0 ? { ok: false, why: "no-option", role: "combobox", options: OPTIONS } : { ok: true, picked: OPTIONS[idx], value: OPTIONS[idx]!.toUpperCase().slice(0, 3), index: idx, total: OPTIONS.length }) } } }
      }
      else if (e.includes('(el.type || "").toLowerCase() === "file"')) result = { result: { value: refOf() === "r4" ? "file" : "other" } }
      else if (e.includes("el.files")) result = { result: { value: JSON.stringify(["cv.pdf (9 بايت)"]) } }
      else if (e.includes("new DataTransfer()")) result = { result: { value: "yes" } }
      else result = { result: { value: "" } }
    }
    if (f.method === "Page.navigate") { currentUrl = f.params.url; result = { frameId: "main" } }
    if (f.method === "Page.captureScreenshot") result = { data: PNG_1x1 }
    if (["DOM.enable", "DOM.setFileInputFiles", "Runtime.releaseObject", "Input.dispatchMouseEvent", "Page.bringToFront"].includes(f.method)) cdp.push({ method: f.method, ...f.params })
    socket.send(JSON.stringify({ id: f.id, result, ...(f.sessionId ? { sessionId: f.sessionId } : {}) }))
  } } })
  const port = server.port!
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { return Response.json({ choices: [{ message: { role: "assistant", content: "Done." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } })
  writeFileSync(settings, JSON.stringify({ language: "ar", mode: "full-access", computerUseEnabled: true, modelRole: "agent", routerGate: "off", agentModel: "fixture/agent", chatModel: "fixture/agent", project,
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, semanticFrame: false, lessons: false, usageMeter: false },
    customProviders: [{ id: "fixture", label: "fixture", local: true, baseUrl: `http://127.0.0.1:${model.port}/v1`, vaultKey: "", models: ["agent"] }] }))
  writeFileSync(join(home, "workspace-v1.json"), JSON.stringify({ preferences: { browserDefaultPermission: "allow", blockedSites: [] } }))
  writeFileSync(join(home, "browser-control-lease.json"), JSON.stringify({ version: 1, port, pid: process.pid, ownerPid: process.pid, endpoint: `ws://127.0.0.1:${port}/devtools/browser/01234567-89ab-cdef-0123-456789abcdef` }))
  const { createHash } = await import("node:crypto")
  mkdirSync(join(home, "trust"), { recursive: true })
  writeFileSync(join(home, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const frames: any[] = []
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: resolve(import.meta.dir, "../../.."), env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: home, ABDO_CODE_TRUST_DIR: join(home, "trust"), ABDO_SHELL_TOKEN: "sud-test", ABDO_FRAMED_STDIO: "1", USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const stderr = new Response(child.stderr).text(); const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) for (const f of decoder.push(bytes)) frames.push(f) })()
  const send = (f: object) => { child.stdin.write(encodeLocalJsonFrame(f)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 30000; while (!predicate()) { if (Date.now() > deadline) throw Error(label + " " + JSON.stringify(frames).slice(-3000)); await Bun.sleep(10) } }
  let n = 0
  const turn = async (body: string) => { const id = `sud-${++n}`; send({ kind: "submit", turn: { id, body }, mode: "full-access" }); await wait(() => frames.some((f) => f.turnId === id && ["done", "refused"].includes(f.kind)), "turn " + body); return frames.filter((f) => f.kind === "event" && f.turnId === id).map((f) => String(f.payload)) }
  try {
    send({ kind: "hello", shell: "desktop", token: "sud-test" }); await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    await turn(`surface ${port}`)
    await turn("open https://allowed.test/form")
    const page = await turn("page"); expect(page.some((p) => p.includes("r2") && p.includes("City"))).toBe(true)

    // select: يُقرأ الخيارُ المستقرّ راجعاً؛ المفقودُ يُقال بالخيارات؛ وما ليس select يُقال باسمه — ولا حدثَ ماوسٍ في أيٍّ منها
    const s1 = await turn("select r2 riyadh"); expect(s1.some((p) => p.includes("اخترتُ «Riyadh»") && p.includes("2/3"))).toBe(true)
    const s2 = await turn("select r2 Dammam"); expect(s2.some((p) => p.includes("لا خيارَ يطابق «Dammam»") && p.includes("Riyadh | Jeddah"))).toBe(true)
    const s3 = await turn("select r1 x"); expect(s3.some((p) => p.includes("ليس قائمةً منسدلةً أصليّة"))).toBe(true)
    const s4 = await turn("select r2"); expect(s4.some((p) => p.startsWith("الصيغة: select"))).toBe(true)
    expect(cdp.filter((c) => c.method === "Input.dispatchMouseEvent").length).toBe(0)

    // upload: الملفُّ داخل المشروع يصل DOM.setFileInputFiles بكائن الحقل وبالمسار المطلق، ويُقرأ الحقلُ بعدها
    const u1 = await turn("upload r4 cv.pdf")
    expect(u1.some((p) => p.includes("رفعتُ «cv.pdf»") && p.includes("cv.pdf (9 بايت)"))).toBe(true)
    const setFiles = cdp.filter((c) => c.method === "DOM.setFileInputFiles")
    expect(setFiles).toEqual([{ method: "DOM.setFileInputFiles", files: [resolve(project, "cv.pdf")], objectId: "obj-r4" }])
    // خارج المشروع وملفُّ الاعتماد وغيرُ حقل الملفّ: رفضٌ مسمّى بلا أمرٍ يصل المتصفّح
    const before = cdp.length
    const u2 = await turn("upload r4 ../outside.pdf"); expect(u2.some((p) => p.includes("خارج مجلّد المشروع"))).toBe(true)
    const u3 = await turn("upload r4 .env"); expect(u3.some((p) => p.includes("ملفُّ اعتمادٍ"))).toBe(true)
    const u4 = await turn("upload r1 cv.pdf"); expect(u4.some((p) => p.includes("ليس حقلَ ملفّ"))).toBe(true)
    expect(cdp.slice(before).filter((c) => c.method === "DOM.setFileInputFiles").length).toBe(0)

    // drag: ضغطٌ عند المصدر، ثماني حركاتٍ، إفلاتٌ عند الهدف — ثمّ أحداثُ HTML5 (تُرى في الإيصال)
    const d1 = await turn("drag r3 r5")
    expect(d1.some((p) => p.includes("سحبتُ «Task A»") && p.includes("«Done column»") && p.includes("(90,100)") && p.includes("HTML5"))).toBe(true)
    const mouse = cdp.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => `${c.type}@${c.x},${c.y}`)
    expect(mouse[0]).toBe("mouseMoved@50,60"); expect(mouse[1]).toBe("mousePressed@50,60"); expect(mouse.at(-1)).toBe("mouseReleased@90,100")
    expect(mouse.filter((m) => m.startsWith("mouseMoved")).length).toBe(9)
    const d2 = await turn("drag r3 r9"); expect(d2.some((p) => p.includes("مرجعُ الهدف غير معروف «r9»"))).toBe(true)
  } finally { child.kill(); await child.exited; server.stop(true); model.stop(true); await stderr; rmSync(home, { recursive: true, force: true }) }
}, 120_000)
