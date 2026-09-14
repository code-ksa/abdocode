/**
 * عميلُ MCP — السلكُ الثاني للقدرة نفسها، لا قدرةٌ ثانية.
 *
 * المستودعُ يحمل **نصفَي المسألة** مبنيَّين ولم يُوصلا: خادمَ MCP حقيقيّاً
 * (`google-search-mcp.ts`: JSON-RPC 2.0 على stdio بـinitialize و tools/list و
 * tools/call)، وعميلَ أدواتٍ خارجيّاً مكتملَ التقسية (`mind/external.ts`) لكنّ
 * لغتَه لغتُنا. هذا الملفّ يصل النصفين: يتكلّم MCP، **ويملأ سطحَ
 * `ToolProviderSession` نفسَه** — فيُعاد كلُّ ما بعده بلا سطرٍ مكرّر: التنسيبُ
 * بـ`<مزوّد>.<أداة>`، وتشديدُ الصنف، وبوّابةُ الموافقة، وإعلانُ الكتالوج،
 * وإفراغُ الأدوات عند الموت. (الازدواجُ أغلى صنفِ عيبٍ في هذا المستودع بشهادة
 * جرده: تسعةَ عشرَ قدرةً في خمسةٍ وثلاثين تنفيذاً.)
 *
 * **ثلاثةُ قيودٍ لا تُساوَم:**
 *
 * ١) **الصنفُ `command` دائماً.** لخادم MCP أن يُعلن `annotations.readOnlyHint`
 *    — وهو **إقرارُ طرفٍ ثالثٍ عن نفسه، لا دليل**. القاعدةُ الحاكمة: «الغيابُ
 *    رفضٌ لا إذن»، و«المجهولُ يُعامَل command فيقف على البوّابة». فلا نقرأ
 *    التلميحاتِ أصلاً كي لا يصير الحقلُ باباً يلتفّ حول الموافقة. مَن أراد
 *    ثقةً أوسعَ لخادمٍ بعينه فطريقُها منحٌ صريحٌ من المشغّل، لا إقرارٌ من
 *    الخادم عن نفسه.
 *
 * ٢) **البيئةُ مجرّدة.** أمرُ الخادم عمليّةُ طرفٍ ثالث، فلا ترث `ABDO_SHELL_TOKEN`
 *    ولا مقابضَ الخزنة. (ثغرةٌ مقيسة 2026-09-04 في المسار الأصليّ نفسِه.)
 *
 * ٣) **المعطياتُ لا تُخمَّن.** ‏MCP يأخذ كائناً بمخطّط، وسطحُنا يعطي نصّاً
 *    حرّاً. التحويلُ **حتميٌّ ويشرح نفسه**: كائنُ JSON يُقبل كما هو؛ ونصٌّ حرٌّ
 *    يُقبل لخانةٍ نصّيّةٍ واحدةٍ لا لبسَ فيها؛ وما عدا ذلك **يُرفض بمفاتيحه
 *    مسمّاة** لا يُخمَّن. تخمينُ معطياتِ أداةٍ تكتب على القرص أسوأُ من رفضٍ.
 */

import { normalise, type ExternalTool, type ToolProviderSession } from "./external"
import { grantableEnvName, stripChildEnv } from "@abdo/tools/env-strip"

/** نسخةُ البروتوكول التي يتكلّمها خادمُنا نفسُه — مصدرٌ واحد للرقم. */
export const MCP_PROTOCOL_VERSION = "2025-11-25"

const MAX_TEXT = 4_000
const MAX_USAGE_KEYS = 6

type JsonObject = Record<string, unknown>

const asObject = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined

/** مفاتيحُ المخطّط: المطلوبةُ أوّلاً ثمّ البقيّة، بلا تكرارٍ وبسقف. */
export const schemaKeys = (schema: unknown): { readonly required: readonly string[]; readonly all: readonly string[] } => {
  const object = asObject(schema)
  const properties = asObject(object?.properties)
  const all = properties === undefined ? [] : Object.keys(properties)
  const declared = object?.required
  const required = Array.isArray(declared)
    ? declared.filter((key): key is string => typeof key === "string" && all.includes(key))
    : []
  return { required, all: [...required, ...all.filter((key) => !required.includes(key))] }
}

/** صيغةٌ تُقرأ: المطلوبُ بين قوسين زاويّين والاختياريُّ بين معقوفين. */
export const usageFromSchema = (bare: string, schema: unknown): string => {
  const { required, all } = schemaKeys(schema)
  const shown = all.slice(0, MAX_USAGE_KEYS)
  if (shown.length === 0) return bare
  return `${bare} ${shown.map((key) => (required.includes(key) ? `<${key}>` : `[${key}]`)).join(" ")}`
}

