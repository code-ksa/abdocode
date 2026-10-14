export type ProviderWire = "native-ollama" | "openai-compatible" | "anthropic"
export type ModelRole = "system" | "user" | "assistant" | "tool"

export interface ModelMessage {
  readonly role: ModelRole
  readonly content: string
  /** Validated native attachment snapshots; never remote URLs or file paths. */
  readonly images?: readonly { readonly mime: 'image/png' | 'image/jpeg' | 'image/webp'; readonly data: string }[]
  readonly toolCallId?: string
  readonly name?: string
  readonly toolCalls?: readonly ModelToolCall[]
}

export interface ModelToolCall {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

export interface ModelUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  /** Prompt tokens the provider served from its prefix cache (subset of inputTokens). Absent when not reported — never invented. */
  readonly cachedInputTokens?: number
  /** Completion tokens spent on hidden reasoning (subset of outputTokens). Absent when not reported. */
  readonly reasoningTokens?: number
}

export interface ModelTurn {
  readonly kind: "final" | "tools"
  readonly text: string
  readonly calls: readonly ModelToolCall[]
  readonly finishReason: string
  readonly truncated: boolean
  readonly usage: ModelUsage
}

export interface ChatCodecInput {
  readonly wire: ProviderWire
  readonly model: string
  readonly messages: readonly ModelMessage[]
  readonly stream: boolean
  readonly stop?: readonly string[]
  readonly maxOutputTokens?: number
  /** Native runtime context window. Used only by providers that expose it. */
  readonly contextTokens?: number
  /** Provider-neutral sampling knobs; omitted values keep the conservative defaults. */
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  /** Whether a native reasoning runtime should execute its thinking path. */
  readonly think?: boolean
  /** Opt-in until each provider transport is qualified. */
  readonly tools?: readonly { name: string; description: string; parameters: unknown }[]
  /** م9ز — معرِّفُ تثبيت الجلسة (بصمةٌ لا سرّ): رأسُ `x-session-id` على السحابيّ، و`user` في جسد OpenAI، و`metadata.user_id` عند Anthropic — كي يوجَّه طلبُ الجلسة نفسِها إلى الذاكرة المؤقّتة للبادئة نفسِها. */
  readonly sessionAffinity?: string
  /** حقولُ الجسد (`user`/`metadata.user_id`) فقط حين يوثّقها المزوّد (قائمةٌ صريحة في providers) — حقلٌ غيرُ موثَّق عند بوّابةٍ مجهولة مخاطرةٌ بلا نفع؛ الرأسُ يُرسَل دائماً. */
  readonly sessionAffinityBody?: boolean
}

export interface EncodedChatRequest {
  readonly path: string
  readonly body: string
  readonly headers: Readonly<Record<string, string>>
  readonly credential: "none" | "bearer" | "x-api-key"
}

export type RetryDisposition = "never" | "bounded-backoff" | "operator-action"

export type ModelFailureKind =
  | "cancelled"
  | "transport"
  | "rate-limited"
  /** 429/402 whose body says the balance or quota is gone — waiting will not help; another provider or the owner will. */
  | "quota-exhausted"
  | "provider-unavailable"
  | "credential"
  | "invalid-request"
  | "context-limit"
  | "protocol"

