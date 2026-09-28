/**
 * دليلُ القرص للمحكّم (2026-09-28، البند 5 «المحقّق المستقلّ»): المحكّمُ يرى ما تغيّر فعلاً في هذا الدور مقروءاً من git، لا روايةَ
 * الدور وحدها. وحدةٌ على مستودعٍ حقيقيّ، وحيٌّ عبر exec بنموذجٍ مكتوبٍ باليد يكتب ملفّاً ثمّ يدّعي؛ والتوائم: ما كان متّسخاً قبل
 * الدور لا يُنسب إليه، والسرُّ يُحجب (وحدةً: الكتابةُ الحيّة لسرٍّ يرفضها حارسُ الكتابة قبلنا)، والمفتاحُ مطفأً لا قسمَ أصلاً.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { diskEvidence, diskSnapshot, type GitRun } from "../src/disk-evidence"
import { stripChildEnv } from "../../tools/src/env-strip"

const GH = ["ghp", "_", "Z9x8C7v6B5n4M3a2S1d0F9g8H7j6K5l4Q3w2"].join("")
const HEADING = "## ما تغيّر فعلاً على القرص"

function repo() {
  const project = mkdtempSync(join(tmpdir(), "abdo-disk-"))
  const git: GitRun = (args) => { const r = Bun.spawnSync(["git", "-C", project, ...args], { stdout: "pipe", stderr: "pipe" }); return { ok: r.exitCode === 0, out: r.stdout.toString() } }
  git(["init", "-q", "-b", "main"]); git(["config", "user.email", "t@example.com"]); git(["config", "user.name", "t"]); git(["config", "commit.gpgsign", "false"])
  writeFileSync(join(project, "sum.js"), "module.exports = (a, b) => a + b\n"); git(["add", "sum.js"]); git(["commit", "-q", "-m", "init"])
  // عملٌ سابقٌ على الدور — ليس تسليمَ المنفّذ.
  writeFileSync(join(project, "old-notes.txt"), "PRE-EXISTING-7a\n")
  return { project, git }
}
const head = (project: string) => (path: string, lines: number) => readFileSync(join(project, path), "utf8").split("\n").slice(0, lines).join("\n")

test("unit: only what changed in this turn, secrets redacted — and no snapshot means no section", async () => {
  const { project, git } = repo()
  try {
    const before = diskSnapshot(project, git)
    expect(diskEvidence(project, git, before, head(project))).toContain("لا ملفَّ تغيّر")
    await Bun.sleep(20)
    writeFileSync(join(project, "sum.js"), "module.exports = (a, b) => a * b // DISK-MARK-91\n")
    writeFileSync(join(project, "cfg.ts"), `export const token = "${GH}"\n`)
    const evidence = diskEvidence(project, git, before, head(project))!
    expect(evidence).toContain("DISK-MARK-91")
    expect(evidence).toContain("+ (جديد) cfg.ts")
    expect(evidence).not.toContain("old-notes.txt")
    expect(evidence).not.toContain("PRE-EXISTING-7a")
    expect(evidence).not.toContain(GH)
    expect(diskEvidence(project, git, undefined, head(project))).toBeUndefined()
    expect(diskSnapshot(tmpdir(), () => ({ ok: false, out: "" }))).toBeUndefined()
  } finally { rmSync(project, { recursive: true, force: true }) }
})

async function exec(verifier: boolean) {
  const bodies: string[] = []
  const replies = ["نفّذ: write sum.js <<<\nmodule.exports = (a, b) => a * b // DISK-MARK-91\n","Done — sum.js now adds.", "COMPLETE\nthe diff shows the change", "COMPLETE\nok"]
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const content = replies[Math.min(bodies.length, replies.length - 1)]!
    const payload = await request.json() as { stream?: boolean; messages?: unknown[] }
    bodies.push(JSON.stringify(payload.messages ?? []))
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const { project } = repo()
  const home = mkdtempSync(join(tmpdir(), "abdo-disk-home-")), settings = join(home, "settings.json")
  mkdirSync(join(home, "state"), { recursive: true })
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "full-access", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier, reviewer: false, delegation: false, inventory: false, verifyAfterEdit: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "exec", "Make sum.js multiply", "--json", "--project", project, "--mode", "full-access"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "4", ABDO_REQUIRE_SPRINT_PLAN: "0" },
    stdout: "pipe", stderr: "pipe",
  })
  const [, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  server.stop(true)
  const onDisk = readFileSync(join(project, "sum.js"), "utf8")
  rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true })
  return { review: bodies.find((b) => b.includes(HEADING)), bodies, stderr, onDisk }
}

test("live: the verifier's prompt carries the turn's real diff — not the earlier dirt", async () => {
  const r = await exec(true)
  expect(r.onDisk, r.stderr.slice(-600)).toContain("DISK-MARK-91")
  expect(r.review, `${r.bodies.length} requests\n${r.stderr.slice(-600)}`).toBeDefined()
  expect(r.review).toContain("DISK-MARK-91")
  expect(r.review).toContain("sum.js")
  expect(r.review).not.toContain("PRE-EXISTING-7a")
}, 150_000)

test("live, the twin: with the verifier off no request carries a disk section", async () => {
  const r = await exec(false)
  expect(r.onDisk, r.stderr.slice(-600)).toContain("DISK-MARK-91")
  expect(r.review).toBeUndefined()
}, 150_000)
