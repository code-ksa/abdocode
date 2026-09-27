/**
 * الفجوة #3 (2026-09-27) — خطّافاتُ المشروع: التحقّقُ من الملفّ، ومخزنُ الموافقة بالبصمة، وتمريرُ المسار بلا حقن.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { approvedDigest, commandFor, readHooks, recordApproval } from "../src/project-hooks"

const project = (hooks?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-hooks-unit-"))
  if (hooks !== undefined) { mkdirSync(join(dir, ".abdo")); writeFileSync(join(dir, ".abdo", "hooks.json"), hooks) }
  return dir
}

test("a valid file yields its hooks and a content digest; no file is undefined, not an empty approval", () => {
  const none = project()
  expect(readHooks(none)).toBeUndefined()
  const dir = project(JSON.stringify({ afterEdit: [{ match: "\\.ts$", run: "npx prettier --write {file}" }], beforeDone: [{ run: "npm run lint" }] }))
  const loaded = readHooks(dir)!
  expect(loaded.error).toBeUndefined()
  expect(loaded.file!.digest).toMatch(/^[a-f0-9]{64}$/)
  expect(loaded.file!.hooks.map((h) => [h.event, h.run])).toEqual([["afterEdit", "npx prettier --write {file}"], ["beforeDone", "npm run lint"]])
  expect(loaded.file!.hooks[0]!.match!.test("src/a.ts")).toBe(true)
  rmSync(none, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true })
})

test("a half-valid file activates nothing, and every refusal is named", () => {
  const cases: [string, RegExp][] = [
    ["not json", /ليس JSON/u],
    [JSON.stringify({ onStart: [{ run: "x" }] }), /حدثٌ غيرُ معروف/u],
    [JSON.stringify({ afterEdit: [{ run: "echo a\necho b" }] }), /متعدّدُ الأسطر/u],
    [JSON.stringify({ beforeDone: [{ run: "lint {file}" }] }), /\{file\} لـafterEdit وحده/u],
    [JSON.stringify({ beforeDone: [{ match: "x", run: "lint" }] }), /«match» لـafterEdit وحده/u],
    [JSON.stringify({ afterEdit: [{ match: "(", run: "x" }] }), /تعبيرٌ غيرُ صالح/u],
    [JSON.stringify({ afterEdit: Array.from({ length: 9 }, () => ({ run: "x" })) }), /أكثرُ من 8/u],
    [JSON.stringify({}), /بلا خطّافات/u],
  ]
  for (const [content, why] of cases) {
    const dir = project(content)
    const loaded = readHooks(dir)!
    expect(loaded.file, content).toBeUndefined()
    expect(loaded.error, content).toMatch(why)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("approval is stored per project by digest — another project or a changed file is not approved", () => {
  const state = mkdtempSync(join(tmpdir(), "abdo-hooks-state-"))
  expect(approvedDigest(state, "C:/work/a")).toBeUndefined()
  recordApproval(state, "C:/work/a", "d1")
  expect(approvedDigest(state, "c:/WORK/a")).toBe("d1")
  expect(approvedDigest(state, "C:/work/b")).toBeUndefined()
  recordApproval(state, "C:/work/b", "d2")
  expect(approvedDigest(state, "C:/work/a")).toBe("d1")
  rmSync(state, { recursive: true, force: true })
})

test("{file} is quoted and a path carrying shell characters is refused, never escaped", () => {
  const hook = { event: "afterEdit" as const, run: "npx prettier --write {file}" }
  expect(commandFor(hook, "src/app/page.tsx")).toBe('npx prettier --write "src/app/page.tsx"')
  for (const evil of ['a"; rm -rf ~; ".ts', "a$(whoami).ts", "a`id`.ts", "a|b.ts", "a&b.ts", "a;b.ts", "a%PATH%.ts", "a>b.ts"]) expect(commandFor(hook, evil), evil).toBeUndefined()
  expect(commandFor({ event: "beforeDone", run: "npm run lint" })).toBe("npm run lint")
})
