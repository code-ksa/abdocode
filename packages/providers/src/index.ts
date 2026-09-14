import { allow } from "@abdo/egress"
import {
  buildChatRequest,
  type DroppedHarnessTool,
  type HarnessToolBinding,
  type HarnessToolDefinition,
  type HarnessWire,
  type ModelMessage,
} from "@abdo/harness"
import { decodeChatResponse, type ModelTurn } from "@abdo/model-gateway"
import { DeterministicRegistry, type RegistryEntry } from "@abdo/registry"
import { MAX_CUSTOM_PROVIDERS, PROVIDER_DEFINITIONS, PROVIDER_TEMPLATES } from "./catalog"
export { MAX_CUSTOM_PROVIDERS, PROVIDER_DEFINITIONS, PROVIDER_TEMPLATES } from "./catalog"
export { hasDeclaredImageInput } from './images'
export {
  DEFAULT_AGENT_MODEL,
  DEFAULT_CHAT_MODEL,
  classifyModelLane,
  isResumeIntent,
  selectModelLane,
  type ModelLane,
  type ModelRole,
} from "./routing"
export {
  climb,
  evidenceFrom,
  receiptLine,
  startOf,
  type Escalation,
  type EscalationEvidence,
  type EvidenceKind,
  type EvidenceRead,
  type LadderState,
  type ModelRung,
  type VerificationLike,
} from "./escalation"

export interface Provider extends RegistryEntry {
  readonly label: string
  readonly local: boolean
  readonly wire: HarnessWire
  readonly harness: string
  readonly baseUrl: string
  readonly vaultKey?: string
  readonly models: readonly string[]
  readonly imageModels?: readonly string[]
}

const registry = new DeterministicRegistry<Provider>()
for (const definition of PROVIDER_DEFINITIONS) registry.register(definition)
let ownerProviders = new Map<string, Provider>()

/**
 * الكتالوجُ **المُجمَّع** — لقطةٌ عند التحميل، وثباتُها مقصود: `catalogDigest`
 * يشهد عليها، وبوّابةُ التكافؤ تقارنها بما في عامل رست. فتلويثُها بتسجيلٍ
 * وقتَ التشغيل يكسر الشهادة، ولذلك يمنعه اختبارٌ قائم.
 *
 * ولهذا **لا تُقرأ حيث يُراد الحيّ**: من أراد «كلَّ المزوّدين الآن — ومنهم
 * ما سجّله المالك» فليقرأ `listProviders()`. العطلُ المقيس (2026-09-03) أنّ
 * ثلاثة قرّاءٍ يريدون الحيّ كانوا يقرأون هذه: مجموعةَ النماذج، وحالةَ
 * الخزنة، وبذرةَ الكتالوج. فمزوّدٌ مخصّصٌ يُسجَّل بنجاحٍ ثم **لا يظهر في أيّ
 * قائمة** — يعمل بمرجعٍ يُكتب باليد ولا يُرى في منتقٍ أبداً.
 */
export const PROVIDERS = registry.snapshot().entries
export const catalogDigest = registry.snapshot().digest

/**
 * كلُّ المزوّدين **الآن**: المُجمَّعون وما سجّله المالك. لقطةٌ عند النداء لا
 * عند التحميل — وهذا هو الفرق كلُّه.
 */
export function listProviders(): readonly Provider[] {
  return Object.freeze([...PROVIDERS, ...ownerProviders.values()].sort((a, b) => a.id.localeCompare(b.id)))
}

export function provider(id: string): Provider | undefined {
  return registry.get(id) ?? ownerProviders.get(id)
}

export interface CustomProviderSettings {
  readonly id: string
  readonly label: string
  readonly baseUrl: string
  readonly vaultKey: string
  readonly local?: boolean
  readonly models?: readonly string[]
  /** Explicit owner declaration for a compatible local/remote endpoint. */
  readonly imageModels?: readonly string[]
}

