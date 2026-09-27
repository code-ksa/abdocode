/**
 * البند 25 من جرد هيرمس/أوبن‑كلاو — حارسُ الإكمال الفارغ، على المحرّك الحقيقيّ ونموذجٍ مكتوبٍ باليد.
 *
 * مقيس 2026-09-27 قبل الإصلاح: نموذجٌ يردّ فراغاً ⇦ نداءٌ واحد ثمّ `done · completed` بصفر أدوات —
 * طلبُ «أنشئ ملفّاً» ينتهي «مكتملاً» بلا شيء. الآن: الفراغُ لا يُحسب إنجازاً أبداً ويُسمّى سببُه،
 * و`plugins.emptyGuard` يضيف محاولةً ثانيةً واحدة بتنبيهٍ ثمّ يتوقّف — لا إعادةَ بلا حدّ.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const EMPTY_LINE = "⚠ ردّ النموذج فراغاً — لا جوابَ ولا أداة."

async function turnWith(replies: readonly string[], emptyGuard: boolean) {
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const content = replies[Math.min(requests, replies.length - 1)]!
    requests += 1
    const body = await request.json() as { stream?: boolean }
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const base = mkdtempSync(join(tmpdir(), "abdo-empty-guard-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), "{}")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({
    language: "en", agentModel: "fx/model", chatModel: "fx/model", modelRole: "agent", mode: "auto", project, routerGate: "off", railPolicy: "thin", workMode: "basic",
    plugins: { inventory: false, verifier: false, reviewer: false, emptyGuard },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...process.env, ABDO_SHELL_TOKEN: "t", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), frames: any[] = [], decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) for (const frame of decoder.push(bytes)) frames.push(frame) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 60_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out: " + label); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "t" })
    await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    send({ kind: "submit", mode: "auto", turn: { id: "e1", body: "Say hello in one word" } })
    await wait(() => frames.some((f) => f.turnId === "e1" && ["done", "refused", "unresolved"].includes(f.kind)), "turn end")
    const end = frames.find((f) => f.turnId === "e1" && ["done", "refused", "unresolved"].includes(f.kind))
    const events = frames.filter((f) => f.turnId === "e1" && f.kind === "event").map((f) => String(f.payload))
    return { requests, end, events }
  } finally {
    child.kill(); await child.exited; await reading; await stderr; server.stop(true)
    rmSync(base, { recursive: true, force: true })
  }
}

test("an empty reply is never completed: off stops at once by name, on asks exactly once more", async () => {
  const off = await turnWith([""], false)
  expect(off.requests).toBe(1)
  expect(off.end).toMatchObject({ kind: "done", outcome: "checkpointed" })
  expect(off.events.some((e) => e.includes("التوقف: empty-reply"))).toBe(true)
  expect(off.events.filter((e) => e.startsWith(EMPTY_LINE))).toHaveLength(1)

  const on = await turnWith(["  \n "], true)
  // نداءان لا أكثر: السياقُ نفسُه لا يُعاد إلى الطريق نفسِه بلا حدّ.
  expect(on.requests).toBe(2)
  expect(on.end).toMatchObject({ kind: "done", outcome: "checkpointed" })
  expect(on.events.some((e) => e.startsWith("↻ ردٌّ فارغ من النموذج"))).toBe(true)
  expect(on.events.some((e) => e.includes("التوقف: empty-reply"))).toBe(true)
}, 120_000)

test("the positive twin: with the guard on, an empty reply followed by a real answer completes normally", async () => {
  const recovered = await turnWith(["", "hello"], true)
  expect(recovered.requests).toBe(2)
  expect(recovered.end).toMatchObject({ kind: "done", outcome: "completed" })
  expect(recovered.events.some((e) => e.startsWith(EMPTY_LINE))).toBe(false)
  expect(recovered.events).toContain("hello")
}, 120_000)
