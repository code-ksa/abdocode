/**
 * 09-29 — عمّالٌ متوازون في شجرات عملٍ معزولة (فكرةُ Verdent «Agent Deck»/worktrees، مكتوبةٌ على نظامنا لا fork):
 * الدورُ الأب يقسّم مهمّةً كبيرة إلى مهامَّ مستقلّة، وكلُّ مهمّةٍ تُنفَّذ بمحرّكٍ كاملٍ في `git worktree` وفرعٍ خاصّ
 * (`exec --worktree` القائم)، فلا تتزاحم الكتاباتُ ولا يُفسد عاملٌ شجرةَ غيره؛ ثمّ يعود تقريرٌ واحد بفروعها وملفّاتها،
 * والدمجُ قرارٌ صريح بأداة `merge` تمرّ ببوّابة الأوامر. السقفُ أربعةُ عمّال — أكثرُ من ذلك شجرةٌ لا يراها أحد.
 */

export const PARALLEL_MAX = 4
export const PARALLEL_USAGE = "الصيغة: parallel <<<\nمهمّة ١ (مستقلّة وكاملة الوصف)\nمهمّة ٢\n… (حتى أربع مهامّ، سطرٌ لكلّ مهمّة) — أو: parallel مهمّة ١ || مهمّة ٢"
export const MERGE_USAGE = "الصيغة: merge <فرع abdocode/task-XXXXXXXX> — يدمج فرعَ عاملٍ متوازٍ في الفرع الحاليّ (--no-ff)"
export const WORKER_BRANCH = /^abdocode\/task-[0-9a-f]{8}$/u

const NOT_TASK = (t: string): boolean => t.length === 0 || t.startsWith("#") || /^(?:<<<|>>>|`{3,}\w*)$/u.test(t)
const NUMBERED = /^\s*(?:\d+|[٠-٩]+)\s*[.)\-–:]\s+/u
const cleanLine = (t: string): string => t.trim().replace(/^[-*\d.)\s]+/u, "").trim()
/**
 * 10-11 (مقيس على m11 بعاملَين بالمثبَّت 4.0.145): النموذجُ كتب كلَّ مهمّةٍ رأساً وأسطرَ بنود («اقرأ العقد أوّلاً» في المهمّتين) فقُرئ كلُّ سطرٍ
 * مهمّةً، فرُفض «مهمّتان متطابقتان» ثلاثَ مرّاتٍ حتى بنى الأبُ كلَّ شيءٍ وحده. المهمّةُ متعدّدةُ الأسطر تُجمع: كتلٌ بينها سطرٌ فارغ،
 * أو رؤوسٌ مرقّمة تتبعها أسطرُها؛ وما عدا ذلك سطرٌ لكلّ مهمّة كما كان.
 */
function groupTasks(raw: readonly string[]): string[] {
  const body = raw.join("\n")
  const blocks = body.split(/\n[ \t]*\n/u).map((block) => block.split("\n").map((line) => line.trim()).filter((line) => !NOT_TASK(line)))
    .filter((lines) => lines.length > 0)
  if (blocks.length >= 2 && blocks.some((lines) => lines.length > 1)) return blocks.map((lines) => [cleanLine(lines[0]!), ...lines.slice(1)].join("\n").trim())
  const lines = raw.map((line) => line.trimEnd()).filter((line) => !NOT_TASK(line.trim()))
  const headers = lines.filter((line) => NUMBERED.test(line)).length
  if (headers >= 2 && lines.some((line) => !NUMBERED.test(line))) {
    const grouped: string[][] = []
    for (const line of lines) {
      if (NUMBERED.test(line) || grouped.length === 0) grouped.push([cleanLine(line)])
      else grouped[grouped.length - 1]!.push(line.trim())
    }
    return grouped.map((g) => g.join("\n").trim())
  }
  return lines.map(cleanLine).filter((t) => !NOT_TASK(t))
}

/** المهامُّ من جسم الأمر: كتلةُ `<<<` سطراً لكلّ مهمّة، أو مفصولةٌ بـ`||`. سلسلةٌ = رفضٌ مسمّى. */
export function parseParallelTasks(body: string): string[] | string {
  const marker = body.match(/\s<<<(?:\r?\n|[ \t])/u)
  let raw: string[]
  if (marker?.index !== undefined) {
    raw = body.slice(marker.index + marker[0].length).split(/\r?\n/u)
  } else {
    const inline = body.replace(/^\s*parallel\s*/u, "")
    raw = inline.split(/\|\|/u)
  }
  // 09-29 (مقيس على تطبيق المالك): جاء الجسمُ «parallel <<<» بلا مهامّ فقرأ المحلّلُ العلامةَ مهمّةً وقال «أقصر من أن تُفوَّض: «<<<»» —
  // علامةُ الكتلة وسياجاتُ الشيفرة (```) ليست مهامّ؛ تُهمَل فيصل النموذجَ سطرُ الصيغة الصحيح.
  const tasks = groupTasks(raw)
  if (tasks.length < 2) return `parallel يحتاج مهمّتين مستقلّتين على الأقلّ — لمهمّةٍ واحدة نفّذها مباشرةً. ${PARALLEL_USAGE}`
  if (tasks.length > PARALLEL_MAX) return `parallel حتى ${PARALLEL_MAX} مهامّ (وردت ${tasks.length}) — اجمع المتقارب أو قسّم على جولتين.`
  const unique = [...new Set(tasks)]
  if (unique.length !== tasks.length) return "مهمّتان متطابقتان في parallel — كلُّ عاملٍ يحتاج مهمّةً مختلفة. إن كانت المهمّةُ أسطراً فافصل بين المهامّ بسطرٍ فارغ أو رقّم رأسَ كلٍّ (1. … ثمّ 2. …) — كلُّ سطرٍ وحده مهمّةٌ مستقلّة."
  for (const t of unique) if (t.length < 12) return `مهمّةٌ أقصر من أن تُفوَّض: «${t}» — صف ما يُبنى وأين وكيف يُتحقَّق منه.`
  return unique
}

