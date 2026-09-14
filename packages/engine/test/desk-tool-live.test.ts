import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

// ب6 — أداةُ desk على المحرّك الحقيقيّ: مطفأةٌ افتراضاً (رفضٌ يسمّي الإعداد)، القراءةُ (windows) تعمل حين تُفعَّل، والفعلُ المُدخِل
// (click) يقف على بوّابة الموافقة في نمط القراءة فقط ويُرفض حين يُرفض — لا نقرةَ حقيقيةً تصل سطح مكتب المستخدم في هذا الاختبار.

const ROOT = resolve(import.meta.dir, "../../..")

test.skipIf(process.platform !== "win32")("desk is off by default, reads windows when enabled, and an input action waits for approval and honours denial", async () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-desk-live-")), state = join(base, "state"), project = join(base, "project")
  mkdirSync(state, { recursive: true }); mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "project" }))
  let script: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean }
    const content = script.shift() ?? "Done."
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  const write = (extra: Record<string, unknown>) => writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "desk-fixture/model", chatModel: "desk-fixture/model", modelRole: "agent", mode: "read-only", project, routerGate: "off", plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, customProviders: [{ id: "desk-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }], ...extra }))
  write({})
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "desk-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 60_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2500)); await Bun.sleep(15) } }
  const results = (id: string) => frames.filter((f) => f.kind === "tool-result" && f.turnId === id).map((f) => String(f.output))
  try {
    mkdirSync(join(state, "trust"), { recursive: true })
    send({ kind: "hello", shell: "desktop", token: "desk-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    // ١) مطفأٌ افتراضاً ⇒ رفضٌ يسمّي الإعداد
    script = ["نفّذ: desk windows", "Done."]
    send({ kind: "submit", mode: "read-only", turn: { id: "d1", body: "اقرأ نوافذي" } }); await wait(() => frames.some((f) => f.turnId === "d1" && ["done", "refused"].includes(f.kind)))
    expect(results("d1")[0]).toContain("تحكّم سطح المكتب")
    // ٢) مفعَّل ⇒ القراءةُ تعمل بلا بوّابة (windows حقيقيةٌ على هذا الجهاز)
    write({ desktopControlEnabled: true }); send({ kind: "settings-get" }); await wait(() => frames.some((f) => f.kind === "settings"))
    script = ["نفّذ: desk windows", "Done."]
    send({ kind: "submit", mode: "read-only", turn: { id: "d2", body: "اقرأ نوافذي" } }); await wait(() => frames.some((f) => f.turnId === "d2" && ["done", "refused"].includes(f.kind)))
    expect(results("d2")[0]).toMatch(/نافذة|لا نوافذَ/)
    expect(frames.some((f) => f.kind === "approval" && f.turnId === "d2")).toBe(false)
    // ٣) فعلٌ مُدخِل في نمط القراءة ⇒ بوّابةٌ ⇒ الرفضُ يمنعه (ولا نقرةَ تقع)
    script = ["نفّذ: desk click 10 10", "Done."]
    send({ kind: "submit", mode: "read-only", turn: { id: "d3", body: "انقر" } })
    await wait(() => frames.some((f) => f.kind === "approval" && f.turnId === "d3"))
    send({ kind: "deny", turnId: "d3" })
    await wait(() => frames.some((f) => f.turnId === "d3" && ["done", "refused", "unresolved"].includes(f.kind)))
    expect(results("d3")[0]).toContain("لم تُمنح الموافقة")
    // ٤) صيغةٌ خاطئة ⇒ رسالةُ الصيغة لا انهيار
    script = ["نفّذ: desk dance", "Done."]
    send({ kind: "submit", mode: "read-only", turn: { id: "d4", body: "ارقص" } }); await wait(() => frames.some((f) => f.turnId === "d4" && ["done", "refused"].includes(f.kind)))
    expect(results("d4")[0]).toContain("الصيغة: desk")
    // ٥) ب6ب — **موافقةٌ مُنِحت وبلا نافذةٍ مربوطة**: لا حقنَ في «أيّ نافذةٍ في المقدّمة»؛ الرفضُ يصل النموذجَ عبر المحرّك الحقيقيّ
    // ويقول ما يُفعل. هذا هو التوأمُ الإيجابيّ للحالة ٣: هناك مُنع بالرفض، وهنا **مُنع رغم القبول**.
    script = ["نفّذ: desk type سرٌّ لا يُكتب", "Done."]
    send({ kind: "submit", mode: "read-only", turn: { id: "d5", body: "اكتب" } })
    await wait(() => frames.some((f) => f.kind === "approval" && f.turnId === "d5"))
    send({ kind: "approve", turnId: "d5" })
    await wait(() => frames.some((f) => f.turnId === "d5" && ["done", "refused", "unresolved"].includes(f.kind)))
    expect(results("d5")[0]).toContain("desk focus")
    expect(results("d5")[0]).toContain("لا نافذةَ مربوطة")
    // ٦) ب11 — **لقطةٌ بلا نافذةٍ مربوطة كانت تصوّر سطح المكتب كلَّه بلا موافقة** وتُرسل إلى نموذج الرؤية إن ضُبط،
    // بينما الكتالوجُ والإعداداتُ يَعِدان «للنافذة المركَّزة وحدها». الآن تُرفض ويُقال الطريقان.
    script = ["نفّذ: desk shot", "Done."]
    send({ kind: "submit", mode: "read-only", turn: { id: "d6", body: "التقط" } })
    await wait(() => frames.some((f) => f.turnId === "d6" && ["done", "refused"].includes(f.kind)))
    expect(results("d6")[0]).toContain("لا نافذةَ مربوطة")
    expect(results("d6")[0]).toContain("desk shot screen")
    expect(frames.some((f) => f.kind === "browser-shot" && f.turnId === undefined && String(f.url ?? "").includes("desktop"))).toBe(false)
    // ٧) وطلبُ الشاشة كلِّها صريحاً **فعلٌ خارجيّ**: يقف على البوّابة، والرفضُ يمنعه — فلا صورةَ تُلتقط أصلاً.
    script = ["نفّذ: desk shot screen", "Done."]
    send({ kind: "submit", mode: "read-only", turn: { id: "d7", body: "التقط الشاشة" } })
    await wait(() => frames.some((f) => f.kind === "approval" && f.turnId === "d7"))
    send({ kind: "deny", turnId: "d7" })
    await wait(() => frames.some((f) => f.turnId === "d7" && ["done", "refused", "unresolved"].includes(f.kind)))
    expect(results("d7")[0]).toContain("لم تُمنح الموافقة")
    expect(frames.some((f) => f.kind === "browser-shot")).toBe(false)
  } finally { child.kill(); await child.exited; server.stop(true); await errors; rmSync(base, { recursive: true, force: true }) }
}, 150_000)
