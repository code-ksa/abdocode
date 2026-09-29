/**
 * 09-29 — فكرةُ LangGraph على نظامنا، حيّاً: (١) ادّعاءُ اكتمالٍ وخطواتٌ مفتوحة في خطّةٍ لمسها الدور ⇦ بوّابةُ الخطّة توجّه إلى
 * التالي الجاهز (حتى مرّتين) ولا تسلّم؛ (٢) أداةٌ فشلت وخطوةٌ جارية ⇦ تُعلَّم فاشلةً بسببها من الإيصال لا من الادّعاء؛
 * (٣) عرضُ اللوح وحدَه لا يستدعي البوّابة (التوأم السالب).
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const ROOT = resolve(import.meta.dir, "../../..")

test.skipIf(process.platform !== "win32")("plan routing: the completion gate names the next ready step, a failed tool fails the running step with its reason, and plan show alone is not gated", async () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-plan-route-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  let script: string[] = []
  const prompts: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages?: { role: string; content: unknown }[] }
    const users = (body.messages ?? []).filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content))
    prompts.push(users[users.length - 1] ?? "")
    const content = script.shift() ?? "Done."
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "tool-fixture/model", chatModel: "tool-fixture/model", modelRole: "agent", mode: "full-access", project, routerGate: "off", railPolicy: "thin", workMode: "basic", plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 }, customProviders: [{ id: "tool-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_MAX_AGENT_EPOCHS: "4" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 90_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2500)); await Bun.sleep(50) } }
  let n = 0
  const turn = async (...replies: string[]) => {
    const id = `pr-${++n}`; script = [...replies]
    const before = frames.length
    send({ kind: "submit", mode: "full-access", turn: { id, body: "go " + id } })
    await wait(() => frames.slice(before).some((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind)))
    const mine = frames.slice(before).filter((f) => f.turnId === id)
    return { events: mine.filter((f) => f.kind === "event").map((f) => String(f.payload ?? "")), results: mine.filter((f) => f.kind === "tool-result").map((f) => String(f.output)) }
  }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    // (١) خطّةٌ من خطوتين ثمّ ادّعاءُ اكتمال ⇦ البوّابةُ توجّه إلى s1 مرّتين ثمّ تترك الحكمَ لبقيّة السلسلة.
    const before = prompts.length
    const t1 = await turn("نفّذ: plan set بناء <<<\ns1: أنشئ الملف\ns2: اختبر [after: s1]", "تمّ الهدف.", "تمّ الهدف.", "تمّ الهدف.")
    const gates = t1.events.filter((e) => e.startsWith("↻ بوّابةُ الخطّة"))
    expect(gates).toHaveLength(2)
    expect(gates[0]).toContain("(1/2): 2 خطوة باقية — التالي: s1: أنشئ الملف")
    expect(prompts.slice(before).some((p) => p.includes("الخطّةُ لم تكتمل: 2 خطوة باقية") && p.includes("التالي الجاهز: s1: أنشئ الملف"))).toBe(true)
    // الدورُ لا يُختم مكتملاً: إمّا سطرُ «غير مكتملة» وإمّا بوّابةٌ ثانية ثمّ حكمُ السلسلة — المهمّ أنّ done لا يحمل completed مع خطّةٍ مفتوحة.
    expect(frames.some((f) => f.turnId === "pr-1" && f.kind === "done" && f.outcome === "completed")).toBe(false)
    // (٢) خطوةٌ جارية وأداةٌ تفشل ⇦ تُعلَّم فاشلةً بسببها تلقائياً، واللوح يعرضها ✗ بالسبب.
    const t2 = await turn("نفّذ: plan start s1", "نفّذ: run cmd /c exit 7", "نفّذ: plan show", "تمّ.")
    expect(t2.events.some((e) => e.startsWith("✗ الخطّة: الخطوةُ الجارية «s1» فشلت بأداتها"))).toBe(true)
    const board = t2.results.filter((r) => r.includes("الخطّة (0/2 منجزة)")).at(-1)
    expect(board).toBeDefined()
    expect(board).toContain("✗ s1")
    expect(t2.events.some((e) => e.startsWith("↻ بوّابةُ الخطّة") && e.includes("فاشلة: s1"))).toBe(true)
    // (٣) التوأمُ السالب: دورٌ يعرض اللوحَ فقط ويدّعي الاكتمال لا يُوجَّه.
    const t3 = await turn("نفّذ: plan show", "تمّ.")
    expect(t3.events.filter((e) => e.startsWith("↻ بوّابةُ الخطّة"))).toHaveLength(0)
  } finally {
    child.kill(); await child.exited; server.stop(true); await errors
    for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
  }
}, 180_000)
