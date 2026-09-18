/**
 * م11 حيّاً — ضغطُ حمولةِ الكتابة على المحرّك الحقيقيّ: مزوّدٌ وهميّ يكتب `notes.md` ثلاثَ مرّاتٍ بحمولاتٍ ١٢ ألف حرف (الشكلُ المقيس
 * 09-14 على super-120b: كتاباتٌ كاملة متكرّرة لملفٍّ واحد ملأت ٣٧٣ ألف توكن). المقيس: في النداء الرابع تصل الكتابتان الأوليان إلى
 * المزوّد مختصرتَين برأسهما وسطرِ الإيصال، والثالثةُ كاملةً؛ سطرُ نقطة الحفظ يحمل «ضغط الكتابة=1»؛ والقرصُ يحمل الحمولةَ الأخيرة.
 * التوأمُ السلبيّ: كتاباتٌ صغيرة تحت الميزانية ⇦ لا اختصارَ و«ضغط الكتابة=0».
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const ROOT = resolve(import.meta.dir, "../../..")

async function run(size: number): Promise<{ events: string[]; assistants: string[][]; end: string; disk: string }> {
  const base = mkdtempSync(join(tmpdir(), "abdo-wcomp-live-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  const assistants: string[][] = []
  const payload = (k: number) => `# notes ${k}\n` + String.fromCharCode(65 + k).repeat(size)
  let calls = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages?: { role: string; content: unknown }[] }
    const msgs = body.messages ?? []
    const text = (m: { content: unknown } | undefined) => m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    const system = msgs.filter((m) => m.role === "system").map(text).join("\n")
    const users = msgs.filter((m) => m.role === "user").map(text)
    let content = "تمّ الهدف."
    if (system.includes("أنت الوكيلُ الموجِّه") || users.join("\n").includes("أنت الوكيلُ الموجِّه")) content = "لا حاجة للتوجيه هنا."
    else { calls += 1; assistants.push(msgs.filter((m) => m.role === "assistant").map(text)); content = calls <= 3 ? `نفّذ: write notes.md <<<\n${payload(calls - 1)}` : "كُتبت الملاحظات — تمّ الهدف." }
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "fab/model", chatModel: "fab/model", modelRole: "agent", mode: "full-access", project, routerGate: "off", railPolicy: "thin", workMode: "basic", plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 }, customProviders: [{ id: "fab", label: "fab", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
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
    send({ kind: "submit", mode: "full-access", turn: { id: "f1", body: "اكتب الملاحظات ثلاث مرّات" } })
    await wait(() => frames.some((f) => f.turnId === "f1" && ["done", "refused", "unresolved"].includes(f.kind)))
    const end = frames.find((f) => f.turnId === "f1" && ["done", "refused", "unresolved"].includes(f.kind))
    const disk = (() => { try { return readFileSync(join(project, "notes.md"), "utf8") } catch { return "" } })()
    return { events: frames.filter((f) => f.kind === "event" && f.turnId === "f1").map((f) => String(f.payload ?? "")), assistants, end: end.kind, disk }
  } finally { child.kill(); await child.exited; server.stop(true); await errors; for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } } }
}

test.skipIf(process.platform !== "win32")("three 12k writes: the two older payloads reach the provider digested, the newest full; checkpoint says ضغط الكتابة=1; disk holds the last", async () => {
  const r = await run(12_000)
  expect(r.end).toBe("done")
  expect(r.disk).toBe("# notes 2\n" + "C".repeat(12_000))
  const checkpoint = r.events.find((t) => t.includes("نقطة حفظ الحقبة"))
  expect(checkpoint).toContain("ضغط الكتابة=1")
  // النداءُ الرابع (بعد إيصال الكتابة الثالثة): w0 وw1 مختصرتان، w2 كاملة.
  const fourth = r.assistants[3]!
  const writes = fourth.filter((m) => m.includes("write notes.md <<<"))
  expect(writes).toHaveLength(3)
  expect(writes[0]).toContain("[اختُصرت حمولةُ الكتابة: 12010 حرفاً كُتبت فعلاً، بصمة ")
  expect(writes[0]).not.toContain("A".repeat(200))
  expect(writes[1]).toContain("[اختُصرت حمولةُ الكتابة: 12010 حرفاً")
  expect(writes[1]).not.toContain("B".repeat(200))
  expect(writes[2]).toContain("C".repeat(12_000))
  expect(writes[2]).not.toContain("اختُصرت")
  // قبل عبور الميزانية (النداءُ الثالث: w0 وحدها مرشَّحة ≈ 12k < 20k) لا اختصار.
  expect(r.assistants[2]!.some((m) => m.includes("اختُصرت"))).toBe(false)
}, 180_000)

test.skipIf(process.platform !== "win32")("small writes under the budget are never digested (negative twin): ضغط الكتابة=0 and every payload reaches the provider whole", async () => {
  const r = await run(300)
  expect(r.end).toBe("done")
  expect(r.disk).toBe("# notes 2\n" + "C".repeat(300))
  expect(r.events.find((t) => t.includes("نقطة حفظ الحقبة"))).toContain("ضغط الكتابة=0")
  expect(r.assistants.flat().some((m) => m.includes("اختُصرت"))).toBe(false)
  expect(r.assistants[3]!.filter((m) => m.includes("write notes.md <<<"))).toHaveLength(3)
}, 180_000)