export interface ModelFailure {
  readonly kind: ModelFailureKind
  readonly retry: RetryDisposition
  readonly status?: number
  readonly retryAfterMs?: number
  readonly reason: string
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
/** Provider phrasings of an exhausted balance or quota (z.ai 1113, OpenAI insufficient_quota, credit/billing wording, Qwen arrearage). */
export const QUOTA_EXHAUSTED = /insufficient[ _](?:balance|quota|credits?|funds)|no resource package|"code"\s*:\s*"?1113\b|exceeded your current quota|credit balance is too low|billing (?:hard )?limit|quota (?:exceeded|exhausted)|arrearage|out of credits|payment required|recharge/iu

/**
 * One fail-closed retry taxonomy for every provider family.
 *
 * A response that has emitted any bytes is never retried here: doing so could
 * duplicate a model turn while presenting it as one stream. This function
 * classifies only; the caller still owns a bounded retry budget.
 */
export function classifyModelFailure(input: {
  readonly status?: number
  readonly error?: unknown
  readonly responseStarted?: boolean
  readonly retryAfter?: string | null
  /** The first bytes of a refusal body (never logged by this function), to tell an exhausted quota from a busy provider. */
  readonly body?: string
}): ModelFailure {
  if (input.error instanceof DOMException && input.error.name === "AbortError") {
    return Object.freeze({ kind: "cancelled", retry: "never", reason: "request cancelled" })
  }
  if (input.responseStarted === true) {
    return Object.freeze({
      kind: "protocol",
      retry: "never",
      ...(input.status === undefined ? {} : { status: input.status }),
      reason: "response already started; automatic replay is forbidden",
    })
  }
  if (input.status === undefined) {
    // The worker can refuse a missing vault credential before HTTP exists.
    const message = input.error instanceof Error ? input.error.message : String(input.error ?? "")
    if (/provider credential (?:unavailable|rejected)|credential_unavailable|missing[_ ](?:api[_ ]key|credential)/iu.test(message)) {
      return Object.freeze({ kind: "credential", retry: "operator-action", reason: "provider credential unavailable" })
    }
    // 🔴 **مِصنَفٌ يبتلع السببَ يحوّل كلَّ الأعطال إلى عطلٍ واحدٍ لا يُشخَّص.**
    //
    // كان الرفضُ يعود بعبارةٍ واحدةٍ مهما كان الخطأ: انقطاعُ اسمٍ، أو تفاوضُ TLS، أو
    // مهلةٌ، أو خروجُ العامل. وقِيس على ليلتَي مسحٍ كاملتَين: ستُّ إلى تسعِ سقطاتٍ في
    // الجولة الواحدة أبطلت خمسَ جولات — **وفي الوقت نفسِه** نجحت عشرةُ نداءاتٍ
    // متوازيةٍ بـ`fetch` مباشرةً إلى المزوّد نفسِه (10/10، ~1.5ث لكلٍّ). فالعطلُ في
    // طريقنا لا في الشبكة، ولم يكن في السجلّ ما يدلّ عليه.
    //
    // فالسببُ يُحمَل الآن مقصوصاً. والتصنيفُ لا يتغيّر: يبقى `transport` بتراجعٍ محدود.
    const detail = (input.error instanceof Error ? input.error.message : String(input.error ?? "")).replace(/\s+/gu, " ").trim().slice(0, 160)
    return Object.freeze({
      kind: "transport",
      retry: "bounded-backoff",
      reason: detail.length === 0 ? "transport failed before response" : `transport failed before response: ${detail}`,
    })
  }
  const status = input.status
  if (status === 401 || status === 403) {
    return Object.freeze({ kind: "credential", retry: "operator-action", status, reason: "credential rejected" })
  }
  // 🔴 Measured 2026-09-25: z.ai answered 429 {"code":"1113","message":"Insufficient balance or no resource package"}, and every
  // turn retried the same provider seven times (~2.5 min) under the label "busy", then looked like a product defect.
  // An exhausted balance or quota is not transient: it is said once, never retried here, and the ladder moves on.
  if ((status === 429 || status === 402) && typeof input.body === "string" && QUOTA_EXHAUSTED.test(input.body)) {
    return Object.freeze({ kind: "quota-exhausted", retry: "operator-action", status, reason: "provider balance or quota exhausted" })
  }
  if (status === 413) {
    return Object.freeze({ kind: "context-limit", retry: "operator-action", status, reason: "request exceeds provider limit" })
  }
  if (RETRYABLE_STATUS.has(status) || status >= 500) {
    const seconds = input.retryAfter === null || input.retryAfter === undefined ? Number.NaN : Number(input.retryAfter)
    const retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1_000, 60_000) : undefined
    return Object.freeze({
      kind: status === 429 ? "rate-limited" : "provider-unavailable",
      retry: "bounded-backoff",
      status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      reason: status === 429 ? "provider rate limited the request" : "provider unavailable",
    })
  }
  return Object.freeze({ kind: "invalid-request", retry: "never", status, reason: "provider rejected the request" })
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined

/** أقصى طولٍ لصورةٍ واحدة (base64). مقيس 2026-09-13: لقطةُ صفحةٍ PNG ≈ 713k حرفاً فكانت تُرفض «invalid image content» ويموت الدور — المُلتقِط يقصّ إلى هذا السقف. */
export const MAX_IMAGE_BASE64 = 350_000

const assertMessages = (messages: readonly ModelMessage[]) => {
  for (const message of messages) {
    if (message.images !== undefined && (message.role !== 'user' || message.images.length > 4 || message.images.some(image => !['image/png','image/jpeg','image/webp'].includes(image.mime) || image.data.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(image.data)))) throw new Error('invalid image content')
    if (message.content.trim().length === 0 && !(message.role === "assistant" && message.toolCalls?.length)) throw new Error(`empty ${message.role} message`)
    if (message.role === "tool" && message.toolCallId === undefined) throw new Error("tool message requires toolCallId")
  }
}

/** معرِّفُ التثبيت بصمةٌ قصيرة من محارف آمنة — نصٌّ حرّ أو سرٌّ يُرفض قبل أن يغادر. */
const sessionAffinityValue = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  if (!/^[A-Za-z0-9._-]{8,64}$/u.test(value)) throw new Error("session affinity must be an opaque 8..64 char token")
  return value
}
const affinityHeader = (value: string | undefined): Record<string, string> => value === undefined ? {} : { "x-session-id": value }

