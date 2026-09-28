/**
 * دليلُ القرص للمحكّم — «اسأل القرصَ لا الدالّة» (منهج السبرنت §4). المحكّمُ المستقلّ كان يرى المطلوبَ وادّعاءَ المنفّذ وإيصالاتِ
 * أدواته: كلُّها روايةُ الدور عن نفسه. هنا يرى **ما تغيّر فعلاً على القرص في هذا الدور** مقروءاً من git لحظةَ التحكيم.
 *
 * «في هذا الدور» جزءٌ من الميزة: مستودعٌ متّسخٌ قبل الدور (عملُ جلسةٍ أخرى، ملفّاتٌ غير مودَعة) ليس تسليمَ المنفّذ، فلقطةٌ عند
 * بدء الدور (المسارُ ← الحجم:وقتُ التعديل) تُطرح من حال التحكيم. والأسرارُ تُحجب قبل أن يصل الفرقُ نموذجاً.
 */
import { statSync } from "node:fs"
import { join } from "node:path"
import { redact } from "@abdo/tools/secrets"
import { clipKeepCause } from "./semantic-verifier"

export type GitRun = (args: readonly string[]) => { readonly ok: boolean; readonly out: string }

export type DiskSnapshot = ReadonlyMap<string, string>

const DIFF_BUDGET = 6000
const NEW_FILE_LINES = 40
const MAX_PATHS = 40

/** مسارُ سطر porcelain (v1): «XY path» أو «XY old -> new» — والمقتبسُ يُفكّ علامتاه. */
function porcelainPaths(out: string): { readonly path: string; readonly untracked: boolean }[] {
  return out.split("\n").filter((line) => line.length > 3).map((line) => {
    const raw = line.slice(3).split(" -> ").at(-1)!.trim()
    return { path: raw.startsWith("\"") && raw.endsWith("\"") ? raw.slice(1, -1) : raw, untracked: line.startsWith("??") }
  })
}

function stamp(root: string, path: string): string {
  try { const s = statSync(join(root, path)); return `${s.size}:${s.mtimeMs}` } catch { return "absent" }
}

/** لقطةُ بدء الدور: كلُّ مسارٍ متّسخٍ وختمُه. undefined = ليس مستودعاً (فلا دليلَ قرصٍ يُدّعى). */
export function diskSnapshot(root: string, git: GitRun): DiskSnapshot | undefined {
  if (!git(["rev-parse", "--is-inside-work-tree"]).ok) return undefined
  const status = git(["status", "--porcelain"])
  if (!status.ok) return undefined
  return new Map(porcelainPaths(status.out).map(({ path }) => [path, stamp(root, path)]))
}

/**
 * ما تغيّر منذ اللقطة: فرقُ المتتبَّع، ورأسُ الجديد غير المتتبَّع، محجوبَي الأسرار ومقصوصَين بإعلان.
 * undefined = لا لقطة (ليس مستودعاً) — والمحكّمُ حينها بلا قسمٍ لا بقسمٍ فارغٍ يوهم «لا تغيير».
 */
export function diskEvidence(root: string, git: GitRun, before: DiskSnapshot | undefined, readHead: (path: string, lines: number) => string): string | undefined {
  if (before === undefined) return undefined
  const status = git(["status", "--porcelain"])
  if (!status.ok) return undefined
  const changed = porcelainPaths(status.out).filter(({ path }) => before.get(path) !== stamp(root, path))
  if (changed.length === 0) return "(لا ملفَّ تغيّر على القرص في هذا الدور.)"
  const listed = changed.slice(0, MAX_PATHS)
  const tracked = listed.filter((c) => !c.untracked).map((c) => c.path)
  const parts = [`${changed.length} مساراً تغيّر في هذا الدور:`, ...listed.map((c) => `${c.untracked ? "+ (جديد)" : "~"} ${c.path}`)]
  if (changed.length > listed.length) parts.push(`… و${changed.length - listed.length} مساراً آخر`)
  if (tracked.length > 0) {
    const diff = git(["diff", "HEAD", "--no-color", "--no-ext-diff", "--no-textconv", "-U2", "--", ...tracked])
    if (diff.ok && diff.out.trim() !== "") parts.push("", clipKeepCause(diff.out, DIFF_BUDGET))
  }
  for (const c of listed.filter((c) => c.untracked && !c.path.endsWith("/")).slice(0, 6)) {
    parts.push("", `--- ${c.path} (جديد، أوّلُ ${NEW_FILE_LINES} سطراً)`, readHead(c.path, NEW_FILE_LINES))
  }
  return redact(parts.join("\n"))
}
