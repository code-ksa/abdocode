/**
 * `security scan` (2026-09-28): المشروعُ كلُّه بقواعد فحص الفرق — المتتبَّعُ وحده، والقيمةُ لا تُعاد. مستودعٌ حقيقيٌّ فيه سرٌّ
 * متتبَّع وeval، وتوأمان: سرٌّ في ملفٍّ متجاهَل لا يُنسب للمستودع، والثنائيُّ يُتخطّى ويُعدّ. وحيٌّ عبر exec بلا نموذجٍ يُنادى.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseSecurityScan, renderProjectScan, scanProject, type GitRun } from "../src/project-security-scan"
import { stripChildEnv } from "../../tools/src/env-strip"

const GH = ["ghp", "_", "R4t5Y6u7I8o9P0a1S2d3F4g5H6j7K8l9Z0x1"].join("")

function repo() {
  const root = mkdtempSync(join(tmpdir(), "abdo-secscan-"))
  const git: GitRun = (args) => { const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" }); return { ok: r.exitCode === 0, out: r.stdout.toString() } }
  git(["init", "-q", "-b", "main"])
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "cfg.ts"), `export const token = "${GH}"\n`)
  writeFileSync(join(root, "src", "app.js"), "const x = 1\nconst y = eval(userInput)\n")
  writeFileSync(join(root, "logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]))
  writeFileSync(join(root, ".gitignore"), ".env.local\n")
  writeFileSync(join(root, ".env.local"), `GITHUB_TOKEN=${GH}\n`)
  git(["add", "src/cfg.ts", "src/app.js", "logo.bin", ".gitignore"])
  return { root, git }
}

test("the forms, and a path that climbs out is refused", () => {
  expect(parseSecurityScan("security scan")).toEqual({})
  expect(parseSecurityScan("/security scan src")).toEqual({ path: "src" })
  expect(parseSecurityScan("افحص المشروع أمنيّاً")).toEqual({})
  expect(parseSecurityScan("security scan ../etc")).toMatchObject({ error: expect.any(String) })
  expect(parseSecurityScan("run a security scan please")).toBeUndefined()
})

test("tracked files only: the secret and the eval are named without the value, the ignored file is not the repo's, the binary is counted", () => {
  const { root, git } = repo()
  try {
    const scan = scanProject(root, git)
    if ("error" in scan) throw new Error(scan.error)
    const report = renderProjectScan(scan)
    expect(report).toContain("src/cfg.ts:1")
    expect(report).toContain("secret:")
    expect(report).toContain("src/app.js:2")
    expect(report).not.toContain(".env.local")
    expect(report).not.toContain(GH)
    expect(scan.skipped).toBe(1)
    expect(report).toContain("⛔ الخطيرةُ لا تُدفع")
    // النطاقُ بمسار: src/app.js وحده.
    const narrowed = scanProject(root, git, "src/app.js")
    if ("error" in narrowed) throw new Error(narrowed.error)
    expect(narrowed.findings.every((f) => f.file === "src/app.js")).toBe(true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("the twin: not a repository is said, not scanned as clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-secscan-norepo-"))
  try {
    expect(scanProject(dir, () => ({ ok: false, out: "" }))).toMatchObject({ error: expect.stringContaining("git") })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("live: `security scan` through exec answers from the lane — no model call, no value", async () => {
  let calls = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { calls += 1; return Response.json({ choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "stop" }] }) } })
  const { root } = repo()
  const home = mkdtempSync(join(tmpdir(), "abdo-secscan-home-")), settings = join(home, "settings.json")
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "read-only", modelRole: "agent", routerGate: "off", project: root, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "exec", "security scan", "--json", "--quiet", "--project", root, "--mode", "read-only"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home },
    stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  server.stop(true)
  rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true })
  const summary = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1))
  expect(summary.answer, stderr.slice(-600)).toContain("src/cfg.ts:1")
  expect(summary.outcome).toBe("completed")
  expect(`${stdout}${stderr}`).not.toContain(GH)
  expect(calls).toBe(0)
}, 120_000)
