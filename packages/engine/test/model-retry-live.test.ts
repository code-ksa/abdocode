/**
 * إعادةُ المحاولة المحدودة لنداء النموذج — حيّاً على المحرّك الحقيقيّ بمزوّدٍ وهميّ يعدّ الطلبات:
 * - 503 مرّتين ثمّ 200 ⇦ الدورُ يكتمل وعددُ الطلبات ٣ (التوأمُ الإيجابيّ).
 * - 400 مرّةً ⇦ لا إعادة: طلبٌ واحد ورفضٌ يحمل (HTTP 400) (التوأمُ السلبيّ — غيرُ العابر لا يُعاد).
 * - 503 ثلاثاً ⇦ ينتهي بالرفض بعد ٣ محاولات بالضبط (السقفُ يعضّ).
 * مقيس 09-14: إنفيديا NIM تردّ «Worker local total request limit reached» 503 وتعلّق في ~40٪ من الطلبات فكان أوّلُ دورٍ يموت بلا محاولةٍ ثانية.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const ROOT = resolve(import.meta.dir, "../../..")

async function run(script: number[]): Promise<{ requests: number; end: { kind: string; why?: string; outcome?: string }; events: string[] }> {
  const base = mkdtempSync(join(tmpdir(), "abdo-retry-live-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean }
    requests += 1
    const status = script[requests - 1] ?? 200
    if (status !== 200) return new Response(JSON.stringify({ error: { message: `scripted ${status}` } }), { status, headers: { "content-type": "application/json" } })
    const content = "تمّ."
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "flaky/model", chatModel: "flaky/model", modelRole: "agent", mode: "read-only", project, routerGate: "off", railPolicy: "thin", workMode: "basic", plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 }, customProviders: [{ id: "flaky", label: "flaky", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
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
    send({ kind: "submit", mode: "read-only", turn: { id: "r1", body: "قل تمّ فقط" } })
    await wait(() => frames.some((f) => f.turnId === "r1" && ["done", "refused", "unresolved"].includes(f.kind)))
    const end = frames.find((f) => f.turnId === "r1" && ["done", "refused", "unresolved"].includes(f.kind))
    return { requests, end: { kind: end.kind, why: end.why, outcome: end.outcome }, events: frames.filter((f) => f.kind === "event" && f.turnId === "r1").map((f) => String(f.payload ?? "")) }
  } finally { child.kill(); await child.exited; server.stop(true); await errors; for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } } }
}

test.skipIf(process.platform !== "win32")("503 twice then 200: the turn completes after exactly three requests", async () => {
  const r = await run([503, 503, 200])
  expect(r.requests).toBe(3)
  expect(r.end.kind).toBe("done")
}, 120_000)

test.skipIf(process.platform !== "win32")("400 once: no retry — one request and a refusal naming HTTP 400 (the negative twin)", async () => {
  const r = await run([400])
  expect(r.requests).toBe(1)
  expect(r.end.kind).toBe("refused")
  expect(r.end.why).toContain("(HTTP 400)")
}, 120_000)

test.skipIf(process.platform !== "win32")("503 five times: the cap bites — exactly five requests, then a refusal naming HTTP 503 (09-14: three were not enough for NIM)", async () => {
  const r = await run([503, 503, 503, 503, 503, 200])
  expect(r.requests).toBe(5)
  expect(r.end.kind).toBe("refused")
  expect(r.end.why).toContain("(HTTP 503)")
}, 180_000)
