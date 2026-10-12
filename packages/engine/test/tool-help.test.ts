/**
 * 10-08 — measured with gpt-6.1-sol: «audit --help» ran a full audit of 40 pages. `<tool> --help` answers with the tool's usage and runs nothing.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
const at = cli.indexOf("const dispatchToolV = async")
const body = cli.slice(at, at + 1600)
const HELP = /^\S+\s+(?:--help|-h|help|\/\?)\s*$/iu

test("the help check answers before the raw dispatch runs anything", () => {
  const help = body.indexOf("const helpOnly =")
  const raw = body.indexOf("result = await dispatchToolRaw(")
  expect(help).toBeGreaterThan(0)
  expect(help).toBeLessThan(raw)
  expect(body).toContain("if (helpSpec !== undefined) return okText(")
})

test("only a bare help request matches — a program's own --help through run still runs", () => {
  for (const c of ["audit --help", "audit -h", "deploy help", "server /?"]) expect(HELP.test(c)).toBe(true)
  for (const c of ["run npm --help", "audit /", "audit / --widths 360", "grep --help-me src"]) expect(HELP.test(c)).toBe(false)
})
