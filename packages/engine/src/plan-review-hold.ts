/**
 * 10-10 مقيسٌ في مهمّة n8n أنّ عبدو كود قال «أعرض الخطّة وأتوقّف للمراجعة» ثمّ شغّل npm install وnpm run build في
 * الدور نفسِه. آليّةُ اعتماد الخطّة (plan-approve) قائمة لكنّها خلف ABDO_REQUIRE_SPRINT_PLAN الذي لا تضبطه القشرة، وفي الوصول الكامل يمرّ
 * plan-approve بلا يد المستخدم — فالنموذجُ يعتمد خطّتَه بنفسه.
 *
 * الحجزُ هنا لكلّ دور: إذا طلب المستخدمُ في رسالة هذا الدور التوقّفَ للمراجعة (أو كان الطلبُ استنساخَ موقعٍ من مرجع — خطوتُه الخامسة «اعرض
 * الخطّة وتوقّف») وكُتبت ABDO-SPRINTS.md في هذا الدور، فما بعدها قراءةٌ ومرجعٌ وكتابةُ ملفّات الخطّة فقط حتى رسالةٍ جديدة من المستخدم
 * («اكمل»). القرارُ حتميّ من نصّ المستخدم وتوقيت الملفّ — لا من وعد النموذج.
 */
import { asksReferenceClone } from "./reference-clone"

const REVIEW_WORDS = /(?:توقّ?ف|انتظر|قف)[^\n.]{0,60}(?:حتى|حتّى|لين|إلى أن|الى ان)|حتّ?ى أقول|(?:راجع|مراجعة|لمراجعة|للمراجعة)[^\n.]{0,24}(?:الخطّ?ة|الخطه)|(?:اعرض|اعرضها)[^\n.]{0,30}(?:وتوقّ?ف|ثم توقّ?ف)|بلا (?:تثبيت|بناء)[^\n.]{0,20}قبل|\b(?:stop|wait)\b[^\n.]{0,40}\b(?:review|approv\w*|until I say)\b/iu

/** Pure. Whether this turn's own message asks the agent to stop after presenting the plan. */
export function asksPlanReview(userText: string): boolean {
  const text = String(userText ?? "").slice(0, 8000)
  return REVIEW_WORDS.test(text) || asksReferenceClone(text)
}

const READ_TOOLS = new Set(["read", "list", "glob", "grep", "plan", "templates", "project-inspect", "project-orient", "open", "page", "shot", "look", "find", "styles", "history", "sessions", "back", "forward", "tabs", "status", "fetch"])
const PLAN_FILES = /^(?:abdo-sprints\.md|abdo-handoff\.md|reference\.md|abdo-plans\/[^/]+\.md|\.abdo\/reference\/.+)$/u

/** Pure. The refusal for a tool while the plan waits for the user's review — undefined when the tool may run. */
export function planHoldRefusal(tool: string, target: string | undefined): string | undefined {
  if (READ_TOOLS.has(tool) || /^chrome\.(?:page|look|shot|inspect|save|tabs|devtools|browsers|open|scroll|back|forward)$/u.test(tool)) return undefined
  if ((tool === "write" || tool === "edit" || tool === "patch") && target !== undefined && PLAN_FILES.test(target.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase())) return undefined
  return `الخطّةُ معروضةٌ لمراجعة المستخدم (طلب التوقّف في رسالته) — «${tool}» ينتظر رسالتَه التالية («اكمل»). أنهِ الدورَ الآن بملخّص الخطّة وما تغيّر فيها؛ لا تثبيتَ ولا بناءَ ولا كودَ منتجٍ ولا plan-approve في هذا الدور.`
}
