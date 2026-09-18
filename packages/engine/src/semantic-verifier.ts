/** المحكّم الدلالي للتسليم — فكرة ممتصة من Anton (mindsdb/anton، session.py،
 * أفكار لا fork). بواباتنا الميكانيكية تثبت أن الشيفرة «تعمل»؛ هذا يثبت
 * أنها «فعلت المطلوب»: حكمٌ مستقل بعد نجاح البوابات، رباعي الحالات:
 * - COMPLETE: المطلوب سُلّم فعلاً.
 * - INCOMPLETE: ناقص محدد — يعاد للحلقة بتكملة مسمّاة.
 * - WAITING: النموذج طرح سؤالاً يحتاج جواب المشغّل — توقف مشروع لا فشل.
 * - STUCK: جدار بيئة (اعتماد/تنصيب/صلاحية) لا يعالجه مزيد المحاولة.
 *   تعريف STUCK بالجدران المسمّاة درسٌ مقيس عندهم: نقله من 0/12 إلى 12/12.
 *
 * دروس مدفوعة تُحترم هنا:
 * - «لا فشل مفتوحاً أبداً»: حكم غير صالح = «غير محكّم» يُختم على الرد،
 *   لا COMPLETE صامتة.
 * - القصّ يحفظ السبب: ذيل الإيصال هو الحامل للعلة، والحذف يُعلَّم بحجمه
 *   («قصٌّ صامت يجعل المحكّم يستدل من مقدمة كاذبة»).
 * - ميزانيتان منفصلتان: هدف المستخدم لا يزاحمه ضجيج حلقة الأدوات.
 */

export type SemanticStatus = "COMPLETE" | "INCOMPLETE" | "WAITING" | "STUCK"

export interface SemanticVerdict {
  readonly status: SemanticStatus
  readonly reason: string
}

/**
 * قصٌّ يعلن ما حُذف ويُبقي الرأسَ والذيل: آخرُ سطور traceback هي الحاملةُ للسبب (ثلاثةُ أرباع الميزانية للذيل)،
 * وأوّلُ سطور قائمةِ نتائج أداةٍ هي الدليل (الربعُ للرأس) — مقيس 2026-09-17: قصٌّ ذيليٌّ محض أخفى نصفَ نتائج
 * `scripts_find` عن المحكّم فحجب الاكتمالَ وهي أمام المستخدم كاملة.
 */
export function clipKeepCause(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max / 4)
  const tail = max - head
  return `${text.slice(0, head)}\n[... حُذف ${text.length - max} حرفاً من الوسط ...]\n${text.slice(text.length - tail)}`
}

const GOAL_BUDGET = 4000
const ANSWER_BUDGET = 4000
const RECEIPTS_BUDGET = 6000
const RECEIPT_CLIP = 700

export function buildVerifierPrompt(
  goal: string,
  answer: string,
  receipts: readonly { readonly command: string; readonly output: string }[],
): string {
  const lines: string[] = []
  let spent = 0
  for (let i = receipts.length - 1; i >= 0 && spent < RECEIPTS_BUDGET; i--) {
    const r = receipts[i]!
    const clipped = clipKeepCause(r.output, RECEIPT_CLIP)
    const entry = `$ ${r.command.split("\n", 1)[0]}\n${clipped}`
    lines.unshift(entry)
    spent += entry.length
  }
  if (lines.length < receipts.length) lines.unshift(`[... ${receipts.length - lines.length} إيصالاً أقدم حُذف ...]`)
  return [
    "أنت محكّم مستقل. لا تجامل ولا تفترض. احكم فقط مما تراه في الإيصالات.",
    "",
    "## المطلوب الأصلي",
    clipKeepCause(goal, GOAL_BUDGET),
    "",
    "## تسليم المنفّذ (ادّعاء لا دليل)",
    clipKeepCause(answer, ANSWER_BUDGET),
    "",
    "## إيصالات الأدوات المنفَّذة فعلاً (الدليل)",
    lines.join("\n\n"),
    "",
    "## حكمك",
    "أول سطر من ردك يجب أن يكون كلمة واحدة فقط من: COMPLETE أو INCOMPLETE أو WAITING أو STUCK",
    "والسطر الثاني سبباً واحداً محدداً.",
    "- COMPLETE: كل عناصر المطلوب لها دليل في الإيصالات.",
    "- INCOMPLETE: عنصر مسمّى من المطلوب بلا دليل — سمِّه.",
    "- WAITING: المنفّذ طرح سؤالاً يحتاج جواب المشغّل قبل المتابعة.",
    "- STUCK: جدار بيئة — اعتماد غائب، خدمة غير متاحة، أداة نظام لا تُنصَّب،",
    "  أو التفافات فاشلة متكررة حول العائق نفسه — حتى لو قال المنفّذ إنه سيجرّب طريقة أخرى.",
  ].join("\n")
}

const STATUSES: readonly SemanticStatus[] = ["COMPLETE", "INCOMPLETE", "WAITING", "STUCK"]

/** يقرأ الحكم من أول سطر يحمل إحدى الحالات الأربع (بلا حساسية حالة —
 * نموذج 9B يكتبها صغيرة أو موسومة). سطرٌ يحمل حالتين مختلفتين هو صدى
 * قائمة الخيارات من التعليمات لا حكم — يُتخطّى (المسح العدائي: صدى
 * «COMPLETE أو INCOMPLETE أو…» كان يُقرأ COMPLETE كاذبة). undefined =
 * حكم غير صالح — يُختم «غير محكّم» ولا يُترجم أبداً إلى COMPLETE. */
export function parseVerdict(reply: string): SemanticVerdict | undefined {
  const lines = reply.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)
  for (let i = 0; i < Math.min(lines.length, 4); i++) {
    const line = lines[i]!
    const m = line.match(/^[*#>\s-]*(complete|incomplete|waiting|stuck)\b[\s:،—–-]*(.*)$/iu)
    if (m === null) continue
    const status = m[1]!.toUpperCase() as SemanticStatus
    // صدى القائمة يحمل الحالات الأربع؛ سببٌ يذكر كلمة حالةٍ واحدة عرضاً
    // («INCOMPLETE — not complete yet») حكمٌ مشروع. العتبة: حالتان أُخريان.
    const otherCount = STATUSES.filter((s) => s !== status && new RegExp(`\\b${s}\\b`, "iu").test(line)).length
    if (otherCount >= 2) continue
    const sameLine = (m[2] ?? "").trim()
    const reason = (sameLine.length > 0 ? sameLine : lines.slice(i + 1).join(" ")).slice(0, 400) || "بلا سبب مذكور"
    return Object.freeze({ status, reason })
  }
  return undefined
}
