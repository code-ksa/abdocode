import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { stripChildEnv } from "../../tools/src/env-strip"

// ن5 (09-16) — tabs/back/forward عبر الموزّع الحقيقيّ (serve) إلى فكستشر CDP بتبويبين وتاريخٍ لكلّ تبويب: الرجوعُ يصل
// Page.navigateToHistoryEntry بالمدخل الصحيح والتقدّمُ بعده، وبلا مدخلٍ يُقال «لم أنتقل»؛ التبديلُ ينشّط الهدفَ ويعيد قناةَ القيادة
// إليه فتقرأ page التبويبَ الآخر؛ التبويبُ الجديد يصل Target.createTarget بالرابط بعد سياسة المواقع؛ والإغلاقُ لا يمسّ آخرَ تبويب.

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
type Page = { url: string; title: string; history: { id: number; url: string; title: string }[]; index: number }
const titleOf = (url: string): string => url === "about:blank" ? "" : `Page ${url.split("/").pop()}`

test("owned browser: back/forward walk the tab history, tabs list/switch/new/close drive real targets, last tab is never closed", async () => {
  const home = mkdtempSync(join(tmpdir(), "abdo-browser-tabs-")), project = join(home, "proj"), settings = join(home, "engine-settings.json")
  mkdirSync(project)
  const pages = new Map<string, Page>()
  pages.set("main", { url: "about:blank", title: "", history: [{ id: 1, url: "about:blank", title: "" }], index: 0 })
  pages.set("second", { url: "https://allowed.test/second", title: "Second tab", history: [{ id: 1, url: "https://allowed.test/second", title: "Second tab" }], index: 0 })
  let nextTarget = 100, nextEntry = 10
  const cdp: { method: string; [k: string]: unknown }[] = []
  const server = Bun.serve<{}>({ hostname: "127.0.0.1", port: 0, fetch(request, srv) {
    const path = new URL(request.url).pathname
    if (path === "/json") return Response.json([...pages.entries()].map(([id, p]) => ({ id, type: "page", url: p.url, title: p.title, webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/page/${id}` })))
    if (path === "/json/version") return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/01234567-89ab-cdef-0123-456789abcdef` })
    if (srv.upgrade(request, { data: {} })) return
    return new Response("missing", { status: 404 })
  }, websocket: { message(socket, message) {
    const f = JSON.parse(String(message)); let result: unknown = {}
    const tid = String(f.sessionId ?? "").replace(/-session$/u, "")
    const p = pages.get(tid)
    if (f.method === "Target.setAutoAttach" && !f.sessionId) for (const id of pages.keys()) socket.send(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: `${id}-session`, targetInfo: { targetId: id, type: "page" } } }))
    if (f.method === "Runtime.evaluate" && p !== undefined) {
      const e = String(f.params.expression)
      if (e === "document.title") result = { result: { value: p.title } }
      else if (e === "location.href") result = { result: { value: p.url } }
      else if (e.includes("data-abdo-seq")) result = { result: { value: JSON.stringify([{ ref: "r1", role: "heading", name: p.title || "(blank)" }]) } }
      else result = { result: { value: "" } }
    }
    if (f.method === "Page.navigate" && p !== undefined) { p.history = p.history.slice(0, p.index + 1); p.history.push({ id: nextEntry++, url: f.params.url, title: titleOf(f.params.url) }); p.index = p.history.length - 1; p.url = f.params.url; p.title = titleOf(f.params.url); result = { frameId: tid } }
    if (f.method === "Page.getNavigationHistory" && p !== undefined) result = { currentIndex: p.index, entries: p.history }
    if (f.method === "Page.navigateToHistoryEntry" && p !== undefined) { const i = p.history.findIndex((h) => h.id === f.params.entryId); if (i >= 0) { p.index = i; p.url = p.history[i]!.url; p.title = p.history[i]!.title } cdp.push({ method: f.method, tid, ...f.params }) }
    if (f.method === "Target.activateTarget") cdp.push({ method: f.method, ...f.params })
    if (f.method === "Target.closeTarget") { pages.delete(String(f.params.targetId)); cdp.push({ method: f.method, ...f.params }); result = { success: true } }
    if (f.method === "Target.createTarget") { const id = `t${nextTarget++}`; pages.set(id, { url: f.params.url, title: titleOf(f.params.url), history: [{ id: nextEntry++, url: f.params.url, title: titleOf(f.params.url) }], index: 0 }); cdp.push({ method: f.method, ...f.params }); result = { targetId: id } }
    if (f.method === "Page.captureScreenshot") result = { data: PNG_1x1 }
    socket.send(JSON.stringify({ id: f.id, result, ...(f.sessionId ? { sessionId: f.sessionId } : {}) }))
  } } })
  const port = server.port!
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { return Response.json({ choices: [{ message: { role: "assistant", content: "Done." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } })
  writeFileSync(settings, JSON.stringify({ language: "ar", mode: "full-access", computerUseEnabled: true, modelRole: "agent", routerGate: "off", agentModel: "fixture/agent", chatModel: "fixture/agent", project,
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, semanticFrame: false, lessons: false, usageMeter: false },
    customProviders: [{ id: "fixture", label: "fixture", local: true, baseUrl: `http://127.0.0.1:${model.port}/v1`, vaultKey: "", models: ["agent"] }] }))
  writeFileSync(join(home, "workspace-v1.json"), JSON.stringify({ preferences: { browserDefaultPermission: "allow", blockedSites: ["blocked.test"] } }))
  writeFileSync(join(home, "browser-control-lease.json"), JSON.stringify({ version: 1, port, pid: process.pid, ownerPid: process.pid, endpoint: `ws://127.0.0.1:${port}/devtools/browser/01234567-89ab-cdef-0123-456789abcdef` }))
  const { createHash } = await import("node:crypto")
  mkdirSync(join(home, "trust"), { recursive: true })
  writeFileSync(join(home, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const frames: any[] = []
  // ABDO_TEST_ENGINE=<abdocode.exe>: الاختبارُ نفسُه يجري على المحرّك المجمَّع/المثبَّت لا على المصدر وحده.
  const engineArgv = process.env.ABDO_TEST_ENGINE ? [process.env.ABDO_TEST_ENGINE, "serve"] : [process.execPath, "packages/engine/src/cli.ts", "serve"]
  const child = Bun.spawn(engineArgv, { cwd: resolve(import.meta.dir, "../../.."), env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: home, ABDO_CODE_TRUST_DIR: join(home, "trust"), ABDO_SHELL_TOKEN: "tabs-test", ABDO_FRAMED_STDIO: "1", USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const stderr = new Response(child.stderr).text(); const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) for (const f of decoder.push(bytes)) frames.push(f) })()
  const send = (f: object) => { child.stdin.write(encodeLocalJsonFrame(f)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 30000; while (!predicate()) { if (Date.now() > deadline) throw Error(label + " " + JSON.stringify(frames).slice(-3000)); await Bun.sleep(10) } }
  let n = 0
  const turn = async (body: string) => { const id = `tabs-${++n}`; send({ kind: "submit", turn: { id, body }, mode: "full-access" }); await wait(() => frames.some((f) => f.turnId === id && ["done", "refused"].includes(f.kind)), "turn " + body); return frames.filter((f) => f.kind === "event" && f.turnId === id).map((f) => String(f.payload)) }
  const has = (lines: string[], needle: string) => lines.some((l) => l.includes(needle))
  try {
    send({ kind: "hello", shell: "desktop", token: "tabs-test" }); await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    await turn(`surface ${port}`)
    await turn("open https://allowed.test/a")
    await turn("open https://allowed.test/b")

    // التاريخ: رجوعٌ إلى a بالمدخل الصحيح، تقدّمٌ إلى b، ثمّ «لا لاحقة» بلا أمرٍ يصل المتصفّح
    const b1 = await turn("back"); expect(has(b1, "رجعتُ إلى «Page a» (https://allowed.test/a)")).toBe(true)
    expect(pages.get("main")!.url).toBe("https://allowed.test/a")
    const f1 = await turn("forward"); expect(has(f1, "تقدّمتُ إلى «Page b» (https://allowed.test/b)")).toBe(true)
    const before = cdp.filter((c) => c.method === "Page.navigateToHistoryEntry").length
    const f2 = await turn("forward"); expect(has(f2, "لم أنتقل: لا صفحةَ لاحقة")).toBe(true)
    expect(cdp.filter((c) => c.method === "Page.navigateToHistoryEntry").length).toBe(before)
    expect(cdp.filter((c) => c.method === "Page.navigateToHistoryEntry").map((c) => c.tid)).toEqual(["main", "main"])

    // التبويبات: القائمةُ تعلّم الحاليّ، والتبديلُ ينشّط الهدفَ ويقرأ page التبويبَ الآخر، وتكرارُه يُقال
    const t1 = await turn("tabs"); expect(has(t1, "2 تبويباً")).toBe(true); expect(has(t1, "1. ● Page b — https://allowed.test/b")).toBe(true); expect(has(t1, "2. ○ Second tab — https://allowed.test/second")).toBe(true)
    const s1 = await turn("tabs switch 2"); expect(has(s1, "انتقلتُ إلى التبويب 2 «Second tab»")).toBe(true)
    expect(cdp.some((c) => c.method === "Target.activateTarget" && c.targetId === "second")).toBe(true)
    const pg = await turn("page"); expect(has(pg, "heading: Second tab")).toBe(true)
    const s2 = await turn("tabs switch 2"); expect(has(s2, "هو الحاليُّ أصلاً")).toBe(true)
    const s3 = await turn("tabs switch 9"); expect(has(s3, "الصيغة: tabs switch")).toBe(true)

    // تبويبٌ جديد: سياسةُ المواقع قبل Target.createTarget، والمسموحُ يُنشأ ويُنتقل إليه
    const n1 = await turn("tabs new https://blocked.test/x"); expect(has(n1, "Navigation blocked by saved site permissions")).toBe(true)
    expect(cdp.filter((c) => c.method === "Target.createTarget").length).toBe(0)
    const n2 = await turn("tabs new https://allowed.test/new"); expect(has(n2, "فتحتُ تبويباً جديداً (https://allowed.test/new)")).toBe(true)
    expect(cdp.filter((c) => c.method === "Target.createTarget").map((c) => c.url)).toEqual(["https://allowed.test/new"])
    const t2 = await turn("tabs"); expect(has(t2, "3 تبويباً")).toBe(true); expect(has(t2, "3. ● Page new")).toBe(true)

    // الإغلاق: غيرُ الحاليّ يُغلق والقناةُ كما هي؛ الحاليُّ يُغلق وتنتقل القيادة؛ وآخرُ تبويبٍ لا يُغلق ولا يصل أمرٌ
    const c1 = await turn("tabs close 1"); expect(has(c1, "أغلقتُ التبويب «Page b»؛ التبويبُ الحاليُّ كما هو")).toBe(true)
    expect(cdp.some((c) => c.method === "Target.closeTarget" && c.targetId === "main")).toBe(true)
    const c2 = await turn("tabs close 2"); expect(has(c2, "أغلقتُ «Page new» وانتقلتُ إلى «Second tab»")).toBe(true)
    const closes = cdp.filter((c) => c.method === "Target.closeTarget").length
    const c3 = await turn("tabs close 1"); expect(has(c3, "لم أغلق: آخرُ تبويبٍ لا يُغلق")).toBe(true)
    expect(cdp.filter((c) => c.method === "Target.closeTarget").length).toBe(closes)
    expect([...pages.keys()]).toEqual(["second"])
  } finally { child.kill(); await child.exited; server.stop(true); model.stop(true); await stderr; rmSync(home, { recursive: true, force: true }) }
}, 120_000)