/** مزوّد مخصص من إعدادات المالك (تبويب المزودين) — تسجيلٌ وقت التشغيل.
 *
 * الحدود المقصودة، لا نقصاً:
 * - «owner-config» مصدره، فلا يلوّث بصمة الكتالوج المدمج ولا بوابة التكافؤ.
 * - https إلزامي للسحابي؛ المحلي loopback حصراً وبلا اعتماد.
 * - لهجة OpenAI المتوافقة فقط (أوسع لهجة عند المزودين الصغار).
 * - تسجيل معرفٍ قائم بتعريفٍ مطابق يُخطّى بصمت (إعادة حفظ الإعدادات)؛
 *   وبتعريفٍ مختلف يُرفض بالاسم — السجل لا يُستبدل تحت الأقدام.
 * - السحابي يمر بعامل Rust الذي يطابق إعلان المالك والنقطة والمقبض.
 *   المحلي يمر بمسار الطلب المحلي الموجود، ولا يحمل سراً ولا يعلن للعامل.
 */
function customDefinition(input: CustomProviderSettings): Provider | string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.id)) return "معرف مزوّد غير صالح"
  if (input.label.length === 0 || input.label.length > 64) return "اسم مزوّد غير صالح"
  if (input.baseUrl.length > 512 || /[|;\s]/u.test(input.baseUrl)) return "عنوان URL لمزوّد غير صالح"
  let endpoint: URL
  try {
    endpoint = new URL(input.baseUrl)
  } catch {
    return `عنوان المزود «${input.id}» ليس URL صالحاً`
  }
  const local = input.local === true
  if(input.imageModels !== undefined && (!Array.isArray(input.imageModels) || input.imageModels.length>64 || input.imageModels.some(model=>!input.models?.includes(model)))) return 'Image models must be included in the configured model list'
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return "عنوان المزود يجب ألا يحتوي اعتماداً أو استعلاماً أو جزءاً مخفياً"
  if (local) {
    if (!["http:", "https:"].includes(endpoint.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) return "المزوّد المحلي يجب أن يعمل على loopback لهذا الكمبيوتر فقط"
    if (input.vaultKey !== "") return "المزوّد المحلي لا يقبل مقبض اعتماد سحابي"
  } else if (endpoint.protocol !== "https:") return `مزوّد مخصص فوق ${endpoint.protocol}// مرفوض — https إلزامي لاعتماد سحابي`
  if (input.models !== undefined && (!Array.isArray(input.models) || input.models.length > 64 || input.models.some((model) => typeof model !== "string" || model.trim().length === 0 || model.length > 160 || /[\s\u0000-\u001f]/u.test(model)))) return "قائمة النماذج غير صالحة — حتى 64 معرفاً صحيحاً"
  // فضاء أسماء الخزنة مقفول: مقبض المخصص يبدأ بـcustom- ولا يساوي مقبض
  // مزوّدٍ مُجمَّع أبداً — وإلا صار «مزوّد مخصص» طريقاً لتسريب مفتاح
  // OpenAI/أنثروبيك إلى نقطةٍ غريبة (المسح العدائي 2026-09-01، حرج).
  if (!local && !/^custom-[a-z0-9-]+$/.test(input.vaultKey)) {
    return `مقبض خزنة المزوّد المخصص «${input.id}» يجب أن يبدأ بـcustom- — مقابض المزوّدين المُجمَّعين ليست له`
  }
  if (PROVIDERS.some((p) => p.vaultKey === input.vaultKey)) {
    return `مقبض الخزنة «${input.vaultKey}» ملك مزوّدٍ مُجمَّع — مرفوض`
  }
  return Object.freeze({
    id: input.id,
    version: "1",
    source: "owner-config",
    label: input.label,
    local,
    wire: "openai-compatible" as HarnessWire,
    harness: "abdo-native",
    baseUrl: input.baseUrl,
    vaultKey: local ? undefined : input.vaultKey,
    models: Object.freeze([...new Set(input.models ?? [])]),
    ...(input.imageModels?.length ? {imageModels:Object.freeze([...new Set(input.imageModels)])} : {}),
  })
}

