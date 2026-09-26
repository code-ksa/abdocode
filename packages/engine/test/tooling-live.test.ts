import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { Database } from "bun:sqlite"

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
    // د7ب — نطاقُ الدور عبر المحرّك الحقيقيّ: المستخدمُ قال «go» فقط؛ notes.md موجودٌ ولم يُسمَّ ولم يُقرأ (grep ليس قراءة) ⇦ رفضٌ مسمّى
    // يطلب القراءةَ أوّلاً، والملفُّ لا يُمسّ. ثمّ التوأمُ الإيجابيّ: read في الدور نفسِه ⇦ medit يمرّ.
    const unread = await turn("نفّذ: medit notes.md <<<\nline one\n=>\nLINE ONE\n@@\nline three\n=>\nLINE THREE")
    expect(unread[0]).toContain("رُفض تعديل notes.md")
    expect(unread[0]).toContain("read notes.md")
    expect(readFileSync(join(project, "notes.md"), "utf8")).toBe("line one\nline two\nline three\n")
    // medit: حزمتان تُطبَّقان معاً؛ حزمةٌ لا تطابق تُسقط الكلّ
    const ok = await turn("نفّذ: read notes.md", "نفّذ: medit notes.md <<<\nline one\n=>\nLINE ONE\n@@\nline three\n=>\nLINE THREE")
    expect(ok[0]).toContain("line two")
    expect(ok[1]).toMatch(/✍|كتابة|notes\.md/)
    expect(readFileSync(join(project, "notes.md"), "utf8")).toBe("LINE ONE\nline two\nLINE THREE\n")
    // نطاقُ الدور يُصفَّر كلَّ دور: قراءةُ الدور السابق لا تكفي، فالقراءةُ تسبق التحرير هنا أيضاً — بمسارٍ مطلق (كما يكتبه nemotron حيّاً) والتحريرُ نسبيّ: مفتاحٌ واحد.
    const bad = await turn(`نفّذ: read ${join(project, "notes.md")}`, "نفّذ: medit notes.md <<<\nline two\n=>\nX\n@@\nmissing text\n=>\nY")
    expect(bad[1]).toContain("الحزمة 2")
    expect(readFileSync(join(project, "notes.md"), "utf8")).toBe("LINE ONE\nline two\nLINE THREE\n")
    // run --bg: معرّفٌ، ثمّ logs يرى الخرج، ثمّ stop يوقف عمليةً ما زالت تعمل
    // 🔴 **اسأل القرصَ لا الدالّة**: أثرُ الشِّلّ يُدخَل في النواة ويُسجَّل في دفترها قبل إقلاعه
    // ويُسوّى بخروجه. العدُّ من `journal_effects` في الملفّ الذي تكتبه النواة نفسُها — فدالّةٌ
    // تُرجع «سُجِّل» ولا تكتب شيئاً تحمرّ هنا ولا تمرّ.
    const journalRows = (): number => {
      const path = join(state, "abdocode.sqlite")
      if (!existsSync(path)) return 0
      const db = new Database(path, { readonly: true })
      try { return (db.query("select count(*) as n from journal_effects").get() as { n: number }).n } finally { db.close() }
    }
    const beforeForeground = journalRows()
    const fg = await turn("نفّذ: run Write-Output ledger-probe")
    expect(fg[0]).toContain("ledger-probe")
    // أربعُ مراحلَ عند البدء (Prepared ⇦ Cleared ⇦ Authorized ⇦ Dispatching) ثمّ تسويةٌ بالخروج —
    // مقيسٌ على ملفٍّ مؤقّت بالنواة الحقيقيّة: سبعةُ صفوفٍ في `journal_effects` لأمرٍ واحد.
    // (وأوّلُ نسخةٍ من هذا الاختبار سألت `journal_events` فوجدت صفراً — الجدولُ الخطأ لا الأثرُ الغائب.)
    const afterForeground = journalRows()
    expect(afterForeground - beforeForeground).toBeGreaterThanOrEqual(5)
    const beforeBackground = journalRows()
    const bg = await turn("نفّذ: run --bg 1..3 | ForEach-Object { \"tick$_\"; Start-Sleep -Milliseconds 400 }; Start-Sleep -Seconds 20")
    // الخلفيّ يبدأ في الدفتر قبل إقلاعه — مراحلُ البدء الأربعُ موجودةٌ قبل أن يخرج.
    expect(journalRows() - beforeBackground).toBeGreaterThanOrEqual(4)
    expect(bg[0]).toContain("بدأ التشغيلُ الخلفيّ bg-1")
    // ✅ الفجوةُ أُغلقت (2026-09-27): الخلفيُّ يمرّ بمُطلِق العزل نفسِه في طَورٍ منفصل، فلا
    // تحذيرَ يُقال — والإيصالُ يقول ما بقي صحيحاً: العمرُ عمرُ الجلسة. والمسمارُ يتحرّك
    // مع الحقيقة: تحذيرٌ باقٍ بعد إغلاقِ سببه كذبٌ في الاتجاه الآخر.
    expect(bg[0]).toContain("عمرُه عمرُ الجلسة")
    expect(bg[0]).not.toContain("خارج مُطلِق العزل")
    await Bun.sleep(2500)
    const logs = await turn("نفّذ: logs bg-1 50")
    expect(logs[0]).toContain("bg-1 · جارٍ")
    expect(logs[0]).toContain("tick3")
    const stopped = await turn("نفّذ: stop bg-1")
    expect(stopped[0]).toContain("أُوقف bg-1")
    await Bun.sleep(600)
    // والتسويةُ وقعت بخروجه الموقوف: أكثرُ من مراحل البدء وحدها.
    const deadline = Date.now() + 8_000
    while (journalRows() - beforeBackground < 5 && Date.now() < deadline) await Bun.sleep(200)
    expect(journalRows() - beforeBackground).toBeGreaterThanOrEqual(5)
    const after = await turn("نفّذ: logs bg-1")
    expect(after[0]).toMatch(/أُوقف|انتهى برمز/)
    const unknown = await turn("نفّذ: logs bg-9")
    expect(unknown[0]).toContain("لا تشغيلَ خلفيّاً")
    expect(existsSync(join(state, "bg-runs", "bg-1.log"))).toBe(true)
    // والسجلُّ من تيّارِ الطفل بترميزٍ نملكه: لا BOM ولا UTF-16LE (كان PowerShell يكتب
    // `*>` بـUTF-16LE مع BOM فتُقرأ بحيلةِ كشفِ ترميز — الحيلةُ باقيةٌ للقديم لا للجديد).
    const logBytes = readFileSync(join(state, "bg-runs", "bg-1.log"))
    expect(logBytes[0] === 0xff && logBytes[1] === 0xfe).toBe(false)
    expect(logBytes.toString("utf8")).toContain("tick3")
    // 🔴 **التوأمُ الحاكم: `--bg` ليس باباً أوسع.** الحرّاسُ كلُّهم يسبقون فرعَ الخلفيّ،
    // فما يُرفض في المقدّمة يُرفض معه — ولو انزلق الفرعُ فوقهم يوماً لصار العلمُ تجاوزاً.
    const beforeRefusals = journalRows()
    const linuxBg = await turn("نفّذ: run --bg rm -rf data")
    expect(linuxBg[0]).toContain("رُفض")
    expect(linuxBg[0]).not.toContain("بدأ التشغيلُ الخلفيّ")
    const globalBg = await turn("نفّذ: run --bg npm install -g typescript")
    expect(globalBg[0]).toContain("رُفض")
    expect(globalBg[0]).not.toContain("بدأ التشغيلُ الخلفيّ")
    // ولا سجلَّ يُخلق لما رُفض: الرفضُ قبل الإطلاق لا بعده.
    expect(existsSync(join(state, "bg-runs", "bg-2.log"))).toBe(false)
    // ولا صفَّ في دفتر النواة: الحرّاسُ تسبق الإدخالَ والبدء، فالمرفوضُ لم يصر أثراً قطّ.
    expect(journalRows()).toBe(beforeRefusals)
    // ومسمارُ مصدرٍ: التشغيلُ الخلفيُّ يمرّ بالمُطلِق في طَورٍ منفصل — ورجوعٌ إلى `Bun.spawn`
    // هنا يُعيد الفجوةَ صامتاً، فيُمسك بالنصّ لا بالنيّة.
    const module_ = readFileSync(join(ROOT, "packages", "engine", "src", "background-runs.ts"), "utf8")
    expect(module_).toContain("launchControlledProcess({")
    expect(module_).toContain("detach: true")
    expect(module_).not.toContain("Bun.spawn(")
  } finally { child.kill(); await child.exited; server.stop(true); await errors; rmSync(base, { recursive: true, force: true }) }
}, 180_000)
