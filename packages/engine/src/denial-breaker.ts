/**
 * سجلُّ الرفض وقاطعُه — «رفضتَ هذا مرّتين».
 *
 * العطلُ الذي يعالجه: نموذجٌ يُرفض طلبُه فيعيده بصيغةٍ أخرى، ثمّ يعيده، والمشغّلُ
 * يُسأل السؤالَ نفسَه أربعَ مرّات فيملّ فيوافق. **إرهاقُ الموافقة بابٌ خلفيٌّ
 * بلا كود**: لا ثغرةَ في البوّابة، بل في صبر من يقف عليها.
 *
 * ═══ فُصل إلى نصفين بحسب القانون ═══
 *
 * • **العرضُ معلومةٌ** — كم مرّةً رُفض هذا الطلبُ قبل الآن — فيصحب كلَّ سؤالٍ
 *   بلا مفتاح: إخفاءُ تاريخٍ يملكه النظامُ عمّن يقرّر ليس حياداً.
 * • **والقطعُ سلوكٌ** — رفضٌ بلا سؤالٍ بعد حدٍّ — فيبدأ **مطفأً** خلف مفتاحه،
 *   لأنّه يقرّر نيابةً عن المشغّل.
 *
 * والعدُّ **للجلسة وحدها**: لا يُكتب على قرص. عدّادٌ ينجو من إعادة التشغيل
 * يصير عقوبةً دائمةً على نيّةٍ قديمة.
 */

import type { RequestKind } from "./shells/shell"

/** الحدُّ الذي يقطع عنده: ثالثةٌ بعد رفضين صريحين ليست ترّدداً بل حلقة. */
export const BREAKER_AT = 3

export interface DenialState {
  readonly counts: Readonly<Record<string, number>>
}

export const empty = (): DenialState => ({ counts: {} })

/**
 * المفتاحُ **الصنفُ والهدفُ معاً** — كما في المنح تماماً. رفضُ `command` على
 * أداةٍ لا يعدّ رفضاً لقراءتها: طلبان مختلفان بالمعنى، وخلطُهما يقطع البريء.
 */
export const keyOf = (request: RequestKind, target: string): string => `${request}|${target}`

export const count = (state: DenialState, request: RequestKind, target: string): number =>
  state.counts[keyOf(request, target)] ?? 0

/** يسجّل رفضاً صريحاً. الهدفُ الغائبُ لا يُعدّ: بلا هدفٍ لا يوجد «هذا الطلب». */
export const record = (state: DenialState, request: RequestKind, target: string | undefined): DenialState => {
  if (target === undefined || target.length === 0) return state
  const key = keyOf(request, target)
  return { counts: { ...state.counts, [key]: (state.counts[key] ?? 0) + 1 } }
}

/** يمحو عدّاداً بعينه — طريقُ العودة، فالقاطعُ ليس بلا رجعة. */
export const reset = (state: DenialState, request: RequestKind, target: string): DenialState => {
  const key = keyOf(request, target)
  if (state.counts[key] === undefined) return state
  const counts = { ...state.counts }
  delete counts[key]
  return { counts }
}

/** والموافقةُ الصريحةُ تمحو التاريخَ: قرارٌ جديدٌ ينسخ ما قبله. */
export const forgive = reset

export interface DenialRow {
  readonly request: RequestKind
  readonly target: string
  readonly denials: number
}

/** ما يُعرض للمشغّل — ثابتُ الترتيب كي لا ترقص القائمةُ بين رسمين. */
export const list = (state: DenialState): readonly DenialRow[] =>
  Object.entries(state.counts)
    .map(([key, denials]) => {
      const cut = key.indexOf("|")
      return { request: key.slice(0, cut) as RequestKind, target: key.slice(cut + 1), denials }
    })
    .sort((a, b) => `${a.request}|${a.target}`.localeCompare(`${b.request}|${b.target}`))

/** سطرُ القطع — يقول العددَ وطريقَ العودة، فرفضٌ بلا مخرجٍ عطلٌ لا حماية. */
export const brokenLine = (target: string, denials: number): string =>
  `⛔ رُفض «${target}» ${denials} مرّاتٍ قبل الآن، فقُطع الطلبُ بلا سؤال. امحُ العدّاد من «الصلاحيات» لتُسأل ثانيةً.`

export * as DenialBreaker from "./denial-breaker"
