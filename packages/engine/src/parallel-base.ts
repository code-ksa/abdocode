/**
 * 10-11 (مقيس على m11 بعاملَين): شجرةُ العامل تُنشأ من HEAD، فما كتبه الأبُ ولم يُودَع (السقالة، العقد، package.json) لا يراه العامل —
 * فبدأ كلٌّ من مشروعٍ فارغ وأعاد ما بُني، ودمجُ فرعه يرفض شجرةً غيرَ نظيفة. والأبُ لا يُودِع على فرع المستخدم بلا طلب.
 * الحلّ بلا مسّ الفرع ولا HEAD ولا الفهرس: لقطةٌ لحالة الأب الحاليّة (بفهرسٍ مؤقّت) يتفرّع منها العمّال، ثمّ يُطبَّق فرقُ كلِّ عاملٍ عن
 * اللقطة على شجرة الأب. التعارضُ لا يُخفى: ما لم ينطبق يبقى ملفّاتِ .rej مسمّاة.
 */
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const decoder = new TextDecoder()
const git = (top: string, args: readonly string[], options: { env?: Record<string, string>; stdin?: Uint8Array } = {}) => {
  const r = Bun.spawnSync(["git", "-C", top, ...args], { stdout: "pipe", stderr: "pipe", ...(options.stdin === undefined ? {} : { stdin: options.stdin }), env: { ...process.env, ...options.env } })
  return { ok: r.exitCode === 0, out: decoder.decode(r.stdout).trim(), raw: r.stdout, err: decoder.decode(r.stderr).trim() }
}

/** إيداعٌ مخفيّ لحالة الشجرة الحاليّة (المتتبَّع والجديد، بلا المتجاهَل) أبوه HEAD — لا يمسّ الفرعَ ولا الفهرس. `undefined` = نظيفة أو تعذّر. */
export function snapshotWorkingTree(top: string): string | undefined {
  const status = git(top, ["status", "--porcelain", "--untracked-files=all"])
  if (!status.ok || status.out.length === 0) return undefined
  const head = git(top, ["rev-parse", "HEAD"])
  if (!head.ok) return undefined
  const index = join(tmpdir(), `abdo-parallel-base-${crypto.randomUUID()}.idx`)
  try {
    const env = { GIT_INDEX_FILE: index }
    if (!git(top, ["read-tree", "HEAD"], { env }).ok) return undefined
    if (!git(top, ["add", "-A"], { env }).ok) return undefined
    const tree = git(top, ["write-tree"], { env })
    if (!tree.ok) return undefined
    const commit = git(top, ["-c", "user.name=abdocode", "-c", "user.email=abdocode@localhost", "commit-tree", tree.out, "-p", head.out, "-m", "abdocode: parent state before parallel"])
    return commit.ok && /^[0-9a-f]{40}$/u.test(commit.out) ? commit.out : undefined
  } finally {
    rmSync(index, { force: true })
    rmSync(`${index}.lock`, { force: true })
  }
}

// 10-11 (مقيس على m11 بعاملَين): العاملُ أودع data/tasks.db (قاعدةَ تشغيله) فسقط الدمجُ «unable to unlink old 'data/tasks.db'» — والخادمُ يمسكها.
// حالةُ التشغيل ليست شيفرة: قواعدُ البيانات المحلّيّة والسجلّاتُ لا تُنقل من العامل.
const RUNTIME_STATE = [":(exclude,glob)**/*.db", ":(exclude,glob)**/*.db-journal", ":(exclude,glob)**/*.db-wal", ":(exclude,glob)**/*.db-shm", ":(exclude,glob)**/*.sqlite", ":(exclude,glob)**/*.sqlite3", ":(exclude,glob)**/*.log"]

export interface WorkerApply { readonly ok: boolean; readonly stat: string; readonly rejected: readonly string[]; readonly detail: string }

/** يطبّق فرقَ فرع العامل عن لقطة الأب على شجرة الأب (لا إيداع). ما لم ينطبق يُطبَّق ما أمكن منه ويُسمّى ملفُّه .rej. */
export function applyWorkerDiff(top: string, base: string, branch: string): WorkerApply {
  const diff = git(top, ["diff", "--binary", "--no-color", base, branch, "--", ".", ...RUNTIME_STATE])
  if (!diff.ok) return { ok: false, stat: "", rejected: [], detail: diff.err.slice(0, 300) }
  const stat = git(top, ["diff", "--stat", "--no-color", base, branch, "--", ".", ...RUNTIME_STATE]).out
  if (diff.raw.length === 0) return { ok: true, stat: "", rejected: [], detail: "لا تغييرَ في الفرع" }
  const clean = git(top, ["apply", "--whitespace=nowarn", "--ignore-whitespace", "-"], { stdin: diff.raw })
  if (clean.ok) return { ok: true, stat, rejected: [], detail: "" }
  const partial = git(top, ["apply", "--reject", "--whitespace=nowarn", "--ignore-whitespace", "-"], { stdin: diff.raw })
  const rejected = git(top, ["status", "--porcelain", "--untracked-files=all"]).out.split(/\r?\n/u).map((line) => line.slice(3).trim()).filter((path) => path.endsWith(".rej")).map((path) => path.replace(/\.rej$/u, ""))
  return { ok: false, stat, rejected, detail: `${clean.err}\n${partial.err}`.trim().slice(0, 900) }
}
