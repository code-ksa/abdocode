/**
 * `mcp-remote <url>` — جسرٌ من stdio (عميلُ MCP عندنا) إلى خادم MCP بعيدٍ على HTTP القابل للبثّ (Streamable HTTP، مواصفة MCP
 * 2025-03-26+): هكذا «تُوصَل الموصّلاتُ في الجلسة» كما في كلود — Slack وLinear وNotion وAsana وAtlassian وFigma وIntercom…
 *
 * الاعتمادُ من البيئة لا من سطر الأمر (قاعدةُ الخزنة): `ABDO_CONNECTOR_ACCESS` (رمزُ الوصول)، وللتجديد عند 401:
 * `ABDO_CONNECTOR_REFRESH` و`ABDO_CONNECTOR_CLIENT_ID` (و`ABDO_CONNECTOR_CLIENT_SECRET` إن كان للعميل سرّ) و`ABDO_CONNECTOR_TOKEN_URL`.
 * الرمزُ المجدَّد يبقى في ذاكرة العمليّة؛ الخزنةُ يحدّثها المحرّكُ لا هذا الطفل.
 *
 * ═══ إعلانُ الوجهة ═══ الوجهةُ الوحيدة هي `<url>` الذي اختاره المستخدم من قائمة الموصّلات وأذن به بالتوصيل؛ لا نداءَ سواه.
 *
 * الردودُ: JSON مباشر أو SSE (`text/event-stream`) يُقرأ حتى تصل الرسالةُ ذاتُ المعرّف. رأسُ الجلسة `Mcp-Session-Id` يُعاد كما جاء.
 */
import { refreshTokens, secureUrl, type Fetch, type TokenSet } from "../connectors/oauth"

export const REMOTE_MCP_PROTOCOL = "2025-11-25"
export const CONNECTOR_ENV = Object.freeze({ access: "ABDO_CONNECTOR_ACCESS", refresh: "ABDO_CONNECTOR_REFRESH", clientId: "ABDO_CONNECTOR_CLIENT_ID", clientSecret: "ABDO_CONNECTOR_CLIENT_SECRET", tokenUrl: "ABDO_CONNECTOR_TOKEN_URL" })

type RpcId = string | number | null
interface RpcMessage { jsonrpc?: string; id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }

export interface RemoteOptions {
  readonly url: string
  readonly accessToken?: string
  readonly refreshToken?: string
  readonly clientId?: string
  readonly clientSecret?: string
  readonly tokenUrl?: string
  readonly fetchImpl?: Fetch
  readonly onTokens?: (tokens: TokenSet) => void
}

/** يقرأ ردَّ SSE حتى أوّل رسالةٍ تحمل المعرّف المطلوب (أو أوّل رسالةٍ إن لم يُطلب معرّف). */
export async function readSseUntil(body: ReadableStream<Uint8Array>, wantedId: RpcId | undefined): Promise<RpcMessage | undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let found: RpcMessage | undefined
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let cut: number
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, cut); buffer = buffer.slice(cut + 2)
        const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")
        if (data.length === 0) continue
        let message: RpcMessage
        try { message = JSON.parse(data) as RpcMessage } catch { continue }
        if (wantedId === undefined || message.id === wantedId) { found = message; break }
      }
      if (found !== undefined) break
    }
  } finally { try { await reader.cancel() } catch { /* أُغلق */ } }
  return found
}

export class RemoteMcp {
  readonly #url: string
  readonly #fetch: Fetch
  #access: string | undefined
  #refresh: string | undefined
  readonly #clientId: string | undefined
  readonly #clientSecret: string | undefined
  readonly #tokenUrl: string | undefined
  readonly #onTokens: ((t: TokenSet) => void) | undefined
  #session: string | undefined
  #seq = 0

  constructor(options: RemoteOptions) {
    if (!secureUrl(options.url)) throw new Error("mcp-remote: الرابط يجب أن يكون https")
    this.#url = options.url
    this.#fetch = options.fetchImpl ?? fetch
    this.#access = options.accessToken
    this.#refresh = options.refreshToken
    this.#clientId = options.clientId
    this.#clientSecret = options.clientSecret
    this.#tokenUrl = options.tokenUrl
    this.#onTokens = options.onTokens
  }

  get sessionId(): string | undefined { return this.#session }

  async #post(message: RpcMessage, expectReply: boolean): Promise<RpcMessage | undefined> {
    const send = async (): Promise<Response> => this.#fetch(this.#url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": REMOTE_MCP_PROTOCOL,
        ...(this.#access === undefined ? {} : { authorization: `Bearer ${this.#access}` }),
        ...(this.#session === undefined ? {} : { "mcp-session-id": this.#session }),
      },
      body: JSON.stringify(message),
    })
    let response = await send()
    if (response.status === 401 && await this.#renew()) response = await send()
    if (response.status === 401) throw new Error("الخدمة رفضت الرمز (401) — أعد الربط من الإعدادات ← الموصّلات")
    const session = response.headers.get("mcp-session-id")
    if (session !== null && session.length > 0) this.#session = session
    if (!expectReply) { try { await response.body?.cancel() } catch { /* لا جسد */ } return undefined }
    if (!response.ok) throw new Error(`الخدمة ردّت ${response.status}: ${(await response.text()).slice(0, 200)}`)
    const type = response.headers.get("content-type") ?? ""
    if (type.includes("text/event-stream")) {
      if (response.body === null) throw new Error("ردُّ SSE بلا جسد")
      const found = await readSseUntil(response.body, message.id ?? undefined)
      if (found === undefined) throw new Error("انتهى بثُّ SSE بلا ردٍّ للطلب")
      return found
    }
    const text = await response.text()
    if (text.trim().length === 0) return undefined
    return JSON.parse(text) as RpcMessage
  }

