/**
 * 10-08 (مقيس على مشروعٍ حقيقيّ): اختبارُ المشروع يطلب خادماً حيّاً، والمضيفُ يشغّله ولا خادم ⇦ ECONNREFUSED ثلاثَ مرّات،
 * والنموذجُ يتجاهله لأنّه ليس من تعديله، فيقف كلُّ دورٍ «acceptance-pending». بعدها: المضيفُ يشغّل خادمَ المشروع (سكربته هو)
 * تحت إدارة النواة مرّةً ويعيد الاختبار — فيخضرّ ويكتمل الدور. والتوأمُ: مشروعٌ بلا سكربت خادم لا يُخترع له أمر.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { stripChildEnv } from "../../tools/src/env-strip"
import { projectServerCommand, refusedLocalPort } from "../src/verify-after-edit"

const freePort = () => new Promise<number>((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => done(port)) }) })

test("the refused port is read from node's error, and the server command is the project's own", () => {
  expect(refusedLocalPort("Error: connect ECONNREFUSED ::1:3000\n  Error: connect ECONNREFUSED 127.0.0.1:3000")).toBe(3000)
  expect(refusedLocalPort("connect ECONNREFUSED localhost:5173")).toBe(5173)
  // مضيفٌ بعيد ليس خادمَ المشروع.
  expect(refusedLocalPort("connect ECONNREFUSED 10.0.0.5:3000")).toBeUndefined()
  expect(refusedLocalPort("✖ adds (2ms) AssertionError")).toBeUndefined()
  const dir = mkdtempSync(join(tmpdir(), "abdo-server-cmd-"))
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test", dev: "next dev", start: "next start" } }))
    expect(projectServerCommand(dir, 3000)).toBe("run --bg npm run dev -- --port 3000")
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test", start: "node server.js" } }))
    writeFileSync(join(dir, "pnpm-lock.yaml"), "")
    expect(projectServerCommand(dir)).toBe("run --bg pnpm run start")
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }))
    expect(projectServerCommand(dir, 3000)).toBeUndefined()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

async function turnWith(replies: readonly string[], opts: { devScript: boolean }) {
  const port = await freePort()
  const bodies: string[] = []
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const content = replies[Math.min(bodies.length, replies.length - 1)]!
    const body = await request.json() as { stream?: boolean; messages?: { content?: unknown }[] }
    bodies.push(JSON.stringify(body.messages ?? []))
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const home = mkdtempSync(join(tmpdir(), "abdo-verify-server-")), project = join(home, "proj"), settings = join(home, "settings.json")
  mkdirSync(project, { recursive: true })
  const scripts: Record<string, string> = { test: "node --test" }
  if (opts.devScript) scripts.dev = "node server.js"
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "verify-server-probe", version: "1.0.0", private: true, scripts }))
  // الخادمُ يقرأ PORT (تضعه النواة) ويجيب /api/health.
  writeFileSync(join(project, "server.js"), "require('node:http').createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ ok: true })) }).listen(Number(process.env.PORT || 3000), '127.0.0.1')\n")
  writeFileSync(join(project, "health.test.js"), `const test = require('node:test'); const assert = require('node:assert'); const http = require('node:http');
test('health', () => new Promise((done, fail) => { http.get('http://127.0.0.1:${port}/api/health', (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { assert.strictEqual(JSON.parse(d).ok, true); done() } catch (e) { fail(e) } }) }).on('error', fail) }))
`)
  writeFileSync(join(project, "util.js"), "module.exports = 1\n")
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "full-access", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false, verifyAfterEdit: true },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${model.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const frames: any[] = []
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), ABDO_SHELL_TOKEN: "t", ABDO_FRAMED_STDIO: "1", USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "8", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) for (const frame of decoder.push(bytes)) frames.push(frame) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 120_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out: " + label + " " + JSON.stringify(frames).slice(-2000)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "t" })
    await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    send({ kind: "submit", mode: "full-access", turn: { id: "s1", body: "Tidy util.js" } })
    await wait(() => frames.some((f) => f.turnId === "s1" && ["done", "refused", "unresolved"].includes(f.kind)), "turn end")
    const end = frames.find((f) => f.turnId === "s1" && ["done", "refused", "unresolved"].includes(f.kind))
    const events = frames.filter((f) => f.turnId === "s1" && f.kind === "event").map((f) => String(f.payload))
    const acceptanceRuns = frames.filter((f) => f.turnId === "s1" && f.kind === "tool" && f.acceptance === true).map((f) => String(f.cmd))
    const results = frames.filter((f) => f.turnId === "s1" && f.kind === "tool-result" && f.acceptance === true).map((f) => `${f.cmd} → ${String(f.output).slice(0, 200)}`)
    return { port, end, events, acceptanceRuns, results }
  } finally {
    child.kill(); await child.exited; await reading; await stderr; model.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}

const EDIT = "نفّذ: write util.js <<<\nmodule.exports = 2\n"

test("a test that needs the project's server: the host starts the project's own dev script under the kernel, re-runs, and the turn completes green", async () => {
  const on = await turnWith([EDIT, "Done.", "Done."], { devScript: true })
  expect(on.events.some((e) => e.includes(`يتّصل بخادمٍ حيّ على المنفذ ${on.port}`))).toBe(true)
  expect(on.acceptanceRuns).toEqual(["run npm test", `run --bg npm run dev -- --port ${on.port}`, "run npm test"])
  expect(on.results.some((r) => r.startsWith(`run --bg npm run dev -- --port ${on.port} → ⚙ الخادم يعمل تحت إدارة النواة`))).toBe(true)
  expect(on.end).toMatchObject({ kind: "done", outcome: "completed" })
}, 200_000)

test("the twin: no dev/start script ⇒ no server is invented, and the red run stops honestly as before", async () => {
  const off = await turnWith([EDIT, "Done.", "Done."], { devScript: false })
  expect(off.acceptanceRuns).toEqual(["run npm test"])
  expect(off.events.some((e) => e.includes("يتّصل بخادمٍ حيّ"))).toBe(false)
  expect(off.end).toMatchObject({ kind: "done", outcome: "checkpointed" })
}, 200_000)