export function registerCustomProvider(input: CustomProviderSettings, opts?: { readonly dryRun?: boolean }): string | undefined {
  const definition = customDefinition(input)
  if (typeof definition === "string") return definition
  const existing = provider(input.id)
  if (existing !== undefined) {
    const same = existing.source === "owner-config" && existing.baseUrl === definition.baseUrl && existing.vaultKey === definition.vaultKey && existing.label === definition.label && existing.local === definition.local && JSON.stringify(existing.models) === JSON.stringify(definition.models) && JSON.stringify(existing.imageModels??[])===JSON.stringify(definition.imageModels??[])
    return same ? undefined : `المعرف «${input.id}» مسجّل بتعريف مختلف — احذف القديم من الإعدادات أولاً`
  }
  if (opts?.dryRun === true) return undefined
  if (listProviders().filter((item) => item.source === "owner-config").length >= MAX_CUSTOM_PROVIDERS) return "قائمة المزودين المخصصين ممتلئة (64)"
  ownerProviders.set(input.id, definition)
  return undefined
}

/** Replace only owner configuration as one validated snapshot. The settings
 * owner calls this at startup or after an explicit save while no turn runs.
 * Existing Provider objects stay immutable; compiled endpoint identity never
 * changes. Invalid siblings cause no partial registration or removal. */
export function syncCustomProviders(list: readonly CustomProviderSettings[], opts?: { readonly dryRun?: boolean }): readonly string[] {
  if (list.length > MAX_CUSTOM_PROVIDERS) return ["قائمة المزودين المخصصين ممتلئة (64)"]
  const next = new Map<string, Provider>()
  const endpoints = new Set<string>()
  for (const input of list) {
    const definition = customDefinition(input)
    if (typeof definition === "string") return [definition]
    if (registry.get(input.id) !== undefined) return [`المعرف «${input.id}» ملك مزوّد مُجمَّع — لا يمكن استبداله`]
    const endpoint = new URL(input.baseUrl).toString().replace(/\/$/u, "")
    if (next.has(input.id) || endpoints.has(endpoint)) return ["معرف أو عنوان مزوّد مكرر"]
    next.set(input.id, definition)
    endpoints.add(endpoint)
  }
  if (opts?.dryRun !== true) ownerProviders = next
  return []
}

/** نقطة الدردشة النهائية لمزوّد مخصص — التركيب نفسه الذي يستعمله
 * prepareChatRequest حرفياً، فيتطابق ما يعلنه المضيف لعامل Rust مع ما
 * يصل العامل وقت النداء بايتاً ببايت. */
export function chatEndpointFor(baseUrl: string): string | undefined {
  try {
    const endpoint = new URL(baseUrl)
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return undefined
    return new URL(`${endpoint.pathname.replace(/\/$/, "")}/chat/completions`, endpoint.origin).toString()
  } catch {
    return undefined
  }
}

/** قيمة `ABDO_CUSTOM_PROVIDERS` التي يعلنها المضيف لعامل Rust —
 * `id|endpoint|vaultKey` بفاصل `;`. عامل Rust لا يقبل مزوّداً مخصصاً إلا
 * بمطابقة هذه القيمة حرفياً؛ undefined = لا مخصص (الغياب رفض). */
export function customProviderEnvValue(
  list: readonly { readonly id: string; readonly baseUrl: string; readonly vaultKey: string; readonly local?: boolean }[],
): string | undefined {
  const entries: string[] = []
  for (const item of list) {
    if (item.local === true) continue
    const endpoint = chatEndpointFor(item.baseUrl)
    if (endpoint === undefined) continue
    if (/[|;\s]/u.test(item.id) || /[|;\s]/u.test(endpoint) || !/^custom-[a-z0-9-]+$/.test(item.vaultKey)) continue
    entries.push(`${item.id}|${endpoint}|${item.vaultKey}`)
  }
  return entries.length === 0 ? undefined : entries.join(";")
}

export interface ModelRef {
  readonly provider: string
  readonly model: string
}

export function parseRef(ref: string): ModelRef | undefined {
  const slash = ref.indexOf("/")
  if (slash <= 0) return undefined
  const providerId = ref.slice(0, slash)
  const model = ref.slice(slash + 1)
  if (provider(providerId) === undefined || model.trim().length === 0) return undefined
  return Object.freeze({ provider: providerId, model })
}

