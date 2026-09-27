/**
 * إتاحةُ الأدوات — أداةٌ شرطُها غائبٌ لا تُعلَن (البند 12 من جرد هيرمس/أوبن‑كلاو؛ الفكرةُ من openclaw
 * `src/tools/types.ts` ToolAvailabilitySignal، لا الشيفرة).
 *
 * مقيس 2026-09-27 على المحرّك الحقيقيّ في إعدادٍ عاديّ (تحكّمُ سطح المكتب مطفأ، مشروعٌ بلا git): كان النموذجُ
 * يرى `desk` و`git` بأخواتها، فيُنفق نداءً عليها ثمّ يُرفض — «مسجَّلةٌ» ليست «قابلةً للاستدعاء». والإخفاءُ هنا
 * إعلانٌ فقط: المُوزِّعُ ما زال يرفض الأداةَ باسمها إن سُمّيت، فلا قدرةَ تُفتح ولا تُغلق من هذا الملفّ.
 *
 * الشروطُ حتميّةٌ رخيصة (ملفٌّ على القرص، قيمةٌ في الإعدادات) — ما لا يُقاس هكذا (خادمُ لغة، نموذجُ رؤية)
 * لا يُخمَّن هنا.
 */

export interface AvailabilityFacts {
  /** `desktopControlEnabled` في الإعدادات — مطفأً يرفض المُوزِّعُ كلَّ `desk`. */
  readonly desktopControl: boolean
  /** مجلّدُ المشروع مستودعُ git (`.git` مجلّداً أو ملفَّ شجرةِ عمل). */
  readonly gitRepository: boolean
}

type Condition = keyof AvailabilityFacts

const CONDITIONS: Readonly<Record<string, Condition>> = Object.freeze({
  desk: "desktopControl",
  git: "gitRepository",
  "git-stage": "gitRepository",
  "git-unstage": "gitRepository",
  "git-commit": "gitRepository",
})

export const UNAVAILABLE_BECAUSE: Readonly<Record<Condition, string>> = Object.freeze({
  desktopControl: "تحكّمُ سطح المكتب مطفأ في الإعدادات",
  gitRepository: "المشروعُ ليس مستودعَ git",
})

/** سببُ الإخفاء، أو `undefined` حين تُتاح الأداة (أو لا شرطَ لها). */
export function unavailableBecause(toolName: string, facts: AvailabilityFacts): string | undefined {
  const condition = CONDITIONS[toolName]
  if (condition === undefined || facts[condition]) return undefined
  return UNAVAILABLE_BECAUSE[condition]
}

/** سطرٌ واحد للدور: ما أُخفي ولماذا — مجمَّعاً بالسبب. فارغٌ حين لا شيء. */
export function hiddenToolsLine(toolNames: readonly string[], facts: AvailabilityFacts): string {
  const byReason = new Map<string, string[]>()
  for (const name of toolNames) {
    const reason = unavailableBecause(name, facts)
    if (reason !== undefined) byReason.set(reason, [...(byReason.get(reason) ?? []), name])
  }
  if (byReason.size === 0) return ""
  return `🧰 مخفيّةٌ لغياب شرطها: ${[...byReason].map(([reason, names]) => `${names.join("، ")} (${reason})`).join(" · ")}`
}
