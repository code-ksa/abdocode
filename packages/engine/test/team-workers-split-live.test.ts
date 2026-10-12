/**
 * 10-11 — الأبُ بنى التطبيقَ واختبره بنفسه (178 ث) ثمّ أطلق عاملَين يعيدانه،
 * وعاملٌ نادى «delegate» (وكيلٌ داخل عامل)، والموجِّهُ قرأ مجلّداً لا يحمل إلا README. مقيسٌ هنا بما يصل النموذجَ وبدفتر المحرّك.
 */
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { stripChildEnv } from "../../tools/src/env-strip"

async function run(workMode: string, task: string, replies: readonly string[], options: { env?: Record<string, string>; files?: Record<string, string>; git?: boolean; inspect?: (project: string) => void } = {}) {
  const home = mkdtempSync(join(tmpdir(), "abdo-team-split-")), project = join(home, "proj")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "README.md"), "# tasks app\nBuild the server and the page.\n")
  for (const [path, body] of Object.entries(options.files ?? {})) { mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), body) }
  if (options.git === true) for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "seed"]]) Bun.spawnSync(["git", "-C", project, ...args], { stdout: "pipe", stderr: "pipe" })
  let requests = 0
  const bodies: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const text = await request.text(); bodies.push(text)
    const orienting = text.includes("أنت الوكيلُ الموجِّه")
    const content = orienting ? "[ORIENTATION] read." : replies[Math.min(requests, replies.length - 1)]!
    if (!orienting) requests += 1
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
      env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "1", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "", ...(options.env ?? {}) },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    options.inspect?.(project)
    const main = bodies.filter((b) => !b.includes("أنت الوكيلُ الموجِّه"))
    const { Database } = await import("bun:sqlite")
    const db = new Database(join(home, "state", "abdocode-events.sqlite"), { readonly: true })
    const events = (db.query("select data from events where type='serve.output.emitted'").all() as { data: string }[]).map((r) => String(JSON.parse(r.data).payload ?? ""))
    db.close()
    return { main, bodies, stdout, stderr, events, orienting: bodies.some((b) => b.includes("أنت الوكيلُ الموجِّه")) }
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }) }
}

const PLAIN = "Build the tasks app described in README.md"
const TWO = "Build the tasks app described in README.md — use two agents in parallel: one for the server, one for the page"

test("the customer named two workers: the brief says to write the shared scaffold first, then split into exactly two — before building", async () => {
  const r = await run("stronger", TWO, ["Done."])
  const first = r.main[0] ?? ""
  expect(first, r.stderr.slice(-600)).toContain("طلب العميلُ 2 عمّالاً متوازين")
  expect(first).toContain("اكتب أوّلاً المشتركَ وحده")
  expect(first).toContain("parallel <<<")
  expect(first).toContain("لا تبنِ جزءاً بنفسك ثمّ تفوّضه")
}, 180_000)

test("a named count works in «strong» (no parallel by default) and in Arabic without the word parallel: «بعاملين» opens the workers", async () => {
  const r = await run("strong", "ابنِ تطبيق المهامّ الموصوف في README.md بعاملين: واحدٌ للخادم وواحدٌ للصفحة", ["Done."])
  const first = r.main[0] ?? ""
  expect(first, r.stderr.slice(-600)).toContain("طلب العميلُ 2 عمّالاً متوازين")
  expect(r.events.find((e) => e.startsWith("🧰 أدوات معروضة")) ?? "").toContain("delegation")
}, 180_000)

test("the twin: no count named, no split-first brief", async () => {
  const r = await run("stronger", PLAIN, ["Done."])
  expect((r.main[0] ?? "").length, r.stderr.slice(-600)).toBeGreaterThan(0)
  expect(r.main[0]).not.toContain("طلب العميلُ")
}, 180_000)

const PKG = "نفّذ: write package.json <<<\n{\"name\":\"proj\",\"type\":\"module\",\"scripts\":{\"test\":\"node --test\"}}"
const TEST = "نفّذ: write app.test.js <<<\nimport test from 'node:test'\nimport assert from 'node:assert'\nimport { add } from './app.js'\ntest('adds', () => { assert.equal(add(1, 2), 3) })"
const APP = "نفّذ: write app.js <<<\nexport const add = (a, b) => a + b"
const SPLIT = "نفّذ: parallel <<<\nbuild the server part with its API routes and tests\nbuild the page part with Vite and Tailwind"

test("a late split is refused: the parent already wrote the deliverable and its tests pass — workers would only redo it", async () => {
  const r = await run("stronger", TWO, [PKG, TEST, APP, "نفّذ: run npm test", SPLIT, "Done."])
  const later = r.bodies.join("\n")
  expect(later, r.stderr.slice(-1200)).toContain("رُفض parallel: التسليمُ مكتوبٌ بعملك في هذا الدور ويمرّ بناؤه أو اختباره")
}, 180_000)

test("the twin: the same split before any proof is not refused for that reason", async () => {
  const r = await run("stronger", TWO, [PKG, TEST, APP, SPLIT, "Done."])
  expect(r.bodies.join("\n"), r.stderr.slice(-1200)).not.toContain("التسليمُ مكتوبٌ بعملك")
}, 180_000)

