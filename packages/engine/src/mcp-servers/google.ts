/**
 * `mcp-google` — Gmail وتقويم جوجل وDrive كخادم MCP يشحن داخل ثنائيّنا (جوجل لا تنشر خادمَ MCP بعيداً لهذه الخدمات).
 *
 * الاعتمادُ من البيئة (منحُ الخزنة): `ABDO_CONNECTOR_ACCESS`، `ABDO_CONNECTOR_REFRESH`، `ABDO_CONNECTOR_CLIENT_ID`،
 * `ABDO_CONNECTOR_CLIENT_SECRET`، و`ABDO_CONNECTOR_TOKEN_URL` (oauth2.googleapis.com/token). لا سرَّ في سطر الأمر.
 *
 * ═══ إعلانُ الوجهات ═══ gmail.googleapis.com وwww.googleapis.com (calendar/drive) وoauth2.googleapis.com — كلُّها بعد أن يضغط
 * المستخدم «وصّل» على موصّل جوجل ويأذن بالنطاقات. السببُ المكتوب: قراءةُ بريده وتقويمه وملفّاته وإنشاءُ مسودّاتٍ وأحداثٍ بطلبه.
 *
 * الأفعالُ الكاتبة (مسودّة، إرسالُ مسودّة، إنشاءُ حدث) تمرّ ببوّابة الموافقة في المحرّك كأيّ أداةِ MCP؛ الحذفُ غيرُ موجود.
 */
import { refreshTokens, type Fetch } from "../connectors/oauth"
import { CONNECTOR_ENV } from "./remote"

export const GOOGLE_MCP_PROTOCOL = "2025-11-25"
export const GOOGLE_SCOPES = Object.freeze(["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/drive.readonly"])
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const MAX_TEXT = 8_000

type RpcId = string | number | null
interface RpcRequest { jsonrpc?: string; id?: RpcId; method?: string; params?: Record<string, unknown> }

