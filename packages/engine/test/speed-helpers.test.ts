/**
 * 10-11 (مقيس على m11 بالمثبَّت 4.0.140 وبعاملَين) — مساعداتُ السرعة: عددُ العمّال الذي يسمّيه الطلب، والاعتمادياتُ غيرُ المثبّتة،
 * والاختبارُ دليلاً كاملاً عند المحكّم.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { missingDepsInstall } from "../src/audit-applies"
import { diskEvidence, diskSnapshot, type GitRun } from "../src/disk-evidence"
import { requestedWorkers } from "../src/parallel-workers"

test("the worker count the customer names is read in Arabic and English; no count, no number", () => {
  expect(requestedWorkers("اعمل بعاملَين متوازيَين: عاملٌ للواجهة وعاملٌ للخادم")).toBe(2)
  expect(requestedWorkers("و ب 2 عمال اصلح")).toBe(2)
  expect(requestedWorkers("بثلاثة عمال")).toBe(3)
  expect(requestedWorkers("use two agents in parallel")).toBe(2)
  expect(requestedWorkers("with 9 workers")).toBe(4)
  expect(requestedWorkers("اكتب تطبيقاً بالخادم والواجهة")).toBeUndefined()
  expect(requestedWorkers("عاملٌ واحد يكفي")).toBeUndefined()
})

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "abdo-speed-"))
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), body) }
  return dir
}

test("a build that fails because declared dependencies were never installed gets the project's own install command", () => {
  const npm = project({ "package.json": JSON.stringify({ devDependencies: { vite: "^6.0.0" } }) })
  const pnpm = project({ "package.json": JSON.stringify({ dependencies: { express: "^5" } }), "pnpm-lock.yaml": "lockfileVersion: 9\n" })
  try {
    expect(missingDepsInstall(npm, "> vite build\n'vite' is not recognized as an internal or external command,\noperable program or batch file.")).toBe("npm install")
    expect(missingDepsInstall(npm, "sh: 1: vite: not found")).toBe("npm install")
    expect(missingDepsInstall(pnpm, "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express' imported from server.js")).toBe("pnpm install")
  } finally { rmSync(npm, { recursive: true, force: true }); rmSync(pnpm, { recursive: true, force: true }) }
})

test("the twin: installed dependencies, a code error, a relative import or no manifest are never «install first»", () => {
  const installed = project({ "package.json": JSON.stringify({ devDependencies: { vite: "^6" } }), "node_modules/.keep": "" })
  const bare = project({ "README.md": "# x\n" })
  const deps = project({ "package.json": JSON.stringify({ devDependencies: { vite: "^6" } }) })
  try {
    expect(missingDepsInstall(installed, "'vite' is not recognized as an internal or external command")).toBeUndefined()
    expect(missingDepsInstall(bare, "'vite' is not recognized as an internal or external command")).toBeUndefined()
    expect(missingDepsInstall(deps, "src/main.js:3:1: ERROR: Expected \";\" but found \"}\"")).toBeUndefined()
    expect(missingDepsInstall(deps, "Cannot find module './routes.js'")).toBeUndefined()
  } finally { for (const d of [installed, bare, deps]) rmSync(d, { recursive: true, force: true }) }
})

test("a new test file reaches the judge whole and first — its last assertion is the evidence (DELETE twice ⇦ 404)", () => {
  const top = mkdtempSync(join(tmpdir(), "abdo-speed-disk-"))
  const g: GitRun = (args) => { const r = Bun.spawnSync(["git", "-C", top, ...args], { stdout: "pipe", stderr: "pipe" }); return { ok: r.exitCode === 0, out: r.stdout.toString() } }
  try {
    g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "t"]); g(["config", "commit.gpgsign", "false"])
    writeFileSync(join(top, "README.md"), "# x\n"); g(["add", "-A"]); g(["commit", "-q", "-m", "seed"])
    const before = diskSnapshot(top, g)
    mkdirSync(join(top, "tests")); mkdirSync(join(top, "server"))
    const body = [...Array.from({ length: 120 }, (_, i) => `// step ${i}`), "const { status } = await request(`/api/tasks/${id}`, { method: 'DELETE' })", "assert.equal(status, 404) // DELETE_TWICE_404"].join("\n")
    writeFileSync(join(top, "tests", "tasks.test.js"), body)
    writeFileSync(join(top, "server", "index.js"), Array.from({ length: 120 }, (_, i) => `// server ${i}${i === 100 ? " SERVER_TAIL" : ""}`).join("\n"))
    const evidence = diskEvidence(top, g, before, (path, lines) => readFileSync(join(top, path), "utf8").split("\n").slice(0, lines).join("\n"))!
    expect(evidence).toContain("DELETE_TWICE_404")
    expect(evidence.indexOf("--- tests/tasks.test.js")).toBeLessThan(evidence.indexOf("--- server/index.js"))
    // الشيفرةُ العاديّة تبقى برأسها القصير — الطولُ للاختبار وحده.
    expect(evidence).not.toContain("SERVER_TAIL")
  } finally { rmSync(top, { recursive: true, force: true }) }
})

test("wiring: the forced acceptance probe installs missing dependencies before any escalation", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
  const install = cli.indexOf("const depsInstall = !exitZero(probe.output, probe.verdict) ? missingDepsInstall(PROJECT_DIR, probe.output) : undefined")
  const climb = cli.indexOf('const outcome = climb(ladderState, ladder, { kind: "gate_failed"')
  expect(install).toBeGreaterThan(0)
  expect(climb).toBeGreaterThan(install)
  expect(cli.slice(install, climb)).toContain("probe = await dispatchToolV(\"run\", command, turn.id, hooks)")
})
