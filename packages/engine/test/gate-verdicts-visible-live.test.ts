/**
 * 10-10 — measured in the m11 retry: the build gate judged «Tailwind installed, no CSS in dist» and the test gate judged «tests 0 proves
 * nothing», but both verdicts were thrown away in the main loop's dispatch — the model rebuilt the same thing four times and delivered with
 * no tests. Real engine, real `run`, a local fake model: the verdict must be in the next request the model receives.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const run = async (command: string, project: string) => {
  const root = resolve(import.meta.dir, "../../..")
  const home = mkdtempSync(join(tmpdir(), "abdo-gate-visible-"))
  const state = join(home, "state"), settings = join(home, "settings.json")
  mkdirSync(state)
  const requests: string[] = []
  const reply = (content: string) => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages?: unknown }
    const text = JSON.stringify(body.messages ?? body)
    requests.push(text)
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } })
    return reply(text.includes(command.split(" ").slice(-1)[0]!) && requests.filter((r) => r.includes("انتهى الأمر برمز")).length > 0 ? "تم." : `نفّذ: ${command}`)
  } })
  writeFileSync(settings, JSON.stringify({
    project, language: "ar", mode: "full-access", modelRole: "agent", chatModel: "gate-fixture/model", agentModel: "gate-fixture/model", gateModel: "gate-fixture/model",
    routerGate: "off", railPolicy: "medium", memorySearchEnabled: false,
    customProviders: [{ id: "gate-fixture", label: "Local gate test", baseUrl: `http://127.0.0.1:${server.port}/v1`, local: true, vaultKey: "", models: ["model"] }],
  }))
  const executable = process.env.ABDO_TEST_ENGINE
  const child = Bun.spawn(executable ? [executable, "serve"] : [process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: root, env: { ...process.env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_SHELL_TOKEN: "gate-fixture", ABDO_FRAMED_STDIO: "1", ABDO_VAULT_HOME: home, USERPROFILE: home, HOME: home, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "", ABDO_PROJECT: project },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const decoder = new LocalJsonFrameDecoder(), frames: any[] = []
  void (async () => { for await (const chunk of child.stdout) for (const frame of decoder.push(chunk)) frames.push(frame) })()
  const send = async (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); await child.stdin.flush() }
  const wait = async (check: () => boolean, ms = 90_000) => { const deadline = Date.now() + ms; while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(frames).slice(-800)}`); await Bun.sleep(20) } }
  try {
    await send({ kind: "hello", shell: "desktop", token: "gate-fixture" })
    await wait(() => frames.some((f) => f.kind === "ready"))
    await send({ kind: "trust-grant", path: project })
    await send({ kind: "submit", turn: { id: "gate-1", body: `شغّل ${command} في المشروع وأخبرني بالنتيجة` }, mode: "full-access" })
    await wait(() => requests.some((r) => r.includes("انتهى الأمر برمز")) || frames.some((f) => (f.kind === "done" || f.kind === "refused") && f.turnId === "gate-1"))
    return requests.find((r) => r.includes("انتهى الأمر برمز")) ?? ""
  } finally {
    child.kill(); await child.exited; server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}

const fixture = (pkg: object) => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-gate-project-"))
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg))
  writeFileSync(join(dir, "README.md"), "# fixture\n")
  return dir
}

test("a Vite+Tailwind build that emits no CSS: the model's next request carries the build gate's verdict", async () => {
  const project = fixture({ scripts: { build: "node -e \"const f=require('fs');f.mkdirSync('dist/assets',{recursive:true});f.writeFileSync('dist/index.html','<html></html>');f.writeFileSync('dist/assets/a.js','1')\"" }, devDependencies: { vite: "^8.3.4", tailwindcss: "^4.3.3" } })
  try {
    const seen = await run("run npm run build", project)
    expect(seen).toContain("بوّابةُ البناء لم تقبل هذا البناء")
    expect(seen).toContain("@tailwindcss/vite")
  } finally { rmSync(project, { recursive: true, force: true }) }
}, 150_000)

test("npm test that ran zero tests: the model is told it proved nothing", async () => {
  const project = fixture({ scripts: { test: "node --test" } })
  try {
    const seen = await run("run npm test", project)
    expect(seen).toContain("بوّابةُ الاختبار")
    expect(seen).toContain("tests 0")
  } finally { rmSync(project, { recursive: true, force: true }) }
}, 150_000)
