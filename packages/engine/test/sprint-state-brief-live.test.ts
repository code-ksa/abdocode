/** 10-10 — the open sprint reaches the model's first input (it was loaded for judges only, so the model re-read the plan 68 times). */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const PLAN = "# Plan\n## S1 — Setup\nالحالة: مكتمل\nالأدلة: build PASS\n## S2 — Pricing page\n- toggle monthly/yearly\n- three cards\nالبوّابة: audit /pricing PASS\n## S3 — Enterprise\n- hero\n"

const runTurn = async (first: string, userBody: string, plan?: string) => {
  const requests: string[] = []
  const root = resolve(import.meta.dir, "../../..")
  const home = mkdtempSync(join(tmpdir(), "abdo-sprint-state-"))
  const state = join(home, "state"), project = join(home, "project"), settingsFile = join(home, "settings.json")
  mkdirSync(state); mkdirSync(project); writeFileSync(join(project, "README.md"), "# fixture\n"); if (plan !== undefined) writeFileSync(join(project, "ABDO-SPRINTS.md"), plan)
  let asked = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const raw = await request.text(); requests.push(raw)
    const body = JSON.parse(raw) as { stream?: boolean }
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } })
    const content = asked++ === 0 ? first : "تم."
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
  } })
  writeFileSync(settingsFile, JSON.stringify({
    project, language: "ar", mode: "full-access", modelRole: "agent", chatModel: "fx/model", agentModel: "fx/model", gateModel: "fx/model", routerGate: "off", railPolicy: "medium",
    memorySearchEnabled: false, turnNotifications: true,
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, local: true, vaultKey: "", models: ["model"] }],
  }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: root, env: { ...process.env, ABDO_CODE_SETTINGS: settingsFile, ABDO_CODE_STATE_DIR: state, ABDO_SHELL_TOKEN: "fx", ABDO_FRAMED_STDIO: "1", ABDO_VAULT_HOME: home, USERPROFILE: home, HOME: home, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "", ABDO_PROJECT: project },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const decoder = new LocalJsonFrameDecoder(), frames: any[] = []
  void (async () => { for await (const chunk of child.stdout) for (const frame of decoder.push(chunk)) frames.push(frame) })()
  const send = async (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); await child.stdin.flush() }
  const wait = async (check: () => boolean) => { const deadline = Date.now() + 90_000; while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(frames).slice(-800)}`); await Bun.sleep(20) } }
  try {
    await send({ kind: "hello", shell: "desktop", token: "fx" })
    await wait(() => frames.some((f) => f.kind === "ready"))
    await send({ kind: "trust-grant", path: project })
    await send({ kind: "submit", turn: { id: "s-1", body: userBody }, mode: "full-access" })
    await wait(() => frames.some((f) => (f.kind === "done" || f.kind === "refused") && f.turnId === "s-1"))
    return { requests, tools: frames.filter((f) => f.kind === "tool-result").map((f) => String(f.cmd ?? "")), text: frames.filter((f) => f.kind === "delta" || f.kind === "event").map((f) => String(f.text ?? f.payload ?? "")).join("") }
  } finally {
    child.kill(); await child.exited; server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}

test("live: on «اكمل» the first model request carries SPRINT_STATE with the map and the open sprint's full text, and no order to re-read hand-off files", async () => {
  const run = await runTurn("تم.", "اكمل", PLAN)
  const first = run.requests.find((r) => r.includes("SPRINT_STATE")) ?? ""
  expect(first.length, run.requests.map((r) => r.slice(0, 200)).join("\n---\n")).toBeGreaterThan(0)
  const text = JSON.parse(first).messages.map((m: { content: unknown }) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n")
  expect(text).toContain("✓ S1 — Setup")
  expect(text).toContain("○ S2 — Pricing page")
  expect(text).toContain("- toggle monthly/yearly")
  expect(text).toContain("sprint done")
  expect(text).toContain("استئناف خطّة المشروع «Plan»")
}, 120_000)

test("the twin: without a sprint plan there is no SPRINT_STATE block", async () => {
  const run = await runTurn("تم.", "اكتب دالة sort")
  expect(run.requests.some((r) => r.includes("SPRINT_STATE"))).toBe(false)
}, 120_000)
