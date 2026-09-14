/** قيس (سجلّ المالك 2026-09-06): «اعمل مجلد مشروع على الديسكتوب لبناء موقع…» ومشروعٌ آخر محدَّد ⇦ project-create رُفض
 * («A project is already selected»)، فالتفّ النموذج بـmkdir + project-open فقفل دورُ التوجيه البناءَ في مجلّدٍ فارغ.
 * الآن: نيّةُ الإنشاء في الرسالة تفتح project-create رغم مشروعٍ محدَّد، والمجلّدُ الفارغ مع طلب بناءٍ لا يُقفل بعد
 * project-open. والتوأمُ السلبيّ: «اكمل» بلا نيّة إنشاء ⇦ الرفضُ باقٍ؛ ومجلّدٌ غيرُ فارغ ⇦ التوجيهُ يقفل. المحرّكُ حقيقيّ
 * والنموذجُ خادمٌ زائف يردّ بالسيناريو. */
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const ROOT = resolve(import.meta.dir, "../../..")

async function boot(responsesByTurn: Record<string, string[]>) {
  const base = mkdtempSync(join(tmpdir(), "abdo-create-live-"))
  const state = join(base, "state"), install = join(base, "payload"), documents = join(base, "Documents"), selected = join(documents, "old-project")
  for (const dir of [state, install, selected]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(selected, "package.json"), JSON.stringify({ name: "old-project" }))
  const requests: { messages: { role: string; content: string }[] }[] = []
  const steps: Record<string, number> = {}
  let current = ""
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages: { role: string; content: string }[] }
    requests.push(body)
    const list = responsesByTurn[current] ?? ["Done."]
    const content = list[Math.min(steps[current] ?? 0, list.length - 1)]!
    steps[current] = (steps[current] ?? 0) + 1
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 10 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "en", agentModel: "create-fixture/model", chatModel: "create-fixture/model", modelRole: "agent", mode: "full-access", project: selected, memorySearchEnabled: false, semanticMemoryEnabled: false, routerGate: "off", plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: true, lessons: false, usageMeter: false }, customProviders: [{ id: "create-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "create-test", ABDO_FRAMED_STDIO: "1", ABDO_REQUIRE_PROJECT: "1", ABDO_INSTALL_ROOT: install, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_DOCUMENTS_DIR: documents, USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 40_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2500)); await Bun.sleep(15) } }
  const turn = async (id: string, body: string) => { current = id; send({ kind: "submit", mode: "full-access", turn: { id, body } }); await wait(() => frames.some((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind))) }
  const results = (id: string) => frames.filter((f) => f.kind === "tool-result" && f.turnId === id).map((f) => String(f.output))
  send({ kind: "hello", shell: "desktop", token: "create-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
  // توثيقُ مجلّدٍ كما يفعله حوارُ المشروع (ملفُّ ثقةٍ بمفتاح المسار) — المجلّدُ المفتوح يحتاج ثقةً قبل الكتابة، وهذا ليس موضوعَ الاختبار.
  const trust = (dir: string) => { const key = createHash("sha256").update(resolve(dir).toLowerCase()).digest("hex"); mkdirSync(join(state, "trusted-projects"), { recursive: true }); writeFileSync(join(state, "trusted-projects", key + ".json"), JSON.stringify({ project: resolve(dir), trustedAt: new Date().toISOString(), by: "test" })) }
  return { base, documents, selected, settings, frames, requests, turn, results, trust, stop: async () => { child.kill(); await child.exited; server.stop(true); await errors; rmSync(base, { recursive: true, force: true }) } }
}

test("a create request opens a new project despite a selected one and builds in the same turn; a bare «اكمل» still cannot switch", async () => {
  const target = join(tmpdir(), `abdo-create-target-${Date.now().toString(36)}`)
  const h = await boot({
    // اسمُ الحزمة يجب أن يبدأ باسم المجلّد (حارسُ انحراف الاسم القائم) — ليس موضوعَ الاختبار.
    t1: [`نفّذ: project-create ${target}`, `نفّذ: write package.json <<<\n{"name":"${basename(target)}"}`, "Built sprint 1."],
    t2: [`نفّذ: project-create ${target}-b`, "Done."],
  })
  try {
    await h.turn("t1", "اعمل مجلد مشروع جديد باسم mahami-jeddah لبناء موقع شركة محاماة بنيكست وبريزما")
    const r1 = h.results("t1")
    expect(r1[0]).toContain("Created empty project folder and selected it")
    expect(r1[0]).not.toContain("orientation only")
    expect(existsSync(join(target, "package.json"))).toBe(true)
    expect(JSON.parse(readFileSync(h.settings, "utf8")).project).toBe(target)
    // التوأمُ السلبيّ: بلا نيّة إنشاءٍ في الرسالة يبقى الرفض
    await h.turn("t2", "اكمل")
    expect(h.results("t2")[0]).toContain("A project is already selected")
    expect(existsSync(`${target}-b`)).toBe(false)
  } finally { await h.stop(); rmSync(target, { recursive: true, force: true }) }
}, 120000)

test("project-open on an EMPTY folder with a build request does not lock the turn; a non-empty folder still orients read-only", async () => {
  const empty = mkdtempSync(join(tmpdir(), "abdo-open-empty-")), full = mkdtempSync(join(tmpdir(), "abdo-open-full-"))
  writeFileSync(join(full, "README.md"), "# existing")
  const h = await boot({
    t1: [`نفّذ: project-open ${empty}`, `نفّذ: write package.json <<<\n{"name":"${basename(empty)}"}`, "Built."],
    t2: [`نفّذ: project-open ${full}`, "نفّذ: write NOTE.md <<<\nhijack", "Oriented."],
  })
  try {
    h.trust(empty); h.trust(full)
    await h.turn("t1", `سوي لي مشروع جديد في المجلد ${empty} وابنِ موقع نيكست`)
    const r1 = h.results("t1")
    expect(r1[0]).toContain("The folder is empty and this message asked to build")
    expect(r1[0]).not.toContain("orientation only")
    expect(existsSync(join(empty, "package.json"))).toBe(true)
    await h.turn("t2", `افتح مشروع ${full} وأنشئ فيه ملفاً`)
    const r2 = h.results("t2")
    expect(r2[0]).toContain("This turn is orientation only")
    expect(r2[1]).toContain("Project just opened in this turn")
    expect(existsSync(join(full, "NOTE.md"))).toBe(false)
  } finally { await h.stop(); rmSync(empty, { recursive: true, force: true }); rmSync(full, { recursive: true, force: true }) }
}, 120000)
