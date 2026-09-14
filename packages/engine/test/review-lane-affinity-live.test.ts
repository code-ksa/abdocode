/**
 * م9ح + م9ز حيّاً على المحرّك الحقيقيّ (stdio مؤطَّر، مزوّدٌ وهميّ محلّيّ يسجّل ما يصله على السلك):
 * - م9ز: كلُّ طلبٍ في الجلسة يحمل رأسَ `x-session-id` واحداً بصيغة `abdo-<32 hex>` (ولا `user` لمزوّدٍ خارج قائمة من يوثّقه)؛ محادثةٌ جديدة تبدّله.
 * - م9ح: بعد دورٍ كاتب، «review» يعلن الكلفةَ قبل الإنفاق، ينادي العدساتِ الثلاث بلا أدوات، ويعيد حكماً بالعيب المسمّى
 *   والملاحظةَ بلا سيناريو مفصولة؛ و«review» بلا تغييرات يقول ذلك صادقاً **بلا نداءِ نموذج** (التوأمُ السلبيّ يُعدّ بالطلبات).
 */
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const ROOT = resolve(import.meta.dir, "../../..")

test.skipIf(process.platform !== "win32")("review lane runs three lenses on the writing turn's diff, and every request carries one session affinity token", async () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-review-live-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  const seen: { user: unknown; header: string | null; system: string; lens?: string }[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; user?: unknown; messages?: { role: string; content: unknown }[] }
    const msgs = body.messages ?? []
    const text = (m: { content: unknown } | undefined) => m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    const system = msgs.filter((m) => m.role === "system").map(text).join("\n")
    const all = msgs.filter((m) => m.role === "user").map(text).join("\n")
    let content = "مرحباً — تمّ."
    let lens: string | undefined
    if (system.includes("أنت مراجعُ كودٍ مستقلّ")) {
      lens = all.includes("عدستُك: الصحّة") ? "correctness" : all.includes("عدستُك: الأمان") ? "safety" : "tests"
      // الفرقُ نفسُه يصل كلَّ عدسة — نثبت أنّه يحمل الملفَّ المكتوب
      if (!all.includes("hello-from-turn")) content = "- [حرج] a.txt:1 — الفرقُ لم يصل المراجع — كيف يفشل: المدخلُ بلا فرق"
      else content = lens === "correctness"
        ? "- [حرج] a.txt:1 — لا سطرَ أخيراً في الملفّ — كيف يفشل: cat يلصق السطرَ التالي به"
        : lens === "safety" ? "لا عيب" : "- [متوسط] a.txt — لا اختبارَ يغطّي الملفّ"
    } else if (system.includes("أنت الوكيلُ الموجِّه") || all.includes("أنت الوكيلُ الموجِّه")) content = "لا حاجة للتوجيه هنا."
    seen.push({ user: body.user, header: request.headers.get("x-session-id"), system: system.slice(0, 40), ...(lens === undefined ? {} : { lens }) })
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "tool-fixture/model", chatModel: "tool-fixture/model", modelRole: "agent", mode: "full-access", project, routerGate: "off", railPolicy: "thin", workMode: "basic", plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 }, customProviders: [{ id: "tool-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 120_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2500)); await Bun.sleep(15) } }
  const finished = (id: string) => frames.some((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind))
  const eventsOf = (id: string): string[] => frames.filter((f) => f.kind === "event" && f.turnId === id).map((f) => String(f.payload ?? ""))
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    // دورٌ نموذجيّ عاديّ — يثبت أنّ الطلب يحمل البصمة
    send({ kind: "submit", mode: "full-access", turn: { id: "m1", body: "قل مرحباً فقط" } }); await wait(() => finished("m1"))
    // دورٌ كاتب (كلمةُ مشغّل، بلا نموذج) — تُحفظ نقطةُ رجوعه فتصير مصدرَ المراجعة
    send({ kind: "submit", mode: "full-access", turn: { id: "w1", body: "write a.txt <<< hello-from-turn" } }); await wait(() => finished("w1"))
    expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("hello-from-turn")
    const requestsBeforeReview = seen.length
    send({ kind: "submit", mode: "full-access", turn: { id: "r1", body: "review" } }); await wait(() => finished("r1"))
    const review = eventsOf("r1")
    // الكلفةُ تُقال قبل الإنفاق، والمصدرُ هو الدورُ الكاتب
    expect(review.some((t) => t.includes("🔍 حارةُ المراجعة على الدور w1: 1 ملفّاً") && t.includes("ثلاثةُ نداءات"))).toBe(true)
    // ثلاثُ نداءاتٍ بالضبط، عدسةٌ لكلٍّ، بلا أدوات
    const lensCalls = seen.slice(requestsBeforeReview)
    expect(lensCalls.map((c) => c.lens).sort()).toEqual(["correctness", "safety", "tests"])
    expect(frames.some((f) => f.kind === "tool" && f.turnId === "r1")).toBe(false)
    // الحكمُ: حرجٌ واحد بسيناريو ⇦ يحتاج إصلاحاً؛ والملاحظةُ بلا سيناريو تُعرض ولا تُحتسب
    expect(review.some((t) => t.startsWith("🔍 حكمُ المراجعة: يحتاج إصلاحاً — 1 عيباً بسيناريو") && t.includes("1 ملاحظة بلا سيناريو"))).toBe(true)
    expect(review.some((t) => t.includes("[حرج · الصحّة] a.txt:1 — لا سطرَ أخيراً في الملفّ"))).toBe(true)
    expect(review.some((t) => t.includes("كيف يفشل: cat يلصق السطرَ التالي به"))).toBe(true)
    expect(review.some((t) => t.includes("◦ [عضُّ الاختبارات] a.txt — لا اختبارَ يغطّي الملفّ"))).toBe(true)
    expect(review.some((t) => t.includes("لم يُصلَح شيءٌ تلقائيّاً"))).toBe(true)
    expect(frames.find((f) => f.kind === "done" && f.turnId === "r1")?.outcome).toBe("completed")

    // م9ز: كلُّ طلبات الجلسة (النموذجيّ + العدسات الثلاث) بصمةٌ واحدة في رأس x-session-id؛ والمزوّدُ المخصّص ليس في قائمة
    // من يوثّق حقلَ الجسد فلا `user` يُرسَل إليه (احترازٌ: حقلٌ غيرُ موثَّق عند بوّابةٍ مجهولة)
    const tokens = new Set(seen.map((c) => c.header))
    expect(tokens.size).toBe(1)
    const token = [...tokens][0] as string
    expect(token).toMatch(/^abdo-[0-9a-f]{32}$/u)
    expect(seen.every((c) => c.user === undefined)).toBe(true)

    // محادثةٌ جديدة: بصمةٌ أخرى؛ و«review» فيها بلا دورٍ كاتب ولا مستودع ⇦ صدقٌ بلا نداء
    // الأُطرُ تُعالَج بالترتيب: session-new ثمّ الدورُ التالي في الجلسة الجديدة
    send({ kind: "session-new" })
    const before = seen.length
    send({ kind: "submit", mode: "full-access", turn: { id: "m2", body: "قل مرحباً فقط" } }); await wait(() => finished("m2"))
    expect(seen.length).toBeGreaterThan(before)
    expect(seen[seen.length - 1]!.header).toMatch(/^abdo-[0-9a-f]{32}$/u)
    expect(seen[seen.length - 1]!.header).not.toBe(token)
    const beforeEmpty = seen.length
    send({ kind: "submit", mode: "full-access", turn: { id: "r2", body: "راجع تغييراتي" } }); await wait(() => finished("r2"))
    expect(eventsOf("r2").some((t) => t.startsWith("لا تغييراتٍ تُراجَع"))).toBe(true)
    expect(seen.length).toBe(beforeEmpty)
  } finally {
    child.kill(); await child.exited; server.stop(true); await errors
    for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
    expect(existsSync(base)).toBe(false)
  }
}, 180_000)
