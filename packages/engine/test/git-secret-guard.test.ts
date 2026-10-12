/**
 * 10-08 — قبل إطلاق المهمّة الكاملة: مشروعٌ فيه `.env.bak-20260917` و.gitignore يستبعد `.env` وحده، وله remote. `git add .` يُرفض باسم الملفّ،
 * ويمرّ بعد إصلاح .gitignore، وتمرّ الإضافةُ الضيّقة لملفّاتٍ أخرى. يُقاس على مستودع git حقيقيّ (خرجُ status الحقيقيّ لا نصٌّ مُختلَق).
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isSecretFileName, secretStagingViolation } from "../src/git-secret-guard"

const status = (dir: string): string => Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: dir, stdout: "pipe" }).stdout.toString()

describe("git add never stages an unignored secrets file", () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-gitsec-"))
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir })
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.env\n.env*.local\n")
  writeFileSync(join(dir, ".env"), "KEY=ignored\n")
  writeFileSync(join(dir, ".env.bak-20260917"), "OPENAI_API_KEY=sk-not-real\n")
  writeFileSync(join(dir, ".env.example"), "OPENAI_API_KEY=\n")
  mkdirSync(join(dir, "app")); writeFileSync(join(dir, "app", "page.tsx"), "export default function P() { return null }\n")

  test("the measured shape: `git add .`, `git add -A` and `git add .env.bak-…` are refused naming the file", () => {
    const st = status(dir)
    for (const cmd of ["git add .", "git add -A", "git add --all", "git add .env.bak-20260917", "git add . && git commit -m init", "cd x; git add ."]) {
      const r = secretStagingViolation(cmd, st)
      expect(r).toBeDefined()
      expect(r!).toContain(".env.bak-20260917")
      expect(r!).toContain(".gitignore")
    }
  })
  test("positive twins: a narrow add of other files passes, and after .gitignore covers .env* the broad add passes", () => {
    expect(secretStagingViolation("git add app/page.tsx .env.example", status(dir))).toBeUndefined()
    expect(secretStagingViolation("git status", status(dir))).toBeUndefined()
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n.env*\n!.env.example\n")
    expect(secretStagingViolation("git add .", status(dir))).toBeUndefined()
  })
  test("cleanup", () => rmSync(dir, { recursive: true, force: true }))
})

test("secret file names", () => {
  for (const n of [".env", ".env.production", ".env.bak-20260917", "certs/server.key", "id_rsa", "deploy.pem"]) expect(isSecretFileName(n)).toBe(true)
  for (const n of [".env.example", ".env.sample", "keys.ts", "id_rsa.pub", "README.md"]) expect(isSecretFileName(n)).toBe(false)
})
