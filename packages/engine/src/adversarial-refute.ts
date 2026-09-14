/**
 * هـ3 — التفنيدُ العدائيّ لوضع «أقصى» (أمر المالك 2026-09-07: «نظامٌ أساسيّ ثمّ أقوى ثمّ أقوى ثمّ أقصى»).
 *
 * المراجعةُ المستقلّة تسأل: «هل اكتمل؟» فتجيب COMPLETE. والسؤالُ الذي يكشف ما لا تكشفه: **«ادحضْ أنّه اكتمل»** —
 * عدساتٌ مستقلّة، كلٌّ تحاول أن تُسقط الاكتمال بمدخلٍ أو حالةٍ مسمّاة، ولا تُقبل دعوى دحضٍ بلا ذلك. هذه هي قاعدةُ
 * البيت نفسُها التي أنتجت ٩٥ عيباً في يوم: «كلُّ عيبٍ يُدحَض، والشكُّ يُرجَّح للدحض» — مقلوبةً على الادّعاء الأكبر:
 * «تمّ».
 *
 * ثلاثُ عدساتٍ لا واحدة: مُدّعٍ واحدٌ يوافق نفسَه، والعدساتُ المختلفة تكشف أصنافاً مختلفة (إيصالٌ لا يُثبت الهدف،
 * ادّعاءٌ بلا إيصال، مدخلٌ يكسر ما بُني). والحكمُ بالأغلبية: دحضٌ واحدٌ من ثلاثةٍ رأيٌ، واثنان قرينةٌ تُوقف التسليم.
 *
 * الوحدة **نقيّة**: لا شبكة ولا قرص ولا ساعة — تبني النصوص وتقرأ الأحكام، والنداءُ في `cli.ts` بدفتر الكلفة نفسه.
 */

/** عدسةُ تفنيدٍ واحدة: اسمٌ يُعرض في الإيصال، وسؤالٌ يختلف عن أخويه اختلافاً حقيقيّاً. */
export interface RefuteLens {
  readonly key: string
  readonly label: string
  readonly question: string
}

export const REFUTE_LENSES: readonly RefuteLens[] = Object.freeze([
  Object.freeze({
    key: "evidence",
    label: "الإيصالُ يثبت الهدف؟",
    question: "افحص كلَّ إيصالٍ مقابل الهدف: هل يُثبت الإيصالُ ما يدّعيه الجواب، أم يُثبت شيئاً مجاوراً (بناءٌ نجح لا يعني الميزة تعمل، واختبارٌ أخضر قد يعني أنّه لم يُشغَّل على ما تغيّر)؟",
  }),
  Object.freeze({
    key: "unproven",
    label: "ادّعاءٌ بلا إيصال؟",
    question: "اعدد ادّعاءات الجواب واحداً واحداً، وسمِّ أوّلَ ادّعاءٍ لا يقابله إيصالٌ في القائمة. «لم يُفحص» ليست «نجح».",
  }),
  Object.freeze({
    key: "breaks",
    label: "مدخلٌ يكسره؟",
    question: "اقترح مدخلاً أو حالةً محدّدةً (قيمةٌ، مسارٌ، ترتيبُ خطوات) يُظهر أنّ ما بُني لا يفي بالهدف. لا تفترض عيباً بلا مسارٍ يصل إليه.",
  }),
])

/** حكمُ عدسةٍ واحدة. `refuted` لا تُمنح إلا بمدخلٍ أو حالةٍ مسمّاة — دعوى دحضٍ بلا ذلك تُقرأ «قائم». */
export interface Refutation {
  readonly lens: string
  readonly refuted: boolean
  readonly why: string
}

const CAP = 400