export type ArgumentsVerdict =
  | { readonly ok: true; readonly value: JsonObject }
  | { readonly ok: false; readonly why: string }

/**
 * نصٌّ حرٌّ ← كائنُ MCP. حتميٌّ، ويرفض بمفاتيحَ مسمّاةٍ بدل أن يخمّن.
 */
export const argumentsFor = (raw: string, schema: unknown): ArgumentsVerdict => {
  const text = raw.trim()
  const { required, all } = schemaKeys(schema)
  const properties = asObject(asObject(schema)?.properties)

  if (text.length === 0) {
    if (required.length === 0) return { ok: true, value: {} }
    return { ok: false, why: `الأداة تحتاج: ${required.join("، ")}` }
  }
  if (text.startsWith("{")) {
    try {
      const parsed = asObject(JSON.parse(text))
      if (parsed !== undefined) return { ok: true, value: parsed }
    } catch { /* يسقط إلى الرفض المسمّى أدناه */ }
    return { ok: false, why: "المعطيات تبدأ بـ{ ولا تُحلَّل كائنَ JSON" }
  }
  // نصٌّ حرّ: يُقبل لخانةٍ نصّيّةٍ **واحدةٍ لا لبسَ فيها** فقط.
  const single = required.length === 1 ? required[0]
    : required.length === 0 && all.length === 1 ? all[0]
      : undefined
  if (single !== undefined) {
    const kind = asObject(properties?.[single])?.type
    if (kind === undefined || kind === "string") return { ok: true, value: { [single]: text } }
  }
  const named = all.length === 0 ? "بلا مفاتيح معلَنة" : all.join("، ")
  return { ok: false, why: `الأداة تحتاج كائنَ JSON بمفاتيح: ${named}` }
}

/** ‏`content` الخاصّ بـMCP ← نصٌّ واحد. غيرُ النصّيّ يُسمّى بنوعه لا يُبتلع. */
export const textOfResult = (result: unknown): string => {
  const object = asObject(result)
  const content = object?.content
  if (!Array.isArray(content)) {
    if (object === undefined) return typeof result === "string" ? result : ""
    return JSON.stringify(object)
  }
  const parts: string[] = []
  for (const entry of content) {
    const item = asObject(entry)
    if (item === undefined) continue
    if (typeof item.text === "string") parts.push(item.text)
    else parts.push(`[${typeof item.type === "string" ? item.type : "محتوى"}]`)
  }
  return parts.join("\n")
}

/** جلسةُ خادم MCP حيّة — بالسطح نفسِه الذي تملؤه الجلسةُ الأصليّة. */
export class McpSession implements ToolProviderSession {
  readonly id: string
  #child: import("bun").Subprocess<"pipe", "pipe", "ignore"> | undefined
  #tools: ExternalTool[] = []
  #schemas = new Map<string, unknown>()
  #pending = new Map<number, (value: { ok: boolean; result?: unknown; why?: string }) => void>()
  #seq = 0
  #buffer = ""

