/**
 * 10-11 (مقيس على CRM الثالث): الوكيلُ الموجِّه قرأ 29 أداةً في 111 ث ثمّ لم يكتب خلاصةً مهيكلة فأُهمل كلُّه، وأعادت الحقبةُ الأولى قراءةَ
 * الملفّات نفسِها. يُقاس بما يصل النموذجَ الرئيسيّ: نصُّ ما قرأه الموجِّه في أوّل طلبٍ للحقبة الأولى.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const ROOT = resolve(import.meta.dir, "../../..")
const MARKER = "ZEBRA-4471-ORIENT"

async function run(orientReads: boolean): Promise<{ mainFirst: string; events: string[] }> {
  const base = mkdtempSync(join(tmpdir(), "abdo-orient-reads-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  writeFileSync(join(project, "notes.md"), `# notes\nthe secret word is ${MARKER}\n`)
  let orientAsked = 0
  const mainBodies: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages?: { role: string; content: unknown }[] }
    const msgs = body.messages ?? []
    const text = (m: { content: unknown }) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    const all = msgs.filter((m) => m.role === "user").map(text).join("\n")
    const isOrient = all.includes("أنت الوكيلُ الموجِّه")
    let content = "Done."
    if (isOrient) { orientAsked += 1; content = orientAsked === 1 && orientReads ? "نفّذ: read notes.md" : "Finished looking around." }
    else mainBodies.push(msgs.map(text).join("\n"))
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({
    language: "ar", agentModel: "tool-fixture/weak", chatModel: "tool-fixture/weak", modelRole: "agent", mode: "full-access", project, routerGate: "off", railPolicy: "thin", workMode: "strong",
    plugins: { inventory: false, verifier: false, reviewer: false, delegation: true, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "tool-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["weak"] }],
  }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, USERPROFILE: base, HOME: base, ABDO_MAX_AGENT_EPOCHS: "1", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 120_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2000)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    send({ kind: "submit", mode: "full-access", turn: { id: "or-1", body: "Summarise the project notes" } })
    await wait(() => frames.some((f) => f.turnId === "or-1" && ["done", "refused", "unresolved"].includes(f.kind)))
    return { mainFirst: mainBodies[0] ?? "", events: frames.filter((f) => f.kind === "event").map((f) => String(f.payload ?? "")) }
  } finally { child.kill(); await child.exited; server.stop(true); await errors; for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } } }
}

test.skipIf(process.platform !== "win32")("what the orienting agent read reaches the first epoch even when it wrote no structured summary", async () => {
  const { mainFirst, events } = await run(true)
  expect(events.some((e) => e.includes("لم يخرج بخلاصةٍ مهيكلة") && e.includes("تدخل الحقبة الأولى محمولةً")), events.join("\n").slice(-1500)).toBe(true)
  expect(mainFirst).toContain(MARKER)
  expect(mainFirst).toContain("قراءاتُ الوكيل الموجِّه")
}, 180_000)

test.skipIf(process.platform !== "win32")("the twin: an orienting agent that read nothing carries nothing — the marker never reaches the main agent", async () => {
  const { mainFirst } = await run(false)
  expect(mainFirst.length).toBeGreaterThan(0)
  expect(mainFirst).not.toContain(MARKER)
}, 180_000)
