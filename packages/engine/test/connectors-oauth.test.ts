import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { authorizationUrl, discoverAuthServer, exchangeCode, LoopbackReceiver, parseAuthServerMetadata, pkcePair, refreshTokens, registerClient, runAuthorization, tokenExpired } from "../src/connectors/oauth"

// OAuth للموصّلات على خادمِ تفويضٍ زائف كامل: اكتشافٌ (RFC 9728 ⇦ 8414)، تسجيلٌ ديناميكيّ، PKCE يُفحص فعلاً (المتحقّقُ
// الخاطئ يُرفض)، استقبالُ الرمز على loopback بمطابقة state (الخاطئ يُهمل)، استبدالٌ وتجديد. لا شبكةَ خارجية.

const b64url = (s: string) => createHash("sha256").update(s).digest("base64url")

function fakeAuthServer() {
  const issued: { challenge: string; code: string }[] = []
  const registered: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const origin = `https://as.test`
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: "https://as.test/mcp", authorization_servers: [origin] })
      if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] })
      if (url.pathname === "/register" && request.method === "POST") { const body = await request.json() as Record<string, unknown>; registered.push(body); return Response.json({ client_id: "dyn-client-1", redirect_uris: body.redirect_uris }, { status: 201 }) }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text())
        if (form.get("client_id") !== "dyn-client-1" && form.get("client_id") !== "owner-client") return Response.json({ error: "invalid_client" }, { status: 401 })
        if (form.get("grant_type") === "refresh_token") return form.get("refresh_token") === "refresh-1" ? Response.json({ access_token: "access-2", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-2" }) : Response.json({ error: "invalid_grant" }, { status: 400 })
        const record = issued.find((i) => i.code === form.get("code"))
        if (!record) return Response.json({ error: "invalid_grant", error_description: "unknown code" }, { status: 400 })
        if (b64url(form.get("code_verifier") ?? "") !== record.challenge) return Response.json({ error: "invalid_grant", error_description: "pkce mismatch" }, { status: 400 })
        if (form.get("resource") !== "https://as.test/mcp") return Response.json({ error: "invalid_target" }, { status: 400 })
        return Response.json({ access_token: "access-1", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1", scope: form.get("scope") ?? "read" })
      }
      return new Response("nf", { status: 404 })
    },
  })
  // fetchImpl يعيد توجيه https://as.test إلى الخادم الزائف — الوحدةُ تطالب بـhttps فيُختبر بعنوانٍ https حقيقيّ الشكل.
  const fetchImpl = (input: string, init?: RequestInit) => fetch(input.replace("https://as.test", `http://127.0.0.1:${server.port}`), init)
  /** «المتصفّح»: يقرأ رابطَ التفويض، يصدر رمزاً مربوطاً بالتحدّي، ويعيد التوجيه إلى loopback بالحالة نفسِها (أو بحالةٍ مزوَّرة). */
  const browser = (tamperState?: string) => async (url: string) => {
    const u = new URL(url)
    const code = `code-${issued.length + 1}`
    issued.push({ challenge: u.searchParams.get("code_challenge") ?? "", code })
    const redirect = new URL(u.searchParams.get("redirect_uri")!)
    redirect.searchParams.set("code", code)
    redirect.searchParams.set("state", tamperState ?? (u.searchParams.get("state") ?? ""))
    if (tamperState !== undefined) { await fetch(redirect.toString()); redirect.searchParams.set("state", u.searchParams.get("state") ?? "") }
    await fetch(redirect.toString())
  }
  return { server, fetchImpl, browser, issued, registered, stop: () => server.stop(true) }
}

