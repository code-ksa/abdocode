/** 10-10 — the plan-review hold: «stop until I say continue» + the plan written this turn ⇒ no install/build/product code/plan-approve until the next user message. */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { asksPlanReview, planHoldRefusal } from "../src/plan-review-hold"

const runTurns = async (replies: string[], later: string[], bodies: string[]) => {
  const root = resolve(import.meta.dir, "../../..")
  const home = mkdtempSync(join(tmpdir(), "abdo-plan-hold-"))
  const state = join(home, "state"), project = join(home, "project"), settingsFile = join(home, "settings.json")
  mkdirSync(state); mkdirSync(project); writeFileSync(join(project, "README.md"), "# fixture\n")
  let asked = 0, asked2 = 0, phase = 1
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const raw = await request.text()
    const body = JSON.parse(raw) as { stream?: boolean }
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } })
    const turn2 = phase === 2
    const content = turn2 ? (later[asked2++] ?? "تم.") : (replies[asked++] ?? "تم.")
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
  } })
  writeFileSync(settingsFile, JSON.stringify({
    project, language: "ar", mode: "full-access", modelRole: "agent", chatModel: "fx/model", agentModel: "fx/model", gateModel: "fx/model", routerGate: "off", railPolicy: "medium",
    memorySearchEnabled: false, turnNotifications: true,
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, local: true, vaultKey: "", models: ["model"] }],
  }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: root, env: { ...process.env, ABDO_CODE_SETTINGS: settingsFile, ABDO_CODE_STATE_DIR: state, ABDO_SHELL_TOKEN: "fx", ABDO_FRAMED_STDIO: "1", ABDO_VAULT_HOME: home, USERPROFILE: home, HOME: home, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "", ABDO_PROJECT: project },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const decoder = new LocalJsonFrameDecoder(), frames: any[] = []
  void (async () => { for await (const chunk of child.stdout) for (const frame of decoder.push(chunk)) frames.push(frame) })()
  const send = async (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); await child.stdin.flush() }
  const wait = async (check: () => boolean) => { const deadline = Date.now() + 90_000; while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(frames).slice(-800)}`); await Bun.sleep(20) } }
  try {
    await send({ kind: "hello", shell: "desktop", token: "fx" })
    await wait(() => frames.some((f) => f.kind === "ready"))
    await send({ kind: "trust-grant", path: project })
    for (const [i, body] of bodies.entries()) {
      phase = i + 1
      await send({ kind: "submit", turn: { id: `s-${i + 1}`, body }, mode: "full-access" })
      await wait(() => frames.some((f) => (f.kind === "done" || f.kind === "refused") && f.turnId === `s-${i + 1}`))
    }
    return { results: frames.filter((f) => f.kind === "tool-result").map((f) => ({ turn: String(f.turnId), cmd: String(f.cmd ?? ""), out: String(f.output ?? "") })), tools: frames.filter((f) => f.kind === "tool-result").map((f) => String(f.cmd ?? "")), text: frames.filter((f) => f.kind === "delta" || f.kind === "event").map((f) => String(f.text ?? f.payload ?? "")).join("") }
  } finally {
    child.kill(); await child.exited; server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}

test("pure: a message that asks to stop for review is recognised; a plain «اكمل» or a coding request is not", () => {
  for (const t of ["حدّث الخطة واعرضها وتوقف حتى أقول «اكمل» — بلا تثبيت ولا بناء قبلها", "راجع الخطة معي قبل التنفيذ", "write the plan, then stop and wait for my review", "ابني موقعاً مثل n8n.io بجميع خصائصه"]) expect(asksPlanReview(t)).toBe(true)
  for (const t of ["اكمل", "أصلح خطأ البناء في صفحة pricing", "نفّذ السبرنتات بالترتيب حتى آخرها"]) expect(asksPlanReview(t)).toBe(false)
  expect(planHoldRefusal("run", undefined)).toContain("الخطّةُ معروضةٌ لمراجعة المستخدم")
  expect(planHoldRefusal("plan-approve", undefined)).toContain("plan-approve")
  expect(planHoldRefusal("write", "app/page.tsx")).toBeDefined()
  // the twin: reading, the reference and the plan files themselves stay open
  for (const [tool, target] of [["read", undefined], ["page", undefined], ["write", "ABDO-SPRINTS.md"], ["edit", "REFERENCE.md"], ["write", ".abdo/reference/n8n.io/home/page.html"]] as const) expect(planHoldRefusal(tool, target)).toBeUndefined()
})

test("live: after the plan is written in a «stop for review» turn, run npm install and plan-approve are refused; the next «اكمل» turn is not held", async () => {
  const run = await runTurns([
    "نفّذ: write ABDO-SPRINTS.md <<<\n# Plan\n| S1 | setup |\n",
    "نفّذ: run npm install",
    "نفّذ: plan-approve",
  ], ["نفّذ: run npm install"], ["اكتب الخطة واعرضها وتوقف حتى أقول «اكمل» — بلا تثبيت ولا بناء قبلها", "اكمل"])
  const first = run.results.filter((r) => r.turn === "s-1")
  expect(first.some((r) => r.cmd.startsWith("write ABDO-SPRINTS.md")), JSON.stringify(run.results)).toBe(true)
  const install1 = first.find((r) => r.cmd.startsWith("run npm install"))
  expect(install1?.out ?? "", JSON.stringify(first)).toContain("الخطّةُ معروضةٌ لمراجعة المستخدم")
  expect(first.find((r) => r.cmd.startsWith("plan-approve"))?.out ?? "").toContain("الخطّةُ معروضةٌ لمراجعة المستخدم")
  const second = run.results.filter((r) => r.turn === "s-2")
  const install2 = second.find((r) => r.cmd.startsWith("run npm install"))
  expect(install2, JSON.stringify(run.results)).toBeDefined()
  expect(install2!.out).not.toContain("الخطّةُ معروضةٌ لمراجعة المستخدم")
}, 180_000)
