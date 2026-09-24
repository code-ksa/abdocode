/**
 * إعداداته أوتوماتيك حسب النموذج»). مقيسٌ على omni-30b في مهمّة بليندر: (١) `edit` مسح سكربتَ ٥٫٥ك حرفاً إلى سطرٍ واحد
 * (+1 −59) ثمّ شغّل بليندر عليه «بنجاح»؛ (٢) رفضُ التحرير تكرّر ثلاثاً بالنصّ الخاطئ نفسِه بلا تصعيد.
 *
 * القاعدة: الصرامةُ من سياسة القضبان (`RailTier`) — النموذجُ الضعيف يُحمى أكثر، والقويُّ يُترك له العنان إلا في الكارثيّ.
 * الوحدة نقيّة: لا قرص ولا شبكة ولا ساعة.
 */
import type { RailTier } from "./rail-policy"

export interface ShrinkVerdict { readonly refused: true; readonly why: string }

/** علمُ النيّة الصريحة: `write --shrink <ملف> <<<` يعلن أنّ الاستبدالَ بأصغر مقصود. */
export const SHRINK_FLAG = "--shrink"

/**
 * كتابةٌ تُصغّر ملفّاً قائماً تصغيراً كارثيّاً تُرفض ما لم تُعلَن النيّة. العتبةُ بحسب القضبان:
 * صارم/متوسط: ملفٌّ ≥ ٤٠٠ حرف يُترك منه أقلُّ من ٢٥٪ — رفض؛ رفيع: ملفٌّ ≥ ٢٠٠٠ حرف يُترك منه أقلُّ من ٥٪ — رفض (الكارثيّ فقط).
 */
export function shrinkViolation(before: string | undefined, after: string, tier: RailTier, intended = false): ShrinkVerdict | undefined {
  if (intended || before === undefined) return undefined
  const minBefore = tier === "thin" ? 2_000 : 400
  const keepRatio = tier === "thin" ? 0.05 : 0.25
  if (before.length < minBefore) return undefined
  if (after.length >= before.length * keepRatio) return undefined
  const pct = Math.round((1 - after.length / before.length) * 100)
  return {
    refused: true,
    why: `رُفضت الكتابة: تُسقط ${pct}٪ من الملفّ (${before.length} ⇦ ${after.length} حرفاً) — هذا يشبه محوَ الملفّ لا تعديله. ` +
      `إن كان القصدُ استبدالَه بأصغر منه فاكتب «write ${SHRINK_FLAG} <الملفّ> <<< …»؛ وإلا فأعد كتابة الملفّ كاملاً بمحتواه المصحَّح.`,
  }
}

/**
 * عدّادُ رفض التحرير لكلّ (دور، ملفّ): الرفضُ الثاني بالملفّ نفسِه يصعّد النصيحةَ إلى «أعد كتابته كاملاً» — والضعيفُ (صارم/متوسط)
 * يُنصح من الرفض الأوّل، والقويُّ من الثاني. لا يُغيّر الحكمَ نفسَه؛ يضيف الذيل.
 */
export class EditRefusalTracker {
  readonly #counts = new Map<string, number>()
  /** يسجّل رفضاً ويعيد الذيلَ الذي يُلحق برسالة الرفض (فارغٌ حين لا تصعيد بعد). */
  refused(turnId: string, path: string, tier: RailTier, fileChars: number): string {
    const key = `${turnId}\x00${path.toLowerCase()}`
    const n = (this.#counts.get(key) ?? 0) + 1
    this.#counts.set(key, n)
    const threshold = tier === "thin" ? 2 : 1
    if (n < threshold) return ""
    const size = fileChars <= 12_000 ? `الملفّ ${fileChars} حرفاً — أعد كتابته كاملاً بأداة write بالمحتوى المصحَّح بدل التحرير` : "اقرأ المقطعَ المقصود بـread وانسخ السطرَ حرفيّاً"
    return ` هذا الرفض رقم ${n} لتحرير الملفّ نفسِه في هذا الدور: ${size}.`
  }
  /** نجاحُ تحريرٍ يصفّر عدّادَ الملفّ. */
  succeeded(turnId: string, path: string): void { this.#counts.delete(`${turnId}\x00${path.toLowerCase()}`) }
  count(turnId: string, path: string): number { return this.#counts.get(`${turnId}\x00${path.toLowerCase()}`) ?? 0 }
}
