/** S11 — قياس حالة جيت: الحيّ والمتقدّم وغير المدفوع، بالقياس لا بالظنّ.
 *
 * كتالوج العائلة ٢: إنتاجٌ على فرعٍ غير مدفوع (الاسم يكذب)، وريموتٌ يسبق
 * المحلي، وكوميتاتٌ محلية لا يراها `ahead` (تُكشف بـ--all --not --remotes)،
 * وعلاماتُ تعارضٍ تدخل الشيفرة. القياس من جيت مباشرةً، والقرار للنموذج.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

// git يُستدعى مباشرةً لا عبر cmd: تغليف `cmd /c git a b c` يمرّر «git» وحدها
// ويلفظ «The syntax of the command is incorrect» (قيس). git.exe في PATH.
const runGit = (cwd: string, args: readonly string[]): { ok: boolean; out: string } => {
  try {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() }
  } catch {
    return { ok: false, out: "git غير متاح" }
  }
}

export interface GitState {
  readonly isRepo: boolean
  readonly branch?: string
  readonly ahead?: number
  readonly behind?: number
  readonly dirty?: number
  readonly unpushedAcrossAll?: number
  readonly conflictMarkers?: readonly string[]
  readonly report: string
}

/** يقيس حالة مستودعٍ في `cwd` ويعيد تقريراً بشرياً + أرقاماً. */
export function gitState(cwd: string): GitState {
  const inside = runGit(cwd, ["rev-parse", "--is-inside-work-tree"])
  if (!inside.ok || inside.out !== "true") return { isRepo: false, report: "ليس مستودع git." }

  const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).out
  const dirty = runGit(cwd, ["status", "--porcelain"]).out.split("\n").filter((l) => l.trim().length > 0).length

  let ahead: number | undefined
  let behind: number | undefined
  const upstream = runGit(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"])
  if (upstream.ok) {
    const counts = runGit(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]).out.split(/\s+/)
    behind = Number.parseInt(counts[0] ?? "0", 10)
    ahead = Number.parseInt(counts[1] ?? "0", 10)
  }

  // كوميتاتٌ لا يراها ahead: موجودة في أي مرجعٍ محليّ وليست في أيّ ريموت.
  const unpushed = runGit(cwd, ["log", "--all", "--not", "--remotes", "--oneline"])
  const unpushedAcrossAll = unpushed.ok ? unpushed.out.split("\n").filter((l) => l.trim().length > 0).length : undefined

  // علامات تعارضٍ في الملفات المتعقَّبة.
  const conflicts = runGit(cwd, ["grep", "-l", "-E", "^(<{7}|={7}|>{7}) "])
  const conflictMarkers = conflicts.ok && conflicts.out.length > 0 ? conflicts.out.split("\n").filter((l) => l.trim().length > 0) : []

  const lines = [`الفرع: ${branch}`]
  if (upstream.ok) lines.push(`مقابل ${upstream.out}: متقدّم ${ahead} · متأخّر ${behind}` + (behind && behind > 0 ? " ← اسحب/ادمج قبل الدفع" : ""))
  else lines.push("لا upstream مضبوط لهذا الفرع — الدفع يحتاج -u، وقد يكون الحيّ غير مدفوع أصلاً")
  lines.push(`تغييرات غير مودعة: ${dirty}`)
  if (unpushedAcrossAll !== undefined && unpushedAcrossAll > 0) lines.push(`⚠ ${unpushedAcrossAll} كوميت محليّ لا يوجد في أيّ ريموت (لا يراها ahead) — عملٌ معرّضٌ للضياع`)
  if (conflictMarkers.length > 0) lines.push(`🔴 علامات تعارض دمجٍ في: ${conflictMarkers.join("، ")} — لا تُبنى ولا تُدفع قبل حلّها`)

  return { isRepo: true, branch, ahead, behind, dirty, unpushedAcrossAll, conflictMarkers, report: lines.join("\n") }
}

const gitLines = (out: string): string[] => out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("warning:"))

/** م9ح — تغييراتُ الشجرة مقابل HEAD لحارة المراجعة: المتعقَّبُ فرقاً جاهزاً من git، وغيرُ المتعقَّب نصّاً كاملاً (حتى ٤٠ و٢٠ ملفّاً، ٦٤ كيلوبايت لكلّ ملفّ). */
export function gitChanges(cwd: string): { readonly path: string; readonly patch?: string; readonly after?: string }[] {
  const inside = runGit(cwd, ["rev-parse", "--is-inside-work-tree"])
  if (!inside.ok || inside.out !== "true") return []
  const out: { path: string; patch?: string; after?: string }[] = []
  const names = runGit(cwd, ["diff", "HEAD", "--name-only"])
  for (const name of (names.ok ? gitLines(names.out) : []).slice(0, 40)) {
    const patch = runGit(cwd, ["diff", "HEAD", "--", name])
    if (patch.ok && patch.out.length > 0) out.push({ path: name, patch: patch.out.split("\n").filter((l) => !l.startsWith("warning:")).join("\n").slice(0, 20_000) })
  }
  const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard"])
  for (const name of (untracked.ok ? gitLines(untracked.out) : []).slice(0, 20)) {
    try {
      const bytes = readFileSync(join(cwd, name))
      if (bytes.length > 65_536 || bytes.includes(0)) { out.push({ path: name }); continue }
      out.push({ path: name, after: bytes.toString("utf8") })
    } catch { out.push({ path: name }) }
  }
  return out
}
