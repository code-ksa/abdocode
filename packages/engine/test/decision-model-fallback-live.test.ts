/**
 * 10-09 (measured on m7 against OpenCode): the decision model answered 503/502 five times, so the semantic judge waited 145 s of a 234 s turn
 * after the working model had finished. Live on the real engine with two fake providers: the decision model gets two attempts, then the
 * working agent model judges, with a line telling the operator. The twin: a healthy decision model is still the one asked.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const ROOT = resolve(import.meta.dir, "../../..")
process.env.ABDO_MODEL_RETRY_BACKOFF_MS = "20"

const reply = (body: { stream?: boolean }, content: string): Response => body.stream === false
  ? Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })
  : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })

async function run(judgeDown: boolean): Promise<{ agent: number; judge: number; end: string; events: string[] }> {
  const base = mkdtempSync(join(tmpdir(), "abdo-judge-live-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  let agent = 0, judge = 0
  const verdict = JSON.stringify({ status: "COMPLETE", reason: "answered" })
  const agentServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean }
    agent += 1
    return reply(body, agent === 1 ? "تمّ." : verdict)
  } })
  const judgeServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean }
    judge += 1
    if (judgeDown) return new Response(JSON.stringify({ error: { message: "scripted 503" } }), { status: 503, headers: { "content-type": "application/json" } })
    return reply(body, verdict)
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "work/model", chatModel: "work/model", decisionModel: "judge/model", modelRole: "agent", mode: "read-only", project, routerGate: "off", railPolicy: "thin", workMode: "basic", plugins: { inventory: false, verifier: true, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 }, customProviders: [
    { id: "work", label: "work", baseUrl: `http://127.0.0.1:${agentServer.port}/v1`, vaultKey: "", local: true, models: ["model"] },
    { id: "judge", label: "judge", baseUrl: `http://127.0.0.1:${judgeServer.port}/v1`, vaultKey: "", local: true, models: ["model"] },
  ] }))
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
    send({ kind: "submit", mode: "read-only", turn: { id: "j1", body: "قل تمّ فقط" } })
    await wait(() => frames.some((f) => f.turnId === "j1" && ["done", "refused", "unresolved"].includes(f.kind)))
    const end = frames.find((f) => f.turnId === "j1" && ["done", "refused", "unresolved"].includes(f.kind))
    return { agent, judge, end: end.kind, events: frames.filter((f) => f.kind === "event" && f.turnId === "j1").map((f) => String(f.payload ?? "")) }
  } finally { child.kill(); await child.exited; agentServer.stop(true); judgeServer.stop(true); await errors; for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } } }
}

test.skipIf(process.platform !== "win32")("a decision model that keeps answering 503 gets two attempts, then the working model judges", async () => {
  const r = await run(true)
  expect(r.judge).toBe(2)
  expect(r.agent).toBe(2)
  expect(r.end).toBe("done")
  expect(r.events.join("\n")).toContain("نموذجُ القرار judge/model لا يجيب")
}, 120_000)

test.skipIf(process.platform !== "win32")("the twin: a healthy decision model is the one that judges, the working model is asked once", async () => {
  const r = await run(false)
  expect(r.judge).toBe(1)
  expect(r.agent).toBe(1)
  expect(r.end).toBe("done")
}, 120_000)
