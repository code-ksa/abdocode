import { describe, expect, test } from "bun:test"
import { readSseUntil, RemoteMcp, remoteOptionsFromEnv, serveRemoteMcp } from "../src/mcp-servers/remote"

// جسرُ MCP البعيد على خادمٍ زائف يطالب بـBearer: المصافحة، الجلسة، tools/list وtools/call، ردٌّ SSE، و401 يجدّد الرمزَ مرّةً
// ثمّ يعيد الطلب — والفشلُ في التجديد يقول للنموذج ما يفعله المستخدم. الحلقةُ على stdio تُقاد بأسطرٍ كعميلنا.

function fakeRemote() {
  const seen: { auth: string | null; method: string; session: string | null }[] = []
  let valid = new Set(["access-1"])
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text())
        if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "refresh-1" && form.get("client_id") === "c1") { valid = new Set(["access-2"]); return Response.json({ access_token: "access-2", token_type: "Bearer", expires_in: 60 }) }
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      }
      if (url.pathname !== "/mcp") return new Response("nf", { status: 404 })
      const auth = request.headers.get("authorization")
      const body = await request.json() as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }
      seen.push({ auth, method: body.method, session: request.headers.get("mcp-session-id") })
      if (auth !== `Bearer ${[...valid][0]}`) return Response.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32001, message: "missing_token" } }, { status: 401 })
      const headers = { "mcp-session-id": "sess-9" }
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", serverInfo: { name: "fake-remote", version: "1" }, capabilities: { tools: {} } } }, { headers })
      if (body.method === "notifications/initialized") return new Response(null, { status: 202, headers })
      if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "search", description: "search things", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] } }, { headers })
      if (body.method === "tools/call") {
        // ردٌّ SSE: رسالةٌ لا تخصّ الطلب أوّلاً ثمّ الردّ
        const stream = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { p: 1 } })}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `found ${body.params?.arguments?.q}` }] } })}\n\n`
        return new Response(stream, { headers: { ...headers, "content-type": "text/event-stream" } })
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } }, { headers })
    },
  })
  const fetchImpl = (input: string, init?: RequestInit) => fetch(input.replace("https://remote.test", `http://127.0.0.1:${server.port}`), init)
  return { server, fetchImpl, seen, stop: () => server.stop(true) }
}

describe("mcp-remote — خادمُ MCP بعيد بـBearer", () => {
  test("المصافحة والجلسة والأدوات وردُّ SSE؛ ثمّ 401 ⇦ تجديدٌ ⇦ إعادةٌ بالرمز الجديد", async () => {
    const r = fakeRemote()
    try {
      const renewed: string[] = []
      const remote = new RemoteMcp({ url: "https://remote.test/mcp", accessToken: "stale", refreshToken: "refresh-1", clientId: "c1", tokenUrl: "https://remote.test/token", fetchImpl: r.fetchImpl, onTokens: (t) => renewed.push(t.accessToken) })
      // الرمزُ البادئ فاسد ⇒ 401 ⇒ تجديد ⇒ access-2 ⇒ المصافحة تنجح
      const info = await remote.initialize() as { serverInfo: { name: string } }
      expect(info.serverInfo.name).toBe("fake-remote")
      expect(renewed).toEqual(["access-2"])
      expect(remote.sessionId).toBe("sess-9")
      const tools = await remote.request("tools/list") as { tools: { name: string }[] }
      expect(tools.tools.map((t) => t.name)).toEqual(["search"])
      const called = await remote.request("tools/call", { name: "search", arguments: { q: "abdo" } }) as { content: { text: string }[] }
      expect(called.content[0]!.text).toBe("found abdo")
      expect(r.seen.filter((s) => s.method === "tools/call")[0]!.session).toBe("sess-9")
      expect(r.seen.filter((s) => s.method === "initialize").map((s) => s.auth)).toEqual(["Bearer stale", "Bearer access-2"])
    } finally { r.stop() }
  })

  test("بلا refresh ⇒ 401 يقول للمستخدم أن يعيد الربط؛ والرابطُ غيرُ https مرفوض", async () => {
    const r = fakeRemote()
    try {
      const remote = new RemoteMcp({ url: "https://remote.test/mcp", accessToken: "bad", fetchImpl: r.fetchImpl })
      await expect(remote.initialize()).rejects.toThrow("أعد الربط")
      expect(() => new RemoteMcp({ url: "http://remote.test/mcp" })).toThrow("https")
    } finally { r.stop() }
  })

  test("readSseUntil يتجاوز الرسائلَ الأخرى ويعيد ذاتَ المعرّف", async () => {
    const stream = new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "x" })}\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 7, result: 1 })}\n\n`).body!
    expect(await readSseUntil(stream, 7)).toEqual({ jsonrpc: "2.0", id: 7, result: 1 })
    expect(await readSseUntil(new Response("data: not json\n\n").body!, 1)).toBeUndefined()
  })

  test("الحلقةُ على stdio: initialize يستبدل بمصافحتنا، tools/call يمرّ، وقبل التهيئة رفض", async () => {
    const r = fakeRemote()
    try {
      const lines = [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { q: "z" } } }),
        JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }),
        "not json",
      ]
      const out: string[] = []
      const options = remoteOptionsFromEnv("https://remote.test/mcp", { ABDO_CONNECTOR_ACCESS: "access-1" }, r.fetchImpl)
      expect(options.accessToken).toBe("access-1")
      const code = await serveRemoteMcp(options, (async function* () { for (const l of lines) yield l })(), (l) => out.push(l))
      expect(code).toBe(0)
      const replies = out.map((l) => JSON.parse(l))
      expect(replies[0]).toMatchObject({ id: 1, error: { code: -32002 } })
      expect(replies[1]).toMatchObject({ id: 2, result: { serverInfo: { name: "abdocode-remote", upstream: { name: "fake-remote" } } } })
      expect(replies[2]).toMatchObject({ id: 3, result: { content: [{ text: "found z" }] } })
      expect(replies[3]).toMatchObject({ id: 4, result: {} })
      expect(replies[4]).toMatchObject({ id: null, error: { code: -32700 } })
    } finally { r.stop() }
  })
})