export function formatRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`
}

export function seedCatalog(): readonly { ref: string; provider: Provider; needsKey: boolean }[] {
  return listProviders().flatMap((entry) => entry.models.map((model) => ({ ref: `${entry.id}/${model}`, provider: entry, needsKey: !entry.local })))
}

/** م9ز — المزوّدون الذين يوثّقون حقلَ تثبيتٍ في الجسد (`user` عند OpenRouter/OpenAI، `metadata.user_id` عند Anthropic). غيرُهم يأخذ الرأسَ وحده. (مقيس 09-14: إنفيديا NIM تعلّق ~40٪ من الطلبات بلا علاقةٍ بالحقل — لا يُنسَب إليه.) */
export const AFFINITY_BODY_PROVIDERS: ReadonlySet<string> = new Set(["openrouter", "openai", "anthropic"])

export function prepareChatRequest(input: {
  readonly provider: Provider
  readonly model: string
  readonly system?: string
  readonly messages: readonly ModelMessage[]
  readonly tools?: readonly HarnessToolDefinition[]
  readonly stream: boolean
  readonly contextTokens?: number
  readonly maxOutputTokens?: number
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly think?: boolean
  readonly nativeTools?: boolean
  readonly conversationOnly?: boolean
  /** م9ز — معرِّفُ تثبيت الجلسة (يمرّ إلى الهارنس ثمّ المرمِّز). */
  readonly sessionAffinity?: string
  readonly credentialHandle?: {
    applyToHeaders(
      headers: Readonly<Record<string, string>>,
      kind: "none" | "bearer" | "x-api-key",
    ): Readonly<Record<string, string>>
  }
  readonly credentialOwner?: "caller" | "rust-worker"
}): {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly credential: "none" | "bearer" | "x-api-key"
  readonly body: string
  readonly toolBindings: readonly HarnessToolBinding[]
  readonly droppedTools: readonly DroppedHarnessTool[]
} {
  const endpoint = new URL(input.provider.baseUrl)
  if (!input.provider.local && input.credentialHandle === undefined && input.credentialOwner !== "rust-worker") {
    throw new Error(`provider ${input.provider.id} requires its vault credential`)
  }
  allow(endpoint.hostname, `owner-selected model provider ${input.provider.id}`)
  const request = buildChatRequest({
    wire: input.provider.wire,
    harness: input.provider.harness,
    model: input.model,
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    stream: input.stream,
    contextTokens: input.contextTokens,
    maxOutputTokens: input.maxOutputTokens,
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    think: input.think,
    nativeTools: input.nativeTools,
    conversationOnly: input.conversationOnly,
    sessionAffinity: input.sessionAffinity,
    sessionAffinityBody: input.sessionAffinity !== undefined && AFFINITY_BODY_PROVIDERS.has(input.provider.id),
  })
  const headers = input.credentialHandle === undefined
    ? request.headers
    : input.credentialHandle.applyToHeaders(request.headers, request.credential)
  return Object.freeze({
    url: new URL(`${endpoint.pathname.replace(/\/$/, "")}${request.path}`, endpoint.origin).toString(),
    headers,
    credential: input.provider.local ? "none" : request.credential,
    // Native tool exchanges currently retain content/tool_calls, not vendor
    // reasoning_content. Explicitly select the compatible non-thinking mode
    // for those exchanges instead of inheriting a vendor default that rejects
    // the next tool result. Text-tool agent turns may still request thinking.
    body: input.provider.id === "deepseek"
      ? JSON.stringify({ ...JSON.parse(request.body), thinking: { type: input.think === true && input.nativeTools !== true ? "enabled" : "disabled" } })
      : request.body,
    toolBindings: request.toolBindings,
    droppedTools: request.droppedTools,
  })
}

export function decodeResponse(provider: Provider, payload: unknown): ModelTurn {
  return decodeChatResponse(provider.wire, payload)
}

export const Providers = Object.freeze({ PROVIDERS, PROVIDER_TEMPLATES, MAX_CUSTOM_PROVIDERS, listProviders, catalogDigest, provider, parseRef, formatRef, seedCatalog, prepareChatRequest, decodeResponse, registerCustomProvider, syncCustomProviders, chatEndpointFor, customProviderEnvValue })
