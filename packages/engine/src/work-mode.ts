/**
 * هـ2 — سلّمُ الأوضاع (أمر المالك 2026-09-07): «نفس نظام كلود: أساسيّ ثمّ أقوى ثمّ أقوى ثمّ أقصى — وعند عمل
 * الوكلاء يعملون على مهامّ محدّدة، وأوّلُهم نموذجٌ قويّ يقرأ المشروع من الوعي والذاكرة مثلما تفعل تماماً».
 *
 * الوضعُ يحكم **كم** وكيلاً و**متى**، لا **ماذا** يُسمح: الأدواتُ والبوّابةُ والنمطُ والقضبانُ والأمنُ تبقى للدور كما هي،
 * والأطفالُ يمرّون من المُوزِّع نفسه (S13.5). ما يُشغَّل بحسب الوضع:
 *   - `orientationAgent`: وكيلٌ موجِّه (read-only) يقرأ المشروع من الوعي والذاكرة قبل الحقبة الأولى ويخرج بخلاصةٍ مهيكلة.
 *   - `parallelAgents`: سقفُ أداة `team` (تفويضٌ متوازٍ لمهامّ محدّدة؛ 0 = الأداة مرفوضة، ويبقى `delegate` الفرديّ).
 *   - `independentReview`: تُفعَّل استراتيجيّةُ Super Abdo (فحصٌ ⇦ تنفيذ ⇦ تحقّق ⇦ مراجعةٌ مستقلّة) ولو لم يفعّلها المستخدم بنفسه.
 *   - `adversarialRefute`: تفنيدٌ عدائيّ لنتائج المراجعة — **غيرُ مبنيّ بعد** (العلمُ يُقال لا يُدَّعى).
 * الوحدةُ نقيّة: لا قرص ولا شبكة ولا ساعة.
 */

/** اسمُ أداة الفريق في السجلّ الواحد — مصدرٌ واحد للكتالوج والحارس. */
export const TEAM_TOOL = "team"

export type WorkMode = "basic" | "strong" | "stronger" | "max"

export interface WorkProfile {
  readonly mode: WorkMode
  readonly label: string
  readonly orientationAgent: boolean
  readonly parallelAgents: number
  readonly independentReview: boolean
  /** هـ3 — تفنيدٌ عدائيّ بعد المراجعة المستقلّة: ثلاثُ عدساتٍ تحاول دحضَ الاكتمال، واثنتان تُوقفانه. */
  readonly adversarialRefute: boolean
  readonly reason: string
}

const PROFILES: Record<WorkMode, Omit<WorkProfile, "reason">> = {
  basic: { mode: "basic", label: "أساسيّ", orientationAgent: false, parallelAgents: 0, independentReview: false, adversarialRefute: false },
  strong: { mode: "strong", label: "أقوى", orientationAgent: true, parallelAgents: 0, independentReview: true, adversarialRefute: false },
  stronger: { mode: "stronger", label: "أقوى+", orientationAgent: true, parallelAgents: 4, independentReview: true, adversarialRefute: false },
  max: { mode: "max", label: "أقصى", orientationAgent: true, parallelAgents: 12, independentReview: true, adversarialRefute: true },
}

export const WORK_MODES: readonly WorkMode[] = Object.freeze(["basic", "strong", "stronger", "max"])

export const isWorkMode = (value: unknown): value is WorkMode => typeof value === "string" && (WORK_MODES as readonly string[]).includes(value)

/** الإعدادُ المجهول أو المعطوب = أساسيّ (الغيابُ تشدّدٌ لا ترخّص — لا وكلاءَ إضافيّين بلا اختيارٍ صريح). */
export function workProfile(setting: unknown): WorkProfile {
  const mode: WorkMode = isWorkMode(setting) ? setting : "basic"
  const reason = isWorkMode(setting) ? `وضعُ العمل «${PROFILES[mode].label}» من الإعدادات` : "وضعُ العمل الافتراضيّ «أساسيّ» (لا إعداد أو إعدادٌ غير معروف)"
  return { ...PROFILES[mode], reason }
}

/** سطرُ الإيصال للمشغّل — ما سيُشغَّل فعلاً، وما لم يُبنَ يُقال. */
export function describeWorkProfile(profile: WorkProfile): string {
  const parts = [
    profile.orientationAgent ? "وكيلٌ موجِّه يقرأ المشروع أوّلاً" : "وكيلٌ واحد",
    profile.parallelAgents > 0 ? `فريقٌ متوازٍ حتى ${profile.parallelAgents}` : "لا توازي",
    profile.independentReview ? "تحقّقٌ ومراجعةٌ مستقلّة" : "لا مراجعةَ مستقلّة",
    ...(profile.adversarialRefute ? ["تفنيدٌ عدائيّ بثلاث عدسات بعد المراجعة"] : []),
  ]
  return `وضعُ العمل «${profile.label}»: ${parts.join("، ")}.`
}

/** إعداداتُ Super Abdo بعد الوضع: الوضعُ يفعّل التحقّقَ والمراجعة، ولا يطفئ ما فعّله المستخدم بنفسه. */
export function superAbdoUnderWorkMode<T extends { readonly enabled: boolean; readonly verifyResults: boolean; readonly independentReview: boolean }>(base: T, profile: WorkProfile): T {
  if (!profile.independentReview) return base
  return Object.freeze({ ...base, enabled: true, verifyResults: true, independentReview: true })
}