test("a parallel worker is one agent: delegate is not offered and is refused by name", async () => {
  const r = await run("stronger", TWO, ["نفّذ: delegate builder :: build the server with its routes", "Done."], { env: { ABDO_PARALLEL_WORKER: "1" } })
  const later = r.bodies.slice(1).join("\n")
  expect(later, r.stderr.slice(-800)).toContain("رُفض delegate: أنت عاملٌ متوازٍ — العاملُ وكيلٌ واحد ينفّذ مهمّتَه هنا بنفسه")
  expect(r.events.some((e) => /⚙ delegate builder · حقبة/u.test(e))).toBe(false)
  expect(r.main[0] ?? "").not.toMatch(/وdelegate و/u)
  // ولا parallel/merge وإن حمل نصُّ مهمّته كلمةَ parallel (العاملان ناديا parallel في 4.0.141).
  expect(r.main[0] ?? "").not.toMatch(/وparallel و|وmerge و/u)
}, 180_000)

test("a reply that heals into a real call («⚙ read …») runs it without a «narrated output» correction", async () => {
  const r = await run("basic", PLAIN, ["⚙ read README.md", "Done."])
  expect(r.events.some((e) => /حقبة 1 · read README\.md/u.test(e)), r.events.join("\n").slice(0, 1500)).toBe(true)
  expect(r.events.some((e) => e.includes("سرد خرجَ أمرٍ لم تُنفّذه أداة"))).toBe(false)
}, 180_000)

test("the twin: an invented output line is still named", async () => {
  const r = await run("basic", PLAIN, ["Tests: 12 passed\nDone."])
  expect(r.events.some((e) => e.includes("سرد خرجَ أمرٍ لم تُنفّذه أداة")), r.events.join("\n").slice(0, 1500)).toBe(true)
}, 180_000)

const LOCAL_DEP = { "package.json": JSON.stringify({ name: "proj", private: true, dependencies: { localdep: "file:./localdep" } }), "localdep/package.json": JSON.stringify({ name: "localdep", version: "1.0.0" }), "localdep/index.js": "module.exports = 1\n" }
const SPLIT_NOW = "نفّذ: parallel <<<\nbuild the server part with its API routes and tests\nbuild the page part with Vite and Tailwind"

test("declared dependencies are installed once in the parent before the workers start (they get them linked)", async () => {
  let installed = false
  const r = await run("stronger", TWO, [SPLIT_NOW, "Done."], { git: true, files: LOCAL_DEP, inspect: (project) => { installed = existsSync(join(project, "node_modules", "localdep")) } })
  expect(r.events.some((e) => e.startsWith("📦 الاعتمادياتُ معلنةٌ ولم تُثبَّت")), r.events.join("\n").slice(-1500)).toBe(true)
  expect(installed).toBe(true)
  expect(r.events.some((e) => /🧵 2 عمّالٍ متوازين/u.test(e))).toBe(true)
}, 180_000)

test("the twin: dependencies already installed — no install step before the workers", async () => {
  const r = await run("stronger", TWO, [SPLIT_NOW, "Done."], { git: true, files: { ...LOCAL_DEP, "node_modules/localdep/package.json": JSON.stringify({ name: "localdep", version: "1.0.0" }) } })
  expect(r.events.some((e) => /🧵 2 عمّالٍ متوازين/u.test(e)), r.events.join("\n").slice(-1500)).toBe(true)
  expect(r.events.some((e) => e.startsWith("📦 الاعتمادياتُ معلنةٌ ولم تُثبَّت"))).toBe(false)
}, 180_000)

const WORKER_TASK = "أنشئ مشروع الواجهة: صفحة مهام بسيطة"
const WRITE_PAGE = "نفّذ: write page.html <<<\n<!doctype html><html lang=\"ar\"><body><h1>مهام</h1></body></html>"

test("a worker's task that reads like «create project X» does not lock its own worktree (measured: 18 refusals, STUCK)", async () => {
  const r = await run("basic", WORKER_TASK, [WRITE_PAGE, "Done."], { env: { ABDO_PARALLEL_WORKER: "1" } })
  expect(r.events.some((e) => e.startsWith("🧭 طُلب مشروعٌ جديد")), r.events.join("\n").slice(0, 1500)).toBe(false)
  expect(r.events.some((e) => /حقبة 1 · write page\.html[\s\S]*✍/u.test(e)), r.events.join("\n").slice(-1500)).toBe(true)
}, 180_000)

test("the twin: the same request in a normal turn still asks for a new project first", async () => {
  const r = await run("basic", WORKER_TASK, [WRITE_PAGE, "Done."])
  expect(r.events.some((e) => e.startsWith("🧭 طُلب مشروعٌ جديد")), r.events.join("\n").slice(0, 1500)).toBe(true)
}, 180_000)

const SCOPED_WORKER_TASK = "عامل الخادم: اكتب server.js بخادم المهامّ — لا تعدّل الملفات الأخرى."
const WRITE_SERVER = "نفّذ: write server.js <<<\nexport const port = 3000"

test("a worker scoped by «don't modify the other files» still writes its own part (measured: every write refused, STUCK)", async () => {
  const r = await run("basic", SCOPED_WORKER_TASK, [WRITE_SERVER, "Done."], { env: { ABDO_PARALLEL_WORKER: "1" } })
  expect(r.events.some((e) => /حقبة 1 · write server\.js[\s\S]*✍/u.test(e)), r.events.join("\n").slice(-1500)).toBe(true)
}, 180_000)

test("the twin: the same words from the user in a normal turn still forbid writing", async () => {
  const r = await run("basic", SCOPED_WORKER_TASK, [WRITE_SERVER, "Done."])
  expect(r.events.some((e) => /حقبة 1 · write server\.js[\s\S]*✍/u.test(e)), r.events.join("\n").slice(-1500)).toBe(false)
}, 180_000)