/**
 * نماذجُ الاستدلال تقبل `max_completion_tokens` وحدَه، ولا تقبل `temperature` غيرَ الافتراضيّ (1).
 * 10-08 — **مقيسٌ بمفتاحٍ حيّ**: gpt-6.1-sol ⇦ 400 «'max_tokens' is not supported … Use 'max_completion_tokens'»، وgpt-5.5 ⇦ 400
 * «'temperature' does not support 0 … Only the default (1)»، وكلاهما 200 بلا temperature/presence_penalty ومع max_completion_tokens؛
 * وgpt-4.1 يقبل الشكلَ القديم. فالعائلةُ من gpt-5 فما بعدها (gpt-6، gpt-7…) وسلسلةُ o.
 */
export const REASONING_OUTPUT_CAP = /^(?:o[1-9](?:[.\-]|$)|gpt-(?:[5-9]|[1-9][0-9])(?:[.\-]|$))/iu

/**
 * 10-14 — كلُّ معرّف نداءٍ يُجاب قبل الدور التالي، وكلُّ ردِّ أداةٍ يتبع نداءه: Anthropic وOpenAI يرفضان (400) طلباً فيه نداءٌ بلا ردّ
 * أو ردٌّ بلا نداء. حلقةٌ توقّفت في منتصف طابور نداءاتٍ (تكرار، سقف) تترك نداءً بلا ردّ — يُجاب «لم يُنفَّذ»، والردُّ اليتيم يصير نصّاً.
 */
export const NOT_EXECUTED = "لم يُنفَّذ هذا النداء — توقّفت الحلقةُ قبله."
export function answerEveryCall(messages: readonly ModelMessage[]): readonly ModelMessage[] {
  const out: ModelMessage[] = []
  let open: ModelToolCall[] = []
  const close = () => { for (const call of open) out.push({ role: "tool", content: NOT_EXECUTED, toolCallId: call.id, name: call.name }); open = [] }
  for (const message of messages) {
    if (message.role === "tool") {
      const at = open.findIndex((call) => call.id === message.toolCallId)
      if (at >= 0) { open.splice(at, 1); out.push(message) }
      else out.push({ role: "user", content: message.content })
      continue
    }
    close()
    out.push(message)
    if (message.role === "assistant" && message.toolCalls?.length) open = [...message.toolCalls]
  }
  close()
  return out
}

