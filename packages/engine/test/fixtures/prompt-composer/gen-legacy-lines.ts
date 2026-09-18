/**
 * مولِّدُ `src/prompt-legacy-lines.ts` من بايتات الكود **قبل** S1.
 *
 * مقيس عند أوّل التقاط: نقلُ الأسطر العربيّة باليد يعيد ترتيبَ التشكيل (NFC يضع
 * التنوين قبل الشدّة: «كلٌّ» صارت بايتاتٍ أخرى) فيسقط المسمارُ الذهبيّ. فلا يُنقل
 * حرفٌ عربيٌّ باليد: كلُّ سلسلةٍ في المُركِّب تُقتطع من الإيداع المثبَّت بهذا السكربت.
 *
 * التشغيل (من جذر المستودع): `bun packages/engine/test/fixtures/prompt-composer/gen-legacy-lines.ts`
 */
const PRE_CHANGE_COMMIT = "e7181a7c36"
const repoRoot = new URL("../../../../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1")
const proc = Bun.spawnSync(["git", "show", `${PRE_CHANGE_COMMIT}:packages/engine/src/cli.ts`], { cwd: repoRoot })
if (proc.exitCode !== 0) throw new Error(`git show failed: ${proc.stderr.toString()}`)
const preChange = proc.stdout.toString().replace(/\r\n/gu, "\n")

const HEAD_MARK = "const baseSystem = hooks.conversationMode==='chat' ? CHAT_SYSTEM : "
const TAIL_MARK = "\"{{tool-catalogue}}\""
const start = preChange.indexOf(HEAD_MARK)
if (start < 0) throw new Error("baseSystem head not found")
const exprStart = start + HEAD_MARK.length
const exprEnd = preChange.indexOf(TAIL_MARK, exprStart) + TAIL_MARK.length
const expression = preChange.slice(exprStart, exprEnd)

/** أسماءُ السلاسل غير الفارغة بترتيب ظهورها في التعبير القديم (يُفحص العدد والمطلع). */
const NAMES: readonly { readonly name: string; readonly head: string }[] = [
  { name: "identityWho", head: "أنت «عبدو كود»" },
  { name: "identityNotClient", head: "هذا اسم المساعد" },
  { name: "coachNoCompany", head: "لا توجد مشاريع شركة" },
  { name: "coachLocateProject", head: "حين يسمّي المستخدم" },
  { name: "coachStaleContext", head: "ملفات المشروع وملخصات" },
  { name: "planningOnly", head: "أنت الآن في مرحلة التخطيط" },
  { name: "rootIsFinal", head: "مجلد المشروع المختار" },
  { name: "sprintPlanWrite", head: "هذه مهمة استقلالية" },
  { name: "sprintPlanUnapproved", head: "خطة ABDO-SPRINTS.md مكتوبة" },
  { name: "sprintPlanApproved", head: "خطة ABDO-SPRINTS.md موجودة" },
  { name: "coachNextMinimal", head: "عند إنشاء موقع Next.js" },
  { name: "coachNextLatest", head: "للمشروع الجديد استعمل" },
  { name: "coachNoFabrication", head: "لا تختلق أرقام" },
  { name: "coachComputeExpectation", head: "قبل كتابة توقع" },
  { name: "contractOneTool", head: "عند الحاجة إلى أداة" },
  { name: "contractReadBundle", head: "الاستثناء" },
  { name: "readInChunks", head: "اقرأ الملفات الكبيرة" },
  { name: "coachKeepGoal", head: "حافظ على الهدف" },
  { name: "donePlanning", head: "اكتمال هذا الدور" },
  { name: "doneExecution", head: "لا تقل تم" },
  { name: "coachSuggestNext", head: "إذا بقي عمل" },
  { name: "replyLanguage", head: "أجب باللغة" },
  { name: "catalogue", head: "{{tool-catalogue}}" },
]

// تقطيعُ السلاسل المزدوجة الاقتباس كما في المصدر (بهروبها) — لا تفسيرَ ولا تطبيع.
const literals: string[] = []
for (let i = 0; i < expression.length; i += 1) {
  if (expression[i] !== "\"") continue
  let j = i + 1
  while (j < expression.length && expression[j] !== "\"") { if (expression[j] === "\\") j += 1; j += 1 }
  const raw = expression.slice(i, j + 1)
  if (raw !== "\"\"" && raw !== "\"1\"") literals.push(raw)
  i = j
}
if (literals.length !== NAMES.length) throw new Error(`expected ${NAMES.length} literals, found ${literals.length}`)
const heads = NAMES.map((n, k) => {
  const raw = literals[k]!
  // المطلعُ يُقارن بعد طيّ التشكيل من الجانبين — التسميةُ لا البايتات.
  const fold = (s: string) => s.normalize("NFD").replace(/[ً-ْ]/gu, "")
  if (!fold(raw.slice(1)).startsWith(fold(n.head))) throw new Error(`literal ${k} «${raw.slice(1, 40)}» does not start with «${n.head}» (${n.name})`)
  return `  ${n.name}: ${raw},`
})

const header = `/**
 * أسطرُ رسالة النظام القديمة — **مولَّدٌ لا يُحرَّر باليد**.
 *
 * المصدر: \`${PRE_CHANGE_COMMIT}:packages/engine/src/cli.ts\` (تعبيرُ baseSystem قبل S1)،
 * المولِّد: \`test/fixtures/prompt-composer/gen-legacy-lines.ts\`.
 *
 * لماذا مولَّد: النقلُ اليدويّ يعيد ترتيبَ التشكيل (NFC) فتتغيّر البايتات ويسقط
 * المسمارُ الذهبيّ. كلُّ سلسلةٍ هنا بايتاتُ المصدر حرفيّاً بهروبها.
 */
export const LEGACY_LINES = Object.freeze({
`
const out = `${header}${heads.join("\n")}\n})\n`
const target = new URL("../../../src/prompt-legacy-lines.ts", import.meta.url)
await Bun.write(target, out)
console.log(`wrote ${literals.length} literals → ${target.pathname}`)
for (const [k, n] of NAMES.entries()) console.log(`  ${n.name}: ${Buffer.byteLength(literals[k]!, "utf8")}b`)
