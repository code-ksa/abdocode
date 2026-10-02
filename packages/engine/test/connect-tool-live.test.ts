import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { connectReceipt, renderConnectors, resolveConnector } from "../src/connectors/agent-tools"

// 🔴 مقيس 10-02: الربطُ كان زرّاً في الإعدادات وحده — الوكيلُ لا يعرف من المربوط ولا يطلب الربط، فـ«اربط نوشن وأنشئ صفحة» لا تُنجَز
// من المحادثة. الأداتان connectors وconnect: الحالُ، ثمّ رقصةُ الزرّ نفسُها من الدور، ثمّ أدواتُ الموصّل تُستدعى في الدور نفسِه.

describe("connector names and receipts", () => {
  test("Arabic and Latin names resolve to the registry id", () => {
    expect(resolveConnector("notion")?.id).toBe("notion")
    expect(resolveConnector("نوشن")?.id).toBe("notion")
    expect(resolveConnector("سلاك")?.id).toBe("slack")
    expect(resolveConnector("Gmail")?.id).toBe("google")
    expect(resolveConnector("درايف")?.id).toBe("google")
    expect(resolveConnector("أسانا")?.id).toBe("asana")
    expect(resolveConnector("Jira")?.id).toBe("atlassian")
    expect(resolveConnector("GitHub")?.id).toBe("github")
    expect(resolveConnector("Figma")?.id).toBe("figma")
    expect(resolveConnector("dropbox")).toBeUndefined()
    expect(resolveConnector("")).toBeUndefined()
  })
  test("each state reads as what to do next", () => {
    const text = renderConnectors([
      { id: "slack", label: "Slack", labelAr: "سلاك", linked: true, connected: true, needsClient: false },
      { id: "notion", label: "Notion", labelAr: "Notion", linked: false, connected: false, needsClient: false },
      { id: "github", label: "GitHub", labelAr: "GitHub", linked: false, connected: false, needsClient: true, ownerClient: { howTo: "github.com/settings/developers" } },
      { id: "asana", label: "Asana", labelAr: "Asana", linked: true, connected: false, needsClient: false },
    ], (id) => (id === "slack" ? ["connector-slack.slack_search", "connector-slack.slack_post_message"] : []))
    expect(text).toContain("الموصّلات (1 موصولٌ من 4)")
    expect(text).toContain("✓ سلاك (slack): مربوطٌ وموصول — 2 أداة: connector-slack.slack_search، connector-slack.slack_post_message")
    expect(text).toContain("○ Notion (notion): غيرُ مربوط — connect notion")
    expect(text).toContain("⚠ GitHub (github): يحتاج تطبيقاً خاصّاً قبل الربط — github.com/settings/developers")
    expect(text).toContain("◐ Asana (asana): مربوط")
    expect(connectReceipt("Notion", "error", "رفض الخادم", []).ok).toBe(false)
    expect(connectReceipt("Notion", "authorizing", undefined, []).text).toContain("لم تكتمل الموافقة")
    expect(connectReceipt("Notion", "linked", undefined, ["connector-notion.search"])).toEqual({ ok: true, text: "رُبط «Notion» ووُصل — 1 أداة تُستدعى الآن بأسمائها: connector-notion.search" })
  })
})

const ROOT = resolve(import.meta.dir, "../../..")

