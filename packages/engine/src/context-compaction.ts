/**
 *
 * ما كان: `conversation` (ما يراه النموذجُ من الأدوار السابقة) تُقصّ صامتةً إلى ١٢ رسالة، و«context left» في شريط
 * الحالة رقمٌ ثابت 1. ما صار: (١) نسبةُ السياق المتبقّي تُحسب من التقدير الحقيقيّ عند كلّ نداء (`contextLeftOf`)،
 * (٢) حين يتجاوز تاريخُ المحادثة نسبةً من ميزانية المدخل أو عدداً من الرسائل، تُطوى الرسائلُ القديمةُ إلى
 * **خلاصةٍ موثَّقة** (خلاصةُ الجلسة المؤكَّدة بالإيصالات — لا روايةُ النموذج عن نفسه) مع إبقاء الأحدث كاملةً —
 * وتُعلن للمستخدم بسطرٍ لا تُخفى. الوحدةُ خالصة: لا نداءَ نموذجٍ ولا قرص.
 */
export interface CompactableMessage { readonly role: "user" | "assistant" | "tool"; readonly content: string }

export const COMPACT_MARK = "📌 خلاصةٌ مضغوطة لما سبق من هذه الجلسة (آليّاً، من إيصالاتٍ موثَّقة):"
export const DEFAULT_KEEP_RECENT = 4
export const DEFAULT_RATIO = 0.4
export const DEFAULT_MAX_MESSAGES = 12

/** نسبةُ ما بقي من النافذة — بين 0 و1، ولا تكذب فوق 1 ولا تحت 0. */
export function contextLeftOf(estimatedTokens: number, contextTokens: number): number {
  if (!(contextTokens > 0) || !Number.isFinite(estimatedTokens)) return 1
  return Math.max(0, Math.min(1, 1 - Math.max(0, estimatedTokens) / contextTokens))
}

/** هل يُضغط؟ حين يتجاوز التاريخُ نسبةً من ميزانية المدخل أو سقفَ الرسائل — وبشرط أن يبقى ما يُطوى. */
export function shouldCompact(messages: readonly CompactableMessage[], tokensOf: (m: CompactableMessage) => number, budgetTokens: number, opts: { ratio?: number; maxMessages?: number; keepRecent?: number } = {}): boolean {
  const keep = opts.keepRecent ?? DEFAULT_KEEP_RECENT
  if (messages.length <= keep) return false
  const total = messages.reduce((n, m) => n + tokensOf(m), 0)
  return total > budgetTokens * (opts.ratio ?? DEFAULT_RATIO) || messages.length > (opts.maxMessages ?? DEFAULT_MAX_MESSAGES)
}

export interface CompactResult<M extends CompactableMessage> {
  readonly messages: M[]
  readonly dropped: number
  readonly beforeTokens: number
  readonly afterTokens: number
}

/**
 * الطيُّ: الرسائلُ الأقدم تُستبدل بزوجٍ واحد (سؤالٌ ثابت + خلاصة)، والأحدثُ `keepRecent` تبقى كما هي —
 * ويُحافَظ على تناوب user/assistant بقصّ الأحدث من حدّ زوج. خلاصةٌ فارغة = سطرٌ صادق «حُذفت N رسائل أقدم».
 */
export function compactConversation<M extends CompactableMessage>(messages: readonly M[], summary: string, keepRecent: number, tokensOf: (m: CompactableMessage) => number): CompactResult<M> {
  const keep = Math.max(0, keepRecent - (keepRecent % 2))
  const tail = keep === 0 ? [] : messages.slice(-keep)
  const dropped = messages.length - tail.length
  const beforeTokens = messages.reduce((n, m) => n + tokensOf(m), 0)
  if (dropped <= 0) return { messages: [...messages], dropped: 0, beforeTokens, afterTokens: beforeTokens }
  const body = summary.trim().length > 0 ? summary.trim() : `(حُذفت ${dropped} رسائل أقدم بلا خلاصةٍ موثَّقة — الحقائقُ الدائمة في ذاكرة المشروع تبقى)`
  const folded = [
    { role: "user", content: COMPACT_MARK } as unknown as M,
    { role: "assistant", content: body } as unknown as M,
    ...tail,
  ]
  return { messages: folded, dropped, beforeTokens, afterTokens: folded.reduce((n, m) => n + tokensOf(m), 0) }
}

export const compactionEventLine = (r: CompactResult<CompactableMessage>, keepRecent: number, manual = false): string =>
  `🧹 ${manual ? "ضُغط السياقُ بطلبك" : "ضُغط سياقُ المحادثة آليّاً"}: ${r.dropped} رسائل قديمة ⇦ خلاصةٌ موثَّقة + آخر ${Math.min(keepRecent, r.messages.length - 2)} (≈${r.beforeTokens} ⇦ ${r.afterTokens} توكيناً)`
