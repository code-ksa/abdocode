import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

// ذ9ج — أداةُ lsp على المحرّك الحقيقيّ: غيابُ الخادم يُقال غيرَ متاح بسبب (لا تخمين)، ثمّ خادمٌ زائف يُثبَّت في node_modules/.bin
// (ملفّ .cmd يشغّل node كما يثبّته npm) **ينشر التشخيصَ متأخّراً وبحسب المحتوى** ويعيد URI بترميزٍ آخر (c%3A، حرفُ سواقةٍ صغير):
// diag ينتظر نشراً فعليّاً لهذه النسخة (لا «أجاب» بمصفوفةٍ فارغة، ولا مخزونَ نسخةٍ سابقة بعد تعديل)، والبطيءُ يُقال «لم ينشر»؛
// def/refs بمساراتٍ نسبيّةٍ مثبَتة؛ symbols بتوأمٍ إيجابيّ؛ الحرّاس: الامتداد، خارج المشروع، ملفٌّ غائب، الصيغة، الموضع 0، قراءة-فقط.

const ROOT = resolve(import.meta.dir, "../../..")

const FAKE_SERVER = `
let buf = Buffer.alloc(0)
const send = (obj) => { const body = Buffer.from(JSON.stringify(obj)); process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body])) }
// الخادمُ يعيد URI بترميزه هو: حرفُ السواقة صغيراً و":" مرمَّزة — كما يفعل typescript-language-server (vscode-uri).
const reencode = (uri) => uri.replace(/^file:\\/\\/\\/([A-Za-z]):/, (m, d) => 'file:///' + d.toLowerCase() + '%3A')
const texts = new Map()
// كخوادم اللغة الحقيقيّة: إغلاقُ stdin ينهي الخادم (لا يتيمَ يمسك مجلّد المشروع).
process.stdin.on('end', () => process.exit(0))
const publish = (uri) => {
  const text = texts.get(uri) || ''
  const diagnostics = []
  if (/boom/.test(text)) diagnostics.push({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'Type boom' })
  if (/unused/.test(text)) diagnostics.push({ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } }, severity: 2, message: 'unused' })
  const delay = /slow\\.ts$/.test(uri) ? 3000 : 150
  setTimeout(() => send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: reencode(uri), diagnostics } }), delay)
}
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  for (;;) {
    const i = buf.indexOf('\\r\\n\\r\\n'); if (i < 0) break
    const len = Number(/Content-Length: (\\d+)/.exec(buf.subarray(0, i).toString())[1])
    if (buf.length < i + 4 + len) break
    const msg = JSON.parse(buf.subarray(i + 4, i + 4 + len).toString()); buf = buf.subarray(i + 4 + len)
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { definitionProvider: true } } })
    else if (msg.method === 'textDocument/didOpen') { texts.set(msg.params.textDocument.uri, msg.params.textDocument.text); publish(msg.params.textDocument.uri) }
    else if (msg.method === 'textDocument/didChange') { texts.set(msg.params.textDocument.uri, msg.params.contentChanges[0].text); publish(msg.params.textDocument.uri) }
    else if (msg.method === 'textDocument/definition') send({ jsonrpc: '2.0', id: msg.id, result: [{ uri: reencode(msg.params.textDocument.uri), range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } } }] })
    else if (msg.method === 'textDocument/references') send({ jsonrpc: '2.0', id: msg.id, result: [{ uri: reencode(msg.params.textDocument.uri).replace(/a\\.ts$/, 'b.ts'), range: { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } } }, { uri: 'file:///x/other.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } }] })
    else if (msg.method === 'textDocument/documentSymbol') send({ jsonrpc: '2.0', id: msg.id, result: /empty/.test(texts.get(msg.params.textDocument.uri) || '') ? [] : [{ name: 'x', kind: 13, location: { uri: msg.params.textDocument.uri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } } } }] })
    else if (msg.method === 'shutdown') send({ jsonrpc: '2.0', id: msg.id, result: null })
    else if (msg.method === 'exit') process.exit(0)
    else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } })
  }
})
`