  constructor(provider: {
    readonly id: string
    readonly command: readonly string[]
    /**
     * اعتماداتٌ **مُحلَّةٌ مسبقاً** يمنحها المالكُ لهذا الخادم بعينه.
     * الجلسةُ لا تلمس الخزنة: من يحلّ المقبضَ هو من يملك القرار، والجلسةُ
     * تبقى قابلةً للفحص بلا خزنةٍ أصلاً.
     */
    readonly envOverlay?: Readonly<Record<string, string>>
  }) {
    this.id = provider.id
    // التجريدُ أوّلاً ثمّ المنح: لو انعكس الترتيبُ لجرّد المنحَ نفسَه. وحارسُ
    // «لا يُهرَّب المجرَّدُ عائداً» يُطبَّق هنا ثانيةً — الإعداداتُ تُحرَّر باليد
    // على القرص، وحارسٌ عند بابٍ واحدٍ ليس حارساً.
    const base = stripChildEnv(process.env).env
    const granted: Record<string, string> = { ...base }
    for (const [name, value] of Object.entries(provider.envOverlay ?? {})) {
      if (!grantableEnvName(name)) continue
      granted[name] = value
    }
    this.#child = Bun.spawn(provider.command as string[], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
      env: granted,
    }) as never
    void this.#pump()
  }

  async #pump(): Promise<void> {
    const stdout = this.#child?.stdout as ReadableStream<Uint8Array> | undefined
    if (!stdout) return
    const reader = stdout.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      this.#buffer += decoder.decode(value, { stream: true })
      let cut: number
      while ((cut = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, cut)
        this.#buffer = this.#buffer.slice(cut + 1)
        if (line.trim().length === 0) continue
        let frame: JsonObject | undefined
        try { frame = asObject(JSON.parse(line)) } catch { continue }
        if (frame === undefined || typeof frame.id !== "number") continue // إشعارٌ أو ضجيج
        const settle = this.#pending.get(frame.id)
        if (settle === undefined) continue
        this.#pending.delete(frame.id)
        const failure = asObject(frame.error)
        if (failure !== undefined) {
          settle({ ok: false, why: String(failure.message ?? "خطأ JSON-RPC بلا رسالة") })
        } else {
          settle({ ok: true, result: frame.result })
        }
      }
    }
    // موتُ الخادم يُفرغ أدواته: قائمةٌ لخادمٍ ميتٍ كذبةٌ صامتة.
    this.#tools = []
    this.#schemas.clear()
    for (const [, settle] of this.#pending) settle({ ok: false, why: "خادم MCP انقطع" })
    this.#pending.clear()
  }

  #notify(method: string, params: JsonObject = {}): void {
    this.#child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  #rpc(method: string, params: JsonObject, timeoutMs: number): Promise<{ ok: boolean; result?: unknown; why?: string }> {
    this.#seq += 1
    const id = this.#seq
    const done = new Promise<{ ok: boolean; result?: unknown; why?: string }>((settle) => {
      this.#pending.set(id, settle)
      // `unref` ضروريّ: مؤقّتٌ حيٌّ يمنع العمليةَ من الخروج ولو أُجيب الطلب —
      // الفخُّ نفسُه الذي أثبته المسارُ الأصليّ بـexit=124.
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) settle({ ok: false, why: `خادم MCP لم يُجب ${method} داخل المهلة` })
      }, timeoutMs)
      timer.unref?.()
    })
    this.#child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    return done
  }

  async handshake(timeoutMs = 10_000): Promise<readonly ExternalTool[]> {
    const half = Math.max(1_000, Math.floor(timeoutMs / 2))
    const hello = await this.#rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "abdocode", version: "4" },
    }, half)
    if (!hello.ok) return []
    this.#notify("notifications/initialized")

    const listed = await this.#rpc("tools/list", {}, half)
    if (!listed.ok) return []
    const tools = asObject(listed.result)?.tools
    if (!Array.isArray(tools)) return []

    const built: ExternalTool[] = []
    for (const entry of tools) {
      const item = asObject(entry)
      if (item === undefined || typeof item.name !== "string") continue
      const schema = item.inputSchema
      // ‏`effect` غيرُ ممرَّرٍ عمداً ⇒ `normalise` تشدّه إلى `command`.
      // التلميحاتُ (`annotations.readOnlyHint`) لا تُقرأ: إقرارُ طرفٍ ثالثٍ
      // عن نفسه ليس دليلاً، وقراءتُه هنا بابٌ حول بوّابة الموافقة.
      const tool = normalise(this.id, {
        name: item.name,
        usage: usageFromSchema(item.name, schema),
        summary: typeof item.description === "string" ? item.description : undefined,
      })
      if (tool === undefined) continue
      built.push(tool)
      this.#schemas.set(item.name, schema)
    }
    this.#tools = built
    return this.#tools
  }

  tools(): readonly ExternalTool[] {
    return this.#tools
  }

  /** المخطَّطُ المُعلَن لأداةٍ — يُقرأ في الفحص وفي شرح الرفض. */
  schemaOf(name: string): unknown {
    return this.#schemas.get(name.startsWith(`${this.id}.`) ? name.slice(this.id.length + 1) : name)
  }

  async call(name: string, args: string, timeoutMs = 60_000): Promise<{ ok: boolean; text: string }> {
    const bare = name.startsWith(`${this.id}.`) ? name.slice(this.id.length + 1) : name
    if (!this.#schemas.has(bare)) return { ok: false, text: `لا أداةَ باسم ${bare} عند خادم MCP «${this.id}»` }
    const built = argumentsFor(args, this.#schemas.get(bare))
    // الرفضُ يشرح نفسه بمفاتيحه: أهونُ من تخمينٍ يكتب على قرصِ أحدهم.
    if (!built.ok) return { ok: false, text: built.why }

    const answer = await this.#rpc("tools/call", { name: bare, arguments: built.value }, timeoutMs)
    if (!answer.ok) return { ok: false, text: String(answer.why ?? "خطأ غير مسمّى") }
    const result = asObject(answer.result)
    const text = textOfResult(answer.result).slice(0, MAX_TEXT)
    // ‏MCP يعلن فشلَ الأداة داخل النتيجة لا بخطأ البروتوكول.
    return { ok: result?.isError !== true, text }
  }

  close(): void {
    this.#child?.kill()
    this.#child = undefined
    this.#tools = []
    this.#schemas.clear()
  }
}

export * as Mcp from "./mcp"
