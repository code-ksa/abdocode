import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

// هـ2 (تشديدُ المراجعة 2026-09-07) — ما لا يثبته اختبارُ السلّم: **التوازي الحقيقيّ** بطفلين يعملان معاً.
//  (١) موافقتان متزامنتان: خريطةُ الأسئلة مفتاحُها turnId وحده، فبلا رتلٍ يدهس الثاني الأوّلَ ويعلّق الدورَ أبداً.
//      الاختبار يفشل بانتهاء المهلة إن سقط الرتل — ويثبت التتابع: سؤالٌ ⇦ جوابٌ ⇦ سؤالٌ ⇦ جواب، لا سؤالان معاً.
//      (النمطُ «قراءة-فقط»: فيه وحده تُسأل الكتابة — «auto» يسمح بالتحرير والتنفيذ ويسأل عن الشبكة وخارج المساحة.)
//  (٢) سقفُ كلّ طفلٍ سقفُه هو: planner (قراءةٌ فقط) تُرفض كتابتُه بينما builder يكتب في اللحظة نفسها — التوأمُ الإيجابيّ
//      الذي يفرّق `hooks.childAgent` عن المتغيّر العالميّ الواحد.
//  (٣) طفلٌ لا يكتمل: التقريرُ يسمّيه وسببَه، وتقاريرُ إخوته لا تضيع، وكلُّ إطارِ أداةٍ يُغلق مرّةً واحدة.

const ROOT = resolve(import.meta.dir, "../../..")

interface Session {
  readonly turn: (body: string) => Promise<string[]>
  readonly frames: any[]
  readonly project: string
  readonly close: () => Promise<void>
}

/** عدّادٌ لكلّ علامةٍ يملكه الاختبار: بدايةُ نصّ الطفلين واحدةٌ (تعليماتُ الوكيل نفسها)، فعدّادٌ بمفتاح النصّ يخلط بينهما. */
const counter = () => { const seen = new Map<string, number>(); return (key: string) => { const n = (seen.get(key) ?? 0) + 1; seen.set(key, n); return n } }

async function session(workMode: string, mode: "read-only" | "full-access", reply: (user: string) => string): Promise<Session> {
  const base = mkdtempSync(join(tmpdir(), "abdo-wmc-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages?: { role: string; content: unknown }[] }
    const msgs = body.messages ?? []
    const text = (m: { content: unknown } | undefined) => m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    // كلُّ رسائل المستخدم لا آخرَها وحدها: الجولةُ الثانية داخل الحقبة تحمل رسالةَ تصحيحٍ قصيرة، فمطابقةُ الأخيرة تسقط.
    const content = reply(msgs.filter((m) => m.role === "user").map((m) => text(m)).join("\n"))
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "tool-fixture/model", chatModel: "tool-fixture/model", modelRole: "agent", mode, project, routerGate: "off", railPolicy: "thin", workMode, plugins: { inventory: false, verifier: false, reviewer: false, delegation: true, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false, unattendedDeny: false }, superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 }, customProviders: [{ id: "tool-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  // الموافقةُ تُمنح بعد مهلةٍ قصيرة: لو وصل سؤالان قبل أن يُجاب الأوّل لبانا متجاورين في السجلّ — وهو ما يُفحص.
  void (async () => {
    for await (const bytes of child.stdout) {
      for (const frame of decoder.push(bytes)) {
        frames.push(frame)
        if ((frame as { kind?: string }).kind === "approval") {
          const turnId = (frame as { turnId?: string }).turnId
          setTimeout(() => { frames.push({ kind: "test-approve", turnId }); send({ kind: "approve", turnId }) }, 50)
        }
      }
    }
  })()
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 120_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2500)); await Bun.sleep(15) } }
  send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
  let n = 0
  const turn = async (body: string) => { const id = `wc-${++n}`; send({ kind: "submit", mode, turn: { id, body } }); await wait(() => frames.some((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind))); return frames.filter((f) => f.kind === "tool-result" && f.turnId === id).map((f) => String(f.output)) }
  return { turn, frames, project, close: async () => { child.kill(); await child.exited; server.stop(true); await errors; for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } } } }
}

/** ما بثّه النموذج (أطر delta): الأطفالُ يرثون قناةَ البثّ نفسها، فيُقرأ منها ما حاوله كلُّ طفلٍ فعلاً. */
const spoken = (s: Session): string => s.frames.filter((f) => f.kind === "delta").map((f) => String(f.text ?? "")).join("")