export function encodeChatRequest(input: ChatCodecInput): EncodedChatRequest {
  if (input.model.trim().length === 0) throw new Error("model is required")
  assertMessages(input.messages)
  if (input.wire !== "native-ollama" && input.messages.some((message) => message.toolCalls?.length || message.role === "tool")) input = { ...input, messages: answerEveryCall(input.messages) }
  const affinity = sessionAffinityValue(input.sessionAffinity)
  const affinityBody = input.sessionAffinityBody === true ? affinity : undefined
  // 10-08 (مقيس على NIM): gpt-oss-20b يستدعي أدواتِه بقناته الأصليّة — بلا أدواتٍ معلَنة في الطلب أسقطها المزوّدُ فعاد المحتوى فارغاً
  // والوسائطُ في `reasoning` ({"path":"src/price.js",…}) ثلاثَ مرّاتٍ ولو بتنبيه. الشكلُ المتوافق مع OpenAI صار ينقل الأدوات الأصليّة
  // (tools، tool_calls، رسائل tool). و10-14 صار الأنثروبيّ ينقلها أيضاً (tool_use/tool_result) — انظر فرعَه أدناه.
  const stop = input.stop?.length ? input.stop : undefined
  if (input.wire === "native-ollama") {
    return Object.freeze({
      path: "/api/chat",
      headers: Object.freeze({ "content-type": "application/json" }),
      credential: "none" as const,
      body: JSON.stringify({
        model: input.model,
        stream: input.stream,
        think: input.think ?? false,
        options: {
          temperature: input.temperature ?? 0,
          presence_penalty: 0,
          ...(input.topP === undefined ? {} : { top_p: input.topP }),
          ...(input.topK === undefined ? {} : { top_k: input.topK }),
          ...(input.contextTokens === undefined ? {} : { num_ctx: input.contextTokens }),
          ...(input.maxOutputTokens === undefined ? {} : { num_predict: input.maxOutputTokens }),
          ...(stop === undefined ? {} : { stop }),
        },
        ...(input.tools?.length ? { tools: input.tools.map((tool) => ({ type: "function", function: tool })) } : {}),
        messages: input.messages.map((message) => ({
          role: message.role, content: message.content,
          ...(message.images?.length ? { images: message.images.map(image => image.data) } : {}),
          ...(message.role === "tool" ? { tool_name: message.name } : {}),
          ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({
            id: call.id, type: "function", function: { name: call.name, arguments: call.input },
          })) } : {}),
        })),
      }),
    })
  }
  if (input.wire === "anthropic") {
    // 10-14 — مقيسٌ مقابل Claude Code بالنموذج نفسِه (claude-sonnet-5-5) على n8n: كان الطلبُ يخرج بلا cache_control فيُدفع السياقُ
    // كاملاً بسعره في كلّ نداء، وبلا أدواتٍ أصليّة (رفضٌ صريح هنا) فيكتب النموذجُ «نفّذ:» نصّاً على عُرفٍ لم يُدرَّب عليه.
    // فالأدواتُ تُرسل بشكلها (input_schema)، ونداءاتُ المساعد tool_use، والنتائجُ tool_result متتاليةً في رسالة user واحدة؛
    // ونقاطُ الخبيئة الأربع (الحدُّ الأقصى): آخرُ أداة، والنظام، وآخرُ رسالة، وآخرُ رسالةِ user قبلها — فالبادئةُ تُقرأ بعُشر سعرها.
    const systems = input.messages.filter((message) => message.role === "system").map((message) => message.content)
    type Block = Record<string, unknown>
    const turns: { role: "user" | "assistant"; content: Block[] }[] = []
    const push = (role: "user" | "assistant", blocks: Block[]) => {
      const last = turns.at(-1)
      if (last?.role === role) last.content.push(...blocks)
      else turns.push({ role, content: blocks })
    }
    for (const message of input.messages) {
      if (message.role === "system") continue
      if (message.role === "tool") { push("user", [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }]); continue }
      const blocks: Block[] = message.images?.length ? message.images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mime, data: image.data } })) : []
      if (message.content.trim().length > 0) blocks.push({ type: "text", text: message.role === "assistant" ? message.content.trimEnd() : message.content })
      if (message.role === "assistant") for (const call of message.toolCalls ?? []) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: record(parseJsonArguments(call.input)) ?? {} })
      push(message.role === "assistant" ? "assistant" : "user", blocks)
    }
    const ephemeral = { type: "ephemeral" }
    const mark = (turn: { content: Block[] } | undefined) => { const block = turn?.content.at(-1); if (block !== undefined) block.cache_control = ephemeral }
    mark(turns.at(-1))
    mark(turns.slice(0, -1).findLast((turn) => turn.role === "user"))
    const tools = input.tools?.map((tool, index, all) => {
      const schema = record(tool.parameters)
      return {
        name: tool.name,
        description: tool.description,
        input_schema: schema?.type === "object" ? schema : { type: "object", properties: {} },
        ...(index === all.length - 1 ? { cache_control: ephemeral } : {}),
      }
    })
    return Object.freeze({
      path: "/messages",
      headers: Object.freeze({ "content-type": "application/json", "anthropic-version": "2023-06-01", ...affinityHeader(affinity) }),
      credential: "x-api-key" as const,
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxOutputTokens ?? 4096,
        stream: input.stream,
        ...(affinityBody === undefined ? {} : { metadata: { user_id: affinityBody } }),
        ...(systems.length === 0 ? {} : { system: [{ type: "text", text: systems.join("\n\n"), cache_control: ephemeral }] }),
        // عُرفُ النصّ (‏</tool_result>) يقطع النداءَ الأصليّ قبل أن يكتمل — لا وقفَ مع الأدوات الأصليّة.
        ...(stop === undefined || tools?.length ? {} : { stop_sequences: stop }),
        ...(tools?.length ? { tools } : {}),
        messages: turns,
      }),
    })
  }
  return Object.freeze({
    path: "/chat/completions",
    headers: Object.freeze({ "content-type": "application/json", ...affinityHeader(affinity) }),
    credential: "bearer" as const,
    body: JSON.stringify({
      model: input.model,
      stream: input.stream,
      // 10-08 (مقيس): نماذجُ الاستدلال ترفض temperature=0 بـ400 — تُترك على افتراضها.
      ...(REASONING_OUTPUT_CAP.test(input.model) ? {} : { temperature: 0, presence_penalty: 0 }),
      // 🔴 **سقفُ الإخراج كان يُحسب ولا يُرسل.** المحرّك يحجز ثمانيةَ آلافٍ للحقبة
      // ويحاسب عليها، والجسمُ المتوافق مع OpenAI كان يخرج **بلا `max_tokens`** —
      // فالمزوّدُ لا يعرف حدّاً، ومهلةُ المحاولة المبنيّةُ على السقف لا تجد رقماً
      // فتبقى على أرضيّتها (مقيس 2026-09-26: «timed out after 150000ms» يتكرّر سبعاً
      // على نداءٍ مشروع). الشكلُ الأنثروبيّ كان يرسله دائماً — فالفرقُ كان صدفةَ شكل.
      // ونماذجُ الاستدلال (o-series، gpt-5) **ترفض** `max_tokens` بـ400 وتطلب
      // `max_completion_tokens` — من عقد المزوّد المنشور، **غيرُ مقيسٍ هنا** (لا مفتاحَ
      // لنا عليه في هذه الجلسة). فالحقلُ يُختار بالاسم، وكتالوجُنا يشحن `o3-mini`.
      ...(input.maxOutputTokens === undefined
        ? {}
        : REASONING_OUTPUT_CAP.test(input.model)
          ? { max_completion_tokens: input.maxOutputTokens }
          : { max_tokens: input.maxOutputTokens }),

      ...(stop === undefined ? {} : { stop }),
      ...(affinityBody === undefined ? {} : { user: affinityBody }),
      ...(input.tools?.length ? { tools: input.tools.map((tool) => ({ type: "function", function: tool })) } : {}),
      messages: input.messages.map(({ images, toolCallId, toolCalls, ...message }) => {
        if (message.role === "tool") return { role: "tool", tool_call_id: toolCallId, content: message.content }
        if (toolCalls?.length) return { ...message, content: message.content.trim().length > 0 ? message.content : null, tool_calls: toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {}) } })) }
        return images?.length ? {...message,content:[{type:'text',text:message.content},...images.map(image=>({type:'image_url',image_url:{url:`data:${image.mime};base64,${image.data}`}}))]} : message
      }),
    }),
  })
}

