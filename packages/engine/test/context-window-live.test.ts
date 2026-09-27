/**
 * البندان 9 و10 — نافذةُ السياق في المهامّ الطويلة، على المحرّك الحقيقيّ ونموذجٍ مكتوبٍ باليد.
 * نافذةٌ صغيرة (ABDO_AGENT_CONTEXT_TOKENS) ونتيجةُ قراءةٍ كبيرة ⇦ الطلبُ الثاني يتجاوز الميزانيّة.
 * قبل الإصلاح: يُسقط التبادلُ كاملاً بصمت فلا يرى النموذجُ ما قرأه أصلاً ولا يُقال شيء.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { clipForWindow, contextBreakdownLine } from "../src/context-window"

test("clipping keeps head, tail and a visible marker, spares recent messages, and stops once enough is saved", () => {
  const tokensOf = (text: string) => Math.ceil(text.length / 4)
  const big = "A".repeat(20_000) + "MIDDLE" + "Z".repeat(20_000)
  const history = [{ role: "user", content: big }, { role: "assistant", content: "x" }, { role: "user", content: big }, { role: "assistant", content: "recent" }]
  const small = clipForWindow(history, 100, tokensOf)
  expect(small.clipped).toBe(1)
  expect(small.messages[0]!.content.startsWith("AAAA")).toBe(true)
  expect(small.messages[0]!.content.endsWith("ZZZZ")).toBe(true)
  expect(small.messages[0]!.content).toContain("…[قُصّ للنافذة: حُذف")
  expect(small.messages[0]!.content).not.toContain("MIDDLE")
  // الأقدمُ قبل الأحدث: حاجةٌ صغيرة تُقضى من الرسالة القديمة ولا تمسّ الأحدث.
  expect(small.messages[2]!.content).toBe(big)
  // وحين لا يكفي القديمُ يُقصّ الأحدثُ أيضاً — ولا يُترك الإسقاطُ الكامل وحده.
  const both = clipForWindow(history, 15_000, tokensOf)
  expect(both.clipped).toBe(2)
  expect(both.messages[2]!.content).toContain("…[قُصّ للنافذة: حُذف")
  expect(both.messages[3]!.content).toBe("recent")
  expect(clipForWindow(history, 0, tokensOf).clipped).toBe(0)
  expect(contextBreakdownLine({ system: 4200, catalogue: 7800, history: 34000, toolResults: 28000, request: 300, attachments: 0 }, 65536))
    .toBe("📏 نافذة السياق: نظام 4.2k · كتالوج 7.8k · تاريخ 34.0k (نتائج أدوات 28.0k) · الطلب 300 · مرفقات 0 = 46.3k من 65.5k (71%)")
})

async function longTask(ladder: boolean) {
  const bodies: string[] = []
  let calls = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages?: unknown }
    bodies.push(JSON.stringify(body.messages ?? []))
    calls += 1
    const content = calls === 1 ? "نفّذ: read big.txt" : "done"
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const base = mkdtempSync(join(tmpdir(), "abdo-window-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), "{}")
  // أرقامٌ متمايزة تُعرف أطرافُها: HEAD-0001 أوّلُ الملفّ وTAIL-END آخرُه.
  writeFileSync(join(project, "big.txt"), `HEAD-0001\n${Array.from({ length: 2400 }, (_, i) => `line ${i} of the long fixture text`).join("\n")}\nTAIL-END\n`)
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({
    language: "en", agentModel: "fx/model", chatModel: "fx/model", modelRole: "agent", mode: "auto", project, routerGate: "off", railPolicy: "thin", workMode: "basic",
    plugins: { inventory: false, verifier: false, reviewer: false, readCompaction: false, trailCompaction: false, overflowLadder: ladder, contextBreakdown: true },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...process.env, ABDO_SHELL_TOKEN: "t", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, APPDATA: base, ABDO_VAULT_HOME: join(base, "vh"), ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_CONTEXT_TOKENS: String(Number(process.env.WINDOW_TOKENS ?? 22_000)) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), frames: any[] = [], decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) for (const frame of decoder.push(bytes)) frames.push(frame) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 90_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out: " + label); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "t" })
    await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    send({ kind: "submit", mode: "auto", turn: { id: "w1", body: "Read big.txt and tell me its first and last lines" } })
    await wait(() => frames.some((f) => f.turnId === "w1" && ["done", "refused", "unresolved"].includes(f.kind)), "turn end")
    const events = frames.filter((f) => f.turnId === "w1" && f.kind === "event").map((f) => String(f.payload))
    return { bodies, events }
  } finally {
    child.kill(); await child.exited; await reading; await stderr; server.stop(true)
    rmSync(base, { recursive: true, force: true })
  }
}

test("a long task over the window: the ladder clips and keeps both ends, the old path drops and now says so", async () => {
  const withLadder = await longTask(true)
  expect(withLadder.events.some((e) => e.startsWith("📏 نافذة السياق:"))).toBe(true)
  const clippedLine = withLadder.events.find((e) => e.startsWith("📏 السياقُ تجاوز"))
  expect(clippedLine).toContain("قُصّت")
  expect(clippedLine).not.toContain("أُسقط")
  // الطلبُ الثاني يحمل طرفَي ما قُرئ وعلامةَ القصّ — لا نسياناً صامتاً.
  const second = withLadder.bodies[1]!
  expect(second).toContain("HEAD-0001")
  expect(second).toContain("قُصّ للنافذة")

  expect(withLadder.bodies).toHaveLength(2)

  // المسارُ القديم (السلّمُ مطفأ): يُسقط التبادلَ الذي يحمل الطلبَ الأصليّ، ثمّ تبقى النتيجةُ فوق الميزانيّة
  // فيفشل الدورُ ولا يصل النموذجَ الطلبُ الثاني أصلاً — والفرقُ الآن مقولٌ لا صامت.
  const withoutLadder = await longTask(false)
  const droppedLine = withoutLadder.events.find((e) => e.startsWith("📏 السياقُ تجاوز"))
  expect(droppedLine).toContain("أُسقط")
  expect(withoutLadder.events.some((e) => e.startsWith("السياق ") && e.includes("يتجاوز ميزانية المدخل"))).toBe(true)
  expect(withoutLadder.bodies).toHaveLength(1)
}, 240_000)
