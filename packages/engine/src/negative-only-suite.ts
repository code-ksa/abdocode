/**
 * سويتةٌ سلبيّةٌ كلُّها لا تحرس شيئاً — والكشفُ عنها في الدور الذي كُتبت فيه.
 *
 * **مقيس 2026-09-24** في جولةٍ حيّة: البذرةُ فيها أربعةُ اختباراتٍ كلُّها تؤكّد
 * **الغياب** (`isBlocked(...) === false`). عطّلتُ الحارسَ بالكامل — `return false` دائماً —
 * فبقيت السويتةُ **خضراء**. أي أنّ أربعةَ اختباراتٍ كانت تحرس صفراً. وفي الجولة نفسِها
 * كتب الوكيلُ (بوضعٍ بلا إعدادِ الكفاءة) سويتةً بالعيب نفسِه فسقط في مسمار الطفرة.
 *
 * وهذا وجهٌ آخرُ لقاعدتنا: «الأخضرُ قد يعني: لم يحدث شيء. لكلّ فحصٍ سلبيٍّ توأمٌ إيجابيٌّ
 * يثبت أنّ الشيءَ يُنتَج أصلاً».
 *
 * والحكمُ هنا **يقول ولا يمنع**: كتابةُ اختبارٍ ليست فعلاً هدّاماً، وحارسٌ يرفض ملفَّ
 * اختبارٍ يُعطِب المنتَج. فالمخرَجُ سطرُ إيصالٍ يُقال في الدور ويصل النموذجَ، فيُصلحه
 * قبل أن يدّعي إتماماً. وحدُّه المعلن: هذا **قارئُ شكلٍ** لا مشغّلُ طفرات — يمسك النمطَ
 * الغالب (سويتةٌ لا تؤكّد وجودَ شيءٍ قطّ) ولا يدّعي أنّه يكشف كلَّ اختبارٍ لا يعضّ.
 *
 * الوحدةُ نقيّة: النصُّ يصل مدخلاً، ولا قرصَ هنا.
 */

/** أقلُّ عددِ تأكيداتٍ يُحكم عليها — ملفٌّ بتأكيدٍ واحدٍ قد يكون مسماراً مقصوداً. */
export const MIN_ASSERTIONS = 2

/** شكلُ تأكيدٍ واحدٍ كما يُقرأ من النصّ. */
export type AssertionKind = "negative" | "positive"

/**
 * ما يُعَدُّ تأكيداً **سلبيّاً**: يؤكّد غياباً أو نفياً أو صفراً أو فراغاً.
 * `not.` بأيّ صورة، و`toBe(false|undefined|null|0)`، و`toHaveLength(0)`، و`toEqual([])`،
 * و`assert.equal(x, false)`، و`toBeFalsy`, `toBeUndefined`, `toBeNull`, `toThrow`.
 */
const NEGATIVE = [
  /\.not\s*\./u,
  /\btoBe\s*\(\s*(?:false|undefined|null|0)\s*\)/u,
  /\btoBeFalsy\s*\(/u,
  /\btoBeUndefined\s*\(/u,
  /\btoBeNull\s*\(/u,
  /\btoThrow\s*\(/u,
  /\btoHaveLength\s*\(\s*0\s*\)/u,
  /\btoEqual\s*\(\s*(?:\[\s*\]|\{\s*\})\s*\)/u,
  /\bassert\.(?:equal|strictEqual)\s*\([^;\n]*,\s*(?:false|undefined|null|0)\s*\)/u,
  /\bassert\.(?:notEqual|notStrictEqual|throws|rejects)\s*\(/u,
  /\bassert\.ok\s*\(\s*!/u,
]

/** أشكالُ التأكيد التي نعدّها — `expect(...)` و`assert...`. */
const ASSERTION = /(?:\bexpect\s*\([\s\S]*?\)\s*(?:\.\w+)*\s*(?:\.\w+\s*\([^;\n]*\))|\bassert(?:\.\w+)?\s*\([^;\n]*\))/gu

export interface SuiteReading {
  readonly total: number
  readonly negative: number
  readonly positive: number
}

/** يعدّ التأكيداتَ ويصنّفها. لا حكمَ هنا — العدُّ وحده، ليُقاس. */
export function readSuite(source: string): SuiteReading {
  // التعليقاتُ تُنزع أوّلاً: مثالٌ في تعليقٍ ليس تأكيداً يعمل.
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/(^|[^:])\/\/[^\n]*/gu, "$1 ")
  const found = [...code.matchAll(ASSERTION)].map((m) => m[0])
  let negative = 0
  for (const one of found) if (NEGATIVE.some((rule) => rule.test(one))) negative += 1
  return { total: found.length, negative, positive: found.length - negative }
}

/**
 * سببٌ مسمّى إن كانت السويتةُ سلبيّةً كلَّها، وإلّا `undefined`.
 * والاسمُ يُذكر كي يُفتح الملفُّ لا كي يُبحث عنه.
 */
export function negativeOnlySuite(file: string, source: string): string | undefined {
  const reading = readSuite(source)
  if (reading.total < MIN_ASSERTIONS) return undefined
  if (reading.positive > 0) return undefined
  return `⚠ «${file}»: ${reading.total} تأكيداً كلُّها **سلبيّة** (تؤكّد غياباً أو نفياً) ولا واحدَ يؤكّد أنّ الشيءَ يُنتَج أصلاً. سويتةٌ كهذه تبقى خضراءَ لو عُطِّل ما تحرسه بالكامل — أضِف توأماً إيجابيّاً: حالةً تُنتج القيمةَ المطلوبةَ ويؤكّدها الاختبار.`
}

/** سطرُ الإيصال لعدّة ملفّات — يُقال في الدور، ولا صمتَ عن سويتةٍ لا تحرس شيئاً. */
export function negativeSuiteNotice(problems: readonly string[]): string | undefined {
  if (problems.length === 0) return undefined
  return problems.join("\n")
}