const parseJsonArguments = (value: unknown): unknown => {
  if (typeof value !== "string") return value ?? {}
  try { return JSON.parse(value) } catch { return { malformed: value } }
}

const usage = (input: unknown, output: unknown, cached?: unknown, reasoning?: unknown): ModelUsage => Object.freeze({
  ...(number(input) === undefined ? {} : { inputTokens: number(input) }),
  ...(number(output) === undefined ? {} : { outputTokens: number(output) }),
  ...(number(cached) === undefined ? {} : { cachedInputTokens: number(cached) }),
  ...(number(reasoning) === undefined ? {} : { reasoningTokens: number(reasoning) }),
})

const turn = (text: string, calls: readonly ModelToolCall[], finishReason: string, modelUsage: ModelUsage): ModelTurn =>
  Object.freeze({
    kind: calls.length === 0 ? "final" as const : "tools" as const,
    text,
    calls: Object.freeze(calls),
    finishReason,
    truncated: finishReason === "length" || finishReason === "max_tokens",
    usage: modelUsage,
  })

export function decodeChatResponse(wire: ProviderWire, payload: unknown): ModelTurn {
  const root = record(payload)
  if (root === undefined) throw new Error("provider response must be an object")
  if (wire === "native-ollama") {
    const message = record(root.message) ?? {}
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map((entry, index) => {
      const call = record(entry) ?? {}
      const fn = record(call.function) ?? {}
      return Object.freeze({
        id: string(call.id) ?? `ollama-${index}`,
        name: string(fn.name) ?? "",
        input: parseJsonArguments(fn.arguments),
      })
    }) : []
    const finish = string(root.done_reason) ?? (root.done === true ? "stop" : "partial")
    return turn(string(message.content) ?? "", calls, finish, usage(root.prompt_eval_count, root.eval_count))
  }
  if (wire === "anthropic") {
    const content = Array.isArray(root.content) ? root.content : []
    const texts: string[] = []
    const calls: ModelToolCall[] = []
    for (const entry of content) {
      const block = record(entry)
      if (block?.type === "text" && typeof block.text === "string") texts.push(block.text)
      if (block?.type === "tool_use") calls.push(Object.freeze({
        id: string(block.id) ?? "",
        name: string(block.name) ?? "",
        input: block.input ?? {},
      }))
    }
    // 10-14 — input_tokens عند Anthropic **لا يشمل** المقروءَ من الخبيئة ولا المكتوبَ فيها: الإدخالُ كلُّه مجموعُ الثلاثة، والمخبوءُ
    // cache_read وحده. كان المقروءُ يسقط فيبدو كلُّ نداءٍ صغيراً ولا يُرى أنّ الخبيئة تعمل.
    const counts = record(root.usage) ?? {}
    const read = number(counts.cache_read_input_tokens)
    const written = number(counts.cache_creation_input_tokens)
    const fresh = number(counts.input_tokens)
    const total = fresh === undefined ? undefined : fresh + (read ?? 0) + (written ?? 0)
    // أسبابُ التوقّف بمفردات البقيّة: nativeToolReply يقبل stop/tool_calls وحدهما، فـ«tool_use» كان سيُرفض «incomplete_native_response»
    // في كلّ نداءٍ أصليّ. max_tokens يبقى باسمه (المقطوعُ يُعرف به).
    const reason = string(root.stop_reason)
    const finish = reason === "tool_use" ? "tool_calls" : reason === "end_turn" || reason === "stop_sequence" ? "stop" : reason ?? "unknown"
    return turn(texts.join(""), calls, finish, usage(total, counts.output_tokens, read))
  }
  const choice = Array.isArray(root.choices) ? record(root.choices[0]) ?? {} : {}
  const message = record(choice.message) ?? {}
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map((entry) => {
    const call = record(entry) ?? {}
    const fn = record(call.function) ?? {}
    return Object.freeze({ id: string(call.id) ?? "", name: string(fn.name) ?? "", input: parseJsonArguments(fn.arguments) })
  }) : []
  const counts = record(root.usage) ?? {}
  // OpenAI-compatible detail blocks (measured on token-plan 2026-09-02): cached prefix and hidden reasoning.
  const promptDetails = record(counts.prompt_tokens_details) ?? {}
  const completionDetails = record(counts.completion_tokens_details) ?? {}
  return turn(string(message.content) ?? "", calls, string(choice.finish_reason) ?? "unknown",
    usage(counts.prompt_tokens, counts.completion_tokens, promptDetails.cached_tokens, completionDetails.reasoning_tokens))
}

