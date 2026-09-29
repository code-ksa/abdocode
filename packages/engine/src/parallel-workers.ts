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
  const tasks = raw.map((t) => t.trim().replace(/^[-*\d.)\s]+/u, "").trim()).filter((t) => t.length > 0 && !t.startsWith("#") && !/^(?:<<<|>>>|`{3,}\w*)$/u.test(t))
  if (tasks.length < 2) return `parallel يحتاج مهمّتين مستقلّتين على الأقلّ — لمهمّةٍ واحدة نفّذها مباشرةً. ${PARALLEL_USAGE}`
  if (tasks.length > PARALLEL_MAX) return `parallel حتى ${PARALLEL_MAX} مهامّ (وردت ${tasks.length}) — اجمع المتقارب أو قسّم على جولتين.`
  const unique = [...new Set(tasks)]
  if (unique.length !== tasks.length) return "مهمّتان متطابقتان في parallel — كلُّ عاملٍ يحتاج مهمّةً مختلفة."
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
