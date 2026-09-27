/**
 * الفجوة #6 (2026-09-27) — `abdocode exec`: دورٌ كاملٌ من سطر الأوامر، على المحرّك الحقيقيّ ونموذجٍ مكتوبٍ باليد.
 * رمزُ الخروج يتبع النتيجة، والخلاصةُ JSON، والجوابُ هو الخاتم لا نصّ الحقب، والموافقةُ تُرفض في الحال ولا تُنتظر.
 */
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseExecArgs } from "../src/exec-mode"
import { stripChildEnv } from "../../tools/src/env-strip"

async function exec(args: readonly string[], replies: readonly string[]) {
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const content = replies[Math.min(requests, replies.length - 1)]!
    requests += 1
    const payload = await request.json() as { stream?: boolean }
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const home = mkdtempSync(join(tmpdir(), "abdo-exec-")), project = join(home, "proj"), settings = join(home, "settings.json")
  mkdirSync(project, { recursive: true })
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "auto", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const started = Date.now()
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "exec", ...args.map((a) => a === "<project>" ? project : a)], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "3", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
    stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  server.stop(true)
  const note = existsSync(join(project, "note.txt")) ? readFileSync(join(project, "note.txt"), "utf8") : undefined
  rmSync(home, { recursive: true, force: true })
  return { stdout, stderr, code, ms: Date.now() - started, note }
}

test("a completed task exits 0 with a JSON summary: outcome, tools with verdicts, and the final answer only", async () => {
  const run = await exec(["Create note.txt containing hello", "--project", "<project>", "--mode", "full-access", "--json"], ["نفّذ: write note.txt <<<\nhello\n", "Wrote note.txt with hello."])
  expect(run.code).toBe(0)
  const summary = JSON.parse(run.stdout)
  expect(summary).toMatchObject({ outcome: "completed", exitCode: 0, approvalsDenied: [] })
  expect(summary.tools).toEqual([{ cmd: "write note.txt <<<", ok: true }])
  expect(summary.answer).toContain("Wrote note.txt with hello.")
  // الجوابُ الخاتم وحده — لا نصُّ حقبة الأداة.
  expect(summary.answer).not.toContain("نفّذ:")
  expect(run.note).toBe("hello")
  // التقدّمُ إلى stderr لا يلوّث JSON.
  expect(run.stderr).toContain("⚙ write note.txt")
}, 120_000)

test("an approval is refused at once and recorded — CI grants nothing implicitly and never waits out the silence", async () => {
  // في read-only يُسأل عن التنفيذ (وفي auto عن الشبكة): لا مُوافِقَ في exec، فالرفضُ فوريّ.
  const run = await exec(["Run the greeting script", "--project", "<project>", "--mode", "read-only", "--json", "--quiet"], ["نفّذ: run node -e \"console.log('hi')\"", "I could not run it."])
  const summary = JSON.parse(run.stdout)
  expect(summary.approvalsDenied).toHaveLength(1)
  expect(summary.approvalsDenied[0]).toContain("node -e")
  expect(summary.tools[0]).toMatchObject({ ok: false })
  // لا ينتظر مهلةَ الصمت (دقائق): يُرفض في الحال.
  expect(run.ms).toBeLessThan(60_000)
  expect(run.stderr).not.toContain("🔐 رُفض آليّاً")
}, 120_000)

test("arguments: an unknown option or a missing task exits 2 with the usage — nothing is guessed", async () => {
  const bad = await exec(["--frobnicate", "x"], ["unused"])
  expect(bad.code).toBe(2)
  expect(bad.stderr).toContain("خيارٌ غيرُ معروف")
  expect(parseExecArgs([])).toMatchObject({ error: expect.stringContaining("الصيغة") })
  expect(parseExecArgs(["a", "task", "--mode", "yolo"])).toMatchObject({ error: expect.stringContaining("--mode") })
  expect(parseExecArgs(["fix", "it", "--timeout", "120", "--json"])).toMatchObject({ task: "fix it", timeoutMs: 120_000, json: true, mode: "auto" })
}, 60_000)