export interface WorkerOutcome {
  readonly task: string
  readonly outcome: string
  readonly stop?: string
  readonly durationMs: number
  readonly toolCount: number
  readonly failedTools: number
  readonly branch?: string
  readonly commit?: string
  readonly changedFiles: readonly string[]
  readonly answer: string
  readonly reason?: string
  readonly gates?: string
}

/** تقريرٌ واحد للأب: لكلّ عاملٍ فرعُه وملفّاتُه وخلاصتُه — والدمجُ قرارٌ لاحق بالاسم. */
export function renderParallelReport(workers: readonly WorkerOutcome[]): string {
  const lines: string[] = [`🧵 عمّالٌ متوازون: ${workers.length} — كلٌّ في فرعٍ وشجرة عملٍ معزولة`]
  workers.forEach((w, i) => {
    const head = `[${i + 1}] ${w.outcome}${w.stop === undefined ? "" : ` (${w.stop})`} · ${w.toolCount} أداة${w.failedTools > 0 ? ` (${w.failedTools} فشلت)` : ""} · ${Math.round(w.durationMs / 1000)} ث`
    lines.push(`${head}\n    المهمّة: ${w.task.slice(0, 140)}`)
    if (w.branch !== undefined) lines.push(`    الفرع: ${w.branch}${w.commit === undefined ? " (بلا إيداع — لم يتغيّر ملفّ)" : ` @ ${w.commit}`} · الملفّات: ${w.changedFiles.length === 0 ? "—" : w.changedFiles.slice(0, 12).join("، ")}${w.changedFiles.length > 12 ? " …" : ""}`)
    if (w.gates !== undefined) lines.push(`    ${w.gates.slice(0, 160)}`)
    if (w.reason !== undefined) lines.push(`    ⚠ ${w.reason.slice(0, 200)}`)
    if (w.answer.length > 0) lines.push(`    الخلاصة: ${w.answer.replace(/\s+/gu, " ").slice(0, 300)}`)
  })
  const mergeable = workers.filter((w) => w.branch !== undefined && w.commit !== undefined)
  lines.push(mergeable.length === 0
    ? "لا فرعَ فيه إيداع — لا شيءَ يُدمج."
    : `للدمج (واحداً واحداً، وابنِ/اختبر بعد كلّ دمج): ${mergeable.map((w) => `merge ${w.branch}`).join(" ثمّ ")}`)
  return lines.join("\n")
}

