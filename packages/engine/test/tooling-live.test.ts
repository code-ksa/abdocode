import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

// ذ9ب — «علّمه أدواتي» على المحرّك الحقيقيّ: grep بأعلامٍ (-i، --count، --files، -C)، medit بعدّة استبدالاتٍ بموافقةٍ واحدة (وفشلُ
// حزمةٍ يُسقط الكلّ)، وrun --bg بمعرّفٍ ثمّ logs ثمّ stop. النموذجُ خادمٌ زائف يردّ بالسيناريو، والمشروعُ موثوقٌ في مجلّدٍ مؤقّت.

const ROOT = resolve(import.meta.dir, "../../..")

test.skipIf(process.platform !== "win32")("grep flags, medit all-or-nothing, and run --bg with logs/stop work through the real engine", async () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-tooling-live-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(join(project, "src"), { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  writeFileSync(join(project, "src", "a.ts"), "export const Alpha = 1\nexport const beta = 2\n// ALPHA again\n")
  writeFileSync(join(project, "src", "b.ts"), "import { Alpha } from './a'\nconsole.log(Alpha)\n")
  writeFileSync(join(project, "notes.md"), "line one\nline two\nline three\n")
  let script: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean }
    const content = script.shift() ?? "Done."
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "tool-fixture/model", chatModel: "tool-fixture/model", modelRole: "agent", mode: "full-access", project, routerGate: "off", plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, customProviders: [{ id: "tool-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 60_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2500)); await Bun.sleep(15) } }
  const results = (id: string) => frames.filter((f) => f.kind === "tool-result" && f.turnId === id).map((f) => String(f.output))
  let n = 0
  const turn = async (...replies: string[]) => { const id = `tl-${++n}`; script = [...replies, "Done."]; send({ kind: "submit", mode: "full-access", turn: { id, body: "go " + id } }); await wait(() => frames.some((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind))); return results(id) }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    // grep: بلا حساسيةٍ للحالة يجد الثلاثة، والحسّاسُ يجد اثنين؛ --count و--files و-C
    const ci = await turn("نفّذ: grep alpha -i")
    expect(ci[0]).toContain("4 سطراً")
    const cs = await turn("نفّذ: grep Alpha")
    expect(cs[0]).toContain("3 سطراً")
    const count = await turn("نفّذ: grep Alpha --count --type ts")
    expect(count[0]).toMatch(/3 مطابقة في 2 ملفّاً/)
    const files = await turn("نفّذ: grep Alpha --files")
    expect(files[0]).toContain("2 ملفّاً")
    expect(files[0]).not.toContain("console.log")
    const ctx = await turn("نفّذ: grep two -C 1 notes.md")
    expect(ctx[0]).toContain("notes.md-1- line one")
    expect(ctx[0]).toContain("notes.md:2: line two")
    expect(ctx[0]).toContain("notes.md-3- line three")
    // medit: حزمتان تُطبَّقان معاً؛ حزمةٌ لا تطابق تُسقط الكلّ
    const ok = await turn("نفّذ: medit notes.md <<<\nline one\n=>\nLINE ONE\n@@\nline three\n=>\nLINE THREE")
    expect(ok[0]).toMatch(/✍|كتابة|notes\.md/)
    expect(readFileSync(join(project, "notes.md"), "utf8")).toBe("LINE ONE\nline two\nLINE THREE\n")
    const bad = await turn("نفّذ: medit notes.md <<<\nline two\n=>\nX\n@@\nmissing text\n=>\nY")
    expect(bad[0]).toContain("الحزمة 2")
    expect(readFileSync(join(project, "notes.md"), "utf8")).toBe("LINE ONE\nline two\nLINE THREE\n")
    // run --bg: معرّفٌ، ثمّ logs يرى الخرج، ثمّ stop يوقف عمليةً ما زالت تعمل
    const bg = await turn("نفّذ: run --bg 1..3 | ForEach-Object { \"tick$_\"; Start-Sleep -Milliseconds 400 }; Start-Sleep -Seconds 20")
    expect(bg[0]).toContain("بدأ التشغيلُ الخلفيّ bg-1")
    await Bun.sleep(2500)
    const logs = await turn("نفّذ: logs bg-1 50")
    expect(logs[0]).toContain("bg-1 · جارٍ")
    expect(logs[0]).toContain("tick3")
    const stopped = await turn("نفّذ: stop bg-1")
    expect(stopped[0]).toContain("أُوقف bg-1")
    await Bun.sleep(600)
    const after = await turn("نفّذ: logs bg-1")
    expect(after[0]).toMatch(/أُوقف|انتهى برمز/)
    const unknown = await turn("نفّذ: logs bg-9")
    expect(unknown[0]).toContain("لا تشغيلَ خلفيّاً")
    expect(existsSync(join(state, "bg-runs", "bg-1.log"))).toBe(true)
  } finally { child.kill(); await child.exited; server.stop(true); await errors; rmSync(base, { recursive: true, force: true }) }
}, 180_000)
