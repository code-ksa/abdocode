/**
 * 09-29 — اختبارُ جودةٍ حيّ لفكرة AgentScope على نظامنا (وكيلٌ يفوّض وكيلاً برسالة): الأبُ يفوّض «recaller» مهمّةَ قراءة،
 * الطفلُ يعمل بحقبه وأدواته المعلَنة عبر مُوزِّع الأب نفسه، ويعود تقريرٌ مهيكل إلى الأب، والطفلُ الذي يحاول أداةً خارج سقفه يُرفض
 * قبل التوزيع بالاسم. النموذجُ خادمٌ زائف يفرّق الأبَ عن الطفل بمدخلِ الطفل («المهمّة المفوَّضة إليك»).
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const ROOT = resolve(import.meta.dir, "../../..")

test.skipIf(process.platform !== "win32")("delegate: the child reads with its own tools through the parent's dispatcher, a tool outside its ceiling is refused by name, and the parent receives a structured report", async () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-deleg-live-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(join(project, "src"), { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0", description: "delegation fixture" }))
  writeFileSync(join(project, "src", "a.ts"), "export const a = 1\n")
  const childPrompts: string[] = []
  let parentCalls = 0, childCalls = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages?: { role: string; content: unknown }[] }
    const msgs = body.messages ?? []
    const text = (m: { content: unknown }) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    const users = msgs.filter((m) => m.role === "user").map(text)
    const isChild = users.some((u) => u.includes("المهمّة المفوَّضة إليك"))
    let content: string
    if (isChild) {
      childCalls += 1; childPrompts.push(users[users.length - 1] ?? "")
      // الطفل: يقرأ، ثمّ يجرّب أداةً خارج سقفه (write)، ثمّ يقدّم تقريره.
      content = childCalls === 1 ? "نفّذ: read package.json" : childCalls === 2 ? "نفّذ: write src/b.ts <<<\nexport const b = 2\n" : "التقرير: package.json يصف proj v1.0.0 (delegation fixture)."
    } else {
      parentCalls += 1
      content = parentCalls === 1 ? "نفّذ: delegate recaller :: اقرأ package.json ولخّص ما يصفه المشروع" : "تمّ: التقرير وصل."
    }
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "tool-fixture/model", chatModel: "tool-fixture/model", modelRole: "agent", mode: "full-access", project, routerGate: "off", railPolicy: "thin", workMode: "basic", plugins: { inventory: false, verifier: false, reviewer: false, delegation: true, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 }, customProviders: [{ id: "tool-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_MAX_AGENT_EPOCHS: "3" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 120_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2500)); await Bun.sleep(50) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    send({ kind: "submit", mode: "full-access", turn: { id: "d1", body: "لخّص المشروع عبر وكيل الاسترجاع" } })
    await wait(() => frames.some((f) => f.turnId === "d1" && ["done", "refused", "unresolved"].includes(f.kind)))
    const mine = frames.filter((f) => f.turnId === "d1")
    const results = mine.filter((f) => f.kind === "tool-result").map((f) => String(f.output))
    const report = results.find((r) => r.includes("🤝 تقرير الوكيل «recaller»"))
    if (report === undefined) throw new Error("no delegate report; results were:\n" + results.join("\n---\n").slice(0, 3000))
    // الطفلُ قرأ فعلاً عبر مُوزِّع الأب، ورُفضت له الكتابة بالاسم قبل التوزيع، وتقريرُه مهيكل بخلاصته.
    expect(report).toContain("قراءة-فقط")
    expect(report).toContain("نُفّذ: read package.json")
    // الكتابةُ خارج سقفه لم تصل التوزيعَ أصلاً (isCallable يرفضها قبله) — فلا تُعدّ «منفَّذة» ولا يُكتب الملفّ.
    expect(report).toContain("الأدوات المنفَّذة: 1")
    expect(report).toContain("الخلاصة: التقرير: package.json يصف proj v1.0.0")
    expect(childPrompts[0]).toContain("المهمّة المفوَّضة إليك:\nاقرأ package.json ولخّص ما يصفه المشروع")
    expect(childPrompts[0]).toContain("سقفُك قراءةٌ فقط")
    // الأبُ أكمل بعد التقرير؛ ولم يُكتب src/b.ts.
    expect(mine.some((f) => f.kind === "done")).toBe(true)
    expect(await Bun.file(join(project, "src", "b.ts")).exists()).toBe(false)
    expect(parentCalls).toBeGreaterThanOrEqual(2)
    expect(childCalls).toBeGreaterThanOrEqual(2)
  } finally {
    child.kill(); await child.exited; server.stop(true); await errors
    for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
  }
}, 180_000)
