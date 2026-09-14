import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

// ب11 — **ما يغادر الجهاز يُقاس في جسد الطلب نفسِه**: مزوّدٌ مزيّفٌ يسجّل كلّ بايتٍ يصله، فالحكمُ على ما وصله
// لا على نيّة الشيفرة. ثلاثةُ أبوابٍ كانت مفتوحةً وكلُّها تُغلق هنا بأثرها:
//   (١) ملاحظةٌ وسمها المالكُ **حسّاسة**: لا تصل النموذجَ والمفتاحُ مطفأ، وتصله حين يُشعله (التوأمُ الإيجابيّ —
//       فبلا هذا التوأم يمرّ «لم يصل» لأنّ المسار لم يُستدعَ أصلاً).
//   (٢) ملاحظةٌ نطاقُها **هذه المحادثة**: أداةُ `recall` كانت تقدّمها في كلّ محادثةٍ أخرى؛ وملاحظةُ المشروع تُقدَّم.
//   (٣) **الدرسُ من أمرٍ فاشل**: كان يحفظ الأمرَ وخرجَه خامَّين ويحقنهما في كلّ دورٍ لاحق — والمفتاحُ فيهما.

const ROOT = resolve(import.meta.dir, "../../..")
const SECRET = "sk-live-ZZTESTKEY9911223344556677"

interface Harness {
  readonly bodies: string[]
  readonly send: (frame: object) => void
  readonly frames: any[]
  readonly wait: (predicate: () => boolean, label: string) => Promise<void>
  readonly results: (id: string) => string[]
  readonly stop: () => Promise<void>
  script: string[]
}

const start = async (base: string, project: string, state: string, patch: Record<string, unknown>): Promise<Harness> => {
  const bodies: string[] = []
  let script: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const raw = await request.text()
    bodies.push(raw)
    const body = JSON.parse(raw) as { stream?: boolean }
    const content = script.shift() ?? "Done."
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "mem-fixture/model", chatModel: "mem-fixture/model", modelRole: "agent", mode: "full-access", project, routerGate: "off", semanticMemoryEnabled: false,
    plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, semanticFrame: false, usageMeter: false },
    customProviders: [{ id: "mem-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }], ...patch }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "mem-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 60_000; while (!predicate()) { if (Date.now() > deadline) throw Error(`${label}: ${JSON.stringify(frames).slice(-1500)}`); await Bun.sleep(15) } }
  const harness: Harness = {
    bodies, send, frames, wait,
    results: (id) => frames.filter((f) => f.kind === "tool-result" && f.turnId === id).map((f) => String(f.output)),
    stop: async () => { child.kill(); await child.exited; server.stop(true); await errors },
    get script() { return script },
    set script(value: string[]) { script = value },
  } as Harness
  send({ kind: "hello", shell: "desktop", token: "mem-test" })
  await wait(() => frames.some((f) => f.kind === "ready"), "ready")
  return harness
}

test.skipIf(process.platform !== "win32")("a sensitive note, a this-conversation note and a failing command's secret never reach the provider — and the positive twins prove the paths carry them", async () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-egress-")), state = join(base, "state"), project = join(base, "project")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "project", version: "1.0.0" }))

  // ── الجلسة الأولى: المفتاحُ مشتعلٌ فتُكتب الملاحظاتُ (الحفظُ نفسُه يحترمه)، ويُسجَّل درسٌ من أمرٍ فاشلٍ يحمل مفتاحاً ──
  let h = await start(base, project, state, { sensitiveMemoryEnabled: true })
  try {
    // حسّاسٌ لا يعني اعتماداً: الاعتمادُ يُرفض حفظُه في الذاكرة أصلاً (حارسٌ قائم) — والخصوصيّةُ أوسعُ من المفاتيح.
    h.send({ kind: "memory-note", title: "ميزانية", text: "راتبُ المطوّر الأوّل ١٨٠٠٠ ريال شهرياً", scope: "project", sensitive: true })
    await h.wait(() => h.frames.some((f) => f.kind === "memory-saved"), "sensitive note")
    h.send({ kind: "memory-note", title: "قاعدة", text: "المشروع يستعمل بوستجرس", scope: "project" })
    await h.wait(() => h.frames.filter((f) => f.kind === "memory-saved").length === 2, "project note")
    h.send({ kind: "memory-note", title: "مؤقّت", text: "هذه المحادثة تجرّب الواجهة فقط", scope: "session" })
    await h.wait(() => h.frames.filter((f) => f.kind === "memory-saved").length === 3, "session note")

    // درسٌ من فشلٍ حقيقيّ: الأمرُ نفسُه يحمل مفتاحاً — يُحفظ في المشروع بلا جلسة ويُحقن لاحقاً.
    h.script = [`نفّذ: run node -e "console.log('${SECRET}'); process.exit(1)"`, "Done."]
    h.send({ kind: "submit", mode: "full-access", turn: { id: "e1", body: "شغّل" } })
    await h.wait(() => h.frames.some((f) => f.turnId === "e1" && ["done", "refused", "unresolved"].includes(f.kind)), "e1 end")
  } finally { await h.stop() }

  // ── الجلسة الثانية: ما الذي يصل المزوّد فعلاً؟ (سؤالٌ لكلّ ملاحظة — البحثُ بالمصطلح لا بالعموم) ──
  h = await start(base, project, state, { sensitiveMemoryEnabled: false })
  try {
    const ask = async (id: string, question: string): Promise<string> => {
      h.script = [`نفّذ: recall ${question}`, "Done."]
      h.send({ kind: "submit", mode: "full-access", turn: { id, body: "ذكّرني" } })
      await h.wait(() => h.frames.some((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind)), `${id} end`)
      const out = h.results(id).join("\n")
      return out
    }
    // التوأمُ الإيجابيّ أوّلاً: ملاحظةُ المشروع **تصل** — فما يلي ليس «المسارُ لم يُستدعَ».
    expect(await ask("e2a", "بوستجرس")).toContain("بوستجرس")
    // (١) الحسّاسُ لا يُقدَّم والمفتاحُ مطفأ.
    expect(await ask("e2b", "ميزانية راتب")).not.toContain("١٨٠٠٠")
    // (٢) ونطاقُ «هذه المحادثة» يُحترم في محادثةٍ أخرى.
    expect(await ask("e2c", "الواجهة")).not.toContain("تجرّب الواجهة فقط")
    // (٣) ولا المفتاحُ الذي فشل به أمرٌ سابق يصل المزوّد في أيّ طلبٍ من هذه الجلسة (الدرسُ يُحقن محجوباً).
    expect(h.bodies.join("\n")).not.toContain(SECRET)
    expect(h.bodies.join("\n")).not.toContain("١٨٠٠٠")
  } finally { await h.stop() }
  // ── التوأمُ الإيجابيّ للمفتاح الحسّاس: بإشعاله يصل، فالفحصُ الأوّل ليس «المسارُ لم يُستدعَ» ──
  h = await start(base, project, state, { sensitiveMemoryEnabled: true })
  try {
    h.script = ["نفّذ: recall ميزانية راتب", "Done."]
    h.send({ kind: "submit", mode: "full-access", turn: { id: "e3", body: "ذكّرني" } })
    await h.wait(() => h.frames.some((f) => f.turnId === "e3" && ["done", "refused", "unresolved"].includes(f.kind)), "e3 end")
    expect(h.results("e3").join("\n")).toContain("١٨٠٠٠")
  } finally {
    await h.stop()
    for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
  }
}, 300_000)
