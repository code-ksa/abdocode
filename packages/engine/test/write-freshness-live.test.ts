import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

// ب10 — **الكتابةُ على قراءةٍ بائتة**: بين قراءة الملفّ وكتابته بوّابةُ موافقةٍ تنتظر إنساناً (عشر دقائق افتراضاً)،
// والكتابةُ كتابةُ الملفّ **كلِّه** محسوبةً من البايتات القديمة. فمستخدمٌ يصلح سطراً في محرّره أثناء انتظاره،
// أو أخٌ متوازٍ يسبقنا، يضيع عملُه بلا رسالة. اللوحُ يقيس الأثر لا النيّة: يُعدَّل الملفّ **بينما البوّابة معلَّقة**،
// ثمّ تُمنح الموافقة، فيجب أن **لا يُكتب شيء** وأن يبقى نصُّ المستخدم على القرص.
//   (أ) التوأمُ الإيجابيّ: بلا تعديلٍ أثناء الانتظار، التحريرُ يقع فعلاً — فالرفضُ ليس «لا يكتب أبداً».
//   (ب) مجلّدٌ باسم ملفّ: يُقال بالاسم ولا يُسقط الدور باستثناء.
//   (ج) `patch` بـ«Add File» على ملفٍّ موجود: يُرفض بدل استبداله صامتاً.

const ROOT = resolve(import.meta.dir, "../../..")

