/**
 * 10-11 (مقيس على m11 بعاملَين): العمّالُ تفرّعوا من HEAD فلم يروا ما كتبه الأبُ ولم يُودِعه، فأعاد كلٌّ المشروعَ من الصفر، ودمجُ الفرع
 * يرفض شجرةً غيرَ نظيفة. اللقطةُ تحمل حالةَ الأب بلا مسّ فرعه، وفرقُ العامل عنها يُطبَّق على شجرته.
 */
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyWorkerDiff, snapshotWorkingTree } from "../src/parallel-base"

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim() }
}

function repo() {
  const top = mkdtempSync(join(tmpdir(), "abdo-par-base-"))
  git(top, "init", "-q", "-b", "main"); git(top, "config", "user.email", "t@example.com"); git(top, "config", "user.name", "t"); git(top, "config", "commit.gpgsign", "false")
  writeFileSync(join(top, "README.md"), "# task\n"); writeFileSync(join(top, ".gitignore"), "node_modules/\n")
  git(top, "add", "-A"); git(top, "commit", "-q", "-m", "seed")
  return top
}

/** عاملٌ: شجرةُ عملٍ من القاعدة، يكتب ثمّ يودِع في فرعه — كما يفعل runExecInWorktree. */
function worker(top: string, base: string, name: string, files: Record<string, string>) {
  const dir = join(mkdtempSync(join(tmpdir(), "abdo-par-wt-")), "wt")
  expect(git(top, "worktree", "add", "-q", "-b", name, dir, base).ok).toBe(true)
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), body) }
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", name)
  return dir
}

test("workers branch from the parent's uncommitted scaffold, and their work lands on the parent's tree — branch, HEAD and index untouched", () => {
  const top = repo()
  try {
    writeFileSync(join(top, "package.json"), "{\n  \"name\": \"tasks\",\n  \"scripts\": { \"start\": \"node server/index.js\" }\n}\n")
    mkdirSync(join(top, "node_modules", "vite"), { recursive: true }); writeFileSync(join(top, "node_modules", "vite", "index.js"), "ignored\n")
    const head = git(top, "rev-parse", "HEAD").out
    const base = snapshotWorkingTree(top)!
    expect(base).toMatch(/^[0-9a-f]{40}$/u)
    expect(git(top, "rev-parse", "HEAD").out).toBe(head)
    expect(git(top, "status", "--porcelain").out).toContain("?? package.json")
    expect(git(top, "show", `${base}:package.json`).out).toContain("node server/index.js")
    expect(git(top, "ls-tree", "-r", "--name-only", base).out).not.toContain("node_modules")

    const wa = worker(top, base, "abdocode/task-aaaaaaaa", { "server/index.js": "export const port = 3000\n", "data/tasks.db": "SQLite format 3 WORKER_RUNTIME_STATE\n", "server.log": "WORKER_LOG\n" })
    const wb = worker(top, base, "abdocode/task-bbbbbbbb", { "src/main.js": "console.log('ui')\n" })
    expect(existsSync(join(wa, "package.json"))).toBe(true)

    const a = applyWorkerDiff(top, base, "abdocode/task-aaaaaaaa")
    const b = applyWorkerDiff(top, base, "abdocode/task-bbbbbbbb")
    expect(a.ok && b.ok).toBe(true)
    expect(readFileSync(join(top, "server", "index.js"), "utf8")).toContain("port = 3000")
    expect(readFileSync(join(top, "src", "main.js"), "utf8")).toContain("ui")
    expect(readFileSync(join(top, "package.json"), "utf8")).toContain("node server/index.js")
    expect(git(top, "rev-parse", "HEAD").out).toBe(head)
    expect(git(top, "diff", "--cached", "--name-only").out).toBe("")
    expect(a.stat).toContain("server/index.js")
    // حالةُ تشغيل العامل (قاعدتُه وسجلّه) لا تُنقل إلى الأب.
    expect(existsSync(join(top, "data", "tasks.db"))).toBe(false)
    expect(existsSync(join(top, "server.log"))).toBe(false)
    for (const d of [wa, wb]) git(top, "worktree", "remove", "--force", d)
  } finally { rmSync(top, { recursive: true, force: true }) }
})

test("the twin: a clean tree needs no snapshot (workers branch from HEAD as before)", () => {
  const top = repo()
  try { expect(snapshotWorkingTree(top)).toBeUndefined() } finally { rmSync(top, { recursive: true, force: true }) }
})

test("two workers editing the same line: the second is not silently dropped — it is applied as far as it goes and its file is named", () => {
  const top = repo()
  try {
    writeFileSync(join(top, "package.json"), "{\n  \"name\": \"tasks\",\n  \"version\": \"1.0.0\"\n}\n")
    const base = snapshotWorkingTree(top)!
    const wa = worker(top, base, "abdocode/task-cccccccc", { "package.json": "{\n  \"name\": \"tasks-server\",\n  \"version\": \"1.0.0\"\n}\n" })
    const wb = worker(top, base, "abdocode/task-dddddddd", { "package.json": "{\n  \"name\": \"tasks-ui\",\n  \"version\": \"1.0.0\"\n}\n", "src/ui.js": "export {}\n" })
    expect(applyWorkerDiff(top, base, "abdocode/task-cccccccc").ok).toBe(true)
    const second = applyWorkerDiff(top, base, "abdocode/task-dddddddd")
    expect(second.ok).toBe(false)
    expect(second.rejected).toContain("package.json")
    expect(existsSync(join(top, "src", "ui.js"))).toBe(true)
    expect(readFileSync(join(top, "package.json"), "utf8")).toContain("tasks-server")
    for (const d of [wa, wb]) git(top, "worktree", "remove", "--force", d)
  } finally { rmSync(top, { recursive: true, force: true }) }
})