describe("OAuth للموصّلات — الرقصةُ كاملةً على خادمٍ زائف", () => {
  test("الاكتشاف: بياناتُ المورد المحميّ تقود إلى خادم التفويض، والمورد يُحمل", async () => {
    const as = fakeAuthServer()
    try {
      const meta = await discoverAuthServer("https://as.test/mcp", as.fetchImpl)
      expect(meta.authorization_endpoint).toBe("https://as.test/authorize")
      expect(meta.registration_endpoint).toBe("https://as.test/register")
      expect(meta.resource).toBe("https://as.test/mcp")
      await expect(discoverAuthServer("http://as.test/mcp", as.fetchImpl)).rejects.toThrow("https")
    } finally { as.stop() }
  })

  test("التسجيلُ الديناميكيّ ثمّ التفويضُ بـPKCE ثمّ الاستبدال ثمّ التجديد — والمتحقّقُ الخاطئ يُرفض", async () => {
    const as = fakeAuthServer()
    try {
      const meta = await discoverAuthServer("https://as.test/mcp", as.fetchImpl)
      const client = await registerClient(meta, { clientName: "Abdo Code", redirectUris: ["http://127.0.0.1:1/callback"] }, as.fetchImpl)
      expect(client.clientId).toBe("dyn-client-1")
      expect(as.registered[0]!.token_endpoint_auth_method).toBe("none")
      let opened = ""
      const tokens = await runAuthorization({ meta, client, scope: "read write", open: async (url) => { opened = url; await as.browser()(url) } }, as.fetchImpl)
      expect(tokens.accessToken).toBe("access-1")
      expect(tokens.refreshToken).toBe("refresh-1")
      expect(tokens.expiresAt! > Date.now()).toBe(true)
      expect(tokenExpired(tokens)).toBe(false)
      expect(tokenExpired({ ...tokens, expiresAt: Date.now() - 1 })).toBe(true)
      const u = new URL(opened)
      expect(u.searchParams.get("code_challenge_method")).toBe("S256")
      expect(u.searchParams.get("resource")).toBe("https://as.test/mcp")
      expect(u.searchParams.get("redirect_uri")!.startsWith("http://127.0.0.1:")).toBe(true)
      // التجديد
      const renewed = await refreshTokens(meta, "refresh-1", client, as.fetchImpl)
      expect(renewed.accessToken).toBe("access-2")
      await expect(refreshTokens(meta, "stale", client, as.fetchImpl)).rejects.toThrow("invalid_grant")
      // المتحقّقُ الخاطئ: الخادمُ الزائف يفحص PKCE فعلاً
      const { challenge } = pkcePair()
      as.issued.push({ challenge, code: "code-x" })
      await expect(exchangeCode(meta, { code: "code-x", redirectUri: "http://127.0.0.1:1/callback", verifier: "wrong" }, client, as.fetchImpl)).rejects.toThrow("pkce mismatch")
    } finally { as.stop() }
  })

  test("state مزوَّرة تُهمل ولا تُنهي الانتظار؛ الصحيحةُ تُكمله", async () => {
    const as = fakeAuthServer()
    try {
      const meta = await discoverAuthServer("https://as.test/mcp", as.fetchImpl)
      const tokens = await runAuthorization({ meta, client: { clientId: "owner-client" }, scope: "read", open: as.browser("forged-state") }, as.fetchImpl)
      expect(tokens.accessToken).toBe("access-1")
    } finally { as.stop() }
  })

  test("المستقبِل: مسارٌ آخر 404، ولا طلبَ مفتوحاً ⇒ صفحةُ «انتهى»، والمهلةُ تعيد timeout", async () => {
    const receiver = new LoopbackReceiver({ timeoutMs: 150 })
    const { port, redirectUri } = receiver.start(0)
    try {
      expect(redirectUri).toBe(`http://127.0.0.1:${port}/callback`)
      expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404)
      expect(await (await fetch(`http://127.0.0.1:${port}/callback?code=x&state=y`)).text()).toContain("لا طلبَ")
      expect(await receiver.waitForCode("s")).toEqual({ error: "timeout" })
    } finally { receiver.stop() }
  })

  test("بياناتُ خادمٍ بلا https أو ناقصة تُرفض؛ التسجيلُ بلا نقطة تسجيلٍ يقول ما يلزم المالك", async () => {
    expect(() => parseAuthServerMetadata({ authorization_endpoint: "http://x/a", token_endpoint: "https://x/t" })).toThrow("https")
    expect(() => parseAuthServerMetadata({ token_endpoint: "https://x/t" })).toThrow("ناقصة")
    const meta = parseAuthServerMetadata({ authorization_endpoint: "https://x/a", token_endpoint: "https://x/t" })
    await expect(registerClient(meta, { clientName: "a", redirectUris: [] })).rejects.toThrow("معرّفُ عميلٍ")
    expect(authorizationUrl(meta, { clientId: "c", redirectUri: "http://127.0.0.1:9/callback", scope: "s", state: "st", challenge: "ch", extra: { access_type: "offline" } })).toContain("access_type=offline")
  })
})