test.skipIf(process.platform !== "win32")("from the conversation: connectors, then connect linear (browser consent), then a Linear tool runs in the same turn", async () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-connect-tool-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  // خادمٌ زائف: تفويضٌ (اكتشاف، DCR، PKCE) وخادمُ MCP بعيد بـBearer — كاختبار الموصّلات.
  const issued: { challenge: string; code: string }[] = []
  let token = "none"
  const remoteCalls: string[] = []
  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), origin = `http://127.0.0.1:${fake.port}`
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
    if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] })
    if (url.pathname === "/register") return Response.json({ client_id: "dyn-linear" }, { status: 201 })
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await request.text())
      const rec = issued.find((i) => i.code === form.get("code"))
      if (!rec || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== rec.challenge) return Response.json({ error: "invalid_grant" }, { status: 400 })
      token = "access-live"
      return Response.json({ access_token: "access-live", refresh_token: "refresh-live", token_type: "Bearer", expires_in: 3600 })
    }
    if (url.pathname === "/mcp") {
      const body = await request.json() as { id?: number; method: string; params?: { name?: string } }
      if (request.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32001, message: "missing_token" } }, { status: 401 })
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", serverInfo: { name: "fake-linear", version: "1" }, capabilities: { tools: {} } } })
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "create_project", description: "create a Linear project", inputSchema: { type: "object", properties: { name: { type: "string" } } } }] } })
      if (body.method === "tools/call") { remoteCalls.push(body.params?.name ?? "?"); return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "PROJECT-CREATED: Saudi AI" }] } }) }
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } })
    }
    return new Response("nf", { status: 404 })
  } })
  // نموذجٌ زائف: الحالُ ثمّ الربطُ ثمّ أداةُ الموصّل ثمّ الخلاصة — بحسب آخر إيصالٍ وصله.
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages?: { role: string; content: unknown }[] }
    const text = (m: { content: unknown } | undefined) => m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    const last = text([...(body.messages ?? [])].reverse().find((m) => m.role === "user"))
    const all = (body.messages ?? []).map(text).join("\n")
    let content = "تمّ."
    if (all.includes("CONNECT-LIVE")) {
      if (last.includes("PROJECT-CREATED")) content = "أنشأتُ المشروع في Linear."
      else if (last.includes("ووُصل")) content = 'نفّذ: connector-linear.create_project {"name":"Saudi AI"}'
      else if (last.includes("الموصّلات (")) content = "نفّذ: connect linear"
      else content = "نفّذ: connectors"
    }
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "tool-fixture/model", chatModel: "tool-fixture/model", modelRole: "agent", mode: "full-access", project, routerGate: "off", railPolicy: "thin", plugins: { mcpClient: true, inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, customProviders: [{ id: "tool-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${model.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_CONNECTOR_RESOURCE_OVERRIDE: `linear=http://127.0.0.1:${fake.port}/mcp` }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  // القشرةُ والمتصفّح: الرابطُ يُتبع إلى loopback، والإعداداتُ المحفوظة بخادمٍ autoConnect تُوصَل — كما تفعل القشرةُ الحقيقيّة.
  const connected = new Set<string>()
  void (async () => {
    for await (const bytes of child.stdout) for (const f of decoder.push(bytes) as any[]) {
      frames.push(f)
      if (f.kind === "connector-open") {
        const u = new URL(f.url), redirect = new URL(u.searchParams.get("redirect_uri")!)
        issued.push({ challenge: u.searchParams.get("code_challenge")!, code: "code-1" })
        redirect.searchParams.set("code", "code-1"); redirect.searchParams.set("state", u.searchParams.get("state")!)
        void fetch(redirect.toString())
      }
      if (f.kind === "settings") for (const s of f.settings?.mcpServers ?? []) {
        if (s.autoConnect === true && !connected.has(s.id)) { connected.add(s.id); send({ kind: "external-connect", id: s.id, command: s.command, protocol: "mcp" }) }
      }
    }
  })()
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 90_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames.map((f) => f.kind + (f.why ? ":" + f.why : ""))).slice(-2000)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    send({ kind: "submit", mode: "full-access", turn: { id: "c-1", body: "CONNECT-LIVE اربط Linear وأنشئ مشروعاً" } })
    await wait(() => frames.some((f) => f.turnId === "c-1" && ["done", "refused", "unresolved"].includes(f.kind)))
    const cmds = frames.filter((f) => f.kind === "tool" && f.turnId === "c-1").map((f) => String(f.cmd))
    const outs = frames.filter((f) => f.kind === "tool-result" && f.turnId === "c-1").map((f) => String(f.output))
    expect(cmds.slice(0, 3)).toEqual(["connectors", "connect linear", 'connector-linear.create_project {"name":"Saudi AI"}'])
    expect(outs[0]).toContain("○ Linear (linear): غيرُ مربوط — connect linear")
    expect(outs[1]).toBe("رُبط «Linear» ووُصل — 1 أداة تُستدعى الآن بأسمائها: connector-linear.create_project")
    expect(outs[2]).toContain("PROJECT-CREATED: Saudi AI")
    expect(remoteCalls).toEqual(["create_project"])
    // الرموزُ في الخزنة لا في الإعدادات ولا في الإيصالات
    expect(readFileSync(settings, "utf8")).not.toContain("access-live")
    expect(outs.join("\n")).not.toContain("access-live")
  } finally { child.kill(); await child.exited; fake.stop(true); model.stop(true); await errors; for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } } }
}, 180_000)
