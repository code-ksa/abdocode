/** 10-11 — release-check's code-checks flagged n8n.io's own captured scripts under `.abdo/reference/` (17 false warnings). */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { codeChecks } from "../src/code-checks"

const LOCALHOST = 'export const errorPage = "http://localhost:8081/error.html"\n'

test("captured reference scripts under .abdo/ are not project code — no finding; the same line in src/ is still flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-codechecks-"))
  try {
    mkdirSync(join(dir, ".abdo", "reference", "n8n.io", "scripts"), { recursive: true })
    writeFileSync(join(dir, ".abdo", "reference", "n8n.io", "scripts", "11-paddle.js"), LOCALHOST)
    writeFileSync(join(dir, "package.json"), "{}")
    expect(codeChecks(dir).filter((f) => JSON.stringify(f).includes(".abdo"))).toEqual([])
    // the twin: the guard still bites on project code
    mkdirSync(join(dir, "src"))
    writeFileSync(join(dir, "src", "paddle.ts"), LOCALHOST)
    expect(codeChecks(dir).some((f) => JSON.stringify(f).includes("paddle.ts") && JSON.stringify(f).includes("localhost"))).toBe(true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
