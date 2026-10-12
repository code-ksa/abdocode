/**
 * 10-11 (مقيس على m11 بالمثبَّت 4.0.141: 134 نداءً، الحقبتان 4 و5 أعادتا الطقسَ كلَّه بعد «لم يُفحص البناء/التدقيق»، وكتابةُ .gitignore
 * أبطلت البناء): النموذجُ ادّعى الاكتمالَ وما بقي بوّابةٌ حتميّة — تشغّلها النواة، فإن نجحت أُغلق الدورُ بلا نداء نموذج؛ وملفّاتُ التعريف لا تُبطل البوّابات.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { stripChildEnv } from "../../tools/src/env-strip"

async function run(replies: readonly string[]) {
  const home = mkdtempSync(join(tmpdir(), "abdo-gate-replay-")), project = join(home, "proj")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "README.md"), "# page\nA static page built into dist/.\n")
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const text = await request.text()
    const content = replies[Math.min(requests, replies.length - 1)]!
    requests += 1
    const payload = JSON.parse(text) as { stream?: boolean }
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(home, "settings.json")
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "auto", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  try {
    const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "exec", "Build the page described in README.md", "--project", project, "--mode", "full-access", "--json"], {
      cwd: resolve(import.meta.dir, "../../.."),
      env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "5", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const { Database } = await import("bun:sqlite")
    const db = new Database(join(home, "state", "abdocode-events.sqlite"), { readonly: true })
    const events = (db.query("select data from events where type='serve.output.emitted'").all() as { data: string }[]).map((r) => String(JSON.parse(r.data).payload ?? ""))
    db.close()
    let summary: { outcome?: string; stop?: string; answer?: string } = {}
    try { summary = JSON.parse(stdout) } catch { /* reported by the assertion */ }
    return { requests, events, stderr, summary }
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }) }
}

const PKG = "نفّذ: write package.json <<<\n{\"name\":\"proj\",\"private\":true,\"scripts\":{\"build\":\"node build.js\"}}"
const BUILD_OK = "نفّذ: write build.js <<<\nconst fs = require('fs')\nfs.mkdirSync('dist', { recursive: true })\nfs.writeFileSync('dist/index.html', '<!doctype html><html lang=\"ar\"><body><h1>page</h1></body></html>')\nconsole.log('built dist/index.html')"
const BUILD_BAD = "نفّذ: write build.js <<<\nthrow new Error('BUILD_BROKEN_ON_PURPOSE')"
const FINAL = "Done: the page builds into dist/index.html."

test("the model claimed done before building: the engine runs the build, it passes, and the turn closes with no further model call", async () => {
  const r = await run([PKG, BUILD_OK, FINAL, "SHOULD_NOT_BE_ASKED"])
  expect(r.events.some((e) => e.includes("شرط القبول")), r.events.join("\n").slice(-2000)).toBe(true)
  expect(r.events.some((e) => e.startsWith("✓ البوّابةُ التي بقيت نجحت بتشغيل النواة"))).toBe(true)
  expect(r.requests).toBe(3)
  expect(r.summary.answer ?? "").toContain("dist/index.html")
}, 180_000)

test("the twin: the engine-run build fails, so the model is asked again with the failure", async () => {
  const r = await run([PKG, BUILD_BAD, FINAL, FINAL, FINAL])
  expect(r.events.some((e) => e.startsWith("✓ البوّابةُ التي بقيت نجحت"))).toBe(false)
  expect(r.requests, r.events.join("\n").slice(-1500)).toBeGreaterThan(3)
}, 180_000)

test("writing .gitignore after a passing build does not reopen the build gate", async () => {
  const r = await run([PKG, BUILD_OK, "نفّذ: run npm run build", "نفّذ: write .gitignore <<<\nnode_modules/\ndist/", FINAL, "SHOULD_NOT_BE_ASKED"])
  expect(r.events.some((e) => e.includes("شرط القبول")), r.events.join("\n").slice(-1500)).toBe(false)
  expect(r.requests).toBe(5)
}, 180_000)

test("the twin: editing code after the build reopens it", async () => {
  const r = await run([PKG, BUILD_OK, "نفّذ: run npm run build", "نفّذ: write build.js <<<\nconst fs = require('fs')\nfs.mkdirSync('dist', { recursive: true })\nfs.writeFileSync('dist/index.html', '<!doctype html><html lang=\"ar\"><body><h1>v2</h1></body></html>')", FINAL, "SHOULD_NOT_BE_ASKED"])
  expect(r.events.some((e) => e.includes("شرط القبول")), r.events.join("\n").slice(-1500)).toBe(true)
}, 180_000)
