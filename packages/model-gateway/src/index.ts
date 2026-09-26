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

export function encodeChatRequest(input: ChatCodecInput): EncodedChatRequest {
  if (input.model.trim().length === 0) throw new Error("model is required")
  assertMessages(input.messages)
  const affinity = sessionAffinityValue(input.sessionAffinity)
  const affinityBody = input.sessionAffinityBody === true ? affinity : undefined
  if (input.wire !== "native-ollama" && (input.tools?.length || input.messages.some((m) => m.toolCalls?.length))) {
    throw new Error("native tool transport is not qualified for this provider")
  }
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
    const systems = input.messages.filter((message) => message.role === "system").map((message) => message.content)
    const messages = input.messages.filter((message) => message.role !== "system").map((message) => {
      if (message.role !== "tool") return { role: message.role, content: message.images?.length ? [...message.images.map(image => ({type:'image',source:{type:'base64',media_type:image.mime,data:image.data}})),{type:'text',text:message.content}] : message.content }
      return {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }],
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
        ...(systems.length === 0 ? {} : { system: systems.join("\n\n") }),
        ...(stop === undefined ? {} : { stop_sequences: stop }),
        messages,
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
      temperature: 0,
      presence_penalty: 0,
      ...(stop === undefined ? {} : { stop }),
      ...(affinityBody === undefined ? {} : { user: affinityBody }),
      messages: input.messages.map(({images,...message}) => images?.length ? {...message,content:[{type:'text',text:message.content},...images.map(image=>({type:'image_url',image_url:{url:`data:${image.mime};base64,${image.data}`}}))]} : message),
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
    const counts = record(root.usage) ?? {}
    return turn(texts.join(""), calls, string(root.stop_reason) ?? "unknown", usage(counts.input_tokens, counts.output_tokens))
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
