/**
 * 10-11 (مقيس على n8n-clone، S11): التدقيقُ الذي ينفّذه المحرّكُ بنفسه سقط على اعتمادياتٍ لم تمسّها الجولة، فعُدّ فشلاً يُصلَح —
 * صعودٌ ودرسٌ و«أصلح السبب» — فسرد النموذجُ «⚙ npm install» بلا أداة. يُقاس بما يصل النموذجَ بعد التدقيق الآليّ.
 * (`npm audit` بلا ملفّ قفل يفشل حتميّاً بلا شبكة: ENOLOCK.)
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { stripChildEnv } from "../../tools/src/env-strip"

async function run(task: string, replies: readonly string[], dependencies: Record<string, string> = { "left-pad": "1.3.0" }) {
  // the folder carries the package's name: the identity guard refuses a package.json rewrite whose name differs from its folder
  const home = mkdtempSync(join(tmpdir(), "abdo-audit-pre-")), project = join(home, "audit-pre")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "audit-pre", version: "1.0.0", private: true, dependencies }))
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
  try {
    const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "exec", task, "--project", project, "--mode", "full-access", "--json"], {
      cwd: resolve(import.meta.dir, "../../.."),
      env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "3", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
      stdout: "pipe", stderr: "pipe",
    })
    const [, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const afterAudit = bodies.filter((b) => b.includes("npm audit --audit-level=high") && b.includes("تلقائيًا"))
    // 10-11 — بعد التدقيق الذي تشغّله النواة: نداءُ نموذجٍ آخر، أو إغلاقٌ بلا نداء (gate-replay-live) — يُعدّ من نداءات النموذج.
    return { stderr, afterAudit, audited: stderr.includes("npm audit"), calls: bodies.length, manifest: readFileSync(join(project, "package.json"), "utf8") }
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }) }
}

test("an engine-run audit that fails on untouched dependencies is reported once and does not send the model to repair packages", async () => {
  const r = await run("Add index.js to this npm project that prints hi", ["نفّذ: write index.js <<<\nconsole.log('hi')\n", "Done: index.js prints hi."])
  // 10-11: الفشلُ الموروث لا يحجب — فالدورُ يُغلق بلا نداء نموذجٍ بعد التدقيق (نداءان: الكتابة والجواب)، فلا أحدَ يُرسَل لإصلاح الحزم.
  expect(r.audited, r.stderr.slice(-1500)).toBe(true)
  expect(r.calls).toBe(2)
  expect(r.afterAudit.some((b) => b.includes("أصلح السبب إن فشل"))).toBe(false)
}, 180_000)

test("the twin: when the turn changed a dependency in package.json the same audit failure is a failure to fix", async () => {
  // read first: the write tool refuses to overwrite a file it has not read (a refused write is not a dependency change)
  const r = await run("Add index.js to this npm project that prints hi", ["نفّذ: read package.json", "نفّذ: write package.json <<<\n{\"name\":\"audit-pre\",\"version\":\"1.0.1\",\"private\":true,\"dependencies\":{\"left-pad\":\"1.3.0\",\"is-odd\":\"3.0.1\"}}\n", "نفّذ: write index.js <<<\nconsole.log('hi')\n", "Done: index.js prints hi."])
  expect(JSON.parse(r.manifest).dependencies?.["is-odd"], r.stderr.slice(-1500)).toBe("3.0.1")
  expect(r.afterAudit.length, r.stderr.slice(-1500)).toBeGreaterThan(0)
  expect(r.afterAudit.some((b) => b.includes("أصلح السبب إن فشل"))).toBe(true)
  expect(r.afterAudit.some((b) => b.includes("ثغراتٌ سابقة في اعتمادياتٍ لم تمسّها"))).toBe(false)
}, 180_000)

// 10-11 (مقيس على m7): بلا dependencies ولا قفل لا شيءَ يُدقَّق — كانت البوّابةُ تطالب بـnpm audit (ENOLOCK) أربعَ حقبٍ بعد اكتمال العمل.
test("a project with no dependencies and no lockfile is never sent to npm audit", async () => {
  const r = await run("Add index.js to this npm project that prints hi", ["نفّذ: write index.js <<<\nconsole.log('hi')\n", "Done: index.js prints hi."], {})
  expect(r.audited, r.stderr.slice(-1200)).toBe(false)
  expect(r.afterAudit.length).toBe(0)
}, 180_000)

// 10-11 (مقيس على CRM الثالث): تعديلُ سطر سكربتٍ («db:drift») ليس مسّاً للاعتماديات — كان يجعل فشلَ التدقيق الموروث فشلاً يُصلَح ويصعد إلى Pro.
test("editing only a script in package.json leaves an inherited audit failure non-blocking", async () => {
  const r = await run("Add index.js to this npm project that prints hi", ["نفّذ: read package.json", "نفّذ: write package.json <<<\n{\"name\":\"audit-pre\",\"version\":\"1.0.0\",\"private\":true,\"dependencies\":{\"left-pad\":\"1.3.0\"},\"scripts\":{\"start\":\"node index.js\"}}\n", "نفّذ: write index.js <<<\nconsole.log('hi')\n", "Done: index.js prints hi."])
  // the positive twin: the script edit really landed — the green below is not «the write was refused»
  expect(JSON.parse(r.manifest).scripts?.start, r.stderr.slice(-1500)).toBe("node index.js")
  expect(r.audited, r.stderr.slice(-1500)).toBe(true)
  expect(r.calls).toBe(4) // read، كتابةُ البيان، كتابةُ index.js، الجواب — ولا نداءَ بعد التدقيق
  expect(r.afterAudit.some((b) => b.includes("أصلح السبب إن فشل"))).toBe(false)
}, 180_000)