export interface WireFrame {
  readonly done: boolean
  readonly payload?: unknown
}

/** Bounded NDJSON/SSE framing. Semantic provider deltas are decoded above this layer. */
export class BoundedWireDecoder {
  #buffer = ""
  #bytes = 0
  readonly #decoder = new TextDecoder()
  constructor(readonly maxBytes = 1_048_576) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive safe integer")
  }

  push(chunk: Uint8Array | string): readonly WireFrame[] {
    const text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true })
    this.#bytes += typeof chunk === "string" ? new TextEncoder().encode(chunk).byteLength : chunk.byteLength
    if (this.#bytes > this.maxBytes) throw new Error(`provider stream exceeded ${this.maxBytes} bytes`)
    this.#buffer += text
    const frames: WireFrame[] = []
    for (;;) {
      const cut = this.#buffer.indexOf("\n")
      if (cut < 0) break
      const line = this.#buffer.slice(0, cut).trim()
      this.#buffer = this.#buffer.slice(cut + 1)
      if (line.length === 0 || line.startsWith("event:")) continue
      const data = line.startsWith("data:") ? line.slice(5).trim() : line
      if (data === "[DONE]") frames.push(Object.freeze({ done: true }))
      else frames.push(Object.freeze({ done: false, payload: JSON.parse(data) }))
    }
    return Object.freeze(frames)
  }

  finish(): void {
    this.#buffer += this.#decoder.decode()
    if (this.#buffer.trim().length !== 0) throw new Error("provider stream ended with an incomplete frame")
  }
}
