/**
 * 10-08 (مقيس على NIM): gpt-oss-20b يستدعي أدواتِه بقناته الأصليّة — بالبروتوكول النصّيّ عاد المحتوى فارغاً ثلاثَ مرّات (empty-reply،
 * صفرُ أدوات). بعد تأهيل النقل الأصليّ على الشكل المتوافق مع OpenAI أكمل المهمّةَ نفسَها (18 أداة، الاختباراتُ 2/2 على القرص).
 * هنا على المحرّك الحقيقيّ ونموذجٍ زائف: الطلبُ يحمل tools، والـtool_calls تُنفَّذ، ونتيجتُها تعود رسالةَ tool بمعرّفها.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { stripChildEnv } from "../../tools/src/env-strip"

async function turnWith(model: string) {
  const bodies: Record<string, any>[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, any>
    bodies.push(body)
    const sawResult = (body.messages ?? []).some((m: { role?: string }) => m.role === "tool")
    const message = sawResult
      ? { role: "assistant", content: "قرأتُ الملفّ: فيه السطر hello." }
      : { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "notes.md" }) } }] }
    const finish = sawResult ? "stop" : "tool_calls"
    if (body.stream === true) {
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: message.content }, finish_reason: finish }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    }
    return Response.json({ choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 9, completion_tokens: 3 } })
  } })
  const home = mkdtempSync(join(tmpdir(), "abdo-native-oai-")), project = join(home, "proj"), settings = join(home, "settings.json")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "notes.md"), "hello\n")
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "full-access", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: `fx/${model}`, chatModel: `fx/${model}`,
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: [model] }],
  }))
  const frames: any[] = []
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), ABDO_SHELL_TOKEN: "t", ABDO_FRAMED_STDIO: "1", USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "4", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) for (const frame of decoder.push(bytes)) frames.push(frame) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 90_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out: " + label + " " + JSON.stringify(frames).slice(-2000)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "t" })
    await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    send({ kind: "submit", mode: "full-access", turn: { id: "n1", body: "What does notes.md say?" } })
    await wait(() => frames.some((f) => f.turnId === "n1" && ["done", "refused", "unresolved"].includes(f.kind)), "turn end")
    const end = frames.find((f) => f.turnId === "n1" && ["done", "refused", "unresolved"].includes(f.kind))
    const tools = frames.filter((f) => f.turnId === "n1" && f.kind === "tool").map((f) => String(f.cmd))
    return { bodies, end, tools }
  } finally {
    child.kill(); await child.exited; await reading; await stderr; server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}

test("a gpt-oss model gets native tools on the OpenAI-compatible shape: its tool_call runs and the result returns as a tool message", async () => {
  const run = await turnWith("openai/gpt-oss-20b")
  expect(run.bodies[0]!.tools?.some((t: { function?: { name?: string } }) => t.function?.name === "read")).toBe(true)
  expect(run.bodies[0]!.stream).toBe(false)
  expect(run.tools).toEqual(["read notes.md"])
  const toolMessage = run.bodies[1]!.messages.find((m: { role: string }) => m.role === "tool")
  expect(toolMessage).toMatchObject({ role: "tool", tool_call_id: "call_1" })
  expect(String(toolMessage.content)).toContain("hello")
  expect(run.end).toMatchObject({ kind: "done", outcome: "completed" })
}, 150_000)

test("the twin: another cloud-style model on the same provider stays on the text protocol (no tools field)", async () => {
  const run = await turnWith("vendor/text-model")
  expect(run.bodies[0]!.tools).toBeUndefined()
  expect(run.tools).toEqual([])
}, 150_000)
