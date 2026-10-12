/** 10-10 — a chat message while a code turn runs in another session is answered beside it, not refused or held (owner: «اصلح جزئية تطبيق الشات»). */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const runSide = async () => {
  const root = resolve(import.meta.dir, "../../..")
  const home = mkdtempSync(join(tmpdir(), "abdo-side-chat-"))
  const state = join(home, "state"), project = join(home, "project"), settingsFile = join(home, "settings.json")
  mkdirSync(state); mkdirSync(project); writeFileSync(join(project, "README.md"), "# fixture\n")
  let asked = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean }
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } })
    const raw = JSON.stringify(body); const content = raw.includes("سؤال دردشة") ? "جوابُ الدردشة" : (asked++ === 0 ? "نفّذ: run node -e \"setTimeout(()=>{},5000)\"" : "تم.")
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
    await send({ kind: "submit", turn: { id: "code-1", body: "شغّل الأمر الطويل" }, mode: "full-access" })
    await wait(() => frames.some((f) => f.kind === "admission" && f.turnId === "code-1"))
    await Bun.sleep(400)
    await send({ kind: "session-new", conversationMode: "chat" })
    await Bun.sleep(200)
    await send({ kind: "submit", turn: { id: "chat-1", body: "سؤال دردشة" }, mode: "full-access", conversationMode: "chat" })
    await wait(() => frames.some((f) => (f.kind === "done" || f.kind === "refused") && f.turnId === "chat-1"))
    const chatEndedAt = frames.findIndex((f) => (f.kind === "done" || f.kind === "refused") && f.turnId === "chat-1")
    const codeDoneBefore = frames.slice(0, chatEndedAt).some((f) => (f.kind === "done" || f.kind === "refused") && f.turnId === "code-1")
    await wait(() => frames.some((f) => (f.kind === "done" || f.kind === "refused") && f.turnId === "code-1"))
    return { codeDoneBefore, chatFrames: frames.filter((f) => f.turnId === "chat-1").map((f) => [f.kind, String(f.text ?? f.payload ?? f.why ?? "")]), codeEnd: frames.find((f) => f.turnId === "code-1" && (f.kind === "done" || f.kind === "refused")), tools: frames.filter((f) => f.kind === "tool-result").map((f) => String(f.cmd ?? "")), text: frames.filter((f) => f.kind === "delta" || f.kind === "event").map((f) => String(f.text ?? f.payload ?? "")).join("") }
  } finally {
    child.kill(); await child.exited; server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}

test("live: the chat is admitted, streamed and done while the code turn is still running; the code turn still completes", async () => {
  const run = await runSide()
  const kinds = run.chatFrames.map(([k]) => k)
  expect(kinds, JSON.stringify(run.chatFrames)).toContain("admission")
  expect(run.chatFrames.some(([k, t]) => k === "delta" && t.includes("جوابُ الدردشة"))).toBe(true)
  expect(kinds).toContain("done")
  expect(run.codeDoneBefore).toBe(false)
  expect(run.codeEnd?.kind).toBe("done")
}, 180_000)
