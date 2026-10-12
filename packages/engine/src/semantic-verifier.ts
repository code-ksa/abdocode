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
// 10-11 (مقيس على m11 بالمثبَّت 4.0.143): «release-check: FAIL — 2/3 مرحلة [... حُذف 13 حرفاً من الوسط ...]» — قصٌّ وفّر 13 حرفاً وأخفى اسمَ المرحلة
// الفاشلة، فحجب المحكّمُ الاكتمالَ لأنّه لا يرى ما فشل. فيضٌ صغير يُعرض كاملاً، وسطورُ الفشل من الوسط المحذوف تُحمل في علامة القصّ.
const CLIP_SLACK = 160
const FAILURE_LINE = /\b(?:FAIL(?:ED|URE)?|ERROR|error:)|[✗✘❌]/u
export function clipKeepCause(text: string, max: number): string {
  if (text.length <= max + CLIP_SLACK) return text
  const head = Math.floor(max / 4)
  const tail = max - head
  const dropped = text.slice(head, text.length - tail)
  const failures = dropped.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0 && FAILURE_LINE.test(line)).slice(0, 3).map((line) => line.slice(0, 200))
  const kept = failures.length === 0 ? "" : `؛ سطورُ الفشل منه: ${failures.join(" ⏎ ")}`
  return `${text.slice(0, head)}\n[... حُذف ${text.length - max} حرفاً من الوسط${kept} ...]\n${text.slice(text.length - tail)}`
}

const GOAL_BUDGET = 4000
const ANSWER_BUDGET = 4000
const RECEIPTS_BUDGET = 6000
const RECEIPT_CLIP = 700
/**
 * 10-11 (مقيس على n8n-clone، دورٌ بـ222 أداة): release-check ‏PASS 7/7 نُفّذ في الحقبة 4 و«sprint done 16» بعده، والمحكّمُ رأى آخرَ ثمانية
 * إيصالاتٍ وحدها فحكم «PASS مذكورٌ بلا إيصال» وحجب الاكتمال — وأخطأ مثلها في S15. آخرُ إيصالٍ لكلّ بوّابةٍ يدخل دائماً (مقصوصاً، سطرُ
 * الحكم أوّلاً) قبل أن تملأ الأحدثُ ما بقي.
 */
const GATE_BUDGET = 3200
const GATE_CLIP = 360
// 10-11 (مقيس على m11 بعاملَين بالمثبَّت 4.0.144): المحكّمُ حجب «لا إيصالَ يثبت تشغيلَ عاملَين» — إيصالُ parallel أقدمُ وأطولُ فأزاحته الأحدث.
// تقريرُ العمّال ودمجُ كلِّ فرعٍ دليلُ «اعمل بعاملين» كما البناءُ دليلُ «ابنِ».
const GATE_RECEIPT = /^(?:release-check|sprint\s+done\s+\d+|seo|audit|probe|verify-\S+|parallel|merge\s+\S+|run\s+(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck|lint|test(?::\S+)?|audit)|run\s+npx\s+(?:tsc|vitest|prisma\s+migrate\s+diff))(?=\s|$)/u
export function gateKey(command: string): string | undefined {
  const first = command.split("\n", 1)[0]!.trim()
  return GATE_RECEIPT.exec(first)?.[0].replace(/\s+/gu, " ")
}

export function buildVerifierPrompt(
  goal: string,
  answer: string,
  receipts: readonly { readonly command: string; readonly output: string }[],
  disk?: string,
): string {
  const chosen = new Map<number, string>()
  const seenGates = new Set<string>()
  let gateSpent = 0
  for (let i = receipts.length - 1; i >= 0 && gateSpent < GATE_BUDGET; i--) {
    const r = receipts[i]!
    const key = gateKey(r.command)
    if (key === undefined || seenGates.has(key)) continue
    seenGates.add(key)
    const [verdict = "", ...rest] = r.output.split("\n")
    const entry = `$ ${r.command.split("\n", 1)[0]}\n${verdict.slice(0, 200)}${rest.length > 0 ? `\n${clipKeepCause(rest.join("\n"), GATE_CLIP)}` : ""}`
    chosen.set(i, entry)
    gateSpent += entry.length
  }
  let spent = 0
  for (let i = receipts.length - 1; i >= 0 && spent < RECEIPTS_BUDGET; i--) {
    if (chosen.has(i)) continue
    const r = receipts[i]!
    const entry = `$ ${r.command.split("\n", 1)[0]}\n${clipKeepCause(r.output, RECEIPT_CLIP)}`
    chosen.set(i, entry)
    spent += entry.length
  }
  const lines = [...chosen.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry)
  if (lines.length < receipts.length) lines.unshift(`[... ${receipts.length - lines.length} إيصالاً أقدم حُذف — وآخرُ إيصالٍ لكلّ بوّابة (release-check/sprint done/build/test/audit…) محفوظٌ أدناه ...]`)
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
    // دليلُ القرص (disk-evidence.ts): ما تغيّر فعلاً في هذا الدور مقروءاً من git لحظةَ التحكيم — لا روايةُ الدور عن نفسه.
    ...(disk === undefined ? [] : ["## ما تغيّر فعلاً على القرص في هذا الدور (من git لحظةَ التحكيم — الحَكَم عند التعارض)", disk, ""]),
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
