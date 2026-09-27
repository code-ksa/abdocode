/**
 * الفجوة #13 (2026-09-27) — `abdocode mcp-agent`: عميلُ MCP يرسل مهمّةً فيُنفّذها الوكيلُ الحقيقيّ في المشروع المثبَّت عند الإقلاع.
 * ping يُجاب أثناء المهمّة (طابورٌ لا حبس)، والمدخلُ الناقص خطأٌ مسمّى، والمجلّدُ غيرُ الموجود يُرفض عند الإقلاع.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseAgentArgs } from "../src/mcp-servers/agent"
import { stripChildEnv } from "../../tools/src/env-strip"

test("an MCP client runs a real task; ping answers while it runs; a bad call is a named error", async () => {
  let requests = 0
  const replies = ["نفّذ: write note.txt <<<\nfrom mcp\n", "Wrote note.txt."]
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const content = replies[Math.min(requests, replies.length - 1)]!
    requests += 1
    // المهمّةُ تستغرق وقتاً حقيقيّاً كي يُثبت أنّ ping لا ينتظرها.
    await Bun.sleep(400)
    const payload = await request.json() as { stream?: boolean }
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const home = mkdtempSync(join(tmpdir(), "abdo-mcp-agent-")), project = join(home, "proj"), settings = join(home, "settings.json")
  mkdirSync(project, { recursive: true })
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "auto", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "mcp-agent", project], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "3", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  void new Response(child.stderr).text()
  const replies2: { id: number; result?: any; error?: any; at: number }[] = []
  const reading = (async () => {
    let buffer = ""
    for await (const bytes of child.stdout) {
      buffer += new TextDecoder().decode(bytes)
      let cut: number
      while ((cut = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1); if (line.trim()) replies2.push({ ...JSON.parse(line), at: Date.now() }) }
    }
  })()
  const send = (message: object) => { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); void child.stdin.flush() }
  const reply = async (id: number) => { const deadline = Date.now() + 90_000; while (!replies2.some((r) => r.id === id)) { if (Date.now() > deadline) throw Error(`no reply ${id}`); await Bun.sleep(20) } return replies2.find((r) => r.id === id)! }
  try {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } })
    expect((await reply(1)).result.serverInfo.name).toBe("abdocode-agent")
    send({ id: 2, method: "tools/list" })
    expect((await reply(2)).result.tools.map((t: { name: string }) => t.name)).toEqual(["run_task"])
    send({ id: 3, method: "tools/call", params: { name: "run_task", arguments: { task: "Create note.txt containing: from mcp" } } })
    send({ id: 4, method: "ping" })
    const ping = await reply(4)
    const task = await reply(3)
    // ping أُجيب قبل تمام المهمّة: الحلقةُ لا تنتظر الطابور.
    expect(ping.at).toBeLessThan(task.at)
    expect(task.result.isError).toBeUndefined()
    expect(task.result.structuredContent).toMatchObject({ outcome: "completed", exitCode: 0, approvalsDenied: [] })
    expect(task.result.content[0].text).toContain("Wrote note.txt.")
    expect(readFileSync(join(project, "note.txt"), "utf8")).toBe("from mcp")
    send({ id: 5, method: "tools/call", params: { name: "run_task", arguments: {} } })
    expect((await reply(5)).result).toMatchObject({ isError: true })
    send({ id: 6, method: "tools/call", params: { name: "delete_everything", arguments: { task: "x" } } })
    expect((await reply(6)).result.content[0].text).toContain("Unknown tool")
  } finally {
    child.stdin.end(); child.kill(); await child.exited; await reading.catch(() => undefined); server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 150_000)

test("the project and mode are fixed at launch: a missing folder or a wider mode by typo is refused before serving", () => {
  expect(parseAgentArgs([])).toMatchObject({ error: expect.stringContaining("مجلّدَ المشروع") })
  expect(parseAgentArgs([join(tmpdir(), "no-such-dir-" + crypto.randomUUID())])).toMatchObject({ error: expect.stringContaining("ليس مجلّداً") })
  expect(parseAgentArgs([tmpdir(), "--mode", "yolo"])).toMatchObject({ error: expect.stringContaining("--mode") })
  expect(parseAgentArgs([tmpdir(), "--project", "/etc"])).toMatchObject({ error: expect.stringContaining("خيارٌ غيرُ معروف") })
  expect(parseAgentArgs([tmpdir()])).toMatchObject({ mode: "auto" })
})
