import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProjectFolder, isEmptyDirectory, resolveNewProjectTarget } from "../src/project-bootstrap"

describe("an existing EMPTY folder is adopted by project-create; a non-empty one still gets a suffix (2026-09-13: the model made the folder with New-Item first and the project landed in «-2»)", () => {
  test("resolveNewProjectTarget returns the empty folder itself, and createProjectFolder does not fail on it", () => {
    const documents = mkdtempSync(join(tmpdir(), "abdo-docs-"))
    mkdirSync(join(documents, "testawy-vite"))
    expect(isEmptyDirectory(join(documents, "testawy-vite"))).toBe(true)
    const target = resolveNewProjectTarget("testawy-vite", documents)
    expect(target).toBe(join(documents, "testawy-vite"))
    expect(createProjectFolder(target, [])).toContain("testawy-vite")
  })
  test("twin: a folder that already holds files is not adopted — the suffix path is returned", () => {
    const documents = mkdtempSync(join(tmpdir(), "abdo-docs-"))
    mkdirSync(join(documents, "site"))
    writeFileSync(join(documents, "site", "index.html"), "<html></html>")
    expect(isEmptyDirectory(join(documents, "site"))).toBe(false)
    expect(resolveNewProjectTarget("site", documents)).toBe(join(documents, "site-2"))
  })
})
