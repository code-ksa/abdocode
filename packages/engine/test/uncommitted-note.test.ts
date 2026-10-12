/**
 * 10-08 — measured on abdo-router: "all sprints closed" with 49 modified files and not one commit since the baseline.
 */
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { uncommittedNote } from "../src/uncommitted-note"

test("a dirty tree is named with a count, a few files, and the commit rule; a clean tree says nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-dirty-"))
  try {
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir })
    writeFileSync(join(dir, "a.ts"), "x"); writeFileSync(join(dir, "b.ts"), "y")
    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: dir, stdout: "pipe" }).stdout.toString()
    const note = uncommittedNote(status)
    expect(note).toContain("2 ملفّاً غيرَ مودَع")
    expect(note).toContain("a.ts")
    expect(note).toContain("لا git add -A")
    expect(uncommittedNote("")).toBe("")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("the sprint done handler appends the note when the last sprint closes", () => {
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
  expect(cli).toContain('if (closed.ok && closed.text.includes("كلُّ السبرنتات مغلقة"))')
  expect(cli).toContain("return closed.text + uncommittedNote(st.stdout.toString())")
})
