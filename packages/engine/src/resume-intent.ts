/** آلية «اكمل من حيث توقفت» — استئنافُ الهدف كميزةِ منتج.
 *
 * قيس 2026-09-01 حيّاً: استدعاء الجلسة السابقة ثم إرسال «اكمل من حيث توقفت»
 * وحده أعاد النموذج إلى NEXT_ACTION.md ثم ABDO-SPRINTS.md — لكن النصّ العاري
 * أسقط كل بوابة قبولٍ مشتقّةٍ من الهدف (بناء/فحص أنواع/تدقيق/اختبارات)، فصار
 * الدور بلا بوابات. هنا: دورٌ نصّه استئنافٌ فقط يرث هدف آخر دورٍ حقيقيّ من
 * ذاكرة الحقائق، فتُشتقّ البوابات منه ويُخبَر النموذج بالهدف الأصلي صريحاً.
 *
 * مفتاح الإعدادات (قاعدة المالك 6): `plugins.resumeIntent` — الافتراض مفعَّل،
 * والمعطَّل = السلوك القديم حرفياً. القرار هنا نقيٌّ بلا حالة؛ القراءة من
 * الذاكرة وربط الدور في cli.ts.
 *
 * كشف الاستئناف نفسه يعيش في `@abdo/providers` (routing.ts) لأنّ مسار
 * النموذج يجب أن يوجّه كلَّ استئنافٍ إلى مسار الوكيل — قائمةٌ واحدة لا قائمتان
 * (2026-09-02: «تابع» كان استئنافاً هنا ودردشةً هناك). يُعاد تصديره من هنا.
 */
import { isResumeIntent } from "@abdo/providers"

export { isResumeIntent }

export interface PriorGoal {
  readonly goal: string
  readonly turnId: string
  readonly status?: string
}

const TURN_KEY = /^turn:([^:]+)$/u

/**
 * يختار آخر هدفٍ حقيقيّ من حقائق الأدوار (`turn:<id>` لا حقائق الحقب)،
 * متجاوزاً الأهداف التي هي نفسها استئناف — فالاستئناف المتسلسل يظلّ يشير
 * إلى الهدف الفعليّ. الحقائق مُلحَقة زمنياً، فالأخير في المصفوفة هو الأحدث.
 *
 * الحالة تُستهلَك: هدفٌ غير مختوم (running/checkpointed) يسبق هدفاً مكتملاً
 * ولو كان المكتمل أحدث — فـ«اكمل» بعد دورٍ مكتمل لا يعيد فرض بوابات عملٍ
 * منجَز ما دام عملٌ معلّق موجوداً. إن لم يوجد إلا المكتمل أُعيد بحالته
 * ليُصرَّح بها للمشغّل والنموذج. الحالة `answered` (البوابة الأمامية أجابت بلا
 * أدوات) تُتخطّى دائماً — ليست هدفاً ولا تُعاد ولو كانت وحدها.
 */
export function pickPriorGoal(facts: readonly { key: string; value: unknown }[]): PriorGoal | undefined {
  let completed: PriorGoal | undefined
  const latest = new Map<string, { candidate: PriorGoal; resumedFrom?: string; index: number }>()
  const seen = new Set<string>()
  for (let i = facts.length - 1; i >= 0; i--) {
    const fact = facts[i]
    const match = TURN_KEY.exec(fact.key)
    if (match === null) continue
    if (seen.has(match[1])) continue
    seen.add(match[1])
    const value = fact.value
    if (typeof value !== "object" || value === null) continue
    const goal = (value as { goal?: unknown }).goal
    if (typeof goal !== "string" || goal.trim().length === 0) continue
    if (isResumeIntent(goal)) continue
    const status = (value as { status?: unknown }).status
    const candidate: PriorGoal = { goal, turnId: match[1], ...(typeof status === "string" ? { status } : {}) }
    // دورٌ أجابته البوابة الأمامية بلا أدوات (routerGate) ليس هدف عملٍ قطّ — «اكمل» بعد
    // تحيّةٍ مُجابة يستأنف آخر هدفٍ حقيقيّ لا التحيّة.
    if (candidate.status === "answered") continue
    const resumedFrom = (value as { resumedFrom?: unknown }).resumedFrom
    latest.set(candidate.turnId, {candidate, index:i, ...(typeof resumedFrom === "string" ? {resumedFrom} : {})})
  }
  // A continuation replaces only an older checkpoint of the same inherited
  // goal. Follow the recorded lineage, never similarity or another session.
  const superseded = new Set<string>()
  for (const entry of latest.values()) {
    const ancestor = entry.resumedFrom ? latest.get(entry.resumedFrom) : undefined
    if (ancestor && ancestor.index < entry.index && ancestor.candidate.goal.trim() === entry.candidate.goal.trim()) superseded.add(ancestor.candidate.turnId)
  }
  for (const {candidate} of latest.values()) {
    if (superseded.has(candidate.turnId)) continue
    if (candidate.status === "completed") {
      completed ??= candidate
      continue
    }
    return candidate
  }
  return completed
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  completed: "مكتمل",
  checkpointed: "نقطة حفظ غير مكتملة",
  running: "لم يُختَم",
  answered: "أُجيب مباشرة",
}

/** حالة الهدف السابق بلفظٍ عربيّ قصير؛ حالةٌ غير معروفة تُعاد بنصّها. */
export const priorGoalStatusLabel = (status?: string): string | undefined =>
  status === undefined ? undefined : (STATUS_LABELS[status] ?? status)

/** سطرٌ واحد يُحقن في مدخل الحقبة الأولى قبل نصّ الدور — يسمّي الهدف الأصلي وحالته ومن أين يُقرأ التسليم. */
export function resumeBrief(prior: PriorGoal): string {
  const label = priorGoalStatusLabel(prior.status)
  const state = label === undefined
    ? ""
    : prior.status === "completed"
      ? ` حالته: ${label} — تحقّق من NEXT_ACTION.md قبل إعادة العمل.`
      : ` حالته: ${label}.`
  return `↩ استئناف: الهدف الأصلي من الدور ${prior.turnId}: «${prior.goal}».${state} اقرأ ABDO-HANDOFF.md وNEXT_ACTION.md ثم واصل من أول سبرنت غير مكتمل بإيصالات حقيقية.\n`
}

/** حدث المشغّل عند الاستئناف — يسمّي الدور وحالته والهدف مقتطعاً. */
export function resumeAnnouncement(prior: PriorGoal): string {
  const label = priorGoalStatusLabel(prior.status)
  return `↩ استئناف الهدف الأصلي (الدور ${prior.turnId}${label === undefined ? "" : ` · ${label}`}): ${prior.goal.slice(0, 160)}`
}
