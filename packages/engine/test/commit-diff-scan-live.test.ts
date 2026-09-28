/**
 * فحصُ الفرق قبل الإيداع على المسار الحقيقيّ (exec ⇦ git-commit ⇦ محوّل النواة). إيداعٌ فيه شكلُ سرٍّ لا يمرّ بلا إذنٍ صريح،
 * وexec لا مُوافِق فيه فيُرفض؛ والقيمةُ لا تظهر في أيّ خرج. والتوأم: فرقٌ نظيف يُودَع بلا سؤال.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { stripChildEnv } from "../../tools/src/env-strip"

const GH = ["ghp", "_", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"].join("")

async function commitWith(content: string) {
  const replies = ["نفّذ: git-commit add config", "Committed."]
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const reply = replies[Math.min(requests, replies.length - 1)]!
    requests += 1
    const payload = await request.json() as { stream?: boolean }
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const home = mkdtempSync(join(tmpdir(), "abdo-scan-")), project = join(home, "proj"), settings = join(home, "settings.json")
  mkdirSync(project, { recursive: true })
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", project, ...args], { stdout: "pipe", stderr: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@example.com"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false")
  writeFileSync(join(project, "config.ts"), content)
  git("add", "config.ts")
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "full-access", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "exec", "commit the config", "--project", project, "--mode", "full-access", "--json", "--no-extensions"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "3" },
    stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const head = git("rev-parse", "--verify", "HEAD").exitCode === 0
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
  const start = stdout.indexOf("{"), end = stdout.lastIndexOf("}")
  return { head, stdout, stderr, summary: start >= 0 ? JSON.parse(stdout.slice(start, end + 1)) : undefined }
}

test("a staged secret shape is not committed without an explicit yes — exec has none, so it is refused, and the value never shows", async () => {
  const r = await commitWith(`export const token = "${GH}"\n`)
  expect(r.head, r.stderr.slice(-800)).toBe(false)
  expect(r.summary?.approvalsDenied?.join("\n") ?? "").toContain("فحص الفرق")
  expect(`${r.stdout}\n${r.stderr}`).not.toContain(GH)
  expect(`${r.stdout}\n${r.stderr}`).toContain("secret:github_token")
}, 150_000)

test("the twin: a clean staged change is committed without a question", async () => {
  const r = await commitWith("export const greeting = \"hello\"\n")
  expect(r.head, r.stderr.slice(-800)).toBe(true)
  expect(r.summary?.approvalsDenied ?? []).toEqual([])
}, 150_000)
