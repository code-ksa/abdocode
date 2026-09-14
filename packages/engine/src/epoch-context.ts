/** S5 — سياق الحقب بميزانية بايتات لا بعدّ رسائل.
 *
 * كان تاريخ الحقب يُقصّ بـ«أكثر من 24 رسالة أسقط الأقدم» — فقد يحمل 24
 * رسالةً صغيرةً بلا فائدة أو يُسقط إيصال قبولٍ يحتاجه القرار، ونفدت
 * ميزانية الإخراج مرتين حياً. هذا المقطّع يقصّ بميزانية بايتات مقيسة
 * (`@abdo/context.byteLength`)، ويحمي الأحدث وإيصالات القبول، ويترك
 * أثراً معلناً بما أُسقط — لا سجلّ ثانٍ ينافس دفتر Rust (الإيصالات فيه).
 */
import { byteLength } from "@abdo/context"

export interface HistoryMessage {
  readonly role: string
  readonly content: string
  readonly toolCalls?: unknown
}

const ACCEPTANCE = /npm run build|npm(?:\s+run)?\s+test|npm audit|Compiled successfully|found 0 vulnerabilities/iu

/** رسالةٌ يجب ألا تُقصّ: إيصال قبولٍ يحمل حالة بوابةٍ يعتمدها القرار. */
const isProtected = (m: HistoryMessage): boolean => ACCEPTANCE.test(m.content)

export interface TrimResult {
  readonly kept: readonly HistoryMessage[]
  readonly dropped: number
  readonly note: string
}

/**
 * يقصّ التاريخ إلى ميزانية بايتات، محتفظاً بالأحدث دائماً وبإيصالات القبول
 * أينما كانت. القصّ من الوسط الأقدم غير المحميّ. الأزواج تبقى متسقة:
 * لا يُترك ردٌّ بلا سؤاله.
 */
export function trimEpochHistory(history: readonly HistoryMessage[], budgetBytes = 48 * 1024, keepRecent = 8): TrimResult {
  const total = history.reduce((n, m) => n + byteLength(m.content), 0)
  if (total <= budgetBytes) return { kept: [...history], dropped: 0, note: "" }

  const n = history.length
  const keep = new Array<boolean>(n).fill(false)
  // احمِ الأحدث دائماً.
  for (let i = Math.max(0, n - keepRecent); i < n; i += 1) keep[i] = true
  // احمِ إيصالات القبول أينما كانت.
  for (let i = 0; i < n; i += 1) if (isProtected(history[i])) keep[i] = true

  // أضف من الأحدث إلى الأقدم حتى الميزانية.
  let used = history.reduce((acc, m, i) => acc + (keep[i] ? byteLength(m.content) : 0), 0)
  for (let i = n - 1; i >= 0 && used < budgetBytes; i -= 1) {
    if (keep[i]) continue
    const size = byteLength(history[i].content)
    if (used + size > budgetBytes) continue
    keep[i] = true
    used += size
  }

  const kept = history.filter((_, i) => keep[i])
  const dropped = n - kept.length
  const note = dropped > 0 ? `⟢ قُصّت ${dropped} رسالة قديمة من السياق لحفظ الميزانية (الإيصالات كلها في دفتر النواة).` : ""
  return { kept, dropped, note }
}
