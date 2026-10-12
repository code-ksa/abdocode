/**
 * 10-08 — بروفات النشر: `glob .env*` عاد «لا مطابقة» و.env موجود، فكتب النموذجُ .env جديداً بـPORT وحده وسقط APP_SECRET.
 * الطرفان: النمطُ يرى الملفّاتِ النقطيّة والمسارَ المطلق داخل المشروع، وكتابةُ ملفّ بيئةٍ موجود لا تُسقط مفاتيحه.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dotenvOverwriteViolation } from "../src/dotenv-mask"
import { globPatternInProject } from "../src/glob-pattern"

async function scan(dir: string, raw: string): Promise<string[] | string> {
  const g = globPatternInProject(raw, dir)
  if ("error" in g) return g.error
  const hits: string[] = []
  for await (const p of new Bun.Glob(g.pattern).scan({ cwd: dir, onlyFiles: true, dot: g.dot })) hits.push(p.replaceAll("\\", "/"))
  return hits.sort()
}

describe("glob sees what the project holds", () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-glob-"))
  writeFileSync(join(dir, ".env"), "APP_SECRET=x\n"); writeFileSync(join(dir, "server.js"), ""); writeFileSync(join(dir, "test_key"), "")
  test("`.env*` finds the dotfile (Bun.Glob hides dotfiles unless asked)", async () => {
    expect(await scan(dir, ".env*")).toEqual([".env"])
  })
  test("an absolute pattern inside the project, with backslashes, is made relative", async () => {
    expect(await scan(dir, `${dir.replaceAll("/", "\\")}\\.env*`)).toEqual([".env"])
    expect(await scan(dir, `"${dir}\\server.js"`)).toEqual(["server.js"])
  })
  test("a plain wildcard still finds ordinary files and does not flood with dotfiles", async () => {
    expect(await scan(dir, "*key*")).toEqual(["test_key"])
    expect(await scan(dir, "*")).toEqual(["server.js", "test_key"])
  })
  test("a path outside the project is named, not answered «no match»", async () => {
    const r = await scan(dir, "C:\\Program Files\\Docker\\*")
    expect(typeof r).toBe("string")
    expect(r as string).toContain("خارجَ المشروع")
  })
  test("cleanup", () => rmSync(dir, { recursive: true, force: true }))
})

describe("an existing .env is not overwritten with fewer keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-envw-"))
  const env = join(dir, ".env")
  writeFileSync(env, "APP_SECRET=s3cr3t-value\nPORT=3000\n")
  test("a rewrite that drops a key is refused and names the key", () => {
    const r = dotenvOverwriteViolation(env, "PORT=3000\n")
    expect(r).toBeDefined()
    expect(r!).toContain("APP_SECRET")
  })
  test("the masked placeholder the model sees is never written as a value", () => {
    expect(dotenvOverwriteViolation(env, "APP_SECRET=•••• (12 حرفاً — محجوبة)\nPORT=3000\n")).toBeDefined()
    expect(dotenvOverwriteViolation(join(dir, ".env.production"), "KEY=•••• (3 حرفاً — محجوبة)\n")).toBeDefined()
  })
  test("positive twins: keeping every key, a new .env file, and example files are written", () => {
    expect(dotenvOverwriteViolation(env, "APP_SECRET=new\nPORT=3000\nEXTRA=1\n")).toBeUndefined()
    expect(dotenvOverwriteViolation(join(dir, ".env.local"), "PORT=1\n")).toBeUndefined()
    writeFileSync(join(dir, ".env.example"), "A=\nB=\n")
    expect(dotenvOverwriteViolation(join(dir, ".env.example"), "A=\n")).toBeUndefined()
    expect(dotenvOverwriteViolation(join(dir, "config.json"), "{}")).toBeUndefined()
  })
  test("cleanup", () => rmSync(dir, { recursive: true, force: true }))
})
