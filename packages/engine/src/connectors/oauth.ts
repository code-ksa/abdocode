/**
 * OAuth 2.1 للموصّلات — كما يصل كلود وكوديكس بخدمات المستخدم، وعلى جهازه وحده.
 *
 * الطريقُ الواحد: اكتشافُ خادم التفويض (RFC 8414 / RFC 9728) ⇦ تسجيلُ عميلٍ ديناميكيّ (RFC 7591) إن أتاحه الخادم وإلا
 * معرّفٌ وسرٌّ يضعهما المالك ⇦ PKCE S256 (RFC 7636) ⇦ فتحُ المتصفّح ⇦ استقبالُ الرمز على منفذٍ محلّيّ (loopback، RFC 8252)
 * ⇦ استبدالُه برموز ⇦ تجديدٌ بالـrefresh_token. لا سرَّ يمرّ في سطر أمرٍ ولا يُطبع؛ التخزينُ شأنُ الخزنة لا هذه الوحدة.
 *
 * ═══ إعلانُ الوجهات (حارسُ الخروج) ═══
 * الوجهاتُ التي تصلها هذه الوحدة يختارها المستخدم بضغطة «وصّل» على موصّلٍ مسمّى: خادمُ تفويض الخدمة نفسِها
 * (accounts.google.com / oauth2.googleapis.com، slack.com، mcp.linear.app، mcp.notion.com …). لا نداءَ قبل ضغطته، ولا نداءَ
 * إلى وجهةٍ غير مشتقّةٍ من عنوان الخدمة التي سمّاها. السببُ المكتوب: ربطُ حساب المستخدم بخدمته — بطلبه.
 *
 * الوحدةُ نقيّة عن الشبكة والقرص إلا بما يُحقن: `fetchImpl` للاختبار بخادمٍ زائف، و`open` لفتح المتصفّح.
 */
import { createHash, randomBytes } from "node:crypto"

export interface AuthServerMetadata {
  readonly issuer?: string
  readonly authorization_endpoint: string
  readonly token_endpoint: string
  readonly registration_endpoint?: string
  readonly revocation_endpoint?: string
  readonly scopes_supported?: readonly string[]
  readonly code_challenge_methods_supported?: readonly string[]
  readonly token_endpoint_auth_methods_supported?: readonly string[]
  /** موردُ MCP المحميّ كما أعلنه الخادم (RFC 8707 `resource`) — يُمرَّر في التفويض والاستبدال إن وُجد. */
  readonly resource?: string
}

export interface TokenSet {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly tokenType: string
  readonly scope?: string
  /** لحظةُ الانتهاء بالمللي ثانية منذ العصر — من `expires_in`؛ غيابُه = لا يُعرف فيُجدَّد عند 401. */
  readonly expiresAt?: number
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const json = async (response: Response): Promise<Record<string, unknown>> => {
  const text = await response.text()
  try { return JSON.parse(text) as Record<string, unknown> } catch { throw new Error(`ردٌّ ليس JSON (${response.status}): ${text.slice(0, 160)}`) }
}
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
/** https إلزاميّ — إلا loopback (127.0.0.1) حيث لا شبكةَ تُعبَر: للاختبارات ولخوادمٍ محلّية. */
export const secureUrl = (url: string): boolean => /^https:\/\//.test(url) || /^http:\/\/127\.0\.0\.1(?::\d+)?(?:\/|$)/.test(url)

/** يقبل صيغةَ RFC 8414 ويحفظ الحقولَ المعروفة وحدها. */
export function parseAuthServerMetadata(value: Record<string, unknown>, resource?: string): AuthServerMetadata {
  const authorization = str(value.authorization_endpoint), token = str(value.token_endpoint)
  if (authorization === undefined || token === undefined) throw new Error("بياناتُ خادم التفويض ناقصة: authorization_endpoint وtoken_endpoint مطلوبان")
  for (const url of [authorization, token]) if (!secureUrl(url)) throw new Error(`نقطةُ التفويض يجب أن تكون https: ${url.slice(0, 80)}`)
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined)
  return {
    ...(str(value.issuer) === undefined ? {} : { issuer: str(value.issuer) }),
    authorization_endpoint: authorization,
    token_endpoint: token,
    ...(str(value.registration_endpoint) === undefined ? {} : { registration_endpoint: str(value.registration_endpoint) }),
    ...(str(value.revocation_endpoint) === undefined ? {} : { revocation_endpoint: str(value.revocation_endpoint) }),
    ...(list(value.scopes_supported) === undefined ? {} : { scopes_supported: list(value.scopes_supported) }),
    ...(list(value.code_challenge_methods_supported) === undefined ? {} : { code_challenge_methods_supported: list(value.code_challenge_methods_supported) }),
    ...(list(value.token_endpoint_auth_methods_supported) === undefined ? {} : { token_endpoint_auth_methods_supported: list(value.token_endpoint_auth_methods_supported) }),
    ...(resource === undefined ? {} : { resource }),
  }
}

