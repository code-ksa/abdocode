/**
 * المنحُ الدائمُ المُقيَّد — إذنٌ مكتوبُ النطاق، لا بابٌ مفتوح.
 *
 * المشكلةُ التي أوجبته مقيسة: كلُّ أداةِ MCP صنفُها `command` عمداً (إقرارُ
 * الخادم عن نفسه ليس دليلاً)، فعشرُ نداءاتٍ تعني عشرَ موافقات. والحلُّ الخاطئ
 * أن يُضعَّف التصنيف؛ والصحيحُ أن يُقال الإذنُ **مرّةً بنطاقٍ مسمّى**.
 *
 * **خمسةُ قيودٍ تجعله إذناً لا ثغرة:**
 *
 * ١) **مقيَّدٌ بالصنف والهدف معاً.** منحُ `read` لا يغطّي `command` أبداً، ولو
 *    كان الهدفُ نفسَه. الصنفُ هو ما تقرّره البوّابة، فهو جزءُ الإذن لا زينة.
 * ٢) **لا منحَ عامّ.** لا نجمةَ وحدها ولا بادئةٌ فارغة: أوسعُ ما يُمنح
 *    «كلُّ أدوات خادمٍ بعينه» (`drive.`)، وهو نطاقٌ يسمّيه المشغّل ويراه.
 * ٣) **جلسةٌ واحدة.** لا يُكتب على القرص ولا ينجو من إعادة تشغيل. إذنٌ يعيش
 *    بعد إغلاق البرنامج هو «ثقةٌ مشتقّة» بعينها.
 * ٤) **يُعلَن عند كلّ استعمال.** منحٌ يعمل بصمتٍ لا يُصدَّق ولا يُصحَّح، وهو
 *    عمليّاً إلغاءٌ للبوّابة لا تخفيفٌ لها.
 * ٥) **يُنقض بنقرة**، وبلا أثرٍ باقٍ.
 *
 * والوحدةُ **نقيّةٌ**: لا تعرف الأُطر ولا الوقت ولا القرص. المُخفِّضُ يُقاس
 * وحده، والوصلُ يُقاس حيّاً — ولا يختلط الاثنان.
 */

import type { RequestKind } from "./shells/shell"

/** أوسعُ نطاقٍ مسموح: كلُّ أدوات مزوّدٍ واحد. البادئةُ تنتهي بنقطةٍ دائماً. */
export type GrantTarget =
  | { readonly kind: "tool"; readonly name: string }
  | { readonly kind: "namespace"; readonly prefix: string }

export interface Grant {
  readonly target: GrantTarget
  readonly request: RequestKind
}

export interface GrantsState {
  readonly grants: readonly Grant[]
}

/** سقفٌ للعدد: قائمةٌ لا تُقرأ لا تُراجَع، ومنحٌ لا يُراجَع لا يُنقَض. */
export const MAX_GRANTS = 24

const NAME_RE = /^[a-zA-Z0-9_.:-]{1,120}$/u

export const empty = (): GrantsState => ({ grants: [] })

export const describeTarget = (target: GrantTarget): string =>
  target.kind === "tool" ? target.name : `${target.prefix}*`

/** المفتاحُ الذي يُقارَن به منحان — الهدفُ والصنفُ معاً، فلا يُظلّل أحدُهما. */
const keyOf = (grant: Grant): string => `${grant.request}|${describeTarget(grant.target)}`

export type GrantOutcome =
  | { readonly state: GrantsState; readonly refused?: undefined }
  | { readonly state: GrantsState; readonly refused: string }

/**
 * يضيف منحاً. الرفضُ **مسمّى** ولا يمسّ الحالة — أثرٌ جزئيٌّ في سجلّ أذونات
 * أسوأ من رفضٍ صريح.
 */
export const grant = (state: GrantsState, next: Grant): GrantOutcome => {
  if (next.target.kind === "tool") {
    if (!NAME_RE.test(next.target.name)) return { state, refused: "اسمُ أداةٍ غيرُ صالح" }
  } else {
    const prefix = next.target.prefix
    // البادئةُ تنتهي بنقطةٍ وتحمل اسماً قبلها: «.» وحدها تمنح كلَّ شيء.
    if (!prefix.endsWith(".") || prefix.length < 2 || !NAME_RE.test(prefix.slice(0, -1))) {
      return { state, refused: "نطاقٌ غيرُ صالح — البادئةُ اسمُ مزوّدٍ متبوعٌ بنقطة" }
    }
  }
  if (state.grants.some((existing) => keyOf(existing) === keyOf(next))) return { state }
  if (state.grants.length >= MAX_GRANTS) return { state, refused: `سقفُ المنح ${MAX_GRANTS} — انقض منحاً قبل أن تضيف` }
  return { state: { grants: [...state.grants, next] } }
}

/**
 * أيُّ منحٍ يغطّي هذا النداء؟ يعيد المنحَ نفسَه لا `true` — المُعلِنُ يحتاج
 * أن يقول **بأيّ إذنٍ** مرّ، وإلا صار الإعلانُ بلا معنى.
 */
export const covers = (state: GrantsState, tool: string, request: RequestKind): Grant | undefined =>
  state.grants.find((entry) => entry.request === request && (entry.target.kind === "tool"
    ? entry.target.name === tool
    : tool.startsWith(entry.target.prefix)))

/** ينقض منحاً بمفتاحه. الغائبُ لا يُخترع: الحالةُ تعود كما هي. */
export const revoke = (state: GrantsState, request: RequestKind, target: string): GrantsState => ({
  grants: state.grants.filter((entry) => keyOf(entry) !== `${request}|${target}`),
})

/** ما يُعرض للمشغّل — نصٌّ ثابتُ الترتيب كي لا ترقص القائمة بين رسمين. */
export const list = (state: GrantsState): readonly { readonly request: RequestKind; readonly target: string }[] =>
  [...state.grants]
    .map((entry) => ({ request: entry.request, target: describeTarget(entry.target) }))
    .sort((a, b) => `${a.request}|${a.target}`.localeCompare(`${b.request}|${b.target}`))

/** سطرُ الإعلان عند كلّ استعمال — يسمّي الإذنَ الذي مرّ به النداء. */
export const usedLine = (tool: string, entry: Grant): string =>
  `🔓 مرّ «${tool}» بمنحٍ قائمٍ لهذه الجلسة: ${entry.request} على ${describeTarget(entry.target)}`

export * as StandingGrants from "./standing-grants"
