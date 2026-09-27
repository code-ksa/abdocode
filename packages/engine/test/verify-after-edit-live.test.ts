/**
 * ميزةُ ذكاءٍ مقيسة (2026-09-27) — التحقّقُ بعد التعديل، على المحرّك الحقيقيّ ونموذجٍ مكتوبٍ باليد.
 *
 * مقيس قبلها (المفتاحُ مطفأ = السلوكُ القديم): نموذجٌ يكسر `sum.js` في مشروعٍ اختباراتُه `node --test` ثمّ
 * يقول «Done.» ⇦ `completed` بنداءَين، والاختباراتُ لم تُشغَّل، والشيفرةُ المكسورة على القرص.
 * بعدها: المضيفُ يشغّل اختباراتِ المشروع بنفسه، فيرى النموذجُ الفشلَ ويصلح، ولا يُعلَن الإكمالُ إلّا أخضرَ.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { stripChildEnv } from "../../tools/src/env-strip"

const BROKEN = "نفّذ: write sum.js <<<\nmodule.exports = (a, b) => a - b\n"
const FIXED = "نفّذ: write sum.js <<<\nmodule.exports = (a, b) => a + b\n"

async function turnWith(replies: readonly string[], opts: { verify: boolean; testScript?: boolean }) {
  const bodies: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const content = replies[Math.min(bodies.length, replies.length - 1)]!
    const body = await request.json() as { stream?: boolean; messages?: { content?: unknown }[] }
    bodies.push(JSON.stringify(body.messages ?? []))
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const home = mkdtempSync(join(tmpdir(), "abdo-verify-edit-")), project = join(home, "proj"), settings = join(home, "settings.json")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "verify-probe", version: "1.0.0", private: true, scripts: opts.testScript === false ? {} : { test: "node --test" } }))
  writeFileSync(join(project, "sum.js"), "module.exports = (a, b) => a + b\n")
  writeFileSync(join(project, "sum.test.js"), "const test = require('node:test'); const assert = require('node:assert'); const sum = require('./sum.js');\ntest('adds', () => assert.strictEqual(sum(2, 3), 5))\n")
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "full-access", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false, verifyAfterEdit: opts.verify },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const frames: any[] = []
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), ABDO_SHELL_TOKEN: "t", ABDO_FRAMED_STDIO: "1", USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "8", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) for (const frame of decoder.push(bytes)) frames.push(frame) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 90_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out: " + label + " " + JSON.stringify(frames).slice(-2000)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "t" })
    await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    send({ kind: "submit", mode: "full-access", turn: { id: "v1", body: "Refactor sum.js for clarity" } })
    await wait(() => frames.some((f) => f.turnId === "v1" && ["done", "refused", "unresolved"].includes(f.kind)), "turn end")
    const end = frames.find((f) => f.turnId === "v1" && ["done", "refused", "unresolved"].includes(f.kind))
    const events = frames.filter((f) => f.turnId === "v1" && f.kind === "event").map((f) => String(f.payload))
    const acceptanceRuns = frames.filter((f) => f.turnId === "v1" && f.kind === "tool" && f.acceptance === true).map((f) => String(f.cmd))
    return { bodies, end, events, acceptanceRuns, sum: readFileSync(join(project, "sum.js"), "utf8") }
  } finally {
    child.kill(); await child.exited; await reading; await stderr; server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}

test("before: with the key off, broken code is declared complete and the tests never run", async () => {
  const off = await turnWith([BROKEN, "Done."], { verify: false })
  expect(off.end).toMatchObject({ kind: "done", outcome: "completed" })
  expect(off.bodies).toHaveLength(2)
  expect(off.acceptanceRuns).toEqual([])
  expect(off.sum).toContain("a - b")
}, 150_000)

test("after: the host runs the project's tests, the model sees the failure and fixes it, and only green completes", async () => {
  const on = await turnWith([BROKEN, "Done.", FIXED, "Done.", "Done."], { verify: true })
  expect(on.events.filter((e) => e.startsWith("↻ التحقّق بعد التعديل"))).toHaveLength(2)
  expect(on.acceptanceRuns).toEqual(["run npm test", "run npm test"])
  // النموذجُ رأى خرجَ الفشل نفسَه — لا تلميحاً عامّاً.
  expect(on.bodies[2]).toContain("run npm test")
  expect(on.bodies[2]).toMatch(/fail(?:ed)?\s+1|1\s+fail/iu)
  expect(on.end).toMatchObject({ kind: "done", outcome: "completed" })
  expect(on.sum).toContain("a + b")
}, 150_000)

test("bounded: a model that offers no fix after a red run stops at once, and one that keeps editing wrong stops after three runs", async () => {
  const stubborn = await turnWith([BROKEN, "Done."], { verify: true })
  // الحارسُ القائم يكفي هنا: فحصٌ أحمر بلا أداة إصلاح ⇦ لا يُعاد الفحصُ نفسُه بلا تغيير.
  expect(stubborn.acceptanceRuns).toEqual(["run npm test"])
  expect(stubborn.events.some((e) => e.startsWith("بوابات القبول:") && e.includes("الاختبارات ✗ فشل"))).toBe(true)
  expect(stubborn.end).toMatchObject({ kind: "done", outcome: "checkpointed" })

  const wrong = (body: string) => `نفّذ: write sum.js <<<
module.exports = (a, b) => ${body}
`
  const flailing = await turnWith([wrong("a - b"), "Done.", wrong("a * b"), "Done.", wrong("a / b"), "Done.", wrong("b - a"), "Done."], { verify: true })
  expect(flailing.acceptanceRuns).toHaveLength(3)
  expect(flailing.events.some((e) => e.startsWith("⚠ التحقّق بعد التعديل: «npm test» لم ينجح بعد آخر تعديل رغم 3 تشغيلات"))).toBe(true)
  expect(flailing.end).toMatchObject({ kind: "done", outcome: "checkpointed" })
}, 200_000)

test("the twins: documentation-only edits and projects without a test script run nothing extra", async () => {
  const docs = await turnWith(["نفّذ: write NOTES.md <<<\n# notes\n", "Done."], { verify: true })
  expect(docs.acceptanceRuns).toEqual([])
  expect(docs.end).toMatchObject({ kind: "done", outcome: "completed" })
  expect(docs.bodies).toHaveLength(2)

  const noTests = await turnWith([BROKEN, "Done."], { verify: true, testScript: false })
  expect(noTests.acceptanceRuns).toEqual([])
  expect(noTests.end).toMatchObject({ kind: "done", outcome: "completed" })
}, 200_000)