/**
 * اكتشافُ خادم التفويض لموردٍ (خادمُ MCP بعيد): أوّلاً بياناتُ المورد المحميّ (RFC 9728) على أصل المورد، ومنها
 * `authorization_servers[0]`؛ ثمّ بياناتُ الخادم (RFC 8414) على ذلك الأصل. الفشلُ يقال لا يُخمَّن.
 */
export async function discoverAuthServer(resourceUrl: string, fetchImpl: Fetch = fetch): Promise<AuthServerMetadata> {
  const resource = new URL(resourceUrl)
  if (!secureUrl(resourceUrl)) throw new Error("موردُ الموصّل يجب أن يكون https")
  const origin = resource.origin
  let authOrigin = origin
  let declaredResource: string | undefined
  try {
    const path = resource.pathname.replace(/\/$/, "")
    const candidates = [`${origin}/.well-known/oauth-protected-resource${path}`, `${origin}/.well-known/oauth-protected-resource`]
    for (const url of candidates) {
      const r = await fetchImpl(url, { headers: { accept: "application/json" } })
      if (!r.ok) continue
      const body = await json(r)
      const servers = Array.isArray(body.authorization_servers) ? body.authorization_servers.filter((x): x is string => typeof x === "string") : []
      if (servers.length > 0) { authOrigin = new URL(servers[0]!).origin; declaredResource = str(body.resource); break }
    }
  } catch { /* لا بياناتِ مورد — يُجرَّب أصلُ المورد نفسُه */ }
  const r = await fetchImpl(`${authOrigin}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" } })
  if (!r.ok) throw new Error(`لا بياناتِ خادمِ تفويضٍ على ${authOrigin} (${r.status})`)
  return parseAuthServerMetadata(await json(r), declaredResource ?? resourceUrl)
}

/** زوجُ PKCE بطريقة S256 — المتحقّقُ ٦٤ حرفاً عشوائيّاً. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

export interface RegisteredClient { readonly clientId: string; readonly clientSecret?: string }

/** تسجيلُ عميلٍ عامّ (بلا سرّ) بـPKCE على خادمٍ يعلن `registration_endpoint`. */
export async function registerClient(meta: AuthServerMetadata, options: { clientName: string; redirectUris: readonly string[]; scope?: string }, fetchImpl: Fetch = fetch): Promise<RegisteredClient> {
  if (meta.registration_endpoint === undefined) throw new Error("الخادم لا يتيح تسجيلَ عميلٍ ديناميكيّاً — يلزم معرّفُ عميلٍ وسرُّه من المالك")
  const r = await fetchImpl(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_name: options.clientName, redirect_uris: options.redirectUris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...(options.scope === undefined ? {} : { scope: options.scope }) }),
  })
  const body = await json(r)
  if (!r.ok) throw new Error(`رُفض تسجيلُ العميل (${r.status}): ${str(body.error_description) ?? str(body.error) ?? ""}`)
  const clientId = str(body.client_id)
  if (clientId === undefined) throw new Error("تسجيلُ العميل عاد بلا client_id")
  return { clientId, ...(str(body.client_secret) === undefined ? {} : { clientSecret: str(body.client_secret) }) }
}

export interface AuthorizeParams {
  readonly clientId: string
  readonly redirectUri: string
  readonly scope: string
  readonly state: string
  readonly challenge: string
  /** وسائطُ خاصّةٌ بالخدمة (جوجل: access_type=offline&prompt=consent؛ سلاك: user_scope). */
  readonly extra?: Readonly<Record<string, string>>
}

export function authorizationUrl(meta: AuthServerMetadata, p: AuthorizeParams): string {
  const url = new URL(meta.authorization_endpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", p.clientId)
  url.searchParams.set("redirect_uri", p.redirectUri)
  url.searchParams.set("scope", p.scope)
  url.searchParams.set("state", p.state)
  url.searchParams.set("code_challenge", p.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  if (meta.resource !== undefined) url.searchParams.set("resource", meta.resource)
  for (const [k, v] of Object.entries(p.extra ?? {})) url.searchParams.set(k, v)
  return url.toString()
}

const tokenSet = (body: Record<string, unknown>): TokenSet => {
  const accessToken = str(body.access_token)
  if (accessToken === undefined) throw new Error(`ردُّ الرموز بلا access_token: ${str(body.error_description) ?? str(body.error) ?? ""}`)
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in)
  return {
    accessToken,
    ...(str(body.refresh_token) === undefined ? {} : { refreshToken: str(body.refresh_token) }),
    tokenType: str(body.token_type) ?? "Bearer",
    ...(str(body.scope) === undefined ? {} : { scope: str(body.scope) }),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
  }
}

const tokenRequest = async (meta: AuthServerMetadata, form: Record<string, string>, client: RegisteredClient, fetchImpl: Fetch): Promise<TokenSet> => {
  const params = new URLSearchParams({ ...form, client_id: client.clientId })
  if (client.clientSecret !== undefined) params.set("client_secret", client.clientSecret)
  if (meta.resource !== undefined && form.grant_type !== undefined) params.set("resource", meta.resource)
  const r = await fetchImpl(meta.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: params.toString() })
  const body = await json(r)
  if (!r.ok) throw new Error(`رفض خادمُ الرموز (${r.status}): ${str(body.error_description) ?? str(body.error) ?? ""}`)
  return tokenSet(body)
}

export const exchangeCode = (meta: AuthServerMetadata, p: { code: string; redirectUri: string; verifier: string }, client: RegisteredClient, fetchImpl: Fetch = fetch): Promise<TokenSet> =>
  tokenRequest(meta, { grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier }, client, fetchImpl)

export const refreshTokens = (meta: AuthServerMetadata, refreshToken: string, client: RegisteredClient, fetchImpl: Fetch = fetch): Promise<TokenSet> =>
  tokenRequest(meta, { grant_type: "refresh_token", refresh_token: refreshToken }, client, fetchImpl)

/**
 * مستقبِلُ الرمز على loopback: يفتح منفذاً على 127.0.0.1 (ثابتاً إن سجّلته الخدمةُ هكذا، أو عشوائيّاً)، يقبل طلباً واحداً
 * على المسار المتّفق ويطابق `state`، ويعرض للمستخدم صفحةً صغيرةً ثمّ يغلق. لا يقبل غيرَ loopback.
 */
export class LoopbackReceiver {
  readonly #path: string
  readonly #timeoutMs: number
  #server: ReturnType<typeof Bun.serve> | undefined
  #resolve: ((v: { code: string } | { error: string }) => void) | undefined
  #expectedState = ""

  constructor(options: { path?: string; timeoutMs?: number } = {}) {
    this.#path = options.path ?? "/callback"
    this.#timeoutMs = options.timeoutMs ?? 5 * 60_000
  }

  start(port = 0): { port: number; redirectUri: string } {
    const receiver = this
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname !== receiver.#path) return new Response("not found", { status: 404 })
        const state = url.searchParams.get("state") ?? ""
        const error = url.searchParams.get("error")
        const code = url.searchParams.get("code")
        const page = (title: string, body: string) => new Response(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:32px;max-width:520px;margin:auto"><h2>${title}</h2><p>${body}</p></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } })
        if (receiver.#resolve === undefined) return page("انتهى", "لا طلبَ تفويضٍ مفتوحاً — ارجع إلى عبدو كود.")
        if (state !== receiver.#expectedState) return page("رُفض", "رمزُ الحالة لا يطابق طلبَ عبدو كود — أُهمل الردّ. أعد المحاولة من التطبيق.")
        const settle = receiver.#resolve; receiver.#resolve = undefined
        if (error !== null || code === null) { settle({ error: error ?? "no_code" }); return page("لم يكتمل الربط", `الخدمة أعادت: ${error ?? "لا رمز"}. ارجع إلى عبدو كود.`) }
        settle({ code })
        return page("تمّ الربط", "يمكنك إغلاق هذه النافذة والعودة إلى عبدو كود.")
      },
    })
    const bound = this.#server.port ?? port
    return { port: bound, redirectUri: `http://127.0.0.1:${bound}${this.#path}` }
  }

  waitForCode(expectedState: string): Promise<{ code: string } | { error: string }> {
    this.#expectedState = expectedState
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (this.#resolve !== undefined) { this.#resolve = undefined; resolve({ error: "timeout" }) } }, this.#timeoutMs)
      timer.unref?.()
      this.#resolve = (v) => { clearTimeout(timer); resolve(v) }
    })
  }

  stop(): void { this.#server?.stop(true); this.#server = undefined; this.#resolve?.({ error: "stopped" }); this.#resolve = undefined }
}