test.skipIf(process.platform !== "win32")("lsp: honest diagnostics (waits for a real publish, no stale version, slow server said so), relative locations, symbols twin, and guards", async () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-lsp-live-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(join(project, "src"), { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  writeFileSync(join(project, "src", "a.ts"), "const x: number = 'boom'\n  unused\n")
  writeFileSync(join(project, "src", "slow.ts"), "export const slow = 'boom'\n")
  writeFileSync(join(project, "src", "e.tsx"), "// empty\n")
  writeFileSync(join(project, "src", "m.py"), "x = 1\n")
  writeFileSync(join(base, "outside.ts"), "export {}\n")
  let script: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean }
    const content = script.shift() ?? "Done."
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "tool-fixture/model", chatModel: "tool-fixture/model", modelRole: "agent", mode: "full-access", project, routerGate: "off", plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, customProviders: [{ id: "tool-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_LSP_DIAG_WAIT_MS: "1500" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 60_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2500)); await Bun.sleep(15) } }
  const results = (id: string) => frames.filter((f) => f.kind === "tool-result" && f.turnId === id).map((f) => String(f.output))
  let n = 0
  const turn = async (mode: "full-access" | "read-only", ...replies: string[]) => { const id = `ls-${++n}`; script = [...replies, "Done."]; send({ kind: "submit", mode, turn: { id, body: "go " + id } }); await wait(() => frames.some((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind))); return results(id) }
  const full = (...replies: string[]) => turn("full-access", ...replies)
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    // الغياب: لا node_modules/.bin ⇦ غيرُ متاح بسببٍ وإرشاد، لا تخمين
    const absent = await full("نفّذ: lsp diag src/a.ts")
    expect(absent[0]).toContain("خادمُ اللغة غيرُ متاح: typescript-language-server ليس في node_modules/.bin")
    expect(absent[0]).toContain("npm i -D typescript-language-server")
    // الحرّاس قبل أيّ إطلاق: امتدادٌ بلا خادم، خارج المشروع، ملفٌّ غائب، صيغةٌ ناقصة، موضعٌ من صفر
    expect((await full("نفّذ: lsp diag src/m.py"))[0]).toContain("لا خادمَ لغةٍ معروفاً لامتداد «py»")
    expect((await full("نفّذ: lsp diag ../outside.ts"))[0]).toContain("خارج المشروع")
    expect((await full("نفّذ: lsp diag src/none.ts"))[0]).toContain("الملفّ غير موجود")
    expect((await full("نفّذ: lsp def src/a.ts"))[0]).toContain("الصيغة: lsp diag")
    expect((await full("نفّذ: lsp def src/a.ts 0:0"))[0]).toContain("السطرُ والعمود من ١")
    // التثبيت كما يثبّته npm: ملفّ .cmd في node_modules/.bin يشغّل node
    mkdirSync(join(project, "node_modules", ".bin"), { recursive: true })
    writeFileSync(join(project, "fake-lsp.cjs"), FAKE_SERVER)
    writeFileSync(join(project, "node_modules", ".bin", "typescript-language-server.cmd"), "@echo off\r\nnode \"%~dp0..\\..\\fake-lsp.cjs\" %*\r\n")
    // قراءة-فقط: إطلاقُ ملفٍّ تنفيذيّ من المشروع أثرُ exec — يُرفض بسبب (التوأمُ السالب لما يليه)
    const ro = await turn("read-only", "نفّذ: lsp diag src/a.ts")
    expect(ro[0]).toContain("غيرُ متاحٍ في نمط قراءة-فقط")
    // diag ينتظر النشرَ الفعليّ (150 ms بعد الفتح) — الخادمُ أعاد URI بترميزٍ آخر ومع ذلك طابق
    const diag = await full("نفّذ: lsp diag src/a.ts")
    expect(diag[0]).toContain("2 تشخيصاً في src/a.ts")
    expect(diag[0]).toContain("src/a.ts:1:1 خطأ: Type boom")
    expect(diag[0]).toContain("src/a.ts:2:3 تحذير: unused")
    // النسخةُ نفسُها تُقرأ من المخزون فوراً؛ وبعد تعديلٍ يُنتظر نشرٌ جديد فلا مخزونَ قديم
    expect((await full("نفّذ: lsp diag src/a.ts"))[0]).toContain("2 تشخيصاً")
    writeFileSync(join(project, "src", "a.ts"), "const x: number = 1\n")
    const clean = await full("نفّذ: lsp diag src/a.ts")
    expect(clean[0]).toBe("لا تشخيصاتٍ لـsrc/a.ts (الخادمُ نشر قائمةً فارغةً لهذه النسخة).")
    // خادمٌ يتأخّر فوق المهلة (3 s > 1.5 s): يُقال «لم ينشر» لا «نظيف»
    const slow = await full("نفّذ: lsp diag src/slow.ts")
    expect(slow[0]).toContain("لم ينشر الخادمُ تشخيصاتٍ لـsrc/slow.ts خلال 2 ث")
    expect(slow[0]).not.toContain("لا تشخيصاتٍ")
    // def/refs: مساراتٌ نسبيّة مثبَتة (الخادمُ أعادها مطلقةً بترميزٍ آخر)، وما خرج عن المشروع يبقى كما جاء
    const def = await full("نفّذ: lsp def src/a.ts 1:7")
    expect(def[0]).toBe("1 موضعاً:\nsrc/a.ts:3:5")
    const refs = await full("نفّذ: lsp refs src/a.ts 1:7")
    expect(refs[0]).toBe("2 موضعاً:\nsrc/b.ts:6:1\nx/other.ts:2:1")
    // symbols: توأمان — رمزٌ بشكل SymbolInformation، وقائمةٌ فارغةٌ يقولها الخادم (tsx لغتُها typescriptreact على العميل نفسه)
    expect((await full("نفّذ: lsp symbols src/a.ts"))[0]).toBe("1: x (k13)")
    expect((await full("نفّذ: lsp symbols src/e.tsx"))[0]).toContain("لا رموزَ في الملفّ")
  } finally {
    // قتلُ المحرّك قتلاً لا يشغّل خطّافَ الخروج، فتُقتل شجرتُه (الغلافُ cmd.exe وخادمُ node) صراحةً، ثمّ يُزال المجلّد بمحاولات.
    try { Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(child.pid)], { stdout: "ignore", stderr: "ignore" }) } catch { /* انتهى */ }
    child.kill(); await child.exited; server.stop(true); await errors
    for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
  }
}, 180_000)
