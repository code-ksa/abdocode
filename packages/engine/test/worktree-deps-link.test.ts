import { expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { linkIgnoredDeps, unlinkIgnoredDeps, worktreeRoot } from "../src/exec-mode"

// 09-29 (مقيس على تطبيق المالك): عاملُ parallel بلا node_modules هرع إلى npm install كاملٍ — الوصلةُ تشارك الاعتماديات وتُفكّ قبل الإزالة.
test("node_modules is linked into the worktree (junction/symlink), readable through the link, and unlinking leaves the base intact", () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-wt-base-")), dir = mkdtempSync(join(tmpdir(), "abdo-wt-dir-"))
  mkdirSync(join(base, "node_modules", "pkg"), { recursive: true })
  writeFileSync(join(base, "node_modules", "pkg", "index.js"), "module.exports = 1\n")
  const lines: string[] = []
  const links = linkIgnoredDeps(base, dir, (l) => lines.push(l))
  expect(links).toEqual([join(dir, "node_modules")])
  expect(lstatSync(join(dir, "node_modules")).isSymbolicLink()).toBe(true)
  expect(readFileSync(join(dir, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1\n")
  expect(lines.some((l) => l.startsWith("🔗 node_modules"))).toBe(true)
  // لا وصلَ حين لا node_modules في الأصل، ولا كتابةَ فوق موجود
  expect(linkIgnoredDeps(mkdtempSync(join(tmpdir(), "abdo-wt-empty-")), dir, () => {})).toEqual([])
  unlinkIgnoredDeps(links)
  expect(existsSync(join(dir, "node_modules"))).toBe(false)
  expect(readFileSync(join(base, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1\n")
  // فكُّ ما ليس وصلة لا يلمسه
  mkdirSync(join(dir, "node_modules")); writeFileSync(join(dir, "node_modules", "real.txt"), "x")
  unlinkIgnoredDeps([join(dir, "node_modules")])
  expect(existsSync(join(dir, "node_modules", "real.txt"))).toBe(true)
  rmSync(base, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true })
})

test("09-29: the worktree root is the long temp path — an 8.3 short name (ABDELR~1) breaks libuv file watchers in workers", () => {
  const root = worktreeRoot()
  expect(root.endsWith("abdocode-worktrees")).toBe(true)
  if (process.platform === "win32") expect(/~\d[\\/]/u.test(root)).toBe(false)
})