export interface AuthorizationFlow {
  readonly meta: AuthServerMetadata
  readonly client: RegisteredClient
  readonly scope: string
  readonly extra?: Readonly<Record<string, string>>
  /** منفذٌ ثابت إن كان مسجَّلاً عند الخدمة (سلاك)، وإلا عشوائيّ. */
  readonly port?: number
  readonly timeoutMs?: number
  /** يفتح الرابطَ في متصفّح المستخدم — القشرةُ تفعلها عبر open_external. */
  readonly open: (url: string) => void | Promise<void>
}

/** الرقصةُ كاملةً: منفذٌ ⇦ رابطٌ ⇦ متصفّح ⇦ رمزٌ ⇦ رموز. المتحقّقُ والحالةُ لا يغادران الذاكرة. */
export async function runAuthorization(flow: AuthorizationFlow, fetchImpl: Fetch = fetch): Promise<TokenSet> {
  const receiver = new LoopbackReceiver({ timeoutMs: flow.timeoutMs })
  const { redirectUri } = receiver.start(flow.port ?? 0)
  try {
    const { verifier, challenge } = pkcePair()
    const state = randomBytes(16).toString("base64url")
    const url = authorizationUrl(flow.meta, { clientId: flow.client.clientId, redirectUri, scope: flow.scope, state, challenge, ...(flow.extra === undefined ? {} : { extra: flow.extra }) })
    const waiting = receiver.waitForCode(state)
    await flow.open(url)
    const outcome = await waiting
    if ("error" in outcome) throw new Error(`لم يكتمل التفويض: ${outcome.error}`)
    return await exchangeCode(flow.meta, { code: outcome.code, redirectUri, verifier }, flow.client, fetchImpl)
  } finally {
    receiver.stop()
  }
}

/** هل انتهى الرمز (بهامش ٦٠ ثانية)؟ غيابُ الأجل = لا يُعرف = لا يُعدّ منتهياً هنا (يُجدَّد عند 401). */
export const tokenExpired = (t: TokenSet, now = Date.now()): boolean => t.expiresAt !== undefined && t.expiresAt - 60_000 <= now
