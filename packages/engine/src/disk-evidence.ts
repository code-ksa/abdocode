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
// 10-11 (مقيس على m11 بالمثبَّت 4.0.140): المحكّمُ حجب «لا اختبارَ يثبت DELETE لمعرّفٍ غير موجود ⇦ 404» والاختبارُ يثبته في سطوره الأخيرة —
// رأى أسماءَ الاختبارات وحدها فأنفق حقبةً ومراجعةً ثانية (77 ث). الاختبارُ دليلُ السلوك: يُعرض أطولَ وأوّلاً.
const TEST_FILE_LINES = 220
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/iu
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

/**
 * حالُ المشروع وحده: `status` مقصورٌ على مجلّده ومساراتُه منسوبةٌ إليه (porcelain ينسبها إلى جذر المستودع).
 * 10-11 (مقيس: m7 في مجلّدِ قياس داخل مستودعٌ أكبر و`tmp/` متجاهَل): git «داخل شجرة» لكنّه لا يرى شيئاً فقيل للمحكّم «لا ملفَّ
 * تغيّر» وقد كُتب ملفّان — فحجب الاكتمال. مشروعٌ يتجاهله مستودعُه الأبُ لا دليلَ قرصٍ له (undefined)، لا دليلٌ فارغٌ يكذب.
 */
function projectStatus(git: GitRun): { readonly path: string; readonly untracked: boolean }[] | undefined {
  if (!git(["rev-parse", "--is-inside-work-tree"]).ok) return undefined
  if (git(["check-ignore", "-q", "."]).ok) return undefined
  const prefix = git(["rev-parse", "--show-prefix"])
  if (!prefix.ok) return undefined
  // 10-11 (مقيس على m11 بالمثبَّت 4.0.139: المحكّمُ حجب «لا دليلَ على SQLite» ولم يرَ server/server.js) — ملفّاتٌ جديدة داخل مجلّدٍ جديد كانت سطراً
  // واحداً «server/» فيُتخطّى ولا يُعرض منها شيء. تُسرد ملفّاً ملفّاً، بلا أثقال التبعيّات والمخرجات.
  const status = git(["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude,glob)**/node_modules/**", ":(exclude,glob)**/dist/**", ":(exclude,glob)**/.next/**", ":(exclude,glob)**/build/**"])
  if (!status.ok) return undefined
  const head = prefix.out.trim()
  return porcelainPaths(status.out).map((entry) => ({ ...entry, path: head.length > 0 && entry.path.startsWith(head) ? entry.path.slice(head.length) : entry.path }))
}

/** لقطةُ بدء الدور: كلُّ مسارٍ متّسخٍ وختمُه. undefined = ليس مستودعاً أو يتجاهله مستودعُه (فلا دليلَ قرصٍ يُدّعى). */
export function diskSnapshot(root: string, git: GitRun): DiskSnapshot | undefined {
  const paths = projectStatus(git)
  if (paths === undefined) return undefined
  return new Map(paths.map(({ path }) => [path, stamp(root, path)]))
}

/**
 * ما تغيّر منذ اللقطة: فرقُ المتتبَّع، ورأسُ الجديد غير المتتبَّع، محجوبَي الأسرار ومقصوصَين بإعلان.
 * undefined = لا لقطة (ليس مستودعاً) — والمحكّمُ حينها بلا قسمٍ لا بقسمٍ فارغٍ يوهم «لا تغيير».
 */
/**
 * 10-14 — مقيسٌ مع claude-sonnet-5-5 (m11، مرّتين): مشروعٌ بعشرة ملفّاتٍ جديدة عُرض منها ستّةٌ برؤوس 40 سطراً، والإعداداتُ (json) آخرُها —
 * فحجب المراجِعُ «package.json وvite.config.js وsrc/style.css غير معروضة» وأُنفقت حقبةُ إصلاحٍ ~73 ث تُثبت ما على القرص أصلاً. المحكّمُ
 * السحابيّ (scale > 1) يرى حتى 18 ملفّاً جديداً برؤوس 100 سطر وفرقاً أوسع؛ المحلّيُّ على ميزانيّته.
 */
export function diskEvidence(root: string, git: GitRun, before: DiskSnapshot | undefined, readHead: (path: string, lines: number) => string, scale = 1): string | undefined {
  if (before === undefined) return undefined
  const paths = projectStatus(git)
  if (paths === undefined) return undefined
  const changed = paths.filter(({ path }) => before.get(path) !== stamp(root, path))
  if (changed.length === 0) return "(لا ملفَّ تغيّر على القرص في هذا الدور.)"
  const listed = changed.slice(0, MAX_PATHS)
  const tracked = listed.filter((c) => !c.untracked).map((c) => c.path)
  const parts = [`${changed.length} مساراً تغيّر في هذا الدور:`, ...listed.map((c) => `${c.untracked ? "+ (جديد)" : "~"} ${c.path}`)]
  if (changed.length > listed.length) parts.push(`… و${changed.length - listed.length} مساراً آخر`)
  if (tracked.length > 0) {
    const diff = git(["diff", "--relative", "HEAD", "--no-color", "--no-ext-diff", "--no-textconv", "-U2", "--", ...tracked])
    if (diff.ok && diff.out.trim() !== "") parts.push("", clipKeepCause(diff.out, DIFF_BUDGET * scale))
  }
  // الشيفرةُ أوّلاً، ولا يُعرض رأسُ ملفٍّ ثنائيّ أو قفل (قاعدةُ بياناتٍ تُقرأ نصّاً ضجيجٌ لا دليل).
  const SHOWN = /\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|rb|php|vue|svelte|html?|css|scss|sql|prisma|json|ya?ml|toml|md)$/iu
  const NOISE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/iu
  const previews = listed.filter((c) => c.untracked && !c.path.endsWith("/") && SHOWN.test(c.path) && !NOISE.test(c.path))
    .sort((a, b) => Number(/\.(?:md|json|ya?ml|toml)$/iu.test(a.path)) - Number(/\.(?:md|json|ya?ml|toml)$/iu.test(b.path)))
    .sort((a, b) => Number(TEST_FILE.test(b.path)) - Number(TEST_FILE.test(a.path)))
  for (const c of previews.slice(0, scale > 1 ? 18 : 6)) {
    const lines = TEST_FILE.test(c.path) ? TEST_FILE_LINES : scale > 1 ? 100 : NEW_FILE_LINES
    parts.push("", `--- ${c.path} (جديد، أوّلُ ${lines} سطراً)`, readHead(c.path, lines))
  }
  return redact(parts.join("\n"))
}
