import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

// هـ2 — سلّمُ الأوضاع على المحرّك الحقيقيّ: «أساسيّ» = وكيلٌ واحد ولا موجِّهَ وteam مرفوضة؛ «أقوى» = الوكيلُ الموجِّه يقرأ أوّلاً
// (طلبُه إلى النموذج يسبق طلبَ الدور ويحمل تعليماته وسقفه) وخلاصتُه [ORIENTATION] تدخل مدخلَ الحقبة الأولى؛ «أقوى+» = team بوكيلين
// متوازيين كلٌّ بمهمّته، والجوابُ فريقٌ من اثنين، وسقفُ العدد يُقال. النموذجُ خادمٌ زائف يردّ بحسب محتوى آخر رسالة.

const ROOT = resolve(import.meta.dir, "../../..")

async function session(workMode: string, orientWithoutTool = false): Promise<{ turn: (body: string) => Promise<string[]>; requests: { system: string; user: string }[]; frames: any[]; close: () => Promise<void> }> {
  const base = mkdtempSync(join(tmpdir(), "abdo-workmode-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(join(project, "src"), { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  writeFileSync(join(project, "README.md"), "# proj\nموقعٌ تجريبيّ.\n")
  writeFileSync(join(project, "src", "a.ts"), "export const a = 1\n")
  const requests: { system: string; user: string }[] = []
  let teamIssued = false, fiveIssued = false, orientToolRan = false
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages?: { role: string; content: unknown }[] }
    const msgs = body.messages ?? []
    const text = (m: { content: unknown } | undefined) => m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    const user = text([...msgs].reverse().find((m) => m.role === "user"))
    // المطابقةُ على كلّ رسائل المستخدم لا آخرِها: الجولةُ الثانية داخل الحقبة تحمل رسالةَ تصحيحٍ قصيرة.
    const all = msgs.filter((m) => m.role === "user").map(text).join("\n")
    requests.push({ system: msgs.filter((m) => m.role === "system").map(text).join("\n"), user })
    // الردُّ بحسب من يسأل: الموجِّه يخرج بخلاصةٍ مهيكلة؛ أطفالُ الفريق يجيبون بمهمّتهم؛ الدورُ الرئيس يستدعي team مرّةً ثمّ ينهي.
    let content = "Done."
    // الموجِّه يقرأ أوّلاً ثمّ يكتب خلاصتَه: خلاصةٌ بلا إيصالٍ تُهمل عمداً (فحصُها في «أقوى بلا أداة» أدناه).
    if (all.includes("أنت الوكيلُ الموجِّه")) content = (orientToolRan || orientWithoutTool) ? "[ORIENTATION]\nالهدف: إضافة صفحة\nالحالة الآن: مشروعٌ بلا Git\nما يخصّ الطلب: src/a.ts\nالفجوات والمخاطر: لا اختبارات\nاقرأ قبل الفعل: README.md\nخطّة مقترحة: s1: أنشئ الصفحة | s2: اختبر [after: s1]\n[/ORIENTATION]" : ((orientToolRan = true), "نفّذ: list .")
    else if (all.includes("المهمّة المفوَّضة إليك:\nاقرأ package.json")) content = "package.json: proj 1.0.0"
    else if (all.includes("المهمّة المفوَّضة إليك:\nاسترجع")) content = "لا شيءَ مقيس بعد"
    else if (all.includes("TEAM-NOW") && !all.includes("المهمّة المفوَّضة") && !teamIssued) { teamIssued = true; content = "نفّذ: team <<<\nplanner :: اقرأ package.json وقل ما فيه\nrecaller :: استرجع ما قيس عن المشروع" }
    else if (all.includes("TEAM-FIVE") && !all.includes("المهمّة المفوَّضة") && !fiveIssued) { fiveIssued = true; content = "نفّذ: team <<<\nplanner :: أ\nplanner :: ب\nplanner :: ج\nplanner :: د\nplanner :: هـ" }
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "tool-fixture/model", chatModel: "tool-fixture/model", modelRole: "agent", mode: "full-access", project, routerGate: "off", railPolicy: "thin", workMode, plugins: { inventory: false, verifier: false, reviewer: false, delegation: true, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 }, customProviders: [{ id: "tool-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 90_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2500)); await Bun.sleep(15) } }
  send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
  let n = 0
  const turn = async (body: string) => { const id = `wm-${++n}`; send({ kind: "submit", mode: "full-access", turn: { id, body } }); await wait(() => frames.some((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind))); return frames.filter((f) => f.kind === "tool-result" && f.turnId === id).map((f) => String(f.output)) }
  return { turn, requests, frames, close: async () => { child.kill(); await child.exited; server.stop(true); await errors; rmSync(base, { recursive: true, force: true }) } }
}

test.skipIf(process.platform !== "win32")("basic: one agent, no orientation, team refused by mode — bytes as before", async () => {
  const s = await session("basic")
  try {
    const results = await s.turn("TEAM-NOW أضف صفحة «من نحن»")
    expect(s.requests[0]!.user).not.toContain("أنت الوكيلُ الموجِّه")
    expect(s.requests[0]!.user).not.toContain("[ORIENTATION]")
    expect(results[0]).toContain("رُفض team: وضعُ العمل «أساسيّ» لا يوازي")
    // ولا تُعلَن أداةٌ لا تعمل في هذا الوضع: كتالوجُ الأساسيّ بلا team (قاعدةُ delegate نفسُها)
    expect(s.requests[0]!.system).not.toContain("- team ")
    expect(s.frames.some((f) => f.kind === "event" && String(f.payload ?? "").includes("🧭 وضعُ العمل"))).toBe(false) // لا إعلانَ وضعٍ ولا موجِّه؛ رفضُ team وحده يذكر الوضع
  } finally { await s.close() }
}, 120_000)

test.skipIf(process.platform !== "win32")("strong: the orientation agent reads first and its [ORIENTATION] brief enters the first epoch; Super Abdo verification is switched on by the mode", async () => {
  const s = await session("strong")
  try {
    await s.turn("أضف صفحة «من نحن»")
    // الطلبُ الأوّل إلى النموذج هو الموجِّه (تعليماتُه وسقفُه)، لا الدور
    expect(s.requests[0]!.user).toContain("أنت الوكيلُ الموجِّه")
    expect(s.requests[0]!.user).toContain("أدواتك المتاحة (وهي كلُّ ما تستطيع): project-orient، recall، read، list، glob، grep، git، docs")
    expect(s.requests[0]!.user).toContain("سقفُك قراءةٌ فقط")
    // الدورُ الرئيس يتلقّى الخلاصةَ في مدخل حقبته الأولى
    const main = s.requests.find((r) => r.user.includes("أضف صفحة «من نحن»") && !r.user.includes("المهمّة المفوَّضة"))
    expect(main).toBeDefined()
    expect(main!.user).toContain("[ORIENTATION]")
    // موسومةٌ بكاتبها: نصُّ نموذجٍ بجوار القياس كان يُقرأ كأنّه قياس
    expect(main!.user).toContain("[وكيلُ التوجيه — نصٌّ كتبه نموذجٌ بعد 1 أداةً")
    expect(main!.user).toContain("خطّة مقترحة: s1: أنشئ الصفحة")
    const events = s.frames.filter((f) => f.kind === "event").map((f) => String(f.payload ?? ""))
    expect(events.some((t) => t.includes("وضعُ العمل «أقوى»") && t.includes("وكيلٌ موجِّه يقرأ المشروع أوّلاً"))).toBe(true)
    expect(events.some((t) => t.includes("الوكيلُ الموجِّه أنهى القراءة") && t.includes("موسومةً بكاتبها"))).toBe(true)
    // والوضعُ يقول إنّه فعّل التحقّقَ فوق إعداد المالك (Super Abdo مطفأٌ في هذه الإعدادات)
    expect(events.some((t) => t.includes("فعّلهما هذا الوضعُ فوق إعدادك"))).toBe(true)
    expect(events.some((t) => t.includes("Super Abdo: inspect"))).toBe(true) // الوضعُ فعّل الاستراتيجيّة رغم إطفاء المستخدم لها
  } finally { await s.close() }
}, 120_000)

test.skipIf(process.platform !== "win32")("stronger: team runs two specific agents in parallel, each under its own ceiling, and reports as one", async () => {
  const s = await session("stronger")
  try {
    const results = await s.turn("TEAM-NOW أضف صفحة «من نحن»")
    const team = results.find((r) => r.includes("فريقٌ من 2 وكلاء"))
    expect(team).toBeDefined()
    expect(team).toContain("وضع «أقوى+»")
    expect(team).toContain("planner")
    expect(team).toContain("recaller")
    // طلبا الطفلين وصلا النموذجَ كلٌّ بمهمّته وسقفه
    expect(s.requests.some((r) => r.user.includes("المهمّة المفوَّضة إليك:\nاقرأ package.json") && r.user.includes("سقفُك قراءةٌ فقط"))).toBe(true)
    expect(s.requests.some((r) => r.user.includes("المهمّة المفوَّضة إليك:\nاسترجع"))).toBe(true)
    // إطارا الأداة للفريق بأرقامهما
    // والتوأمُ الإيجابيّ: في وضعٍ يوازي تُعلَن الأداةُ في كتالوج **الدور** (طلبُ الطفل مقصوصٌ بسقفه فلا تظهر فيه)
    const parentRequest = s.requests.find((r) => r.user.includes("TEAM-NOW") && !r.user.includes("المهمّة المفوَّضة"))
    expect(parentRequest!.system).toContain("- team ")
    const tools = s.frames.filter((f) => f.kind === "tool").map((f) => String(f.cmd))
    expect(tools).toContain("team 1/2 · planner")
    expect(tools).toContain("team 2/2 · recaller")
    // سقفُ العدد يُقال: خمسُ مهامّ في وضعٍ سقفُه ٤
    const over = await s.turn("TEAM-FIVE قسّم العمل")
    expect(over.some((r) => r.includes("تتجاوز سقفَ التوازي 4"))).toBe(true)
  } finally { await s.close() }
}, 180_000)

test.skipIf(process.platform !== "win32")("strong: an orientation brief written without running a single tool is a guess — it is dropped, said, and never injected", async () => {
  const s = await session("strong", true)
  try {
    await s.turn("أضف صفحة «من نحن»")
    const main = s.requests.find((r) => r.user.includes("أضف صفحة «من نحن»") && !r.user.includes("المهمّة المفوَّضة"))
    expect(main).toBeDefined()
    expect(main!.user).not.toContain("[ORIENTATION]")
    expect(main!.user).not.toContain("وكيلُ التوجيه")
    const events = s.frames.filter((f) => f.kind === "event").map((f) => String(f.payload ?? ""))
    expect(events.some((t) => t.includes("بلا تشغيل أداةٍ واحدة") && t.includes("تُهمل"))).toBe(true)
    expect(events.some((t) => t.includes("أنهى القراءة"))).toBe(false)
  } finally { await s.close() }
}, 120_000)
