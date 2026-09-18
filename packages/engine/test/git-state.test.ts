import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitState } from "../src/git-state"

const git = (cwd: string, args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" })

describe("git-state — S11 measurement", () => {
  test("a non-repo directory is reported as such", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-nogit-"))
    expect(gitState(dir).isRepo).toBe(false)
  })

  test("measures branch, dirty count, and unpushed commits on a real repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-git-"))
    git(dir, ["init", "-b", "main"])
    git(dir, ["config", "user.email", "t@t.t"])
    git(dir, ["config", "user.name", "t"])
    writeFileSync(join(dir, "a.txt"), "one")
    git(dir, ["add", "a.txt"])
    git(dir, ["commit", "-m", "first"])
    // كوميت محليّ لا ريموت له — يُكشف بـ--all --not --remotes.
    const state = gitState(dir)
    expect(state.isRepo).toBe(true)
    expect(state.branch).toBe("main")
    expect(state.unpushedAcrossAll).toBeGreaterThanOrEqual(1)
    expect(state.report).toContain("لا يوجد في أيّ ريموت")
    // تغيير غير مودع يُحسب.
    writeFileSync(join(dir, "b.txt"), "two")
    expect(gitState(dir).dirty).toBeGreaterThanOrEqual(1)
  })

  test("flags merge conflict markers in tracked files", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-git-cf-"))
    git(dir, ["init", "-b", "main"])
    git(dir, ["config", "user.email", "t@t.t"])
    git(dir, ["config", "user.name", "t"])
    writeFileSync(join(dir, "c.ts"), "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n")
    git(dir, ["add", "c.ts"])
    git(dir, ["commit", "-m", "conflicted"])
    const state = gitState(dir)
    expect(state.conflictMarkers?.length ?? 0).toBeGreaterThanOrEqual(1)
    expect(state.report).toContain("علامات تعارض")
  })
})
