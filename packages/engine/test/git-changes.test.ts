/**
 * م9ح — `gitChanges()`: مستودعٌ حقيقيّ مؤقّت — المعدَّلُ المتعقَّب يعود فرقاً من git، وغيرُ المتعقَّب نصّاً، والثنائيُّ اسماً بلا
 * محتوى؛ ومجلّدٌ ليس مستودعاً يعيد فراغاً. أسطرُ «warning:» التي يخلطها git في stderr لا تُقرأ أسماءَ ملفّات.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitChanges } from "../src/git-state"

const git = (cwd: string, ...args: string[]): void => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
}

describe("git changes for the review lane", () => {
  test("tracked edit → patch, untracked text → after, untracked binary → name only, non-repo → []", () => {
    const base = mkdtempSync(join(tmpdir(), "abdo-gitchanges-"))
    try {
      expect(gitChanges(base)).toEqual([])
      git(base, "init", "-q"); git(base, "config", "user.email", "t@t"); git(base, "config", "user.name", "t"); git(base, "config", "core.autocrlf", "false")
      writeFileSync(join(base, "tracked.txt"), "one\n"); git(base, "add", "tracked.txt"); git(base, "commit", "-q", "-m", "init")
      writeFileSync(join(base, "tracked.txt"), "one\ntwo\n")
      writeFileSync(join(base, "fresh.txt"), "hello")
      writeFileSync(join(base, "blob.bin"), Buffer.from([0, 1, 2]))
      const rows = gitChanges(base)
      const byPath = new Map(rows.map((r) => [r.path, r]))
      expect(byPath.get("tracked.txt")?.patch).toContain("+two")
      expect(byPath.get("tracked.txt")?.patch?.startsWith("diff --git")).toBe(true)
      expect(byPath.get("fresh.txt")).toEqual({ path: "fresh.txt", after: "hello" })
      expect(byPath.get("blob.bin")).toEqual({ path: "blob.bin" })
      expect(rows.some((r) => r.path.startsWith("warning:"))).toBe(false)
    } finally { for (let i = 0; i < 10; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { Bun.sleepSync(100) } } }
  })
})
