/**
 * 10-11 (مقيس على مقارنة CRM): دورُ exec بلغ سقفَه فنقطةُ حفظ، ثمّ `exec "اكمل"` فتح جلسةً جديدة فلم يجد الهدف وبدأ غريباً.
 * يُقاس بما يصل النموذجَ فعلاً: نصُّ المهمّة الأولى في طلبات التشغيل الثاني — لا بعائد دالّة.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseExecArgs } from "../src/exec-mode"
import { stripChildEnv } from "../../tools/src/env-strip"

const FIRST_TASK = "Create note.txt containing the word marmalade-7741"

function lab() {
  const home = mkdtempSync(join(tmpdir(), "abdo-exec-continue-")), project = join(home, "proj")
  mkdirSync(project, { recursive: true })
  return { home, project }
}

async function exec(home: string, project: string, args: readonly string[], replies: readonly string[]) {
  let requests = 0
  const bodies: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const content = replies[Math.min(requests, replies.length - 1)]!
    requests += 1
    const text = await request.text()
    bodies.push(text)
    const payload = JSON.parse(text) as { stream?: boolean }
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(home, "settings.json")
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "auto", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "exec", ...args, "--project", project, "--mode", "full-access", "--json"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "3", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
    stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  server.stop(true)
  return { summary: JSON.parse(stdout) as { outcome: string; resumedSession?: string }, stderr, bodies }
}

test("«اكمل» resumes the last session itself: the first task reaches the model in the second run, and the summary names the session", async () => {
  const { home, project } = lab()
  try {
    const first = await exec(home, project, [FIRST_TASK], ["نفّذ: write note.txt <<<\nmarmalade-7741\n", "Wrote note.txt."])
    expect(first.summary.resumedSession).toBeUndefined()
    const second = await exec(home, project, ["اكمل"], ["Everything in the task is done."])
    expect(second.stderr).toContain("↩ يكمل الجلسة")
    expect(second.summary.resumedSession).toMatch(/^s-\d+$/u)
    expect(second.bodies.some((b) => b.includes("marmalade-7741")), second.stderr.slice(-800)).toBe(true)
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 180_000)

test("the twin: a new task does not pull the last session in — the first task never reaches the model", async () => {
  const { home, project } = lab()
  try {
    await exec(home, project, [FIRST_TASK], ["نفّذ: write note.txt <<<\nmarmalade-7741\n", "Wrote note.txt."])
    const second = await exec(home, project, ["Say hello in one word"], ["Hello."])
    expect(second.summary.resumedSession).toBeUndefined()
    expect(second.bodies.length).toBeGreaterThan(0)
    expect(second.bodies.some((b) => b.includes("marmalade-7741"))).toBe(false)
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 180_000)

test("parse: --continue is explicit; «اكمل» turns it on by itself; a worktree run never resumes", () => {
  expect(parseExecArgs(["do", "x", "--continue"])).toMatchObject({ task: "do x", continue: true })
  expect(parseExecArgs(["اكمل"])).toMatchObject({ continue: true })
  expect("continue" in (parseExecArgs(["Build a page"]) as object)).toBe(false)
  expect("continue" in (parseExecArgs(["اكمل", "--worktree"]) as object)).toBe(false)
})
