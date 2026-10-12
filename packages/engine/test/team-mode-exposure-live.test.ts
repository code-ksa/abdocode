/**
 * 10-11 — وضعُ الفريق والعمّال المتوازون، مقيساً بما يصل النموذجَ وبدفتر المحرّك:
 * • — «أقوى+» بلا طلبٍ لا يُظهر team/parallel.
 *  • حين يطلب العميلُ وكلاءَ متوازين يُظهرهما الوضعُ ويقول متى يُقسَّم العمل (كانت تُعلن «فريقاً حتى 4» ولا تُعرض).
 *  • «خلّيهم يستهلكوا كأنّه عاملٌ واحد» — العاملُ بلا موجِّهٍ ولا مراجعة، وسقفُ دوره حصّتُه (السقفُ ÷ عددِ العمّال)، ولا يفرّخ عمّالاً.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { stripChildEnv } from "../../tools/src/env-strip"

async function run(workMode: string, task: string, replies: readonly string[], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "abdo-team-mode-")), project = join(home, "proj")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "README.md"), "# tasks app\nBuild the server and the page.\n")
  // مجلّدٌ فيه شيفرة — مجلّدُ README وحده يبدأ بلا موجِّه (team-workers-split-live)، وهذه الاختباراتُ تقيس الموجِّهَ في العامل وتوأمه.
  writeFileSync(join(project, "app.js"), "export const app = 1\n")
  let requests = 0
  const bodies: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const content = replies[Math.min(requests, replies.length - 1)]!
    requests += 1
    const text = await request.text(); bodies.push(text)
    const payload = JSON.parse(text) as { stream?: boolean }
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(home, "settings.json")
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "auto", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode,
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  try {
    const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "exec", task, "--project", project, "--mode", "full-access", "--json"], {
      cwd: resolve(import.meta.dir, "../../.."),
      env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "1", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "", ...env },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const main = bodies.filter((b) => !b.includes("أنت الوكيلُ الموجِّه"))
    const { Database } = await import("bun:sqlite")
    const db = new Database(join(home, "state", "abdocode-events.sqlite"), { readonly: true })
    const events = (db.query("select data from events where type='serve.output.emitted'").all() as { data: string }[]).map((r) => String(JSON.parse(r.data).payload ?? ""))
    db.close()
    return { main, bodies, stdout, stderr, events, exposure: events.find((p) => p.startsWith("🧰 أدوات معروضة")) ?? "" }
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }) }
}

const PLAIN = "Build the tasks app described in README.md"
// بلا عددٍ مسمّى: سطرُ الوضع العامّ (العددُ المسمّى له سطرُه — team-workers-split-live).
const ASKED = "Build the tasks app described in README.md — use parallel agents: one for the server, one for the page"

test("the default is ONE worker: «stronger» without the customer asking for agents shows no team/parallel and no team line", async () => {
  const r = await run("stronger", PLAIN, ["Done."])
  const first = r.main[0] ?? ""
  expect(first.length, r.stderr.slice(-600)).toBeGreaterThan(0)
  expect(first).not.toContain("يتيح وكلاءَ متوازين")
  expect(first).not.toContain("parallel <<<")
  expect(r.exposure).not.toContain("delegation")
})

test("when the customer asks for parallel agents, «stronger» shows team/parallel and says when to split", async () => {
  const r = await run("stronger", ASKED, ["Done."])
  const first = r.main[0] ?? ""
  expect(first, r.stderr.slice(-600)).toContain("يتيح وكلاءَ متوازين حتى 4")
  expect(first).toContain("parallel <<<")
  expect(first).toContain("team <<<")
  expect(r.exposure).toContain("delegation")
})

test("the twin: «strong» (no team) carries no team line even when agents are asked for", async () => {
  const r = await run("strong", ASKED, ["Done."])
  expect((r.main[0] ?? "").length).toBeGreaterThan(0)
  expect(r.main[0]).not.toContain("يتيح وكلاءَ متوازين")
})

test("a parallel worker cannot spawn workers of its own", async () => {
  const r = await run("basic", PLAIN, ["نفّذ: parallel <<<\nbuild the server\nbuild the page", "Done."], { ABDO_PARALLEL_WORKER: "1" })
  expect(r.bodies.slice(1).join("\n"), r.stderr.slice(-800)).toContain("أنت عاملٌ متوازٍ في شجرة عمل — لا تُطلق عمّالاً آخرين")
})

test("a worker costs a share, not a whole turn: «stronger» settings, but no orienting agent, and the turn cap is cap ÷ workers", async () => {
  const worker = await run("stronger", PLAIN, ["Done."], { ABDO_PARALLEL_WORKER: "1", ABDO_PARALLEL_SHARE: "2" })
  expect(worker.bodies.some((b) => b.includes("أنت الوكيلُ الموجِّه"))).toBe(false)
  const capOf = (events: string[]) => Number(/سقف الدور \(حقبة \d+\): فعّال=\d+\/(\d+)/u.exec(events.find((e) => e.startsWith("⏱ سقف الدور")) ?? "")?.[1] ?? NaN)
  // the twin: the same settings as a normal turn run the orienting agent and keep the whole cap
  const normal = await run("stronger", PLAIN, ["Done."])
  expect(normal.bodies.some((b) => b.includes("أنت الوكيلُ الموجِّه"))).toBe(true)
  expect(capOf(worker.events)).toBe(capOf(normal.events) / 2)
})

test("a worker is not driven by whole-project gates (the parent builds and tests after merging); the same edit in a normal turn is", async () => {
  const replies = ["نفّذ: write server.js <<<\nexport const ok = 1\n", "Done: server part written."]
  const worker = await run("basic", "Build the server part and run npm run build", replies, { ABDO_PARALLEL_WORKER: "1", ABDO_PARALLEL_SHARE: "2" })
  const normal = await run("basic", "Build the server part and run npm run build", replies)
  const gated = (events: string[]) => events.some((e) => e.startsWith("↻ شرط القبول") || e.startsWith("↻ توقف النموذج قبل إثبات") || e.startsWith("↻ شرط الأمان"))
  expect(gated(normal.events), normal.events.filter((e) => e.startsWith("↻")).join("\n").slice(0, 800)).toBe(true)
  expect(gated(worker.events)).toBe(false)
})
