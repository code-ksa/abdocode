#!/usr/bin/env bun
/**
 * Every package's own test suite, one package at a time.
 *
 * Measured 2026-09-27: a vocabulary pin in `engine-host` had been red since the
 * previous release, because neither CI nor the engine suite ran package tests —
 * a defect lived until someone ran all 50 suites by hand. This runner is that
 * hand, made repeatable: each suite runs alone (so a failure names its package),
 * a package without a `test` folder is listed rather than silently skipped, and
 * the exit code is non-zero if any suite fails or finds no test files.
 *
 *   bun scripts/run-package-tests.ts                 every package
 *   bun scripts/run-package-tests.ts --exclude engine
 */
import { existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const excluded = new Set<string>()
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === "--exclude" && process.argv[i + 1] !== undefined) excluded.add(process.argv[++i]!)
}

const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
const withTests = packages.filter((name) => existsSync(join(root, "packages", name, "test")) && !excluded.has(name))
const without = packages.filter((name) => !existsSync(join(root, "packages", name, "test")))

const failed: string[] = []
let passed = 0
let skipped = 0
for (const name of withTests) {
  const started = performance.now()
  // `./` is required: a bare `packages/x/test` is read as a name filter, and a
  // doubled slash matches no file at all — both "pass" by running nothing.
  const run = Bun.spawnSync([process.execPath, "test", `./packages/${name}/test`], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const text = `${run.stdout.toString()}\n${run.stderr.toString()}`
  const count = (label: string) => Number(new RegExp(`^\\s*(\\d+) ${label}$`, "mu").exec(text)?.[1] ?? 0)
  const pass = count("pass"), fail = count("fail"), skip = count("skip")
  passed += pass
  skipped += skip
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  const ranNothing = pass + fail + skip === 0
  const ok = run.exitCode === 0 && fail === 0 && !ranNothing
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(26)} ${String(pass).padStart(4)} pass ${String(fail).padStart(3)} fail ${String(skip).padStart(3)} skip  ${seconds}s${ranNothing ? "  (no tests ran)" : ""}`)
  if (!ok) {
    failed.push(name)
    for (const line of text.split("\n").filter((l) => /^\(fail\)|^error:|Expected|Received/u.test(l)).slice(0, 12)) console.log(`       ${line.slice(0, 220)}`)
  }
}
console.log(`\n${withTests.length} suites · ${passed} pass · ${skipped} skip · ${failed.length} failing${failed.length ? ` (${failed.join(", ")})` : ""}`)
if (without.length) console.log(`no test folder: ${without.join(", ")}`)
if (excluded.size) console.log(`excluded here: ${[...excluded].join(", ")}`)
process.exit(failed.length === 0 ? 0 : 1)
