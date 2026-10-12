/** 10-10 — the agentContextTokens setting is the window the engine actually budgets with (measured: 65.5k on DeepSeek trimmed every call). */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const runTurn = async (first: string, userBody: string, extra: Record<string, unknown> = {}) => {
  const root = resolve(import.meta.dir, "../../..")
  const home = mkdtempSync(join(tmpdir(), "abdo-ctx-setting-"))
  const state = join(home, "state"), project = join(home, "project"), settingsFile = join(home, "settings.json")
  mkdirSync(state); mkdirSync(project); writeFileSync(join(project, "README.md"), "# fixture\n")
  let asked = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean }
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } })
    const content = asked++ === 0 ? first : "تم."
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
  } })
  writeFileSync(settingsFile, JSON.stringify({
    project, language: "ar", mode: "full-access", modelRole: "agent", chatModel: "fx/model", agentModel: "fx/model", gateModel: "fx/model", routerGate: "off", railPolicy: "medium",
    memorySearchEnabled: false, turnNotifications: true, ...extra,
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
    return { tools: frames.filter((f) => f.kind === "tool-result").map((f) => String(f.cmd ?? "")), text: frames.filter((f) => f.kind === "delta" || f.kind === "event").map((f) => String(f.text ?? f.payload ?? "")).join("") }
  } finally {
    child.kill(); await child.exited; server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}

test("live: agentContextTokens 131072 is the window in the context line; without it the default 65.5k stays", async () => {
  const big = await runTurn("تم.", "مرحبا", { agentContextTokens: 131072 })
  expect(big.text).toContain("من 131.1k")
  const base = await runTurn("تم.", "مرحبا")
  expect(base.text).toContain("من 65.5k")
}, 180_000)