test.skipIf(process.platform !== "win32")("a file that changed while the approval was pending is never overwritten, while an untouched one is edited normally", async () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-freshness-")), state = join(base, "state"), project = join(base, "project")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "project", version: "1.0.0" }))
  writeFileSync(join(state, "trust", "trusted.json"), "{}")
  const raced = join(project, "raced.txt"), calm = join(project, "calm.txt"), taken = join(project, "taken.txt")
  writeFileSync(raced, "سطرٌ قديم\n", "utf8")
  writeFileSync(calm, "سطرٌ قديم\n", "utf8")
  writeFileSync(taken, "ملفٌّ موجودٌ فعلاً\n", "utf8")
  mkdirSync(join(project, "مجلّد"), { recursive: true })

  let script: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean }
    const content = script.shift() ?? "Done."
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "fresh-fixture/model", chatModel: "fresh-fixture/model", modelRole: "agent", mode: "read-only", project, routerGate: "off",
    plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false },
    customProviders: [{ id: "fresh-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "fresh-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 60_000; while (!predicate()) { if (Date.now() > deadline) throw Error(`${label}: ${JSON.stringify(frames).slice(-1800)}`); await Bun.sleep(15) } }
  const results = (id: string) => frames.filter((f) => f.kind === "tool-result" && f.turnId === id).map((f) => String(f.output))
  try {
    send({ kind: "hello", shell: "desktop", token: "fresh-test" }); await wait(() => frames.some((f) => f.kind === "ready"), "ready")

    // (١) الملفُّ يتغيّر **بينما البوّابة معلَّقة** — ثمّ تُمنح الموافقة.
    script = ["نفّذ: edit raced.txt :: سطرٌ قديم => سطرٌ من الوكيل", "Done."]
    send({ kind: "submit", mode: "read-only", turn: { id: "w1", body: "حرّر raced" } })
    await wait(() => frames.some((f) => f.kind === "approval" && f.turnId === "w1"), "approval w1")
    writeFileSync(raced, "سطرٌ كتبه المستخدم بيده\n", "utf8") // المستخدمُ يصلح شيئاً في محرّره أثناء انتظاره
    send({ kind: "approve", turnId: "w1" })
    await wait(() => frames.some((f) => f.turnId === "w1" && ["done", "refused", "unresolved"].includes(f.kind)), "w1 end")
    expect(results("w1").join("\n")).toContain("تغيّر raced.txt بين قراءتي وكتابتي")
    expect(readFileSync(raced, "utf8")).toBe("سطرٌ كتبه المستخدم بيده\n") // **الأثرُ هو الحكم**: عملُ المستخدم باقٍ
    expect(readFileSync(raced, "utf8")).not.toContain("الوكيل")

    // (٢) التوأمُ الإيجابيّ: بلا سباقٍ يقع التحرير — الحارسُ يمنع الضياع لا الكتابة.
    script = ["نفّذ: edit calm.txt :: سطرٌ قديم => سطرٌ من الوكيل", "Done."]
    send({ kind: "submit", mode: "read-only", turn: { id: "w2", body: "حرّر calm" } })
    await wait(() => frames.some((f) => f.kind === "approval" && f.turnId === "w2"), "approval w2")
    send({ kind: "approve", turnId: "w2" })
    await wait(() => frames.some((f) => f.turnId === "w2" && ["done", "refused", "unresolved"].includes(f.kind)), "w2 end")
    expect(readFileSync(calm, "utf8")).toBe("سطرٌ من الوكيل\n")

    // (٣) مجلّدٌ يحمل اسمَ الهدف: يُقال بالاسم، والدورُ يكتمل (لا استثناءَ يقتله).
    script = ["نفّذ: write مجلّد <<<\nمحتوى", "Done."]
    send({ kind: "submit", mode: "read-only", turn: { id: "w3", body: "اكتب في مجلّد" } })
    await wait(() => frames.some((f) => f.turnId === "w3" && ["done", "refused", "unresolved"].includes(f.kind)), "w3 end")
    expect(results("w3").join("\n")).toContain("مجلّدٌ لا ملفّ")

    // (٤) «Add File» على ملفٍّ موجود: الحارسُ مبنيٌّ (فحصُ الوجود قبل تمرير الأمر إلى write)، لكنّ `patch` قدرةٌ
    // للمزوّد السحابيّ وحده وهذا اللوحُ محلّيٌّ بلا خزنة — فالمقيسُ هنا أنّ **الرفضَ يسبق أيّ كتابة**: الملفُّ باقٍ
    // كما هو. (الشرطُ نفسُه معلَنٌ في الإيداع: غيرُ مبرهَنٍ على المسار السحابيّ حتى يُبنى لوحٌ بمفتاحٍ في الخزنة.)
    script = ["نفّذ: patch <<<\n*** Begin Patch\n*** Add File: taken.txt\n+محتوى جديد\n*** End Patch", "Done."]
    send({ kind: "submit", mode: "read-only", turn: { id: "w4", body: "ارقع" } })
    await wait(() => frames.some((f) => f.turnId === "w4" && ["done", "refused", "unresolved"].includes(f.kind)), "w4 end")
    expect(readFileSync(taken, "utf8")).toBe("ملفٌّ موجودٌ فعلاً\n")
    // (٥) ب10 — **التشغيلُ الخلفيّ لا يورّث الأسرار**: كان `run --bg` ينسخ بيئة المحرّك كاملةً إلى بوويرشِل،
    // فترث كلُّ عمليّةٍ يشغّلها `ABDO_SHELL_TOKEN` ومفاتيحَ المزوّدين. والقياسُ بالأثر: السجلُّ يُظهر أنّ الأمر
    // نفّذ فعلاً (التوأمُ الإيجابيّ) ولا يُظهر قيمةَ الرمز.
    // الأمرُ يُركَّب بالجمع كي يختلف نصُّه عن خرجه: سطرُ السجلّ الأوّل يردّد الأمر، فلو تشابها لكان الفحصُ يقرأ نفسَه.
    script = ["نفّذ: run --bg echo (\"رم\"+\"ز=[\" + $env:ABDO_SHELL_TOKEN + \"]\") ; echo (\"جا\"+\"هز\")", "Done."]
    send({ kind: "submit", mode: "read-only", turn: { id: "w5", body: "شغّل خلفياً" } })
    await wait(() => frames.some((f) => f.kind === "approval" && f.turnId === "w5"), "approval w5")
    send({ kind: "approve", turnId: "w5" })
    await wait(() => frames.some((f) => f.turnId === "w5" && ["done", "refused", "unresolved"].includes(f.kind)), "w5 end")
    const runId = (results("w5").join("\n").match(/bg-\d+/u) ?? [])[0]
    expect(runId).toMatch(/^bg-\d+$/u)
    let log = ""
    for (let i = 0; i < 40 && !log.includes("جاهز"); i += 1) {
      script = [`نفّذ: logs ${runId}`, "Done."]
      const id = `w6-${i}`
      send({ kind: "submit", mode: "read-only", turn: { id, body: "اقرأ السجلّ" } })
      await wait(() => frames.some((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind)), "logs " + id)
      log = results(id).join("\n")
      if (!log.includes("جاهز")) await Bun.sleep(250)
    }
    expect(log).toContain("جاهز") // التوأمُ الإيجابيّ: الأمرُ نفّذ فعلاً وسجلُّه يُقرأ
    expect(log).toContain("رمز=[]") // والرمزُ لم يُورَّث: القوسان فارغان
    expect(log).not.toContain("fresh-test")
  } finally {
    child.kill(); await child.exited; server.stop(true); await errors
    for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
  }
}, 240_000)
