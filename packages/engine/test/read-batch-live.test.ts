import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

// ذ9و — حزمةُ القراءة على المحرّك الحقيقيّ: ثلاثةُ قرّاءٍ في ردٍّ واحد يمرّون بالمُوزِّع نفسِه فيعطون ثلاثةَ إيصالات
// وثلاثةَ أطرِ أداةٍ للمشغّل، ونداءُ نموذجٍ **واحدٌ** بعدها (لا نداءَ بين قراءتين). والتوأمُ السالب: خلطُ كتابةٍ
// بقراءةٍ يُرفض كلُّه فلا يُكتب ملفّ. والعقدُ الجديد يصل النموذجَ في نظام الدور.

const ROOT = resolve(import.meta.dir, "../../..")

test.skipIf(process.platform !== "win32")("three reads in one reply: three receipts, three tool frames, one model call after them — and a mixed write is refused whole", async () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-read-batch-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(join(project, "src"), { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  writeFileSync(join(project, "README.md"), "# proj\nسطرٌ للقراءة.\n")
  writeFileSync(join(project, "src", "a.ts"), "export const alpha = 1\n")
  const requests: { system: string; user: string }[] = []
  let asked = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages?: { role: string; content: unknown }[] }
    const msgs = body.messages ?? []
    const text = (m: { content: unknown } | undefined) => m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    const all = msgs.filter((m) => m.role === "user").map(text).join("\n")
    requests.push({ system: msgs.filter((m) => m.role === "system").map(text).join("\n"), user: text([...msgs].reverse().find((m) => m.role === "user")) })
    let content = "Done."
    if (all.includes("BATCH-READ")) { asked += 1; content = asked === 1 ? "نفّذ: read package.json\nنفّذ: read README.md\nنفّذ: grep alpha src/*.ts" : "قرأتُ الثلاثة: proj 1.0.0 وREADME وalpha." }
    else if (all.includes("BATCH-MIXED")) content = "نفّذ: read README.md\nنفّذ: write hacked.txt <<<\nمحتوى"
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "tool-fixture/model", chatModel: "tool-fixture/model", modelRole: "agent", mode: "full-access", project, routerGate: "off", railPolicy: "thin", plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, customProviders: [{ id: "tool-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 90_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2000)); await Bun.sleep(15) } }
  let n = 0
  const turn = async (body: string) => { const id = `rb-${++n}`; send({ kind: "submit", mode: "full-access", turn: { id, body } }); await wait(() => frames.some((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind))); return id }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    const id = await turn("BATCH-READ اقرأ الثلاثة")
    // ثلاثةُ إيصالاتٍ وثلاثةُ أطرِ أداة — كلُّ قراءةٍ حقيقيّة بمخرجها
    const cmds = frames.filter((f) => f.kind === "tool" && f.turnId === id).map((f) => String(f.cmd))
    expect(cmds).toEqual(["read package.json", "read README.md", "grep alpha src/*.ts"])
    const outs = frames.filter((f) => f.kind === "tool-result" && f.turnId === id).map((f) => String(f.output))
    expect(outs).toHaveLength(3)
    expect(outs.join("\n")).toContain("{\"name\":\"proj\"")
    expect(outs.join("\n")).toContain("سطرٌ للقراءة")
    expect(outs.join("\n")).toContain("alpha")
    // نداءان للنموذج لا أربعة: الأوّلُ يبدأ الدور، والثاني بعد الحزمة كلِّها
    expect(requests).toHaveLength(2)
    expect(requests[1]!.user).toContain("حزمة القراءة (3 نداءً)")
    // والعقدُ الجديد في نظام الدور
    expect(requests[0]!.system).toContain("الاستثناءُ الوحيد: حزمةُ قراءة")
    expect(requests[0]!.system).toContain("كل رد يستدعي أداة واحدة فقط") // السطرُ المثبَّت باقٍ بنصّه
    // التوأمُ السالب: خلطُ كتابةٍ بقراءة يُرفض كلُّه — لا ملفَّ يُكتب ولا قراءةَ تُنفَّذ
    const mixed = await turn("BATCH-MIXED اقرأ واكتب")
    const mixedCmds = frames.filter((f) => f.kind === "tool" && f.turnId === mixed).map((f) => String(f.cmd))
    expect(mixedCmds).toEqual([])
    expect(frames.some((f) => f.kind === "event" && String(f.payload ?? "").includes("hacked.txt"))).toBe(false)
  } finally { child.kill(); await child.exited; server.stop(true); await errors; for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } } }
}, 180_000)