const str = { type: "string" as const }
export const GOOGLE_TOOLS = Object.freeze([
  { name: "gmail_search", description: "بحثٌ في بريد Gmail بصيغة بحث Gmail (from:, subject:, newer_than:7d…) — يعيد حتى ٢٠ رسالة: المعرّف والمرسِل والعنوان والتاريخ والمقتطف", inputSchema: { type: "object", properties: { query: { ...str, maxLength: 400 }, max: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"], additionalProperties: false } },
  { name: "gmail_read", description: "قراءةُ رسالةٍ بمعرّفها: الرؤوسُ والنصُّ (حتى ٨٠٠٠ حرف)", inputSchema: { type: "object", properties: { id: { ...str, maxLength: 64 } }, required: ["id"], additionalProperties: false } },
  { name: "gmail_draft", description: "إنشاءُ مسودّة (لا إرسال) إلى مستلمٍ بعنوانٍ ونصّ — تُراجع في Gmail قبل أن تُرسل", inputSchema: { type: "object", properties: { to: { ...str, maxLength: 300 }, subject: { ...str, maxLength: 300 }, body: { ...str, maxLength: 20000 } }, required: ["to", "subject", "body"], additionalProperties: false } },
  { name: "gmail_send_draft", description: "إرسالُ مسودّةٍ بمعرّفها — فعلٌ لا يُرجَع، يمرّ بموافقة المستخدم", inputSchema: { type: "object", properties: { draftId: { ...str, maxLength: 64 } }, required: ["draftId"], additionalProperties: false } },
  { name: "calendar_events", description: "أحداثُ التقويم الرئيسيّ بين تاريخين (ISO 8601) — الافتراض: الأيّام السبعة القادمة، حتى ٢٥ حدثاً", inputSchema: { type: "object", properties: { timeMin: { ...str, maxLength: 40 }, timeMax: { ...str, maxLength: 40 }, max: { type: "integer", minimum: 1, maximum: 25 } }, additionalProperties: false } },
  { name: "calendar_create", description: "إنشاءُ حدثٍ في التقويم الرئيسيّ: عنوانٌ وبدايةٌ ونهاية (ISO 8601) ووصفٌ ومدعوّون اختياريّون", inputSchema: { type: "object", properties: { summary: { ...str, maxLength: 200 }, start: { ...str, maxLength: 40 }, end: { ...str, maxLength: 40 }, description: { ...str, maxLength: 2000 }, attendees: { type: "array", items: { ...str, maxLength: 200 }, maxItems: 20 } }, required: ["summary", "start", "end"], additionalProperties: false } },
  { name: "drive_search", description: "بحثٌ في Google Drive بالاسم أو بصيغة استعلام Drive — يعيد حتى ٢٠ ملفّاً: المعرّف والاسم والنوع وآخر تعديل والرابط", inputSchema: { type: "object", properties: { query: { ...str, maxLength: 300 }, max: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"], additionalProperties: false } },
  { name: "drive_read", description: "قراءةُ نصّ ملفٍّ بمعرّفه: مستندات جوجل نصّاً، الجداول CSV، والملفّاتُ النصّية كما هي (حتى ٨٠٠٠ حرف)", inputSchema: { type: "object", properties: { id: { ...str, maxLength: 128 } }, required: ["id"], additionalProperties: false } },
])

export interface GoogleOptions {
  readonly accessToken?: string
  readonly refreshToken?: string
  readonly clientId?: string
  readonly clientSecret?: string
  readonly tokenUrl?: string
  readonly fetchImpl?: Fetch
  /** أصولُ الواجهات — تُبدَّل في الاختبار بخادمٍ زائف. */
  readonly gmailBase?: string
  readonly apisBase?: string
}

const decodeBody = (data: string): string => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
const header = (headers: { name: string; value: string }[] | undefined, name: string): string => headers?.find((h) => h.name.toLowerCase() === name)?.value ?? ""

/** يستخرج نصَّ text/plain من شجرة أجزاء الرسالة، وإلا HTML مجرَّداً من الوسوم. */
export function extractText(payload: { mimeType?: string; body?: { data?: string }; parts?: unknown[] } | undefined): string {
  if (payload === undefined) return ""
  const plain: string[] = [], html: string[] = []
  const walk = (p: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }) => {
    if (p.body?.data && p.mimeType === "text/plain") plain.push(decodeBody(p.body.data))
    else if (p.body?.data && p.mimeType === "text/html") html.push(decodeBody(p.body.data))
    for (const part of p.parts ?? []) walk(part as typeof p)
  }
  walk(payload)
  if (plain.length > 0) return plain.join("\n")
  return html.join("\n").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
}

export class GoogleConnector {
  #access: string | undefined
  #refresh: string | undefined
  readonly #clientId: string | undefined
  readonly #clientSecret: string | undefined
  readonly #tokenUrl: string
  readonly #fetch: Fetch
  readonly #gmail: string
  readonly #apis: string

  constructor(options: GoogleOptions) {
    this.#access = options.accessToken
    this.#refresh = options.refreshToken
    this.#clientId = options.clientId
    this.#clientSecret = options.clientSecret
    this.#tokenUrl = options.tokenUrl ?? GOOGLE_TOKEN_URL
    this.#fetch = options.fetchImpl ?? fetch
    this.#gmail = options.gmailBase ?? "https://gmail.googleapis.com/gmail/v1/users/me"
    this.#apis = options.apisBase ?? "https://www.googleapis.com"
  }

  async #renew(): Promise<boolean> {
    if (this.#refresh === undefined || this.#clientId === undefined) return false
    try {
      const t = await refreshTokens({ authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth", token_endpoint: this.#tokenUrl }, this.#refresh, { clientId: this.#clientId, ...(this.#clientSecret === undefined ? {} : { clientSecret: this.#clientSecret }) }, this.#fetch)
      this.#access = t.accessToken
      return true
    } catch { return false }
  }

  async #api(url: string, init: RequestInit = {}, raw = false): Promise<unknown> {
    const send = () => this.#fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), authorization: `Bearer ${this.#access ?? ""}`, accept: raw ? "*/*" : "application/json" } })
    let r = await send()
    if (r.status === 401 && await this.#renew()) r = await send()
    if (r.status === 401) throw new Error("جوجل رفضت الرمز (401) — أعد الربط من الإعدادات ← الموصّلات")
    if (!r.ok) throw new Error(`جوجل ردّت ${r.status}: ${(await r.text()).slice(0, 200)}`)
    return raw ? await r.text() : await r.json()
  }

  async run(name: string, a: Record<string, unknown>): Promise<string> {
    const n = (v: unknown, d: number, cap: number) => Math.min(cap, Math.max(1, Number(v) || d))
    switch (name) {
      case "gmail_search": {
        const list = await this.#api(`${this.#gmail}/messages?q=${encodeURIComponent(String(a.query ?? ""))}&maxResults=${n(a.max, 10, 20)}`) as { messages?: { id: string }[] }
        const ids = (list.messages ?? []).map((m) => m.id)
        if (ids.length === 0) return "لا رسائلَ تطابق البحث."
        const rows: string[] = []
        for (const id of ids) {
          const m = await this.#api(`${this.#gmail}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`) as { id: string; snippet?: string; payload?: { headers?: { name: string; value: string }[] } }
          rows.push(`[${m.id}] ${header(m.payload?.headers, "date")} · من: ${header(m.payload?.headers, "from")} · ${header(m.payload?.headers, "subject")}\n    ${(m.snippet ?? "").slice(0, 160)}`)
        }
        return rows.join("\n")
      }
      case "gmail_read": {
        const m = await this.#api(`${this.#gmail}/messages/${encodeURIComponent(String(a.id))}?format=full`) as { id: string; payload?: { mimeType?: string; headers?: { name: string; value: string }[]; body?: { data?: string }; parts?: unknown[] } }
        const h = m.payload?.headers
        return `من: ${header(h, "from")}\nإلى: ${header(h, "to")}\nالتاريخ: ${header(h, "date")}\nالعنوان: ${header(h, "subject")}\n\n${extractText(m.payload).slice(0, MAX_TEXT)}`
      }
      case "gmail_draft": {
        const raw = Buffer.from(`To: ${String(a.to)}\r\nSubject: ${String(a.subject)}\r\nContent-Type: text/plain; charset=utf-8\r\nMIME-Version: 1.0\r\n\r\n${String(a.body)}`, "utf8").toString("base64url")
        const d = await this.#api(`${this.#gmail}/drafts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: { raw } }) }) as { id: string }
        return `أُنشئت المسودّة ${d.id} إلى ${String(a.to)} — راجعها في Gmail، أو أرسلها بـgmail_send_draft بعد موافقة المستخدم.`
      }
      case "gmail_send_draft": {
        const s = await this.#api(`${this.#gmail}/drafts/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: String(a.draftId) }) }) as { id: string }
        return `أُرسلت المسودّة — الرسالة ${s.id}.`
      }
      case "calendar_events": {
        const timeMin = typeof a.timeMin === "string" ? a.timeMin : new Date().toISOString()
        const timeMax = typeof a.timeMax === "string" ? a.timeMax : new Date(Date.now() + 7 * 86_400_000).toISOString()
        const e = await this.#api(`${this.#apis}/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=${n(a.max, 25, 25)}&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`) as { items?: { id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; location?: string }[] }
        if (!e.items?.length) return "لا أحداثَ في المدى."
        return e.items.map((i) => `[${i.id}] ${i.start?.dateTime ?? i.start?.date ?? ""} ⇦ ${i.end?.dateTime ?? i.end?.date ?? ""} · ${i.summary ?? "(بلا عنوان)"}${i.location ? ` · ${i.location}` : ""}`).join("\n")
      }
      case "calendar_create": {
        const attendees = Array.isArray(a.attendees) ? (a.attendees as unknown[]).filter((x): x is string => typeof x === "string").map((email) => ({ email })) : []
        const created = await this.#api(`${this.#apis}/calendar/v3/calendars/primary/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ summary: String(a.summary), start: { dateTime: String(a.start) }, end: { dateTime: String(a.end) }, ...(typeof a.description === "string" ? { description: a.description } : {}), ...(attendees.length ? { attendees } : {}) }) }) as { id: string; htmlLink?: string }
        return `أُنشئ الحدث ${created.id}${created.htmlLink ? ` — ${created.htmlLink}` : ""}.`
      }
      case "drive_search": {
        const query = String(a.query ?? "")
        const q = /[=<>]|contains|mimeType/.test(query) ? query : `name contains '${query.replace(/'/g, "\\'")}'`
        const f = await this.#api(`${this.#apis}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${n(a.max, 10, 20)}&fields=${encodeURIComponent("files(id,name,mimeType,modifiedTime,webViewLink)")}`) as { files?: { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string }[] }
        if (!f.files?.length) return "لا ملفّاتَ تطابق البحث."
        return f.files.map((x) => `[${x.id}] ${x.name} · ${x.mimeType} · ${x.modifiedTime ?? ""}${x.webViewLink ? ` · ${x.webViewLink}` : ""}`).join("\n")
      }
      case "drive_read": {
        const id = encodeURIComponent(String(a.id))
        const meta = await this.#api(`${this.#apis}/drive/v3/files/${id}?fields=id,name,mimeType`) as { name: string; mimeType: string }
        const exportAs = meta.mimeType === "application/vnd.google-apps.document" ? "text/plain" : meta.mimeType === "application/vnd.google-apps.spreadsheet" ? "text/csv" : meta.mimeType === "application/vnd.google-apps.presentation" ? "text/plain" : undefined
        const text = exportAs !== undefined
          ? await this.#api(`${this.#apis}/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportAs)}`, {}, true) as string
          : /^text\/|json|xml|csv/.test(meta.mimeType) ? await this.#api(`${this.#apis}/drive/v3/files/${id}?alt=media`, {}, true) as string : undefined
        if (text === undefined) return `الملفّ ${meta.name} من نوع ${meta.mimeType} ليس نصّاً — افتحه في Drive.`
        return `${meta.name} (${meta.mimeType}):\n${text.slice(0, MAX_TEXT)}`
      }
      default: return `أداةُ جوجل مجهولة: ${name}`
    }
  }
}

export function googleOptionsFromEnv(env: Record<string, string | undefined> = process.env): GoogleOptions {
  const pick = (name: string) => { const v = env[name]; return v === undefined || v.length === 0 ? undefined : v }
  return {
    ...(pick(CONNECTOR_ENV.access) === undefined ? {} : { accessToken: pick(CONNECTOR_ENV.access) }),
    ...(pick(CONNECTOR_ENV.refresh) === undefined ? {} : { refreshToken: pick(CONNECTOR_ENV.refresh) }),
    ...(pick(CONNECTOR_ENV.clientId) === undefined ? {} : { clientId: pick(CONNECTOR_ENV.clientId) }),
    ...(pick(CONNECTOR_ENV.clientSecret) === undefined ? {} : { clientSecret: pick(CONNECTOR_ENV.clientSecret) }),
    ...(pick(CONNECTOR_ENV.tokenUrl) === undefined ? {} : { tokenUrl: pick(CONNECTOR_ENV.tokenUrl) }),
  }
}

/** حلقةُ MCP على stdio — كإخوتها. */
export async function serveGoogleMcp(options: GoogleOptions, input: AsyncIterable<string> = console, output: (line: string) => void = (line) => console.log(line)): Promise<number> {
  const google = new GoogleConnector(options)
  const emit = (value: object) => output(JSON.stringify(value))
  const result = (id: RpcId, value: unknown) => emit({ jsonrpc: "2.0", id, result: value })
  const failure = (id: RpcId, code: number, message: string) => emit({ jsonrpc: "2.0", id, error: { code, message } })
  for await (const line of input) {
    if (line.trim().length === 0) continue
    let request: RpcRequest
    try { request = JSON.parse(line) as RpcRequest } catch { failure(null, -32700, "Parse error"); continue }
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") { if (request.id !== undefined) failure(request.id, -32600, "Invalid Request"); continue }
    if (request.method === "notifications/initialized") continue
    const id = request.id ?? null
    if (request.method === "initialize") { result(id, { protocolVersion: (request.params?.protocolVersion as string | undefined) ?? GOOGLE_MCP_PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "abdocode-google", version: "1.0.0" } }); continue }
    if (request.method === "tools/list") { result(id, { tools: GOOGLE_TOOLS }); continue }
    if (request.method === "ping") { result(id, {}); continue }
    if (request.method !== "tools/call") { failure(id, -32601, "Method not found"); continue }
    const name = request.params?.name
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>
    if (typeof name !== "string" || !GOOGLE_TOOLS.some((t) => t.name === name)) { failure(id, -32602, "Invalid tool arguments"); continue }
    try { result(id, { content: [{ type: "text", text: await google.run(name, args) }] }) }
    catch (cause) { result(id, { isError: true, content: [{ type: "text", text: String(cause instanceof Error ? cause.message : cause) }] }) }
  }
  return 0
}
