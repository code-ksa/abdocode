/**
 * م9هـ — طابورُ كتابة الملفّ الواحد (فكرةُ Pi «withFileMutationQueue»، مكتوبةٌ هنا): أبناءُ الفريق المتوازون يكتبون في
 * الملفّ نفسِه، وقطاعُ الكتابة عندنا طويل — قراءةُ خطّ الأساس، ثمّ موافقةٌ قد تنتظر دقائق، ثمّ فحصُ القرص، ثمّ الأثر.
 * بلا ترتيبٍ يقرأ الأخوان الأساسَ نفسَه فيُرفض الثاني «تغيّر بين قراءتي وكتابتي» (الحارسُ القائم) — رفضٌ صادق لكنّه
 * عملٌ ضائع. الطابورُ يرتّب القطاعَ كلَّه لكلّ مسارٍ: الثاني يبدأ بعد أثر الأوّل فيقرأ ما كتبه أخوه ويبني فوقه.
 *
 * حدودٌ مقصودة: المفتاحُ المسارُ المطلق (بلا حالة حروف على ويندوز)؛ مساراتٌ مختلفة لا تنتظر بعضها؛ رميةُ عملٍ لا تسدّ
 * الطابور على مَن بعده؛ ولا مهلةَ هنا — مهلةُ الموافقة (١٠ دقائق) هي التي تحدّ الانتظار.
 */
import { resolve } from "node:path"

export class FileMutationQueue {
  readonly #tails = new Map<string, Promise<unknown>>()
  readonly #pending = new Map<string, number>()
  readonly #caseInsensitive: boolean

  constructor(caseInsensitive = process.platform === "win32") { this.#caseInsensitive = caseInsensitive }

  /** المفتاحُ: المسارُ المطلق مطبَّعاً — على ويندوز `A.TXT` و`a.txt` ملفٌّ واحد. */
  keyFor(path: string): string {
    const abs = resolve(path).replaceAll("\\", "/")
    return this.#caseInsensitive ? abs.toLowerCase() : abs
  }

  /** كم عملاً على هذا المسار لم ينتهِ بعد (الجاري + المنتظر) — يُسأل قبل التسجيل ليُقال للمشغّل كم أمامه. */
  pending(path: string): number { return this.#pending.get(this.keyFor(path)) ?? 0 }

  /** ينفّذ `work` بعد كلّ ما سبقه على المسار نفسِه؛ يعيد ناتجَه أو يرمي رميتَه دون أن يسدّ مَن بعده. */
  async run<T>(path: string, work: () => Promise<T>): Promise<T> {
    const key = this.keyFor(path)
    this.#pending.set(key, (this.#pending.get(key) ?? 0) + 1)
    const previous = this.#tails.get(key) ?? Promise.resolve()
    const mine = previous.then(() => undefined, () => undefined).then(work)
    this.#tails.set(key, mine)
    try { return await mine } finally {
      const left = (this.#pending.get(key) ?? 1) - 1
      if (left <= 0) { this.#pending.delete(key); if (this.#tails.get(key) === mine) this.#tails.delete(key) }
      else this.#pending.set(key, left)
    }
  }
}

/** سطرُ الصدق للمشغّل حين ينتظر عملٌ دورَه — يُقال قبل الانتظار لا بعده. */
export const queueWaitLine = (target: string, ahead: number): string =>
  `⏳ ${target}: كتابةٌ متوازية على الملفّ نفسه — تنتظر ${ahead} قبلها كي تبني فوق ما يُكتب لا فوق نسخةٍ قديمة.`
