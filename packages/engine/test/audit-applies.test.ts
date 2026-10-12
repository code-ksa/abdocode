import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectHasDependencies } from "../src/audit-applies"

const project = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-audit-applies-"))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

test("no declared dependencies and no lockfile ⇒ nothing to audit; a dependency or a lockfile ⇒ audit applies", () => {
  const cases: [Record<string, string>, boolean][] = [
    [{ "package.json": JSON.stringify({ name: "x", scripts: { test: "node --test" } }) }, false],
    [{ "package.json": JSON.stringify({ name: "x", dependencies: {} }) }, false],
    [{}, false],
    [{ "package.json": JSON.stringify({ name: "x", dependencies: { next: "15.0.0" } }) }, true],
    [{ "package.json": JSON.stringify({ name: "x", devDependencies: { vitest: "3.0.0" } }) }, true],
    [{ "package.json": JSON.stringify({ name: "x" }), "package-lock.json": "{}" }, true],
  ]
  for (const [files, expected] of cases) {
    const dir = project(files)
    try { expect([JSON.stringify(files).slice(0, 60), projectHasDependencies(dir)]).toEqual([JSON.stringify(files).slice(0, 60), expected]) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})
