/**
 * بوّابةُ الاختبارات ونطاقُها (مقيس حيّاً 2026-09-27 أثناء قياس البحث بلا مفتاح): «Find the Bun test runner documentation» في مشروعٍ
 * بلا اختبارات ولم يُعدَّل فيه شيء ⇦ طالبت البوّابةُ بـnpm test بكلمة «test» وحدها فانتهى الدورُ `checkpointed` أبداً.
 * الآن: لا تنطبق حين لا تُمسّ شيفرة ولا يكلّف الطلبُ بعملٍ على الاختبارات ولا يعرّف المشروعُ أمرَ اختبار — ويُقال ذلك باسمه.
 * والتوأم: «Add tests for sum.js» ونموذجٌ كسولٌ يقول «Done.» بلا كتابة ⇦ الشرطُ باقٍ ولا يُعلن الإكمال.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { stripChildEnv } from "../../tools/src/env-strip"

async function turn(body: string, replies: readonly string[], files: Record<string, string>) {
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const content = replies[Math.min(requests, replies.length - 1)]!
    requests += 1
    const payload = await request.json() as { stream?: boolean }
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const home = mkdtempSync(join(tmpdir(), "abdo-tests-scope-")), project = join(home, "proj"), settings = join(home, "settings.json")
  mkdirSync(project, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(project, name), content)
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
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), ABDO_SHELL_TOKEN: "t", ABDO_FRAMED_STDIO: "1", USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "4", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) for (const frame of decoder.push(bytes)) frames.push(frame) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 60_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out: " + label); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "t" })
    await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    send({ kind: "submit", mode: "full-access", turn: { id: "g1", body } })
    await wait(() => frames.some((f) => f.turnId === "g1" && ["done", "refused", "unresolved"].includes(f.kind)), "turn end")
    return {
      requests,
      end: frames.find((f) => f.turnId === "g1" && ["done", "refused", "unresolved"].includes(f.kind)),
      events: frames.filter((f) => f.turnId === "g1" && f.kind === "event").map((f) => String(f.payload)),
    }
  } finally {
    child.kill(); await child.exited; await reading; await stderr; server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}

test("a lookup that only mentions «test» completes — the gate says by name that it does not apply", async () => {
  const lookup = await turn("Find the Bun test runner documentation", ["The Bun test runner docs are at https://bun.com/docs/test"], {})
  expect(lookup.end).toMatchObject({ kind: "done", outcome: "completed" })
  expect(lookup.events.filter((e) => e.startsWith("↻ شرطُ الاختبارات لا ينطبق"))).toHaveLength(1)
  expect(lookup.events.some((e) => e.startsWith("↻ شرط الاختبارات:"))).toBe(false)
  expect(lookup.events.some((e) => e.startsWith("بوابات القبول:") && e.includes("الاختبارات"))).toBe(false)
}, 120_000)

test("the twin: asking for tests and answering «Done.» without writing any is still not completed", async () => {
  const lazy = await turn("Add tests for sum.js", ["Done."], { "sum.js": "module.exports = (a, b) => a + b\n" })
  expect(lazy.end).toMatchObject({ kind: "done", outcome: "checkpointed" })
  expect(lazy.events.some((e) => e.startsWith("↻ شرط الاختبارات:"))).toBe(true)
  expect(lazy.events.some((e) => e.startsWith("↻ شرطُ الاختبارات لا ينطبق"))).toBe(false)
}, 120_000)
