import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diskEvidence, diskSnapshot, type GitRun } from "../src/disk-evidence"

// 10-14 — measured with claude-sonnet-5-5 on m11 (twice): ten new files, six previewed at 40 lines with configs last, so the reviewer withheld
// «package.json, vite.config.js and src/style.css are not shown» and a ~73 s repair epoch proved what was already on disk.

test("a cloud judge (scale 4) sees every one of ten new files, configs included; the local budget stays at six", () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-disk-scale-"))
  const git: GitRun = (args) => { const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" }); return { ok: r.exitCode === 0, out: r.stdout.toString() } }
  try {
    for (const a of [["init", "-q", "-b", "main"], ["-c", "user.email=b@x", "-c", "user.name=b", "commit", "-q", "--allow-empty", "-m", "seed"]]) git(a)
    const before = diskSnapshot(dir, git)
    mkdirSync(join(dir, "src")); mkdirSync(join(dir, "server")); mkdirSync(join(dir, "test"))
    const files = ["package.json", "vite.config.js", "index.html", "src/style.css", "src/main.js", "server/db.js", "server/app.js", "server/index.js", "test/api.test.js", ".gitignore.json"]
    for (const f of files) writeFileSync(join(dir, f), `// ${f}\n${"line\n".repeat(60)}`)
    const read = (path: string, lines: number) => readFileSync(join(dir, path), "utf8").split("\n").slice(0, lines).join("\n")
    const cloud = diskEvidence(dir, git, before, read, 4)!
    const local = diskEvidence(dir, git, before, read)!
    const shown = (text: string) => (text.match(/^--- /gmu) ?? []).length
    expect(shown(cloud)).toBe(files.length)
    for (const f of ["package.json", "vite.config.js", "src/style.css"]) expect(cloud).toContain(`--- ${f}`)
    expect(shown(local)).toBe(6)
    expect(cloud).toContain("أوّلُ 100 سطراً")
    expect(local).toContain("أوّلُ 40 سطراً")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
