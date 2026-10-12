/**
 * 10-11 (مقيس على m7 داخل مجلّدِ قياس — مجلّدٌ يتجاهله مستودعٌ أكبر): git «داخل شجرة» ولا يرى شيئاً، فقيل للمحكّم «لا ملفَّ
 * تغيّر» وقد كُتب ملفّان، فحجب الاكتمال. وفي مجلّدٍ فرعيٍّ من مستودعٍ أكبر كانت المساراتُ منسوبةً إلى جذر المستودع لا إلى المشروع.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diskEvidence, diskSnapshot, type GitRun } from "../src/disk-evidence"

function parentRepo(ignoreProject: boolean) {
  const top = mkdtempSync(join(tmpdir(), "abdo-disk-parent-"))
  const g = (cwd: string): GitRun => (args) => { const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" }); return { ok: r.exitCode === 0, out: r.stdout.toString() } }
  const gt = g(top)
  gt(["init", "-q", "-b", "main"]); gt(["config", "user.email", "t@example.com"]); gt(["config", "user.name", "t"]); gt(["config", "commit.gpgsign", "false"])
  writeFileSync(join(top, ".gitignore"), ignoreProject ? "tmp/\n" : "")
  const project = join(top, "tmp", "proj")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "guard.js"), "export const v = 1\n")
  gt(["add", "-A"]); gt(["commit", "-q", "-m", "init"])
  return { top, project, git: g(project) }
}
const head = (project: string) => (path: string, lines: number) => readFileSync(join(project, path), "utf8").split("\n").slice(0, lines).join("\n")

test("a project its parent repo ignores gets no disk section — never a false «nothing changed»", () => {
  const { top, project, git } = parentRepo(true)
  try {
    const before = diskSnapshot(project, git)
    writeFileSync(join(project, "guard.js"), "export const v = 2\n")
    expect(before).toBeUndefined()
    expect(diskEvidence(project, git, before, head(project))).toBeUndefined()
  } finally { rmSync(top, { recursive: true, force: true }) }
})

test("the twin: a project in a tracked subfolder of a bigger repo shows its change, with paths relative to the project", () => {
  const { top, project, git } = parentRepo(false)
  try {
    writeFileSync(join(top, "elsewhere.txt"), "not this project\n")
    const before = diskSnapshot(project, git)
    expect(before).toBeDefined()
    writeFileSync(join(project, "guard.js"), "export const v = 2\n")
    writeFileSync(join(project, "new.test.js"), "test('bites')\n")
    const evidence = diskEvidence(project, git, before, head(project))!
    expect(evidence).toContain("~ guard.js")
    expect(evidence).toContain("+ (جديد) new.test.js")
    expect(evidence).toContain("export const v = 2")
    expect(evidence).not.toContain("elsewhere.txt")
    expect(evidence).not.toContain("tmp/proj/")
  } finally { rmSync(top, { recursive: true, force: true }) }
})

// 10-11 (مقيس على m11 بالمثبَّت 4.0.139): المحكّمُ حجب «لا دليلَ على SQLite» — server/server.js (يستعمل node:sqlite) جديدٌ في مجلّدٍ جديد فلم يُعرض.
test("a new file inside a new folder reaches the judge with its head; node_modules and lockfiles never do", () => {
  const { top, project, git } = parentRepo(false)
  try {
    const before = diskSnapshot(project, git)
    mkdirSync(join(project, "server"), { recursive: true })
    writeFileSync(join(project, "server", "server.js"), "import { DatabaseSync } from 'node:sqlite'\nexport const db = new DatabaseSync('data/tasks.db')\n")
    mkdirSync(join(project, "node_modules", "left-pad"), { recursive: true })
    writeFileSync(join(project, "node_modules", "left-pad", "index.js"), "module.exports = 'NODE_MODULES_NOISE'\n")
    writeFileSync(join(project, "package-lock.json"), "{\"lockfileVersion\":3,\"LOCK_NOISE\":true}\n")
    const evidence = diskEvidence(project, git, before, head(project))!
    expect(evidence).toContain("+ (جديد) server/server.js")
    expect(evidence).toContain("import { DatabaseSync } from 'node:sqlite'")
    expect(evidence).not.toContain("NODE_MODULES_NOISE")
    expect(evidence).not.toContain("LOCK_NOISE")
  } finally { rmSync(top, { recursive: true, force: true }) }
})
