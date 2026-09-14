import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

// هـ3 — التفنيدُ العدائيّ في وضع «أقصى» على المحرّك الحقيقيّ: بعد أن تقول المراجعةُ المستقلّة COMPLETE، ثلاثُ عدساتٍ تحاول دحضَ
// الاكتمال. **اثنتان تُوقفان** التسليم بسببهما ويُعاد إلى حلقة الإصلاح، و**واحدةٌ رأيٌ** يُقال ولا يوقف (التوأمُ الإيجابيّ الذي
// يمنع مفنِّداً متشائماً واحداً من أن يصير بابَ تعليقٍ دائم). والعدُّ يُبثّ للمشغّل عدسةً عدسة، والكلفةُ تُعلَن قبل الإنفاق.

const ROOT = resolve(import.meta.dir, "../../..")

async function run(refutations: Record<string, boolean>): Promise<{ events: string[]; results: string[] }> {
  const base = mkdtempSync(join(tmpdir(), "abdo-refute-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  let parentAsked = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages?: { role: string; content: unknown }[] }
    const msgs = body.messages ?? []
    const text = (m: { content: unknown } | undefined) => m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    const system = msgs.filter((m) => m.role === "system").map(text).join("\n")
    const all = msgs.filter((m) => m.role === "user").map(text).join("\n")
    let content = "Done."
    if (system.includes("أنت مُفنِّدٌ مستقلّ")) {
      // كلُّ عدسةٍ تُعرف بسؤالها في المدخل — والردُّ بعقد السطرين
      const lens = all.includes("هل يُثبت الإيصالُ") ? "evidence" : all.includes("اعدد ادّعاءات") ? "unproven" : "breaks"
      content = refutations[lens] === true ? `الحكم: REFUTED\nالسبب: ${lens} — لا إيصالَ يمسّ الهدف` : "الحكم: STANDS\nالسبب: الإيصالات تكفي"
    } else if (system.includes("[SUPER_ABDO_REVIEW]")) {
      content = "COMPLETE\nThe receipts cover the requested reading."
    } else if (system.includes("أنت الوكيلُ الموجِّه") || all.includes("أنت الوكيلُ الموجِّه")) {
      content = "لا حاجة للتوجيه هنا."
    } else {
      parentAsked += 1
      content = parentAsked === 1 ? "نفّذ: read package.json" : "قرأتُ المانيفست: proj 1.0.0 — تمّ الهدف."
    }
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "tool-fixture/model", chatModel: "tool-fixture/model", modelRole: "agent", mode: "full-access", project, routerGate: "off", railPolicy: "thin", workMode: "max", plugins: { inventory: false, verifier: false, reviewer: false, delegation: true, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 }, customProviders: [{ id: "tool-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 120_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2000)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    send({ kind: "submit", mode: "full-access", turn: { id: "rf-1", body: "اقرأ المانيفست وقل ما فيه" } })
    await wait(() => frames.some((f) => f.turnId === "rf-1" && ["done", "refused", "unresolved"].includes(f.kind)))
    return {
      events: frames.filter((f) => f.kind === "event").map((f) => String(f.payload ?? "")),
      results: frames.filter((f) => f.kind === "tool-result" && f.turnId === "rf-1").map((f) => String(f.output)),
    }
  } finally { child.kill(); await child.exited; server.stop(true); await errors; for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } } }
}

test.skipIf(process.platform !== "win32")("max: two refuting lenses withhold completion with their named reasons, and the tally is published lens by lens", async () => {
  const { events } = await run({ evidence: true, unproven: true, breaks: false })
  // الكلفةُ تُعلَن قبل الإنفاق
  expect(events.some((t) => t.includes("⚔ التفنيد العدائيّ (وضع «أقصى»)") && t.includes("ثلاثةُ نداءات"))).toBe(true)
  // والعدُّ عدسةً عدسة
  const tally = events.find((t) => t.includes("2/3 دحضاً"))
  expect(tally).toBeDefined()
  expect(tally).toContain("evidence: دحض")
  expect(tally).toContain("unproven: دحض")
  expect(tally).toContain("breaks: قائم")
  // والتسليمُ يُحجب بسببٍ يحمل اسمَي العدستين
  const withheld = events.find((t) => t.includes("completion withheld"))
  expect(withheld).toBeDefined()
  expect(withheld).toContain("التفنيد العدائيّ أوقف التسليم")
  expect(withheld).toContain("[evidence]")
  expect(withheld).toContain("[unproven]")
}, 240_000)

test.skipIf(process.platform !== "win32")("max: one refuting lens is an opinion — it is published but does not withhold completion (the positive twin)", async () => {
  const { events } = await run({ evidence: true, unproven: false, breaks: false })
  expect(events.some((t) => t.includes("1/3 دحضاً"))).toBe(true)
  expect(events.some((t) => t.includes("completion withheld"))).toBe(false)
  expect(events.some((t) => t.includes("التفنيد العدائيّ أوقف التسليم"))).toBe(false)
}, 240_000)