  async #renew(): Promise<boolean> {
    if (this.#refresh === undefined || this.#clientId === undefined || this.#tokenUrl === undefined) return false
    try {
      const tokens = await refreshTokens({ authorization_endpoint: "https://unused.invalid/", token_endpoint: this.#tokenUrl }, this.#refresh, { clientId: this.#clientId, ...(this.#clientSecret === undefined ? {} : { clientSecret: this.#clientSecret }) }, this.#fetch)
      this.#access = tokens.accessToken
      if (tokens.refreshToken !== undefined) this.#refresh = tokens.refreshToken
      this.#onTokens?.(tokens)
      return true
    } catch { return false }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.#seq
    const reply = await this.#post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, true)
    if (reply === undefined) throw new Error(`لا ردَّ على ${method}`)
    if (reply.error !== undefined) throw new Error(`${method}: ${reply.error.message} (${reply.error.code})`)
    return reply.result
  }

  async notify(method: string, params?: unknown): Promise<void> { await this.#post({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }, false) }

  /** المصافحة: initialize ثمّ notifications/initialized. يعود بمعلومات الخادم. */
  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", { protocolVersion: REMOTE_MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "abdocode-remote", version: "1.0.0" } })
    await this.notify("notifications/initialized")
    return result
  }
}

export function remoteOptionsFromEnv(url: string, env: Record<string, string | undefined> = process.env, fetchImpl?: Fetch): RemoteOptions {
  const pick = (name: string) => { const v = env[name]; return v === undefined || v.length === 0 ? undefined : v }
  return {
    url,
    ...(pick(CONNECTOR_ENV.access) === undefined ? {} : { accessToken: pick(CONNECTOR_ENV.access) }),
    ...(pick(CONNECTOR_ENV.refresh) === undefined ? {} : { refreshToken: pick(CONNECTOR_ENV.refresh) }),
    ...(pick(CONNECTOR_ENV.clientId) === undefined ? {} : { clientId: pick(CONNECTOR_ENV.clientId) }),
    ...(pick(CONNECTOR_ENV.clientSecret) === undefined ? {} : { clientSecret: pick(CONNECTOR_ENV.clientSecret) }),
    ...(pick(CONNECTOR_ENV.tokenUrl) === undefined ? {} : { tokenUrl: pick(CONNECTOR_ENV.tokenUrl) }),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  }
}

/**
 * حلقةُ stdio: كلُّ طلبٍ من عميلنا يُمرَّر إلى الخادم البعيد كما هو (initialize يُستبدل بمصافحتنا؛ tools/list وtools/call وping
 * تمرّ)، والردُّ يُعاد بمعرّف الطلب نفسِه. أخطاءُ الشبكة تعود isError نصّاً لا انهياراً.
 */
export async function serveRemoteMcp(options: RemoteOptions, input: AsyncIterable<string> = console, output: (line: string) => void = (line) => console.log(line)): Promise<number> {
  const remote = new RemoteMcp(options)
  const emit = (value: object) => output(JSON.stringify(value))
  const result = (id: RpcId, value: unknown) => emit({ jsonrpc: "2.0", id, result: value })
  const failure = (id: RpcId, code: number, message: string) => emit({ jsonrpc: "2.0", id, error: { code, message } })
  let initialized = false
  for await (const line of input) {
    if (line.trim().length === 0) continue
    let request: RpcMessage
    try { request = JSON.parse(line) as RpcMessage } catch { failure(null, -32700, "Parse error"); continue }
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") { if (request.id !== undefined) failure(request.id, -32600, "Invalid Request"); continue }
    if (request.method === "notifications/initialized") continue
    const id = request.id ?? null
    try {
      if (request.method === "initialize") {
        const info = await remote.initialize() as Record<string, unknown>
        initialized = true
        result(id, { protocolVersion: (request.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? REMOTE_MCP_PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "abdocode-remote", version: "1.0.0", upstream: info.serverInfo ?? null } })
        continue
      }
      if (!initialized) { failure(id, -32002, "Server not initialized"); continue }
      if (request.method === "ping") { result(id, {}); continue }
      if (request.method === "tools/list" || request.method === "tools/call") { result(id, await remote.request(request.method, request.params)); continue }
      failure(id, -32601, "Method not found")
    } catch (cause) {
      if (request.method === "tools/call") result(id, { isError: true, content: [{ type: "text", text: String(cause instanceof Error ? cause.message : cause) }] })
      else failure(id, -32000, String(cause instanceof Error ? cause.message : cause).slice(0, 300))
    }
  }
  return 0
}
