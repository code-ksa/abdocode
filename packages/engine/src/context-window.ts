/**
 * نافذةُ السياق في المهامّ الطويلة — البندان 9 و10 من جرد هيرمس/أوبن‑كلاو (الفكرتان من openclaw
 * `attempt-prompt-preflight` وhermes `agent/context_breakdown.py`، لا الشيفرة).
 *
 * مقيس 2026-09-27: حين يتجاوز الطلبُ ميزانيّةَ المدخل كان المحرّكُ يُسقط **تبادلاتٍ كاملةً** من أقدمها بصمت
 * حتى يدخل — محادثةٌ طويلة تنسى أوّلَها ولا يقال لأحد. والسلّمُ هنا مسمّى ومرتَّب من الأرخص حفظاً:
 *   ١) قصُّ الرسائل الكبيرة القديمة (رأسٌ وذيلٌ وعلامةٌ ظاهرة — الاقترانُ بين الاستدعاء ونتيجته يبقى)،
 *   ٢) ثمّ إسقاطُ التبادلات الأقدم (كما كان)،
 *   ٣) ثمّ الرفضُ المسمّى.
 * وما وقع يُقال بأرقامه. والتفكيكُ يقيس ما يملأ النافذة **بالمقدِّر نفسِه** الذي يقرّر القصّ، فلا يفترقان.
 */

export interface WindowMessage {
  readonly role: string
  readonly content: string
  readonly toolCalls?: unknown
  readonly images?: readonly unknown[]
}

/** علامةُ القصّ الظاهرة — يراها النموذجُ فيعرف أنّ الوسطَ حُذف لا أنّه لم يوجد. */
export const clipMarker = (dropped: number, total: number): string => `\n…[قُصّ للنافذة: حُذف ${dropped} من ${total} حرفاً من الوسط]…\n`

export interface ClipResult<T> {
  readonly messages: T[]
  readonly clipped: number
  readonly savedTokens: number
}

/**
 * يقصّ أكبرَ الرسائل القديمة (لا الأحدث `keepRecent`) حتى يُوفَّر `excessTokens` أو لا يبقى ما يُقصّ.
 * كلُّ رسالةٍ تُقصّ مرّةً إلى رأسٍ وذيلٍ مجموعُهما `keepChars`؛ ما دونها لا يُمسّ.
 */
export function clipForWindow<T extends WindowMessage>(
  history: readonly T[],
  excessTokens: number,
  tokensOf: (text: string) => number,
  options: { readonly keepRecent?: number; readonly keepChars?: number } = {},
): ClipResult<T> {
  const keepRecent = options.keepRecent ?? 2
  const keepChars = options.keepChars ?? 2_000
  const messages = [...history]
  if (excessTokens <= 0) return { messages, clipped: 0, savedTokens: 0 }
  // الأقدمُ أوّلاً ثمّ الأكبر؛ والأحدثُ (`keepRecent`) آخراً لا أبداً: في المهمّة الطويلة نتيجةُ الأداة الأخيرة هي
  // ما يملأ النافذة (مقيس 09-27)، وحمايتُها المطلقة كانت تترك الإسقاطَ الكامل وحده — وهو يأخذها معه.
  const candidates = messages
    .map((message, index) => ({ index, size: message.content.length, recent: index >= messages.length - keepRecent }))
    .filter(({ size }) => size > keepChars * 2)
    .sort((a, b) => Number(a.recent) - Number(b.recent) || b.size - a.size)
  let saved = 0
  let clipped = 0
  for (const { index } of candidates) {
    if (saved >= excessTokens) break
    const message = messages[index]!
    const content = message.content
    const head = content.slice(0, Math.floor(keepChars / 2))
    const tail = content.slice(content.length - Math.ceil(keepChars / 2))
    const next = head + clipMarker(content.length - head.length - tail.length, content.length) + tail
    saved += Math.max(0, tokensOf(content) - tokensOf(next))
    messages[index] = { ...message, content: next }
    clipped += 1
  }
  return { messages, clipped, savedTokens: saved }
}

/** أجزاءُ النافذة بالتوكنات — من المقدِّر الذي يقرّر القصّ. */
export interface WindowParts {
  readonly system: number
  readonly catalogue: number
  readonly history: number
  /** من التاريخ: نتائجُ الأدوات وحدها (دورُ tool، أو «نتيجة الأداة» في البروتوكول النصّيّ). */
  readonly toolResults: number
  readonly request: number
  readonly attachments: number
}

export const isToolResult = (message: WindowMessage): boolean =>
  message.role === "tool" || (message.role === "user" && message.content.trimStart().startsWith("نتيجة الأداة"))

const k = (tokens: number): string => (tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens))

/** سطرٌ واحد: ما يملأ النافذة، ومجموعُه من سعتها. */
export function contextBreakdownLine(parts: WindowParts, window: number): string {
  const total = parts.system + parts.catalogue + parts.history + parts.request + parts.attachments
  const percent = window > 0 ? Math.round((total / window) * 100) : 0
  return `📏 نافذة السياق: نظام ${k(parts.system)} · كتالوج ${k(parts.catalogue)} · تاريخ ${k(parts.history)} (نتائج أدوات ${k(parts.toolResults)}) · الطلب ${k(parts.request)} · مرفقات ${k(parts.attachments)} = ${k(total)} من ${k(window)} (${percent}%)`
}

/** سطرُ السلّم حين يعمل: ما قُصّ وما أُسقط، بالأرقام. */
export function overflowLine(before: number, after: number, budget: number, clipped: number, savedTokens: number, droppedExchanges: number): string {
  const steps: string[] = []
  if (clipped > 0) steps.push(`قُصّت ${clipped} رسائل كبيرة (−${k(savedTokens)})`)
  if (droppedExchanges > 0) steps.push(`أُسقط ${droppedExchanges} تبادلاً قديماً`)
  return `📏 السياقُ تجاوز ميزانيّةَ المدخل (${k(before)} من ${k(budget)}): ${steps.join("، ثمّ ")} ⇦ ${k(after)}`
}
