/**
 * الفجوة #3 (2026-09-27) — خطّافاتُ المشروع على المحرّك الحقيقيّ ونموذجٍ مكتوبٍ باليد، بنمط **الوصول الكامل**:
 * · الموافقةُ تُسأل رغم الوصول الكامل، ولا يعمل شيءٌ قبلها؛ وتُحفظ بالبصمة فلا تُسأل ثانيةً، وتغييرُ الملفّ يعيدها.
 * · afterEdit يعمل بعد الكتابة وخرجُه في إيصالها؛ وbeforeDone الفاشلُ يعيد خرجَه إلى النموذج حتى يصلح، ثمّ يكتمل الدور.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { stripChildEnv } from "../../tools/src/env-strip"

const BROKEN = "نفّذ: write sum.js <<<\nmodule.exports = (a, b) => a - b\n"
const FIXED = "نفّذ: write sum.js <<<\nmodule.exports = (a, b) => a + b\n"
const HOOKS = JSON.stringify({
  afterEdit: [{ match: "\\.js$", run: "node -e \"console.log('AFTER-EDIT-RAN')\"" }],
  beforeDone: [{ run: "node check.js" }],
})
const CHECK = "const s = require('fs').readFileSync('sum.js', 'utf8'); if (s.includes('a - b')) { console.log('CHECK-FAILED: subtraction'); process.exit(1) } console.log('CHECK-OK')\n"

async function session(home: string, project: string, turns: { replies: readonly string[]; decision: "approve" | "deny" | "none" }[]) {
  let requests = 0
  let script: readonly string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const content = script[Math.min(requests, script.length - 1)]!
    requests += 1
    const payload = await request.json() as { stream?: boolean }
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(home, "settings.json")
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "full-access", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const frames: any[] = []
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), ABDO_SHELL_TOKEN: "t", ABDO_FRAMED_STDIO: "1", USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "6", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) for (const frame of decoder.push(bytes)) frames.push(frame) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 90_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out: " + label + " " + JSON.stringify(frames.slice(-6)).slice(0, 1500)); await Bun.sleep(15) } }
  const results: { approvals: string[]; events: string[]; receipts: string[]; end: any; requests: number }[] = []
  try {
    send({ kind: "hello", shell: "desktop", token: "t" })
    await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    for (const [index, turn] of turns.entries()) {
      // معرّفٌ فريدٌ لكلّ جلسة: المعرّفُ المعاد على الدليل نفسِه يُعيد نتيجةَ الدور السابق (إعادةُ تشغيلٍ متطابقة — سلوكٌ مقصود).
      const id = `h${index}-${crypto.randomUUID().slice(0, 8)}`
      script = turn.replies; requests = 0
      send({ kind: "submit", mode: "full-access", turn: { id, body: "Fix sum.js" } })
      const ended = () => frames.some((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind))
      if (turn.decision !== "none") {
        await wait(() => ended() || frames.some((f) => f.turnId === id && f.kind === "approval"), "approval " + id)
        if (!ended()) send({ kind: turn.decision, turnId: id })
      }
      await wait(ended, "turn end " + id)
      results.push({
        approvals: frames.filter((f) => f.turnId === id && f.kind === "approval").map((f) => String(f.request)),
        events: frames.filter((f) => f.turnId === id && f.kind === "event").map((f) => String(f.payload)),
        receipts: frames.filter((f) => f.turnId === id && f.kind === "tool-result").map((f) => String(f.output)),
        end: frames.find((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind)),
        requests,
      })
    }
    return results
  } finally {
    child.kill(); await child.exited; await reading; await stderr; server.stop(true)
  }
}

const fixture = (hooks = HOOKS) => {
  const home = mkdtempSync(join(tmpdir(), "abdo-hooks-live-")), project = join(home, "proj")
  mkdirSync(join(project, ".abdo"), { recursive: true })
  writeFileSync(join(project, ".abdo", "hooks.json"), hooks)
  writeFileSync(join(project, "check.js"), CHECK)
  writeFileSync(join(project, "sum.js"), "module.exports = (a, b) => a + b\n")
  return { home, project }
}

test("full access still asks; afterEdit reports in the receipt; a red beforeDone sends the model back until it is green", async () => {
  const { home, project } = fixture()
  try {
    const [first, second] = await session(home, project, [
      { replies: [BROKEN, "Done.", FIXED, "Done."], decision: "approve" },
      { replies: ["All good already."], decision: "none" },
    ])
    expect(first!.approvals).toHaveLength(1)
    expect(first!.approvals[0]).toContain("تفعيلُ خطّافات المشروع .abdo/hooks.json")
    expect(first!.approvals[0]).toContain("beforeDone: node check.js")
    expect(first!.events.some((e) => e.startsWith("🪝 خطّافاتُ المشروع مفعّلة (2)"))).toBe(true)
    expect(first!.receipts.filter((r) => r.includes("🪝 afterEdit") && r.includes("AFTER-EDIT-RAN"))).toHaveLength(2)
    const failedAt = first!.events.findIndex((e) => e.startsWith("🪝 beforeDone «node check.js»: فشل") && e.includes("CHECK-FAILED"))
    const passedAt = first!.events.findIndex((e) => e.startsWith("🪝 beforeDone «node check.js»: نجح"))
    expect(failedAt).toBeGreaterThanOrEqual(0)
    expect(passedAt).toBeGreaterThan(failedAt)
    expect(first!.end).toMatchObject({ kind: "done", outcome: "completed" })
    expect(readFileSync(join(project, "sum.js"), "utf8")).toContain("a + b")
    // الموافقةُ محفوظةٌ بالبصمة: الدورُ الثاني لا يُسأل.
    expect(second!.approvals).toHaveLength(0)
    expect(second!.events.some((e) => e.startsWith("🪝 خطّافاتُ المشروع مفعّلة"))).toBe(true)
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 200_000)

test("the twins: a denied approval runs nothing, and a changed file is asked about again", async () => {
  const { home, project } = fixture()
  try {
    const [denied] = await session(home, project, [{ replies: [BROKEN, "Done."], decision: "deny" }])
    expect(denied!.approvals).toHaveLength(1)
    expect(denied!.events.some((e) => e.startsWith("🪝 خطّافاتُ المشروع لم تُفعَّل: لم تُمنح الموافقة"))).toBe(true)
    expect(denied!.receipts.some((r) => r.includes("AFTER-EDIT-RAN"))).toBe(false)
    expect(denied!.events.some((e) => e.startsWith("🪝 beforeDone"))).toBe(false)
    // وافق مرّةً ثمّ غيّر الملفّ: يُسأل من جديد.
    const [approved] = await session(home, project, [{ replies: ["Nothing to do."], decision: "approve" }])
    expect(approved!.approvals).toHaveLength(1)
    writeFileSync(join(project, ".abdo", "hooks.json"), HOOKS.replace("AFTER-EDIT-RAN", "CHANGED-HOOK"))
    const [changed] = await session(home, project, [{ replies: ["Nothing to do."], decision: "deny" }])
    expect(changed!.approvals).toHaveLength(1)
    expect(changed!.approvals[0]).toContain("CHANGED-HOOK")
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 300_000)
