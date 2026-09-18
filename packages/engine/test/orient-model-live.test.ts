import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

// درجةٍ في سلّم المالك** (`modelLadder`، الأخيرةُ الأقدر بالعقد) لا نموذجَ الدور — والاختيارُ يُقال في المحادثة لا يُخمَّن.
// التوأمُ السالب: بلا سلّمٍ في الإعدادات يعمل الموجِّهُ بنموذج الدور بلا ادّعاءٍ ولا سطرٍ زائد.

const ROOT = resolve(import.meta.dir, "../../..")

async function run(ladder: readonly string[] | undefined): Promise<{ models: string[]; events: string[] }> {
  const base = mkdtempSync(join(tmpdir(), "abdo-orient-model-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  const models: string[] = []
  let orientAsked = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; model?: string; messages?: { role: string; content: unknown }[] }
    const msgs = body.messages ?? []
    const text = (m: { content: unknown } | undefined) => m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    const all = msgs.filter((m) => m.role === "user").map(text).join("\n")
    const isOrient = all.includes("أنت الوكيلُ الموجِّه")
    if (isOrient) models.push(String(body.model ?? "?"))
    let content = "Done."
    if (isOrient) { orientAsked += 1; content = orientAsked === 1 ? "نفّذ: list ." : "[ORIENTATION]\nالهدف: قراءة\nالحالة الآن: مشروعٌ صغير\nما يخصّ الطلب: package.json\nالفجوات والمخاطر: لا شيء\nاقرأ قبل الفعل: package.json\nخطّة مقترحة: s1: اقرأ\n[/ORIENTATION]" }
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({
    language: "ar", agentModel: "tool-fixture/weak", chatModel: "tool-fixture/weak", modelRole: "agent", mode: "full-access", project, routerGate: "off", railPolicy: "thin", workMode: "strong",
    ...(ladder === undefined ? {} : { modelLadder: ladder }),
    plugins: { inventory: false, verifier: false, reviewer: false, delegation: true, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "tool-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["weak", "strong"] }],
  }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 120_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2000)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    send({ kind: "submit", mode: "full-access", turn: { id: "om-1", body: "اقرأ المانيفست" } })
    await wait(() => frames.some((f) => f.turnId === "om-1" && ["done", "refused", "unresolved"].includes(f.kind)))
    return { models, events: frames.filter((f) => f.kind === "event").map((f) => String(f.payload ?? "")) }
  } finally { child.kill(); await child.exited; server.stop(true); await errors; for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } } }
}

test.skipIf(process.platform !== "win32")("the orienting agent runs on the ladder's ablest rung, and the swap is announced", async () => {
  const { models, events } = await run(["tool-fixture/weak", "tool-fixture/strong"])
  expect(models.length).toBeGreaterThan(0)
  for (const model of models) expect(model).toBe("strong") // كلُّ نداءات الموجِّه على الأقدر
  expect(events.some((t) => t.includes("أقدر درجةٍ في سلّمك") && t.includes("tool-fixture/strong") && t.includes("tool-fixture/weak"))).toBe(true)
}, 180_000)

test.skipIf(process.platform !== "win32")("without a ladder the orienting agent uses the turn's own model and claims nothing (the negative twin)", async () => {
  const { models, events } = await run(undefined)
  expect(models.length).toBeGreaterThan(0)
  for (const model of models) expect(model).toBe("weak")
  expect(events.some((t) => t.includes("أقدر درجةٍ في سلّمك"))).toBe(false)
}, 180_000)