/** نصُّ نظام المفنِّد: بلا أدوات، بسياقٍ منفصل، وبعقدِ إجابةٍ من سطرين لا نثر. */
export const REFUTE_SYSTEM =
  "أنت مُفنِّدٌ مستقلّ. لا أدواتِ لك ولا سياقَ سابق: أمامك الهدفُ وجوابُ المنفِّذ وإيصالاتُه فقط.\n" +
  "مهمّتك أن **تدحض** دعوى الاكتمال إن استطعت، لا أن تجاملها. ولا تدحض بالظنّ: كلُّ دحضٍ يحتاج مدخلاً أو حالةً مسمّاة.\n" +
  "أجب بسطرين حرفاً:\n" +
  "الحكم: REFUTED أو STANDS\n" +
  "السبب: جملةٌ واحدة تسمّي المدخلَ أو الإيصالَ الناقص (بالعربية)\n"

/** مدخلُ المفنِّد: الهدفُ والجواب والإيصالات مسقوفةً، ثمّ سؤالُ عدسته. */
export const buildRefutePrompt = (
  goal: string,
  answer: string,
  receipts: readonly { readonly command: string; readonly output: string }[],
  lens: RefuteLens,
): string =>
  `الهدف:\n${goal.slice(0, 600)}\n\n` +
  `جوابُ المنفِّذ (دعوى الاكتمال):\n${answer.slice(0, 1200)}\n\n` +
  `الإيصالات المنفَّذة (${receipts.length}):\n${receipts.slice(-12).map((r) => `- ${r.command.split("\n", 1)[0]!.slice(0, 100)} ⇦ ${r.output.replace(/\s+/g, " ").slice(0, 220)}`).join("\n") || "- لا إيصالات"}\n\n` +
  `عدستُك: ${lens.label}\n${lens.question}\n`

/**
 * يقرأ حكمَ عدسةٍ من نصّ النموذج. الغيابُ أو الغموضُ «قائم» لا «مدحوض»: دحضٌ يُخترع من صمتٍ يوقف تسليماً صحيحاً،
 * وهو الوجهُ الآخر من «الأخضر قد يعني لم يحدث شيء».
 */
export const parseRefutation = (lens: string, text: string): Refutation => {
  const verdictLine = /(?:^|\n)\s*(?:الحكم|verdict)\s*[:：]\s*(REFUTED|STANDS)/iu.exec(text)
  const reasonLine = /(?:^|\n)\s*(?:السبب|reason)\s*[:：]\s*([^\n]+)/u.exec(text)
  const why = (reasonLine?.[1] ?? "").trim().replace(/\s+/g, " ").slice(0, CAP)
  const claimed = verdictLine?.[1]?.toUpperCase() === "REFUTED"
  // دحضٌ بلا سببٍ مكتوب ليس دحضاً — العقدُ سطران، ومن لم يكتب السبب لم يدحض.
  return Object.freeze({ lens, refuted: claimed && why.length > 0, why: why.length > 0 ? why : "بلا سبب" })
}

export interface RefuteOutcome {
  readonly refuted: boolean
  readonly tally: string
  /** أسبابُ الدحض وحدها — ما يُعاد إلى المنفِّذ ليصلحه. */
  readonly problem?: string
}

/**
 * الحكمُ الجامع: **اثنان من ثلاثة** يوقفان التسليم. واحدٌ رأيٌ يُقال ولا يوقف (وإلا صار مفنِّدٌ متشائمٌ واحدٌ
 * بابَ تعليقٍ دائم)، والصفرُ يمرّ. والعدُّ يُكتب في الإيصال كما هو — لا «راجعناه» مبهمة.
 */
export const judgeRefutations = (results: readonly Refutation[]): RefuteOutcome => {
  const refuting = results.filter((r) => r.refuted)
  const tally = `التفنيد العدائيّ: ${refuting.length}/${results.length} دحضاً${results.map((r) => ` · ${r.lens}: ${r.refuted ? "دحض" : "قائم"}`).join("")}`
  if (refuting.length < 2) return Object.freeze({ refuted: false, tally })
  return Object.freeze({ refuted: true, tally, problem: refuting.map((r) => `[${r.lens}] ${r.why}`).join(" | ").slice(0, 600) })
}