export function mergeBranchRefusal(branch: string): string | undefined {
  if (!WORKER_BRANCH.test(branch.trim())) return `${MERGE_USAGE} — «${branch.slice(0, 40)}» ليس فرعَ عاملٍ متوازٍ.`
  return undefined
}

/**
 * 09-30 (مقيس: «اكمل» على خطّة سبرنتين مستقلّين بعاملين): كلُّ عاملٍ قرأ ABDO-SPRINTS.md وتسليمَها فنفّذ السبرنتين معاً وأغلق
 * سبرنتَ غيره — وتعارض الدمجُ الثاني في ثلاثة ملفّات. العاملُ ينفّذ مهمّتَه وحدها، والخطّةُ وإغلاقُها للأب بعد الدمج.
 */
export const WORKER_SCOPE_NOTE = "أنت عاملٌ في فرعٍ معزول بين عمّالٍ متوازين: نفّذ هذه المهمّةَ وحدها — لا تنفّذ مهامَّ غيرِك ولو رأيتها في خطّةٍ أو تسليم، ولا تعدّل ABDO-SPRINTS.md ولا ABDO-HANDOFF.md؛ إغلاقُ السبرنتات للأب بعد الدمج. خادمُك على المنفذ الذي يسمّيه إيصالُ run --bg — افحص به لا بمنفذٍ تفترضه. تحقّق من جزئك وحده (اختباراتُه إن وُجدت)؛ البناءُ الكامل والاختباراتُ والتدقيقُ عند الأب بعد الدمج — لا تضف ما يخصّ عاملاً آخر لتمرير فحص."
export const workerTask = (task: string): string => `${task}\n\n(${WORKER_SCOPE_NOTE})`
/** إزاحةُ منفذ العامل: كلُّ عاملٍ في عشرةٍ خاصّة (3010، 3020…) — عاملان يقلعان في اللحظة نفسها لا يتسابقان على 3000. */
export const workerPortOffset = (index: number): number => 10 * (index + 1)

/**
 * 10-11: العميلُ سمّى عدداً من العمّال، فبنى الأبُ التطبيقَ كلَّه بنفسه (178 ث) ثمّ أطلق عاملَين
 * يعيدانه. العددُ الذي يسمّيه الطلبُ يُقرأ، فيُطلب التقسيمُ أوّلاً لا بعد العمل. `undefined` = لم يُسمِّ عدداً.
 */
const WORKER_WORD = String.raw`(?:عمّال|عمال|عامل(?:اً|ا)?|وكلاء|وكيل(?:اً|ا)?|workers?|agents?)`
const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({ "اثنين": 2, "اثنان": 2, "ثلاثة": 3, "ثلاث": 3, "أربعة": 4, "اربعة": 4, "أربع": 4, "اربع": 4, two: 2, three: 3, four: 4 })
export function requestedWorkers(text: string): number | undefined {
  const t = text.replace(/[ً-ْ]/gu, "")
  if (/(?:^|[^\p{L}])(?:ب|و|ل)?(?:عاملين|عاملان|وكيلين|وكيلان)(?![\p{L}])/u.test(t)) return 2
  const digit = new RegExp(String.raw`(?:^|[^\p{L}\d])(?:ب|و)?\s*(\d{1,2})\s*${WORKER_WORD}(?![\p{L}])`, "u").exec(t)?.[1]
  const word = new RegExp(String.raw`(?:^|[^\p{L}])(?:ب)?(${Object.keys(NUMBER_WORDS).join("|")})\s+${WORKER_WORD}(?![\p{L}])`, "iu").exec(t)?.[1]
  const n = digit !== undefined ? Number.parseInt(digit, 10) : word !== undefined ? NUMBER_WORDS[word.toLowerCase()] : undefined
  return n !== undefined && n >= 2 ? Math.min(PARALLEL_MAX, n) : undefined
}
