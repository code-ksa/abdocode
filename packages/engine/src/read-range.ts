/**
 * read-range — قراءة مقطع من ملف بأرقام أسطر (S13.0، اقتصاد القراءة):
 * «read <ملف> [من] [إلى]» بأرقام تبدأ من 1 وشاملة الطرفين؛ «من» وحدها = من
 * ذلك السطر إلى النهاية. وحدة نقيّة بلا أثر: التحليل والتقطيع فقط، والأثر
 * الوحيد (قراءة النواة) يبقى في cli.ts. فشلٌ مغلق: أيّ صيغة غير مفهومة خطأٌ
 * صريح لا تخمين.
 */

export const READ_RANGE_USAGE = "الصيغة: read <ملف> [من] [إلى] — أرقام أسطر تبدأ من 1"
export const READ_NEEDS_FILE = "read يحتاج ملفاً"

export type ReadRangeArgs = Readonly<{ file: string; from?: number; to?: number }>
export type ReadRangeError = Readonly<{ error: string }>
export type ReadRangeSlice = Readonly<{ slice: string; total: number; from: number; to: number }>
export type ReadRange = Readonly<{ from: number; to?: number }>
/** خطّة القراءة كما يستهلكها الأثر: ملفٌ، ومقطعٌ اختياريّ (غيابه = الملفّ كاملاً). */
export type ReadPlan = Readonly<{ file: string; range?: ReadRange }>

const parseLine = (token: string): number | undefined => {
  if (!/^\d+$/.test(token)) return undefined
  const n = Number(token)
  // «0» عادةٌ صفريّة عند النماذج (مقيس 09-14 على نموذجين) — تُقرأ 1 لا خطأً
  return Number.isSafeInteger(n) && n >= 0 ? Math.max(1, n) : undefined
}
/** «-1» في موضع «إلى» = إلى نهاية الملفّ (عادةُ python) — مقيس 09-14. */
const parseToLine = (token: string): number | undefined | null => (token === "-1" ? null : parseLine(token))

/** يحلّل ذيل الأمر: [ملف] أو [ملف، من] أو [ملف، من، إلى]. */
export const parseReadRange = (args: readonly string[]): ReadRangeArgs | ReadRangeError => {
  const [file, fromToken, toToken, ...extra] = args
  if (file === undefined || file.length === 0) return { error: READ_NEEDS_FILE }
  if (extra.length > 0) return { error: READ_RANGE_USAGE }
  if (fromToken === undefined) return { file }
  const from = parseLine(fromToken)
  if (from === undefined) return { error: READ_RANGE_USAGE }
  if (toToken === undefined) return { file, from }
  const to = parseToLine(toToken)
  if (to === null) return { file, from }
  if (to === undefined || from > to) return { error: READ_RANGE_USAGE }
  return { file, from, to }
}

/**
 * من الذيل المحلَّل إلى خطّة الأثر: cli.ts لا يعيد تركيب المقطع بنفسه بل
 * يمرّر `plan.range` كما هو (غيابه = الملفّ كاملاً بإيصاله المطابق بايتاً).
 */
export const planRead = (args: readonly string[]): ReadPlan | ReadRangeError => {
  const parsed = parseReadRange(args)
  if ("error" in parsed) return parsed
  if (parsed.from === undefined) return { file: parsed.file }
  return { file: parsed.file, range: parsed.to === undefined ? { from: parsed.from } : { from: parsed.from, to: parsed.to } }
}

/**
 * ذيل قشرة الطرفية (REPL) حيث لا اقتباس: «read docs/my notes.md» مسارٌ واحد
 * بفراغاته كما كان دائماً، ولا يصير مقطعاً إلا إذا كان كلّ ما بعد الرمز
 * الأوّل أرقاماً — فلا يخسر منفذٌ قديم ما كان يقبله.
 */
export const splitReadTail = (tail: string): string[] => {
  const trimmed = tail.trim()
  if (trimmed.length === 0) return []
  const tokens = trimmed.split(/\s+/)
  const numericTail = tokens.length > 1 && tokens.slice(1).every((token) => /^\d+$/.test(token))
  return numericTail ? tokens : [trimmed]
}

/**
 * يقطّع النصّ بأرقام أسطر 1-based شاملة. كلّ سطرٍ يحمل فاصله الأصليّ هو
 * (CRLF أو LF أو CR وحده) فيعود المقطع بايتاتَ المصدر نفسها حتى في ملفٍ
 * مختلط الفواصل، ولا يُعدّ الفاصل الختاميّ سطراً فارغاً زائداً. «إلى» فوق
 * الطول تُقصّ إلى الطول؛ «من» فوق الطول خطأ.
 */
export const sliceReadRange = (text: string, from: number, to?: number): ReadRangeSlice | ReadRangeError => {
  if (!Number.isSafeInteger(from) || from < 1 || (to !== undefined && (!Number.isSafeInteger(to) || to < from))) {
    return { error: READ_RANGE_USAGE }
  }
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/gu) ?? []
  const total = lines.length
  if (from > total) return { error: `المقطع يبدأ بعد نهاية الملف: السطر ${from} من ${total} سطراً` }
  const end = to === undefined ? total : Math.min(to, total)
  return { slice: lines.slice(from - 1, end).join("").replace(/(?:\r\n|\n|\r)$/u, ""), total, from, to: end }
}