test.skipIf(process.platform !== "win32")("two team children asking for approval at once are queued, not collided: ask → grant → ask → grant, and both effects land", async () => {
  const nth = counter()
  const s = await session("stronger", "read-only", (user) => {
    if (user.includes("اكتب ملفّ alpha")) return nth("alpha") === 1 ? "نفّذ: write alpha.txt <<<\nAAA" : "كُتب alpha."
    if (user.includes("اكتب ملفّ beta")) return nth("beta") === 1 ? "نفّذ: write beta.txt <<<\nBBB" : "كُتب beta."
    if (user.includes("أنت الوكيلُ الموجِّه")) return "لا حاجة للتوجيه هنا."
    if (user.includes("TEAM-APPROVE") && !user.includes("المهمّة المفوَّضة إليك") && nth("parent") === 1) return "نفّذ: team <<<\nbuilder :: اكتب ملفّ alpha\nbuilder :: اكتب ملفّ beta"
    return "Done."
  })
  try {
    const results = await s.turn("TEAM-APPROVE اكتب الملفّين")
    // كلا الأثرين وقع فعلاً — لا طفلٌ عالقٌ على سؤالٍ دُهس، ولا سؤالٌ انتهت مهلتُه
    expect(readFileSync(join(s.project, "alpha.txt"), "utf8")).toContain("AAA")
    expect(readFileSync(join(s.project, "beta.txt"), "utf8")).toContain("BBB")
    expect(results.some((r) => r.includes("فريقٌ من 2 وكلاء"))).toBe(true)
    // التتابع: كلُّ سؤالٍ يُجاب قبل أن يُطرح التالي (بلا الرتل يظهر سؤالان متجاوران)
    const order = s.frames.filter((f) => f.kind === "approval" || f.kind === "test-approve").map((f) => f.kind)
    expect(order.length).toBeGreaterThanOrEqual(4)
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]).toBe("approval")
      expect(order[i + 1]).toBe("test-approve")
    }
    expect(s.frames.some((f) => f.kind === "approval-expired")).toBe(false)
  } finally { await s.close() }
}, 240_000)

test.skipIf(process.platform !== "win32")("each child is judged by its own ceiling while both run: the read-only agent's write is refused and the builder's write lands", async () => {
  const nth = counter()
  const s = await session("stronger", "full-access", (user) => {
    if (user.includes("اكتب ملفّ ممنوع")) return nth("forbidden") === 1 ? "نفّذ: write forbidden.txt <<<\nX" : "لم أستطع: سقفي قراءةٌ فقط."
    if (user.includes("اكتب ملفّ مسموح")) return nth("allowed") === 1 ? "نفّذ: write allowed.txt <<<\nY" : "كُتب allowed."
    if (user.includes("أنت الوكيلُ الموجِّه")) return "لا حاجة للتوجيه هنا."
    if (user.includes("TEAM-CEILING") && !user.includes("المهمّة المفوَّضة إليك") && nth("parent") === 1) return "نفّذ: team <<<\nplanner :: اكتب ملفّ ممنوع\nbuilder :: اكتب ملفّ مسموح"
    return "Done."
  })
  try {
    const results = await s.turn("TEAM-CEILING جرّب السقفين")
    const team = results.find((r) => r.includes("فريقٌ من 2 وكلاء"))
    expect(team).toBeDefined()
    // الطفلُ حاول فعلاً (لا امتناعٌ من النموذج): محاولتُه في قناة البثّ، والملفُّ لم يوجد لأنّ سقفَه منعها
    expect(spoken(s)).toContain("write forbidden.txt")
    expect(existsSync(join(s.project, "forbidden.txt"))).toBe(false)
    expect(team).toContain("«planner»")
    // ⚠ مقيس: الحلقةُ تُسقط الاقتراحَ الذي لا يعلنه سقفُ الوكيل **قبل** التوزيع (isCallable)، فلا يظهر رفضاً في التقرير —
    // الاحتواءُ يُثبت بالأثر: صفرُ أدواةٍ منفَّذة عند planner، وكتابةُ builder في اللحظة نفسها وقعت. والحارسُ نفسُه بتوأمه الوحدويّ.
    expect(team).toContain("الأدوات المنفَّذة: 0")
    expect(readFileSync(join(s.project, "allowed.txt"), "utf8")).toContain("Y")
  } finally { await s.close() }
}, 240_000)

test.skipIf(process.platform !== "win32")("a child that never completes is named with its reason, its sibling's report survives, and every team frame is closed exactly once", async () => {
  const nth = counter()
  const s = await session("stronger", "full-access", (user) => {
    // طفلٌ يكرّر النداء نفسه حتى يقف بسببٍ مسمّى (تكرار/سقف حِقب)، وشقيقٌ ينهي مهمّته
    if (user.includes("دُر بلا نهاية")) return `نفّذ: list .${".".repeat(nth("stuck"))}`
    if (user.includes("اقرأ المانيفست")) return nth("manifest") === 1 ? "نفّذ: read package.json" : "المشروع proj 1.0.0"
    if (user.includes("أنت الوكيلُ الموجِّه")) return "لا حاجة للتوجيه هنا."
    if (user.includes("TEAM-STUCK") && !user.includes("المهمّة المفوَّضة إليك") && nth("parent") === 1) return "نفّذ: team <<<\nplanner :: دُر بلا نهاية\nplanner :: اقرأ المانيفست"
    return "Done."
  })
  try {
    const results = await s.turn("TEAM-STUCK شغّل الاثنين")
    const team = results.find((r) => r.includes("فريقٌ من 2 وكلاء"))
    expect(team).toBeDefined()
    expect(team).toContain("لم يكتمل")
    // تقريرُ الشقيق الذي أنهى لم يضع
    expect(team).toContain("proj 1.0.0")
    // إطارا الأداة أُغلق كلٌّ منهما مرّةً واحدة — لا صفَّ معلّقاً ولا صفوفاً يتيمة
    for (const label of ["team 1/2 · planner", "team 2/2 · planner"]) {
      expect(s.frames.filter((f) => f.kind === "tool" && f.cmd === label)).toHaveLength(1)
      expect(s.frames.filter((f) => f.kind === "tool-result" && f.cmd === label)).toHaveLength(1)
    }
  } finally { await s.close() }
}, 300_000)
