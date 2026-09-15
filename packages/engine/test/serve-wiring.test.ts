import { describe, expect, test } from "bun:test"
import { PLUGINS } from "../src/plugin-registry"
import { runInNewContext } from "node:vm"
import { createSettingsDrafts } from "../../desktop/ui/settings-drafts.js"
import { ANCHORS } from "../src/shells/slots"
import { SKIPPED_WRITE_PREFIX } from "../src/tool-locations"
import { SHIPPED_VAULT_SCRIPT, vaultHome } from "../src/vault"

const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()
const registrySource = await Bun.file(new URL("../src/plugin-registry.ts", import.meta.url)).text()
const vaultSource = await Bun.file(new URL("../src/vault.ts", import.meta.url)).text()

describe("serve convergence wiring", () => {
  test("the engine consumes the owned transport contract instead of declaring frames", async () => {
    const protocol = await Bun.file(new URL("../src/mind/protocol.ts", import.meta.url)).text()
    expect(protocol).toContain('from "@abdo/transport-contracts"')
    expect(protocol).not.toContain('{ kind: "submit", dir: "in"')
  })

  test("desktop child pipes require a per-process authenticated hello", async () => {
    const desktop = await Bun.file(new URL("../../desktop/src-tauri/src/main.rs", import.meta.url)).text()
    expect(source).toContain("ABDO_SHELL_TOKEN")
    expect(source).toContain("timingSafeEqual")
    expect(desktop).toContain('env("ABDO_SHELL_TOKEN", shell_token)')
    expect(desktop).toContain('"token": shell_token')
  })

  // إعادة تسمية 2026-09-03: حارسُ تسريب الهوية كان يطابق «عبدو كود الإخباري»
  // حرفياً. حارسٌ يطابق اسماً لم يعد أحدٌ يكتبه هو حارسٌ ميّتٌ بلا أن يُعلن
  // موته — فيُثبَّت هنا على الاسم المشحون نفسه، ومصدرُ الاسم واحدٌ للحارس
  // ولسطر النظام الذي ينهى النموذج عن كتابته في مشروع العميل.
  test("the assistant-identity leak guard still matches the shipped product name", async () => {
    const desktop = await Bun.file(new URL("../../desktop/src-tauri/src/main.rs", import.meta.url)).text()
    const guard = source.match(/normalizedTarget\) && \/([^/\n]+)\/u\.test\(after\)/u)?.[1]
    expect(guard).toBe("عبدو كود")
    expect(new RegExp(guard!, "u").test("مرحباً من عبدو كود إلى مشروعك")).toBe(true)
    expect(source).toContain(`لا تضع «${guard}» في ملفات المشروع`)
    expect(source).not.toContain("الإخباري")
    // البادئة الجديدة على البابين اللذين يحسبان بيت الخزنة واسمها مستقلّين.
    expect(vaultSource).toContain(`"abdocode"`)
    expect(vaultSource).not.toContain("abdo-akhbari")
    // البادئةُ ما تزال شرطاً، وصارت فضاءَين نملكهما بعد أن كان المزوّدُ
    // المخصّص (`custom-`) يُرفض من هذا الحارس وحده بينما يُلزمه المحرّك.
    expect(desktop).toContain(`const VAULT_NAMESPACES: [&str; 2] = ["abdocode-", "custom-"];`)
    expect(desktop).toContain(`VAULT_NAMESPACES.iter().any(|p| key.starts_with(p))`)
    expect(desktop).not.toContain("abdo-akhbari")
    // وهذان بابان اثنان، لا بيتٌ واحدٌ وحارسُ اسم: `vault_name` في الرست
    // يحرس شكلَ المقبض، أمّا **بيتُ** الخزنة فيُحسب مرّتين مستقلّتين — مرّةً
    // في vault.ts ومرّةً في السكربت المشحون. وعاملُ الرست يستدعي السكربت بلا
    // `ABDO_VAULT_DIR`، فيقع على حسبته هو؛ فلو تغيّرت إحداهما وحدها كتب
    // المحرّك في بيتٍ وقرأ العاملُ من آخر، بلا رفضٍ يسمّي السبب. تُقارَنان هنا.
    expect(vaultHome({ APPDATA: "C:\\A" })).toEqual({ home: "C:\\A\\abdocode" })
    expect(SHIPPED_VAULT_SCRIPT).toContain("Join-Path $env:APPDATA 'abdocode\\vault'")
    expect(SHIPPED_VAULT_SCRIPT).not.toContain("abdo-akhbari")
    // هوية المساعد العربية تبقى داخل البروتوكول، بينما هوية التطبيق المرئية
    // إنجليزية افتراضياً كما طلب المالك، من دون رجوع الاسم القديم.
    expect(desktop).not.toContain("الإخباري")
    expect(desktop).toContain(`name: "عبدو كود".into()`)
    const config = await Bun.file(new URL("../../desktop/src-tauri/tauri.conf.json", import.meta.url)).text()
    expect(config).not.toContain("الإخباري")
    expect(JSON.parse(config).productName).toBe("AbdoCode")
    expect(JSON.parse(config).app.windows[0].title).toBe("AbdoCode")
    const shell = await Bun.file(new URL("../../desktop/ui/index.html", import.meta.url)).text()
    expect(shell).not.toContain("الإخباري")
    expect(shell).not.toContain("abdo-akhbari")
    expect(shell).toContain("<title>AbdoCode</title>")
  })

  // جولة إيدو جلوبال (pnpm monorepo، 2026-09-02): بوابة التدقيق كانت تقبل
  // `npm audit` وحدها ونصّ npm وحده، ومهلة run كانت 120 ثانية ثابتة —
  // بناء turbo يتجاوزها فيُعدّ فشلاً كاذباً.
  test("acceptance recognises pnpm/yarn/bun audit and the run timeout is owner-configurable", () => {
    expect(source).toContain("(?:npm|pnpm|yarn|bun)\\s+audit(?:\\s|$)")
    expect(source).toContain("No known vulnerabilities found")
    expect(source).toContain("ABDO_RUN_TIMEOUT_MS")
    expect(source).toContain("timeoutMs: RUN_TIMEOUT_MS,")
    expect(source).not.toContain("timeoutMs: 120_000,")
    // الغياب أو الفساد يعيد الافتراض القديم — لا مهلة مفتوحة ولا صفر.
    expect(source).toMatch(/return parsed >= 10_000 && parsed <= 30 \* 60_000 \? parsed : 120_000/)
  })

  test("the retired JSONL ledger is import-only", () => {
    expect(source).toContain("openServeJournal")
    expect(source).toContain("legacyRows")
    expect(source).not.toContain("appendFileSync(PERSIST")
    expect(source).not.toMatch(/persist\(\{\s*k:\s*["'](?:session|admit|event|done)["']/)
  })

  test("a second fresh turn is refused before durable admission", () => {
    const runningGuard = source.indexOf('if (running !== undefined) {', source.indexOf('const existingAdmission = admissions.get(turn.id)'))
    const durableAdmission = source.indexOf("await serveJournal.admit", runningGuard)
    expect(runningGuard).toBeGreaterThan(0)
    expect(durableAdmission).toBeGreaterThan(runningGuard)
  })

  test("serve read uses the policy runner and owned Rust adapter", () => {
    const start = source.indexOf("const readThroughKernel")
    const end = source.indexOf("// ---------------------------------------------------------------------------", start + 1)
    const read = source.slice(start, end)
    expect(read).toContain("readBoundObjectTool")
    expect(read).toContain("createEnforcedToolRunner")
    expect(read).toContain("resolveProjectPath(file)")
    expect(read).not.toContain("host.send(")
  })

  // S13.0 اقتصاد القراءة: مقطع بأرقام أسطر عبر أثر النواة الواحد، وقاعدة
  // القراءة في تعليمات النموذج، ومفتاحا الضغط والكاش في لوحة سطح المكتب.
  test("range reads, the read-economy prompt line, and the desktop toggle rows are wired", async () => {
    const desktopUi = await Bun.file(new URL("../../desktop/ui/index.html", import.meta.url)).text()
    expect(source).toContain("read <ملف> [من] [إلى]  قراءة عبر النواة")
    expect(source).toContain('import { READ_NEEDS_FILE, READ_RANGE_USAGE, planRead, sliceReadRange, splitReadTail } from "./read-range"')
    // مسار المقطع يعضّ: خطّةٌ نقيّة تُمرَّر كما هي إلى الأثر الواحد، ولا غلافٌ
    // وسيط يمكن أن يُترك ميتاً (noUnusedLocals مطفأ) وتبقى البوّابة خضراء.
    expect(source).toContain("const plan = planRead(args)")
    // بعد دمج حكم الأداة الصريح (2026-09-02): القمع يحمل الحكم (readCommandV → readThroughKernelV)،
    // والغلافان النصّيان يسقطانه فقط؛ وحالة read في المُوزِّع تمرّ من القمع نفسه لا من نصّ رفضٍ ثانٍ.
    expect(source).toContain('return "error" in plan ? invalid(plan.error) : readThroughKernelV(plan.file, plan.range)')
    expect(source).toContain("const readCommand = async (args: readonly string[]): Promise<string> => (await readCommandV(args)).output")
    // د7ب: القراءةُ المؤطَّرة تُسجَّل في نطاق الدور من خطّة planRead نفسِها ثمّ تمرّ من القمع الواحد.
    expect(source).toContain("const readArgs = framedBody.split(/\\s+/).slice(1)")
    expect(source).toContain('if (!("error" in readPlan)) turnReadPaths.add(turnScopeKey(readPlan.file))')
    expect(source).toContain("return readCommandV(readArgs)")
    expect(source).not.toContain("readThroughKernelRange")
    expect(source).toContain("sliceReadRange(text, range.from, range.to)")
    // المنافذ الثلاثة: REPL يحفظ المسار ذا الفراغات كما كان (splitReadTail)،
    // والجسد النصّي يمرّر الذيل كلّه، والأمر يخرج بـ2 على الرفضَين.
    expect(source).toContain("readCommand(splitReadTail(text.slice(5)))")
    expect(source).toContain('case "read": return readCommand(tail)')
    expect(source).toContain("const out = await readCommand(rest)")
    expect(source).toContain("if (out === READ_NEEDS_FILE || out === READ_RANGE_USAGE) process.exitCode = 2")
    // نصّ الرفض في مصدرٍ واحد (read-range.ts) لا ثلاثة
    expect(source).not.toContain('"read يحتاج ملفاً"')
    expect(source).toContain(
      "اقرأ الملفات الكبيرة بمقطع: «نفّذ: read <ملف> <من> <إلى>» أو ابحث فيها بـgrep بدل قراءتها كاملة؛ لا تعِد قراءة ملف قرأته في هذه الجلسة (تُعاد إليك نتيجته المحفوظة)؛ ولا تعرض قوائم node_modules أو .next.\\n",
    )
    // الوضع الأصلي (native tools) يرفض نصّ «نفّذ:»، فقاعدته تسمّي حقل path لا الصيغة النصّية.
    const nativeTools = await Bun.file(new URL("../src/native-agent-tools.ts", import.meta.url)).text()
    expect(nativeTools).toContain(
      "اقرأ الملفات الكبيرة بمقطع: استدعِ read بحقل path «<ملف> <من> <إلى>» (أرقام أسطر تبدأ من 1) أو ابحث فيها بـgrep بدل قراءتها كاملة؛ لا تعِد قراءة ملف قرأته في هذه الجلسة (تُعاد إليك نتيجته المحفوظة)؛ ولا تعرض قوائم node_modules أو .next.",
    )
    expect(nativeTools).not.toContain("«نفّذ: read")
    const readRange = await Bun.file(new URL("../src/read-range.ts", import.meta.url)).text()
    expect(readRange).toContain('"الصيغة: read <ملف> [من] [إلى] — أرقام أسطر تبدأ من 1"')
    expect(readRange).toContain('"read يحتاج ملفاً"')
    // ── إعادة تثبيت مقصودة (سبرنت سجلّ الإضافات) ────────────────────────────
    // صفوف اللوحة وخريطة الاستعادة لم تعد حرفاً ثابتاً في index.html: صارت
    // تُولَّد من أوصاف المحرّك. التثبيتات أدناه هي التثبيتات نفسها بنصّها،
    // منقولةً إلى المكان الذي صار يملكها — ولا تثبيتَ حُذف ليمرّ اختبار.
    for (const name of ["readCompaction", "cacheAccounting", "trailCompaction", "turnBudget", "receiptFixtures"]) {
      expect(registrySource).toContain(`name: "${name}"`)
    }
    expect(registrySource).toContain("سقف إنفاق الدور")
    expect(registrySource).toContain("ABDO_TURN_TOKEN_CAP")
    expect(registrySource).toContain("ضغط إيصالات التنفيذ")
    expect(registrySource).toContain("التقاط إيصالات الحوادث")
    // الافتراضات بنصّ خريطة الاستعادة القديمة حرفاً بحرف؛ والترتيب صار ترتيب
    // اللوحة وحده (كان trailCompaction يقع في خانتين مختلفتين بين اللوحة
    // والخريطة — وُحّدا هنا عمداً، والقيم لم تتغيّر).
    const declared = PLUGINS.filter((d) => d.meta !== true)
    expect(declared.map((d) => d.name)).toEqual([
      "denialBreaker", "unattendedDeny", "standingGrants", "inboundGuard", "mcpClient", "delegation", "reviewer", "activity", "terminalPanel", "serversPanel", "tasksPanel", "walls", "verifier", "toolVerdict",
      "miner", "readCompaction", "trailCompaction", "cacheAccounting", "resumeIntent", "turnBudget", "receiptFixtures",
      "intentField", "approvalTakeover", "trajectory", "deliverables", "secretIntake",
      // S13.1/S13.2 — صفّا الوعي يُلحقان في الذيل ولا يزحزحان ما قبلهما.
      "sessionAwareness", "projectAwareness",
      // S13.3 — الوعي العام يُلحق في الذيل كأختَيه ولا يزحزح ما قبله.
      "generalAwareness",
      // د2 — المحرّك الدلاليّ يُلحق في الذيل كذلك.
      "semanticFrame",
      "semanticInfer",
      // ذ3 — الدروسُ المقيَّدة بالمشروع تُلحق في الذيل كذلك.
      "lessons",
      // ذ5 — العدّادُ المحلي يُلحق في الذيل كذلك.
      "usageMeter",
    ])
    expect(declared.map((d) => `${d.name}: ${d.defaultOn}`).sort()).toEqual(
      ("denialBreaker: false, unattendedDeny: true, standingGrants: false, inboundGuard: true, mcpClient: false, delegation: false, reviewer: false, activity: false, walls: true, verifier: false, toolVerdict: true, trailCompaction: true, miner: true, readCompaction: true, cacheAccounting: true, resumeIntent: true, turnBudget: true, receiptFixtures: true, intentField: false"
        + ", approvalTakeover: true, trajectory: true, deliverables: false, secretIntake: true"
        + ", sessionAwareness: true, projectAwareness: true, generalAwareness: true, semanticFrame: true, semanticInfer: false, lessons: true, usageMeter: true"
        // ألواحُ قشرة 2026-09-03 — مطفأةٌ افتراضاً: الطرفيّةُ تغيّر الواجهة،
        // والخوادمُ تغيّر **عمرَ العمليات**، وما يغيّر سلوكاً يبدأ مطفأً.
        + ", terminalPanel: true, serversPanel: false, tasksPanel: true").split(", ").sort(),
    )
    // ولا صفَّ ثابتاً بقي في القشرة: الصفوف عُقدٌ تُبنى من الإطار، والاستعادة تُحسب من الأوصاف.
    expect(desktopUi).toContain('<div id="pluginrows"></div>')
    expect(desktopUi).toContain("box.dataset.plugin = d.name;")
    expect(desktopUi).toContain('box.checked = isRule ? (typeof storedValue === "boolean" ? storedValue : !!d.defaultOn) : effective;')
    for (const stale of ['data-plugin="readCompaction"', 'data-plugin="trailCompaction"', 'data-plugin="turnBudget"', 'data-plugin="cacheAccounting"']) {
      expect(desktopUi).not.toContain(stale)
    }
    expect(desktopUi).not.toContain("cacheAccounting: true, resumeIntent: true, turnBudget: true }")
  })

  // إيصال حكم صريح من الأداة (plugins.toolVerdict) — WP3: المنتجون في cli.ts، النقل،
  // المفتاح، القياس، ومفتاح التكرار؛ وإصلاحا جولة إيدو جلوبال 2026-09-02.
  test("tool verdicts ride beside byte-identical receipts, default ON, and OFF hands the loop a bare string", async () => {
    const helpers = await Promise.all([
      "../src/project-test-acceptance.ts", "../src/project-build-acceptance.ts", "../src/turn-memory.ts",
    ].map((p) => Bun.file(new URL(p, import.meta.url)).text()))
    const managedServer = await Bun.file(new URL("../src/managed-server.ts", import.meta.url)).text()
    const desktop = await Bun.file(new URL("../../desktop/ui/index.html", import.meta.url)).text()
    // §6 المفتاح: يُقرأ مرةً لكل دور، الافتراض مفعَّل؛ المعطَّل يسلّم الحلقة نصّاً عارياً.
    expect(source).toContain('const verdictOn = plugins.read("toolVerdict", "turn")')
    expect(source).toContain("return verdictOn ? r : r.output")
    expect(source).toContain("completed: verdictOn && r.verdict !== undefined ? r.verdict.ok : !toolReceiptFailed(turn.body, r.output)")
    // §3 المنتجون بأغلفتهم النصّية.
    for (const producer of ["dispatchToolV(", "runExecV(", "runAdapterV(", "runWriteToolV(", "readThroughKernelV("]) expect(source).toContain(producer)
    // §4/§5 النقل والمستهلكون.
    // S13.0-g أضاف وسيطاً أخيراً (النيّة) — والتوقيع يبقى مثبَّتاً بحرفه الجديد.
    expect(source).toContain("onToolResult: (cmd, output, verdict, idempotencyKey, mutated, intent)")
    expect(source).toContain("receipts.push({ command: cmd, output, verdict, mutated })")
    // TV-2: the closure gate reads allReceipts (both push sites) and the acceptance flags take the verdict.
    expect(source).toContain("allReceipts.push({ command: cmd, output, verdict, mutated })")
    expect(source).toContain("allReceipts.push({ command, output, verdict, mutated })")
    expect(source).not.toContain("allReceipts.push({ command: cmd, output })")
    expect(source).not.toContain("allReceipts.push({ command, output })")
    expect(source).not.toContain("allReceipts.push({ command: cmd, output, verdict })")
    expect(source).not.toContain("allReceipts.push({ command, output, verdict })")
    expect(source).toContain("projectTestPassed(output, verdict)")
    expect(source).toContain("projectBuildViolation(PROJECT_DIR, output, verdict)")
    expect(source).not.toContain("projectTestPassed(output)")
    expect(source).not.toContain("projectBuildViolation(PROJECT_DIR, output)")
    // TV-FC-1: a refused dispatch that still wrote ABDO-SPRINTS.md declares the mutation so the
    // loop's read cache moves; the verdict itself stays a refusal. Both materialisation sites.
    expect(source.split("), mutated: true }").length - 1).toBe(2)
    expect(source).toContain("const mutated = verdictOn ? probe.mutated : undefined")
    // TV-3: the unmapped hand-off feeds the ledger at both observation sites, and the adapter
    // error mapping lives in its own unit-tested module.
    expect(source).toContain("lastUnmapped = r.unmapped === true")
    expect(source).toContain("ledger?.observe(cmd, verdict, lastUnmapped)")
    expect(source).toContain("ledger?.observe(command, verdict, probe.unmapped)")
    expect(source).toContain('import { adapterErrorVerdict } from "./adapter-error-verdict"')
    expect(source).not.toContain("const adapterErrorVerdict")
    expect(source).toContain("wallTracker.observe(output, verdict)")
    expect(source).toContain("playbookMiner.observe(output, verdict)")
    expect(source).toContain("distillFact(cmd, output, verdict)")
    expect(source).toContain("exitZero(output, verdict)")
    // §7 مفتاح التكرار على ToolCall ومعرّفات تنفيذ فريدة.
    expect(source).toContain("{ name: toolName, input, idempotencyKey }")
    for (const stale of ["write_${turnId}`", "git_${turnId}`", "packages_${turnId}`", "fetch_${turnId}`"]) expect(source).not.toContain(stale)
    // §8 القياس.
    expect(source).toContain("new ToolVerdictLedger()")
    expect(source).toContain("verdictCoverage")
    // الحرف القديم «صفر في أي موضع» يعيش في failure-tiering وحده.
    const zeroAnywhere = "انتهى الأمر برمز|exit(?:ed)?(?: with)?(?: code)?)\\s*0\\b"
    expect(source).not.toContain(zeroAnywhere)
    for (const helper of helpers) expect(helper).not.toContain(zeroAnywhere)
    // بقيّة §9 المعلَنة: نصّ Rust والخادم المُدار بنصّه الأوّل.
    expect(source).toContain("دليل عامل Rust:")
    expect(managedServer).toContain("فشل تشغيل الخادم")
    // سطح المكتب: الصفّ والاستعادة صارا مولَّدين — الوصف في السجلّ (بنصّه
    // الأول حرفاً بحرف)، والتوليد في القشرة. إعادة تثبيت لا حذف.
    expect(registrySource).toContain('name: "toolVerdict"')
    expect(registrySource).toContain("حكم صريح من الأداة")
    expect(PLUGINS.find((d) => d.name === "toolVerdict")).toMatchObject({ defaultOn: true, site: "turn", wired: true })
    expect(desktop).toContain('box.checked = isRule ? (typeof storedValue === "boolean" ? storedValue : !!d.defaultOn) : effective;')
    // إيدو جلوبال 2026-09-02 (أ): «NEXT_ACTION» في نصّ الهدف كانت تطابق next.
    // (بعد آلية «اكمل» 2026-09-02 يُفحص الهدف الفعليّ effectiveGoal لا turn.body.)
    expect(source).toContain("/(?:next\\.?js|(?<![\\p{L}\\w])p?npm(?![\\w])|(?<![\\p{L}])موقع(?![\\p{L}]))/iu.test(effectiveGoal)")
    expect(source).not.toContain("/(?:next(?:\\.js)?|npm|موقع)/iu")
    // (ب): تلميح التدقيق يسمّي مدير الحزم عموماً لا npm وحده.
    expect(source).toContain("تدقيق مدير الحزم (npm audit أو pnpm audit بحسب ملف القفل)")
    expect(source).not.toContain("لا يوجد إيصال npm audit نظيف")
  })

  // آلية «اكمل من حيث توقفت» (plugins.resumeIntent) — قيس 2026-09-01: النصّ العاري
  // أعاد النموذج إلى التسليم لكنه أسقط كل بوابة قبولٍ مشتقّة من الهدف. الدور
  // الاستئنافيّ يرث هدف آخر دورٍ حقيقيّ، فتُشتقّ منه البوابات ويُخبَر النموذج.
  test("a bare «اكمل» turn inherits the prior real goal, its gates, and announces it — default ON", async () => {
    const desktop = await Bun.file(new URL("../../desktop/ui/index.html", import.meta.url)).text()
    expect(source).toContain('import { isResumeIntent, pickPriorGoal, resumeAnnouncement, resumeBrief } from "./resume-intent"')
    // §6 المفتاح يُقرأ مرةً لكل دور، الافتراض مفعَّل؛ والقراءة من الذاكرة محاطة بـtry (فشلها = لا استئناف).
    // Pure Chat has no agent goal to resume. Code keeps the existing toggle.
    expect(source).toContain('const resumeOn = modeAtTurn!==\'chat\' && plugins.read("resumeIntent", "turn")')
    expect(source).toContain("const priorGoal = resumeOn && isResumeIntent(turn.body)")
    // R1-01: حقائق الأدوار موسومة بجلستها (sessionId: currentSession)، والصلاحية ترفض
    // الحقيقة الموسومة لاستعلامٍ بلا جلسة — فالاستعلام بجلسة الدور وإلا لا هدف يُستأنف أبداً.
    // A session query also returns unscoped project facts. Privacy filtering
    // must precede goal selection so old shared goals cannot bypass the toggle.
    expect(source).toContain("? (() => { try { return pickPriorGoal(factsForAutomaticRecall(durableMemory.query({ projectId: resolve(PROJECT_DIR), sessionId: currentSession, now: Date.now() }).facts, memorySearchEnabled, currentSession)) } catch { return undefined } })()")
    expect(source).not.toContain("pickPriorGoal(durableMemory.query({ projectId: resolve(PROJECT_DIR), now: Date.now() })")
    expect(source).toContain("const effectiveGoal = priorGoal?.goal ?? turn.body")
    // بوابات القبول الأربع تُشتقّ من الهدف الفعليّ لا من نصّ الدور.
    for (const gate of ["requiresBuild", "requiresTypecheck", "requiresNpmAudit", "requiresTests"]) {
      expect(source).toMatch(new RegExp(`const ${gate} = !planningOnly && /[^\\n]*/iu\\.test\\(effectiveGoal\\)`, "u"))
      expect(source).not.toMatch(new RegExp(`const ${gate} = !planningOnly && /[^\\n]*/iu\\.test\\(turn\\.body\\)`, "u"))
    }
    // بوابة الخرج المسمّى في موضعَيها.
    expect(source.split("outputEvidenceVerdict(effectiveGoal, allReceipts.slice(outputEvidenceFloor))").length - 1).toBe(2)
    expect(source).not.toContain("outputEvidenceVerdict(turn.body,")
    // R1-02: المحكّم الدلاليّ يحكم على الهدف الفعليّ لا على «اكمل» العارية.
    expect(source).toContain("buildVerifierPrompt(effectiveGoal, loop.answer, allReceipts)")
    expect(source).not.toContain("buildVerifierPrompt(turn.body,")
    // مدخل الحقبة الأولى يحمل سطر الاستئناف قبل نصّ الدور؛ وحدث الاستئناف يُعلَن مرةً بحالة الهدف.
    // S14: `secretNotice` تُقحم بين سطر الاستئناف ونصّ الدور — وهي سلسلةٌ
    // فارغة في كلّ دورٍ لا يحمل اعتماداً، فمدخل الحقبة الأولى للأدوار
    // العاديّة هو هو بايتاً بايت.
    // S13.1/S13.2: `projectAwareness` تتصدّر المدخل و`summaryBrief`/`summaryAsk`
    // تركبانه — وثلاثتها سلاسل فارغة حين يكون مفتاحاها معطَّلين، فمدخل الحقبة
    // الأولى للأدوار العاديّة يبقى هو هو بايتاً بايت.
    // S13.3: `generalAwareness` تلي `priorRecall` — بعد طبقات القياس كلّها،
    // لأنها معرفةٌ عامّة لا قياسٌ عن هذا المشروع؛ وهي سلسلةٌ فارغة حين يكون
    // مفتاحها معطَّلاً، فالمدخل يبقى هو هو بايتاً بايت.
    // د2: `semanticBrief` يلي موجزَ الاستئناف — سلسلةٌ فارغة حين يكون مفتاحُه معطَّلاً، فالمدخل يبقى هو هو بايتاً بايت.
    // ذ3: `lessonsBrief` يليه بالقاعدة نفسها — لا درسَ أو مفتاحٌ معطَّل = سلسلةٌ فارغة.
    // هـ1 (2026-09-07): موجزُ الإطار الدلاليّ تحت القضبان أيضاً (rails.semanticBrief) — الرفيعُ السحابيّ لا يحقنه بأمر المالك؛ الترتيبُ كما هو.
    // هـ2 (2026-09-07): خلاصةُ الوكيل الموجِّه تلي رصدَ المشروع — سلسلةٌ فارغة في الوضع الأساسيّ.
    // 2026-09-13: وصفاتُ الإعداد المحفوظة (recipesBrief) تلي الدروسَ بالقاعدة نفسها — لا وصفةَ مذكورةً في الرسالة = سلسلةٌ فارغة.
    expect(source).toContain('? `${projectOrientation}${orientationBrief}${projectAwareness}${summaryBrief}${coldMap}${priorRecall}${generalAwareness}${priorGoal !== undefined ? resumeBrief(priorGoal) : ""}${rails.semanticBrief ? semanticBrief : ""}${lessonsBrief}${recipesBrief}${secretNotice}${turn.body}${summaryAsk}`')
    expect(source).toContain('const secretNotice = secretWarning === undefined ? "" : `${secretWarning.model}\\n\\n`')
    expect(source).toContain("if (priorGoal !== undefined) await emitEvent(turn.id, resumeAnnouncement(priorGoal))")
    // حقيقة الدور تحفظ الهدف الفعليّ — بدءاً ونهايةً — فالاستئناف المتسلسل يظلّ يشير إلى الهدف الحقيقيّ؛
    // ونصّ الدور ومَن استُؤنف منه يُكتبان فقط حين تعمل الميزة (R1-03/R2-06: المعطَّل أو غير
    // الاستئناف يكتب شكل السجل القديم حرفياً، والاستدعاء يعرض السجل للنموذج عبر recallExecutionFact).
    expect(source).toContain('value: { goal: effectiveGoal, status: "running", project: resolve(PROJECT_DIR), ...(priorGoal !== undefined ? { body: turn.body, resumedFrom: priorGoal.turnId } : {}) }')
    expect(source).toMatch(/goal: effectiveGoal,\r?\n\s+\.\.\.\(priorGoal !== undefined \? \{ body: turn\.body, resumedFrom: priorGoal\.turnId \} : \{\}\),\r?\n\s+status: completed \?/u)
    expect(source).not.toContain('body: turn.body, status: "running"')
    expect(source).not.toMatch(/\n\s+body: turn\.body,\r?\n/u)
    expect(source).not.toContain('value: { goal: turn.body, status: "running"')
    // سطح المكتب: إعادة تثبيت — نصّ الصفّ صار في السجلّ، والصفّ يُبنى منه.
    expect(registrySource).toContain('name: "resumeIntent"')
    expect(registrySource).toContain("آلية اكمل من حيث توقفت")
    expect(PLUGINS.find((d) => d.name === "resumeIntent")).toMatchObject({ defaultOn: true, site: "turn", wired: true })
    expect(desktop).not.toContain('data-plugin="resumeIntent" checked')
    expect(desktop).toContain('box.id = "plug" + d.name.toLowerCase(); box.dataset.plugin = d.name;')
  })

  // IDEA 4 — البوابة الأمامية الرخيصة (routerGate: off|cheap|auto). كل تثبيتٍ يسقط إن غاب
  // جزءٌ من الربط؛ وحدات القرار في front-gate.test، وملاحظة الدفتر في token-economy-wiring.
  test("routerGate is a flat tri-state setting (default off = nothing constructed), validated by name, read once per turn", async () => {
    const desktop = await Bun.file(new URL("../../desktop/ui/index.html", import.meta.url)).text()
    expect(source).toContain('import { GATE_OUTPUT_TOKENS, buildGateSystem, condenseForGate, gateEligibility, gateEventLine, interpretGateTurn, normalizeArabic, parseGateMode, type GateDecision } from "./front-gate"') // ن4 (09-15): normalizeArabic لمطابقة wait
    // المفتاحان مسطّحان في Settings/SETTINGS_KEYS — لا بلاجين منطقي (اللوحة تسلسل [data-plugin] كمنطقيّات).
    expect(source).toContain('"railPolicy", "routerGate", "gateModel", "plugins"')
    expect(source).toContain('routerGate?: "off" | "cheap" | "auto"')
    expect(source).toContain("gateModel?: string")
    expect(source).not.toContain("plugins?.routerGate")
    expect(source).not.toContain('plugins.read("routerGate"')
    // تقوية مقصودة (لا إعادة تثبيت): هذا الحارس كان مُسنداً إلى cli.ts فلم
    // يكن يثبت شيئاً — نُقل إلى الملف الذي يعنيه، وبقي على cli.ts أيضاً.
    expect(desktop).not.toContain('data-plugin="routerGate"')
    expect(source).not.toContain('data-plugin="routerGate"')
    // ولا يبتلعه السجلّ: routerGate/gateModel مفتاحان مسطّحان، ولا وصف لهما فيه.
    expect(PLUGINS.map((d) => d.name)).not.toContain("routerGate")
    expect(PLUGINS.map((d) => d.name)).not.toContain("gateModel")
    expect(registrySource).not.toContain("routerGate")
    expect(registrySource).not.toContain("gateModel")
    // التحقّق: قيمة مجهولة تُرفض بالاسم، وgateModel مرجعٌ كـchatModel.
    expect(source).toContain('if (value.routerGate !== undefined && value.routerGate !== "off" && value.routerGate !== "cheap" && value.routerGate !== "auto") return "routerGate غير معروف"')
    // ذ1: نموذجُ الرؤية مفتاحٌ خامس بالتحقّق نفسه.
    expect(source).toContain('for (const key of ["model", "chatModel", "agentModel", "gateModel", "visionModel"] as const) {')
    // يُقرأ مرةً لكل دور؛ off = لا شيء آخر يُقيَّم: gateEligibility( تظهر مرةً واحدة وداخل كتلة gateMode !== "off".
    expect(source).toContain('const gateMode = parseGateMode(loadSettings().routerGate)')
    expect(source.match(/parseGateMode\(/gu)).toHaveLength(1)
    expect(source.match(/gateEligibility\(/gu)).toHaveLength(1)
    const gateBlock = source.indexOf('if (gateMode !== "off") {')
    const eligibility = source.indexOf("gateEligibility(")
    expect(gateBlock).toBeGreaterThan(0)
    expect(eligibility).toBeGreaterThan(gateBlock)
    // RG2-2 — الإحاطة لا الترتيب: الترتيب النصّي وحده كان يمرّ حتى لو رُفع النداء
    // خارج كتلة الحارس (فتعمل الأدوار المُطفأة). الكتلة على مسافة 6 فراغات، فلا
    // يجوز أن يظهر قوس إغلاقٍ عند تلك المسافة بين سطر الحارس والنداء.
    const guardToCall = source.slice(gateBlock, eligibility)
    expect(guardToCall).not.toMatch(/\n {6}\}/u)
    expect(guardToCall).toContain("const gateModel = resolveGateModel(selectedModel)")
    // ودليل أن 6 فراغات هي فعلاً مسافة إغلاق هذه الكتلة: الإغلاق موجود بعد النداء.
    expect(source.slice(eligibility)).toMatch(/\n {6}\}/u)
    // موضع النداء: بعد إطار model-route الثاني (المسار النصّي) وقبل MAX_AGENT_EPOCHS — فالمُجاب يسقط الحلقة كلّها.
    // ذ1: الإطارُ يحمل سمةَ الرؤية حين وُجدت — حقلٌ إضافيّ، والشكلُ القديم بايتاً حين غاب.
    const modelRouteEmit = 'emit({ kind: "model-route", turnId: turn.id, lane: selectedModel.lane, ref: selectedModel.ref, ...(selectedModel.vision ? { vision: true } : {}) })'
    const firstRoute = source.indexOf(modelRouteEmit)
    const secondRoute = source.indexOf(modelRouteEmit, firstRoute + 1)
    const maxEpochs = source.indexOf("const MAX_AGENT_EPOCHS = agentEpochBudget(process.env.ABDO_MAX_AGENT_EPOCHS)")
    expect(secondRoute).toBeGreaterThan(firstRoute)
    expect(gateBlock).toBeGreaterThan(secondRoute)
    expect(eligibility).toBeGreaterThan(secondRoute)
    expect(eligibility).toBeLessThan(maxEpochs)
    expect(gateBlock).toBeLessThan(maxEpochs)
    // النموذج: gateModel إن صحّ وإلا حارة الدردشة؛ الأهلية على الحارة والبيئة والجسد ومحليّة المزوّد.
    expect(source).toContain("const gateModel = resolveGateModel(selectedModel)")
    expect(source).toContain("gateProviderLocal: Providers.provider(gateModel.provider)?.local === true,")
    // R1-3 — auto يبوّب فقط حين يُوفَّر نداءٌ سحابي: محليّة الطرفين تُمرَّر، لا محليّة البوابة وحدها.
    expect(source).toContain("selectedProviderLocal: Providers.provider(selectedModel.provider)?.local === true,")
    expect(source).toContain('env: { requireSprintPlan: process.env.ABDO_REQUIRE_SPRINT_PLAN === "1", planningOnly: process.env.ABDO_AGENT_PHASE === "planning" },')
    // المُجاب: دلتا واحدة، سطر 🚪، ختم الحقيقة answered (0 حقب، 0 أوامر)، دفع المحادثة وقصّها، عودة مكتملة.
    // S14: الجملة الأمنية تسبق الجسد في مدخل البوابة أيضاً — وهي فارغة في
    // الدور العاديّ، والأهليّة تبقى محسوبةً على `turn.body` وحده.
    expect(source).toContain("const gate = await gateAsk(`${secretNotice}${turn.body}`, conversation, gateModel, hooks, gateRecall)")
    expect(source).toContain("mode: gateMode, lane: selectedModel.lane, body: turn.body,")
    expect(source).toContain("hooks.onDelta?.(gate.text)")
    expect(source).toContain('value: { goal: effectiveGoal, status: "answered", epochs: 0, commands: 0, stopReason: "gate-answered" },')
    expect(source).toContain('stopReason: "gate-answered"')
    expect(source).toContain('status: "answered"')
    expect(source).toContain('conversation.push({ role: "user", content: turn.body }, { role: "assistant", content: gate.text })')
    expect(source).toContain("return { answer: gate.text, completed: true }")
    // R1-4 — الختم قبل التسليم، بالفهرس لا بالنيّة: supersede وverify ودفع المحادثة كلها
    // تسبق أوّل دلتا؛ وفشل الختم يُطفئ sealed فيسقط الدور إلى الحلقة بدل إعلان جوابٍ بحقيقةٍ running.
    const answeredStart = source.indexOf('if (gate.kind === "answered") {')
    const answeredReturn = source.indexOf("return { answer: gate.text, completed: true }")
    expect(answeredStart).toBeGreaterThan(0)
    expect(answeredReturn).toBeGreaterThan(answeredStart)
    const epilogue = source.slice(answeredStart, answeredReturn)
    const delta = epilogue.indexOf("hooks.onDelta?.(gate.text)")
    expect(delta).toBeGreaterThan(0)
    expect(epilogue.indexOf("durableMemory.supersede(taskFact.id, {")).toBeLessThan(delta)
    expect(epilogue.indexOf("durableMemory.verify(answeredTask.id)")).toBeLessThan(delta)
    expect(epilogue.indexOf('conversation.push({ role: "user", content: turn.body }, { role: "assistant", content: gate.text })')).toBeLessThan(delta)
    expect(epilogue.indexOf("durableMemory.supersede(taskFact.id, {")).toBeGreaterThan(epilogue.indexOf("let sealed = true"))
    expect(epilogue).toContain("sealed = false")
    expect(epilogue).toContain("if (sealed) {")
    // R1-5 — الدور المُجاب سحابياً شحن العدّاد، فسطر ⏱ يُطبع بعد 💳 وقبل العودة.
    expect(epilogue).toContain("if (turnMeter !== undefined) await emitEvent(turn.id, renderTurnBudgetLine(turnMeter.snapshot(), 0))")
    expect(epilogue.indexOf("renderLedgerLine(cloudLedger)")).toBeLessThan(epilogue.indexOf("renderTurnBudgetLine(turnMeter.snapshot(), 0)"))
    expect(epilogue.indexOf("renderTurnBudgetLine(turnMeter.snapshot(), 0)")).toBeGreaterThan(delta)
    // المتروك/المُصعَّد: سطر 🚪 واحد ثم المسار القديم — لا تلميح للنموذج ولا لمس للتاريخ.
    expect(source).toContain('if (!eligibility.eligible) await emitEvent(turn.id, gateEventLine({ decision: "skipped", reason: eligibility.reason, ref: gateModel.ref }))')
    expect(source).not.toContain("epochHistory.push({ role: \"assistant\", content: gate.text")
    // gateAsk لا بثّ ولا أدوات، 60 ثانية، وكل خطأ تصعيدٌ لا كسرٌ للدور.
    const gateAsk = source.indexOf("const gateAsk = async (")
    const askFn = source.indexOf("const ask = async (")
    expect(gateAsk).toBeGreaterThan(0)
    expect(gateAsk).toBeLessThan(askFn)
    const gateAskBody = source.slice(gateAsk, askFn)
    expect(gateAskBody).toContain("tools: [],")
    expect(gateAskBody).toContain("stream: false,")
    expect(gateAskBody).toContain("nativeTools: false,")
    expect(gateAskBody).toContain("maxOutputTokens: GATE_OUTPUT_TOKENS,")
    expect(gateAskBody).toContain("const timeoutMs = 60_000")
    expect(gateAskBody).toContain('return { kind: "escalated", reason: "gate_error", detail: classifyModelFailure({ error }).kind }')
    expect(gateAskBody).not.toContain("epochHistory")
    expect(gateAskBody).not.toContain("conversation.push")
    // سطح المكتب: صفّ select في لوحة الإضافات خارج تسلسل [data-plugin]، والتعبئة والحفظ والاستعادة خارج plugins{}.
    expect(desktop).toContain('id="setroutergate"')
    expect(desktop).toContain('<select id="setroutergate"><option value="off">')
    expect(desktop).toContain('<option value="cheap">')
    expect(desktop).toContain('<option value="auto">')
    expect(desktop).toContain('routerGate: el("setroutergate").value')
    // RG2-1 — قيمة مخزّنة مجهولة كانت تترك الـselect فارغاً فيرسل كل حفظٍ لاحق routerGate:""
    // ويرفض المحرّك الرقعة كلها بينما تعلن اللوحة نجاحاً. القسر يطابق parseGateMode (fail-closed).
    expect(desktop).toContain("const storedGate = runtimeSettings.routerGate;")
    expect(desktop).toContain('el("setroutergate").value = (storedGate === "cheap" || storedGate === "auto") ? storedGate : "off";')
    expect(desktop).not.toContain('el("setroutergate").value = runtimeSettings.routerGate || "off"')
    // Interface reset cannot erase a working provider, permission mode, or plugin state.
    const resetSource = desktop.slice(desktop.indexOf('    el("settingsreset").onclick ='), desktop.indexOf('    el("projectchip").onclick ='))
    expect(resetSource).toContain("invoke('settings_reset')")
    expect(resetSource).not.toContain('settings-set')
    expect(resetSource).not.toContain('resetPlugins')
    // ترتيب اللوحة: صفوف الإضافات المولَّدة ثم صفّ البوابة الثابت بعدها مباشرة.
    expect(desktop).toMatch(/<div id="pluginrows"><\/div>\r?\n\s*<div id="pluginsoffline"[^>]*>[^<]*<\/div>\r?\n\s*<div class="setting-row"><label>البوابة الأمامية الرخيصة/u)
    expect(desktop.indexOf('id="pluginrows"')).toBeLessThan(desktop.indexOf('id="setroutergate"'))
    expect(desktop.match(/id="setroutergate"/gu)).toHaveLength(1)
    // resume-intent: الحالة answered تُتخطّى وتُسمّى.
    const resume = await Bun.file(new URL("../src/resume-intent.ts", import.meta.url)).text()
    expect(resume).toContain('if (candidate.status === "answered") continue')
    expect(resume).toContain('answered: "أُجيب مباشرة"')
  })

  // سجلّ الإضافات المدموج (فكرتا dsh 5 و12): مصدرٌ واحد للأسماء والافتراضات
  // والنصوص وموضع القراءة؛ فحصٌ مُغلق عند الباب؛ سياج مراجعة وتثبيت من البيئة؛
  // جردٌ لكل دور؛ ولوحةٌ تُولَّد من الوصف لا من حرفٍ مكتوب مرّتين.
  test("every declared toggle is read through the registry — or honestly marked unread — and nothing bypasses the resolver", async () => {
    const desktop = await Bun.file(new URL("../../desktop/ui/index.html", import.meta.url)).text()
    const protocol = await Bun.file(new URL("../../transport-contracts/src/shell-protocol.ts", import.meta.url)).text()
    expect(source).toContain('import { PluginInventory, catalogFor, describePlugins, metaOn, neutralPluginContext, pluginContext, resolvePlugin, resolvePlugins, validatePluginsPatch, type PluginName } from "./plugin-registry"')

    // (أ) لا قراءةً قديمة نجت: صفرُ `loadSettings().plugins?.` في المحرّك كلّه.
    expect(source.match(/loadSettings\(\)\.plugins\?\./gu)).toBeNull()
    expect(source).not.toContain("plugins?.walls")
    expect(source).not.toContain("plugins?.cacheAccounting")

    // (ب) كل مفتاحٍ موصولٍ يُقرأ بموضعه المُعلَن، والمُعلَن بلا قارئ لا يُقرأ أبداً.
    for (const d of PLUGINS) {
      if (d.name === "cacheAccounting") {
        // القراءات خارج الدور: الجرد إن وُجد وإلا المحلّل نفسه (البوّابة)، ونداءُ الاستنتاج
        // الجانبيّ (د3) الذي يحاسب كما تحاسب البوّابة حرفاً — قراءةٌ ثالثة لا رابعة.
        expect(source.match(/pluginOnNow\("cacheAccounting"\)/gu)).toHaveLength(3)
        continue
      }
      if (d.name === "usageMeter") {
        // ذ5: قارئٌ واحد عند النداء داخل meterCall — والمواضعُ الخمسة (البوّابة، الاستنتاج، المرتِّب،
        // النداءُ المفكوك، والبثُّ المحلّيّ) تنادي الدالّة لا المفتاح.
        expect(d.site).toBe("call")
        expect(source.match(/pluginOnNow\("usageMeter"\)/gu)).toHaveLength(1)
        expect(source.match(/meterCall\(prov/gu)).toHaveLength(5)
        continue
      }
      if (d.name === "approvalTakeover") {
        // IDEA 7: بوابة الأثر تعيش فوق نطاق جرد الدور (كـcacheAccounting)،
        // فقارئها `pluginOnNow` — وهو المحلِّل نفسه، لا `!== false` عارية.
        expect(d.site).toBe("call")
        // خمسةُ قرّاء: السؤال، والقرار، والمقاطعة، والإطفاء، **وانتهاءُ
        // المهلة** — وهو مخرجٌ خامسٌ يكتب سطرَ قراره كإخوته، فسؤالٌ انتهت
        // مهلتُه لا يبقى في الدفتر بلا جواب.
        expect(source.match(/pluginOnNow\("approvalTakeover"\)/gu)).toHaveLength(5)
        expect(source).not.toContain("plugins?.approvalTakeover")
        continue
      }
      if (d.name === "denialBreaker") {
        // قارئٌ واحدٌ عند القطع. **والعرضُ بلا مفتاح**: `deniedBefore` يركب
        // كلَّ سؤالٍ سواءٌ اشتغل القاطعُ أم لا — معلومةٌ لا سلوك.
        expect(d.site).toBe("call")
        expect(d.wired).toBe(true)
        expect(source.split('pluginOnNow("denialBreaker")').length - 1).toBe(1)
        expect(source).toContain("deniedBefore })")
        expect(source).not.toContain('pluginOnNow("denialBreaker") ? deniedBefore')
        continue
      }
      if (d.name === "unattendedDeny") {
        // قارئٌ واحدٌ عند نصب المؤقّت. و«الصمتُ ليس إذناً» كانت مكتوبةً في
        // البوّابة بلا آليّة، فالمفتاحُ ينفّذ قاعدةً قائمةً لا يضيف سلوكاً.
        expect(d.site).toBe("call")
        expect(d.wired).toBe(true)
        expect(source.split('pluginOnNow("unattendedDeny")').length - 1).toBe(1)
        // والمؤقّتُ `unref` — مؤقّتٌ حيٌّ يمنع العمليةَ من الخروج (قِيس: exit=124).
        expect(source).toContain("timer.unref?.()")
        continue
      }
      if (d.name === "standingGrants") {
        // قارئان: البوّابةُ تستشير المنح، والسؤالُ يشتقّ النطاقاتِ المعروضة.
        // وثالثٌ عند ترجمة الموافقة إلى منح — فالعددُ ثلاثة، وأيُّ زيادةٍ
        // مسارٌ رابعٌ يمنح بلا أن يُقصد.
        expect(d.site).toBe("call")
        expect(d.wired).toBe(true)
        expect(source.split('pluginOnNow("standingGrants")').length - 1).toBe(3)
        // والمنحُ في الذاكرة وحدها: لا مفتاحَ إعداداتٍ يحمله.
        expect(source).not.toContain('"standingGrants"]')
        continue
      }
      if (d.name === "inboundGuard") {
        // قارئٌ واحدٌ عند **مخرج المُوزِّع الواحد**: للمُوزِّع عشرون `return`،
        // وحراستُها واحدةً واحدةً تُنسى واحدةٌ يوماً — وهي طريقُ الحقن. فيُثبَّت
        // أنّ التغليف قائمٌ وأنّ الخامَ لا يُنادى إلا منه.
        expect(d.site).toBe("call")
        expect(d.wired).toBe(true)
        expect(source.split('pluginOnNow("inboundGuard")').length - 1).toBe(1)
        expect(source).toContain("const result = await dispatchToolRaw(word, body, turnId, hooks, nativeCall)")
        // نداءٌ **واحدٌ** في الملفّ كلِّه — من داخل الغلاف. أيُّ نداءٍ ثانٍ
        // طريقٌ يلتفّ حول الحارس، وهذا العددُ هو ما يمنعه.
        expect(source.split("dispatchToolRaw(").length - 1).toBe(1)
        expect(source).toContain("const dispatchToolRaw = async (word: string")
        continue
      }
      if (d.name === "mcpClient") {
        // قارئٌ واحدٌ عند التوصيل: البوّابةُ تسبق `await import` فلا تُحمَّل
        // وحدةُ العميل وهي مطفأة — «المعطَّل غير محمَّل لا مخفيّ». والترتيبُ
        // جزءٌ من الميزة، فيُثبَّت بموضعَي النصّ لا بوجودهما وحده.
        expect(d.site).toBe("call")
        expect(d.wired).toBe(true)
        expect(source.split('pluginOnNow("mcpClient")').length - 1).toBe(1)
        const guard = source.indexOf('pluginOnNow("mcpClient")')
        const load = source.indexOf('await import("./mind/mcp")')
        expect(guard).toBeGreaterThan(0)
        expect(load).toBeGreaterThan(guard)
        continue
      }
      if (d.name === "delegation" || d.name === "reviewer") {
        // S13.5: قارئهما عند النداء لا عند بدء الدور (كـcacheAccounting/
        // approvalTakeover)، فيقرآن بـ`pluginOnNow` — المحلِّل نفسه، لا
        // `!== false` عارية. delegation قارئان (الإعلان والتوزيع)، وreviewer
        // واحد (ترشيح الكتالوج).
        expect(d.site).toBe("call")
        expect(d.wired).toBe(true)
        // هـ2 (2026-09-07): delegation ثلاثةُ قرّاء — الإعلانُ، وdelegate الفرديّ، وteam المتوازي — كلُّها عند النداء.
        expect(source.split(`pluginOnNow("${d.name}")`).length - 1).toBe(d.name === "delegation" ? 4 : 1)
        expect(source).not.toContain(`plugins?.${d.name}`)
        continue
      }
      if (d.meta === true) continue
      if (d.site === "panel") {
        // موصولٌ في القشرة وحدها: لا قارئ له في المحرّك أصلاً، وتثبيتُه في
        // اختبارَي IDEA 8/9 أدناه على `index.html` لا هنا.
        expect(d.wired).toBe(true)
        expect(source).not.toContain(`plugins.read("${d.name}"`)
        continue
      }
      if (d.wired) expect(source).toContain(`plugins.read("${d.name}", "${d.site}"`)
      else expect(source).not.toContain(`"${d.name}"`)
    }
    expect(source).toContain('...(plugins.read("readCompaction", "epoch", epoch) ? { readCompaction: READ_COMPACTION } : {}),')
    expect(source).toContain('...(plugins.read("trailCompaction", "epoch", epoch) ? { trailCompaction: TRAIL_COMPACTION } : {}),')
    // ولا اسمَ يُقرأ بلا وصف: كل `plugins.read("x"` و`plugins.note("x"`
    // و`pluginOnNow("x"` مسجَّل.
    for (const match of source.matchAll(/(?:plugins\.read|plugins\.note|pluginOnNow)\("(\w+)"/gu)) {
      expect(PLUGINS.map((d) => d.name)).toContain(match[1]!)
    }
    // المفاتيح الحاكمة الثلاثة تُقرأ في كل دور بـmetaOn (خارج المحلِّل)، فتُسجَّل
    // في الجرد — وإلا صنّفتها القشرة «مُعلَن ولم يُقرأ»، وهو عكس الحقيقة تماماً.
    for (const d of PLUGINS) {
      if (d.meta !== true) continue
      expect(source).toContain(`plugins.note("${d.name}", "turn")`)
    }
    expect(source.match(/plugins\.note\(/gu)).toHaveLength(3)
    // الجرد يُبنى مرةً واحدة لكل دور، والسياق يُجمَّد معه.
    expect(source.match(/new PluginInventory\(/gu)).toHaveLength(1)
    expect(source).toContain("const settingsAtTurn = loadSettings()")
    expect(source).toContain("const turnSelection = selectTurnModel(turn.body,currentConversationMode,attached.images.length>0)")
    expect(source).toContain("conversation === 'code' ? 'agent' : selectModelLane(role, input)")
    expect(source).toContain("currentPlugins = plugins")
    expect(source).toContain('if (currentPlugins !== undefined) return currentPlugins.read(name, "call")')

    // (ج) الباب: فحصٌ مُغلق لفضاء الإضافات، وسياج المراجعة، ورقم مراجعةٍ يكتبه المحرّك وحده.
    expect(source).toContain("const pluginsRefusal = validatePluginsPatch(value.plugins, rulesOn)")
    expect(source).toContain("const bumpsRevision = seamOnWrite && Object.prototype.hasOwnProperty.call(patch, \"plugins\")")
    expect(source).toContain("expectedPluginsRevision")
    expect(source).toContain("تعارض إعدادات الإضافات: قرأتَ المراجعة")
    expect(source).toContain('"railPolicy", "routerGate", "gateModel", "plugins"')
    expect(source).not.toContain('"plugins", "pluginsRevision"')
    expect(source).toContain("pluginsRevision?: number")
    // تثبيتٌ مشوَّه من البيئة يُسمَّى مرةً عند الإقلاع ولا يُطبَّق — **على stderr**:
    // stdout في وضع الأُطر هو حاملُ الأُطر نفسه، فسطرٌ نصّيٌّ عليه يُقرأ رأسَ طولٍ
    // (u32) ويهدم القناة قبل ready. لا console.log في قشرة الخدمة أصلاً.
    expect(source).toContain("const warnLine = (line: string): void => { process.stderr.write(`${line}\\n`) }")
    expect(source).toContain("for (const refusal of resolvePlugins(s.plugins, process.env).refusals) warnLine(`[plugins] ${refusal}`)")
    expect(source).toContain("for (const refusal of applyCustomProviders(s.customProviders)) warnLine(`[custom-provider] ${refusal}`)")
    const shellStart = source.indexOf("const framedStdio = process.env.ABDO_FRAMED_STDIO === \"1\"")
    expect(shellStart).toBeGreaterThan(0)
    expect(source.slice(shellStart)).not.toContain("console.log(`[")

    // (د) الأُطر: السجلّ يرافق ready وكل انتقال إعداد يغيّر النموذج أو النمط
    // أو المشروع، إضافة إلى get/set/تعارض. هكذا تبقى القشرة متزامنة بلا
    // نسخة إعدادات ثانية داخل الواجهة.
    // Project creation also emits the canonical settings/registry frame.
    // Both template-backed and empty-folder creation emit canonical settings.
    // Opening an existing project mid-turn (project-open, 2026-09-06) is a project transition too.
    // Connectors (2026-09-06): linking a connector writes its MCP server, and forgetting removes it — both publish canonical settings.
    // 2026-09-13: «browser owned|extension|off» من الشات يحفظ خلفيّة المتصفّح ويبثّ الإعدادات القانونيّة أيضاً.
    // 2026-09-14: «وصّل» على جسر المتصفّح يفعّل عميلَ MCP بنفسه ويبثّ الإعدادات القانونيّة (كان يُرفض بمفتاحٍ لا يعرفه المستخدم).
    expect(source.match(/pluginFrameFields\(/gu)).toHaveLength(14)
    expect(source).toContain("const pluginFrameFields = (s: Settings): Record<string, unknown> => ({")
    // السياق يُمرَّر إلى الوصف: بلا وسيطٍ كانت os تُثبَّت على «other» فتُعرض كلُّ
    // قاعدةٍ على `os == windows` معطَّلةً بينما يقرؤها كلُّ دورٍ مفعَّلة.
    expect(source).toContain("pluginRegistry: describePlugins(s, process.env, neutralPluginContext(process.platform)),")
    expect(source).not.toContain("describePlugins(s, process.env),")
    expect(source).toContain("const stored = describePlugins(beforeWrite, process.env, neutralPluginContext(process.platform))")
    expect(source).toContain('...(metaOn(s.plugins, "inventory") ? { pluginCatalog: catalogFor(s.plugins, metaOn(s.plugins, "rules")) } : {}),')
    const inventoryFrame = source.indexOf('emit({ kind: "plugins", turnId: turn.id, entries: currentPlugins.snapshot(), context: currentPlugins.context })')
    const doneFrame = source.indexOf('emit({ kind: "done", turnId: turn.id, rerun: !completed')
    expect(inventoryFrame).toBeGreaterThan(0)
    expect(inventoryFrame).toBeLessThan(doneFrame)
    expect(source.match(/emit\(\{ kind: "plugins", turnId: turn\.id/gu)).toHaveLength(2)
    expect(protocol).toContain('["settings", "expectedPluginsRevision"], ["settings"]')
    expect(protocol).toContain('{ kind: "plugins", dir: "out", required: ["turnId", "entries"]')

    // (هـ) لا نصَّ يراه النموذج تغيّر: الجرد لا يقترب من الإيصال ولا من مدخل الحقبة.
    expect(source).not.toMatch(/epochInput[^\n]*(?:plugins|inventory|snapshot)/u)
    expect(source).not.toMatch(/forcedReceipt[^\n]*(?:plugins|snapshot)/u)

    // (و) اللوحة: تُولَّد من الإطار بعقدٍ لا بترميزٍ مُحقَن، وتعلن صدقها حين لا محرّك.
    expect(desktop).toContain('if (f.pluginRegistry) pluginRegistry = f.pluginRegistry;')
    expect(desktop.match(/pluginCatalog = f\.pluginCatalog \|\| null;/gu)).toHaveLength(2)
    expect(desktop).toContain('if (f.kind === "plugins") {')
    expect(desktop).toContain('id="pluginsoffline"')
    expect(desktop).toContain("المحرّك غير متصل")
    expect(desktop).toContain('expectedPluginsRevision: pluginRegistry.revision')
    expect(desktop).toContain('rule.dataset.pluginRule = d.name;')
    expect(desktop).toContain("غير موصول بعد — لا قارئ له في المحرّك.")
    // الجرد الوارد يُستهلَك في الشارة — لا حالةً ميتة تُخزَّن ولا تُقرأ.
    expect(desktop).toContain("const lastRead = ((lastPluginInventory && lastPluginInventory.entries) || []).find((e) => e.name === d.name);")
    const renderStart = desktop.indexOf("const renderPluginRows = () => {")
    const renderEnd = desktop.indexOf("const pluginsPatchFromPanel = () => {")
    expect(renderStart).toBeGreaterThan(0)
    expect(renderEnd).toBeGreaterThan(renderStart)
    expect(desktop.slice(renderStart, renderEnd)).not.toContain("innerHTML")
    // إطار الجرد يُعالَج قبل done فلا يبتلعه settle.
    expect(desktop.indexOf('if (f.kind === "plugins") {')).toBeLessThan(desktop.indexOf('if (f.kind === "done") {'))
    // (ز) صدقُ اللوحة: صفٌّ قيمتُه شرطٌ لا يُعلَن له بوليانٌ «نافذٌ الآن» (سياق
    // الدور لا يُعرف خارج دور)، ومربّعه يحمل ما سيُكتب لو مُسح الشرط لا القيمة
    // المحسوبة في سياقٍ محايد — وإلا كتب مسحُ الشرط تعطيلَ إضافةٍ نافذة.
    expect(desktop).toContain('const isRule = cat ? cat.configured === "rule" : !!(storedValue && typeof storedValue === "object");')
    expect(desktop).toContain('(isRule ? "حسب سياق الدور" : (effective ? "مفعَّل" : "معطَّل"))')
    expect(desktop).toContain("box.checked = isRule ? (typeof storedValue === \"boolean\" ? storedValue : !!d.defaultOn) : effective;")
    expect(desktop.slice(renderStart, renderEnd)).not.toContain("box.checked = effective;")
    // (ح) إطار الجرد يحدّث ذيل العدّاد وحده — إعادة البناء الكاملة كانت تمحو
    // تحرير اللوحة غير المحفوظ في آخر كل دور.
    expect(desktop).toContain("if (pluginNoteBase.size) refreshPluginReads(); else renderPluginRows();")
    expect(desktop).toContain("const refreshPluginReads = () => {")
    expect(desktop).toContain("small.dataset.pluginNote = d.name;")
    // إعادةُ البناء الكاملة تبقى لأُطر ready/settings وحدها.
    expect(desktop.match(/renderPluginRows\(\);/gu)).toHaveLength(3)
  })

  // IDEA 2 — حقل النيّة ودروس المخالفة (plugins.intentField). كلّ قفزةٍ في
  // السلسلة مثبَّتة: المفتاح، الخطّافات، المخطّطات، المُوجِّه، الدفتر، الحفظ،
  // السطر المضيف، وحقلُ الحقبة — وإسقاطُ أيّها يسقط هذا الاختبار.
  test("the intent field is wired behind plugins.intentField, defaults OFF, and OFF constructs nothing", async () => {
    const intentField = await Bun.file(new URL("../src/intent-field.ts", import.meta.url)).text()
    const loop = await Bun.file(new URL("../../engine-host/src/text-agent-loop.ts", import.meta.url)).text()
    const desktop = await Bun.file(new URL("../../desktop/ui/index.html", import.meta.url)).text()

    // (أ) المفتاح: يُقرأ مرةً لكل دور عبر السجلّ، وافتراضه معطَّل (يسري من الدور القادم).
    expect(source).toContain('const intentOn = plugins.read("intentField", "turn")')
    expect(source).not.toContain("plugins?.intentField")
    expect(PLUGINS.find((d) => d.name === "intentField")).toMatchObject({ defaultOn: false, site: "turn", wired: true, applies: "next-turn" })
    // لا صفَّ ثابتاً في القشرة: الصفوف تُولَّد من الوصف كبقيّة المفاتيح.
    expect(desktop).not.toContain('data-plugin="intentField"')

    // (ب) المعطَّل لا يبني شيئاً: الخيار والخطّافات والدفتر كلّها انتشارٌ مشروط.
    expect(source.match(/\.\.\.\(intentOn \? \{ intentField: true \} : \{\}\)/gu)).toHaveLength(2)
    expect(source).toContain("const intentLedger = intentOn ? new IntentLedger() : undefined")
    expect(source).toContain("intentLedger?.reset()")

    // (ج) النقل: الوسيط الأخير يصل الخطّافين، والإطار يحمل النيّة حين تُذكر فقط.
    expect(source).toContain("onTool: (cmd, intent) => {")
    expect(source).toContain("onToolResult: (cmd, output, verdict, idempotencyKey, mutated, intent)")
    expect(source).toContain('emit({ kind: "tool", turnId: turn.id, cmd, epoch, ...(intentOn && intent ? { intent } : {}) })')
    expect(loop).toContain("readonly onToolResult?: (command: string, output: string, verdict?: ToolVerdict, idempotencyKey?: string, mutated?: true, intent?: string) => void")

    // (د) المخطّطات والمُوجِّه والمدقّق كلّها بحال المفتاح لا بحالٍ ثانٍ.
    expect(source).toContain("nativeToolDefinition(tool, hooks.intentField === true)")
    expect(source).toContain("nativeToolReply(decoded, legalToolNames, hooks.intentField === true)")
    expect(source).toContain('nativeAgentSystem(planningPhase, process.env.ABDO_REQUIRE_SPRINT_PLAN === "1", hooks.intentField === true, policy)')
    expect(source).toContain('(hooks.intentField === true ? intentInstruction() : "") +')

    // (هـ) الدرس يُقطَّر ويُحفظ حقيقةً دائمة، والحلّ معه — بمسارٍ واحد لا مسارين.
    expect(source).toContain("const learned = intentLedger?.observe(cmd, intent, output, verdict)")
    expect(source).toContain("for (const distilled of [learned?.lesson, learned?.resolved]) {")
    expect(source).toContain("remember({ projectId: resolve(PROJECT_DIR), sessionId: turn.id, kind: distilled.kind, key: distilled.key, value: distilled.value, sourceEventIds: [`turn:${turn.id}:epoch:${epoch}`] })")

    // (و) قيدُ الجدران والمعدِّن نفسه: إيصالات run وحدها تُقطَّر — القيد في الوحدة الخالصة.
    expect(intentField).toContain("const RUN_RECEIPT = /^run\\b/iu")
    expect(intentField.match(/RUN_RECEIPT\.test\(command\)/gu)).toHaveLength(2)

    // (ز) السطر المضيف بجوار سطر الأحكام، وحقلُ الحقبة بجوار تغطيتها — ولا شيء منهما
    // يدخل نصّاً يراه النموذج (الدروس تصل عبر استرجاع الحقبة الأولى القائم وحده).
    const verdictLine = source.indexOf("if (ledger !== undefined) await emitEvent(turn.id, ledger.line(epoch))")
    const intentLine = source.indexOf("if (intentLedger !== undefined) await emitEvent(turn.id, intentLedger.line(epoch))")
    expect(verdictLine).toBeGreaterThan(0)
    expect(intentLine).toBeGreaterThan(verdictLine)
    expect(source).toContain("...(intentLedger !== undefined ? { intents: intentLedger.snapshot() } : {}),")
    expect(source).not.toMatch(/epochInput[^\n]*intent(?:Ledger|Field)/u)
    expect(source).not.toMatch(/forcedReceipt[^\n]*intent(?:Ledger|Field)/u)
    // Both recall sites (gate path and work path) now rank by meaning through the selected
    // provider and report how the memories were chosen; the lexical brief is the fallback inside.
    expect(source.match(/await semanticMemory\.recall\(\{facts,query:effectiveGoal,/gu)).toHaveLength(2)
    expect(source.match(/emit\(\{kind:'memory-recall',turnId:turn\.id,method:result\.method,candidates:result\.candidates,selected:result\.selected\}\)/gu)).toHaveLength(2)
    // ولا حلقة ثانية: القفزة كلّها داخل النداء الواحد القائم.
    expect(source.match(/runTextAgentLoop\(\{/gu)).toHaveLength(1)
  })

  // مفرداتٌ واحدة: السبب من اتحاد ToolVerdictReason لا من حرفٍ محلّيّ.
  test("the distiller borrows the verdict vocabulary instead of inventing one", async () => {
    const intentField = await Bun.file(new URL("../src/intent-field.ts", import.meta.url)).text()
    expect(intentField).toContain('import { REASONS, verdictIsBreakage, type ToolVerdict, type ToolVerdictReason } from "@abdo/engine-host"')
    expect(intentField).toContain('export const INFERRED_REASON: ToolVerdictReason = "tool_failed"')
    expect(intentField).toContain("if (!REASONS.includes(INFERRED_REASON)) throw new Error")
    // ولا سببَ ثانياً مكتوباً بيدٍ: الحرف الوحيد هو الاحتياطيّ المُعلَن.
    const literals = [...intentField.matchAll(/"(nonzero_exit|timeout|policy_denied|guard_refused|tool_failed|unknown_tool)"/gu)].map((m) => m[1])
    expect([...new Set(literals)]).toEqual(["tool_failed"])
    // والحجب من المفردات القائمة لا من قاموسٍ ثانٍ.
    expect(intentField).toContain('import { redactSecretValues, sweepResidualSecrets } from "./secret-command-guard"')
  })

  // IDEA 7 — استيلاء الموافقة + زوج «سُئل/قُرِّر» الدائم. كلّ قفزةٍ مثبَّتة:
  // المفتاح، ترتيبُ السطر قبل الإطار، ترتيبُ القرار قبل الحلّ، والسجلّ الجديد
  // للموافقة المعلّقة. وإسقاطُ أيّها يسقط هذا الاختبار.
  test("the approval ask/decide pair is journalled before the frame and before the resolve — and interrupt resolves ALWAYS", async () => {
    const desktop = await Bun.file(new URL("../../desktop/ui/index.html", import.meta.url)).text()
    const shellApproval = await Bun.file(new URL("../src/shells/approval.ts", import.meta.url)).text()
    const approvalMount = await Bun.file(new URL("../src/shells/approval-mount.ts", import.meta.url)).text()
    expect(source).toContain('import { approvalAskedLine, approvalDecidedLine } from "./approval-ledger"')

    // (أ) السجلّ: الموافقة المعلّقة تحمل نصّ الطلب وصنفَه — الدالّة العارية ماتت.
    expect(source).toContain("const pendingApprovals = new Map<string, {")
    expect(source).not.toContain("new Map<string, (ok: boolean) => void>()")
    // الإطفاء رابعُ المخارج: كان `entry.resolve(false)` عارياً فيترك في الدفتر
    // الدائم سؤالاً بلا جواب إلى الأبد — في الحالة عينها التي وُجد لأجلها.
    // الانتزاع يسبق الإجهاض (وإلّا ابتلع مستمعُ `abort` سطرَ القرار)، ثم
    // يُكتب القرار قبل الحلّ.
    expect(source).not.toContain("for (const entry of pendingApprovals.values()) entry.resolve(false)")
    expect(source).toMatch(
      /const stranded = \[\.\.\.pendingApprovals\.entries\(\)\]\r?\n\s+pendingApprovals\.clear\(\)\r?\n\s+running\.controller\.abort\(\)\r?\n\s+for \(const \[strandedTurn, entry\] of stranded\) \{\r?\n\s+if \(pluginOnNow\("approvalTakeover"\)\) \{\r?\n\s+try \{ await emitEvent\(strandedTurn, approvalDecidedLine\(\{ request: entry\.request, decision: "interrupted" \}\)\) \}\r?\n\s+catch \{[^\n]*\}\r?\n\s+\}\r?\n\s+entry\.settle\?\.\(\)\r?\n\s+entry\.resolve\(false\)/u,
    )

    // (ب) السؤال يُكتب **قبل** الإطار — ترتيبٌ بالفهرس لا بالحضور وحده.
    const askedLine = source.indexOf("await emitEvent(turnId, approvalAskedLine({ request: what, cls: kind, mode: currentMode }))")
    const approvalEmit = source.indexOf('emit({ kind: "approval", turnId, request: what, class: kind, mode: currentMode, ')
    expect(askedLine).toBeGreaterThan(0)
    expect(approvalEmit).toBeGreaterThan(askedLine)
    // وفشلُ الدفتر لا يمنع السؤال: الإطار خارج الـtry، والوعد يُعقد بعده.
    expect(source).toContain("catch { /* الدفتر مساعِد لا حاكم — السؤال يُعرض ولو لم يُكتب */ }")
    // الهدفُ يُحفظ مع السؤال: بدونه لا يُعرف **ما** يُمنح عند الموافقة، ولا
    // يُشتقّ من نصّ السؤال — نصٌّ حرٌّ يُشتقّ منه إذنٌ أوسعُ الأبواب.
    expect(source).toContain("pendingApprovals.set(turnId, { resolve, request: what, class: kind, settle, ...(target === undefined ? {} : { target }) })")

    // (ب٢) العطل المقيس: كتابةُ الدفتر `await` — أي تسليمٌ للخيط إلى حلقة
    // الأُطر — كانت تسبق تسجيلَ الوعد، فمقاطعةٌ واقفةٌ في الرتل تقرأ سجلّاً
    // فارغاً فلا تجد ما تحسمه، ويعلّق الدور على موافقةٍ لا حلَّ لها أبداً
    // (أُثبت حيّاً: `done` لا يصل، وثانيةٌ وحدها تحرّره). القاعدة المثبَّتة:
    // **لا `await` في `gate()` قبل كتابة السجلّ**، ودورٌ مُجهَض لا يسأل أصلاً.
    const gateStart = source.indexOf("const gate = async (turnId: string,")
    const gateBody = source.slice(gateStart, source.indexOf("const insideProject", gateStart))
    expect(gateStart).toBeGreaterThan(0)
    expect(gateBody).toContain("const abort = running !== undefined && running.turnId === turnId ? running.controller.signal : undefined")
    // مرّتان: قبل السؤال أصلاً، وبعد عودة الخيط من كتابة الدفتر. ونداءً لا
    // تعبيراً — التضييق الثابت كان يعتبر الثاني مستحيلاً وهو المقصود.
    expect(gateBody).toContain("const aborted = (): boolean => abort?.aborted === true")
    // ثلاثةٌ منذ المنح القائم: اثنتان في مسار السؤال، وثالثةٌ **بعد** انتظار
    // الدفتر في فرع المنح — دورٌ قُوطع أثناءها كان سينفّذ الأثرَ بإذنٍ سابق.
    // هـ٢+ (2026-09-07): رابعٌ مقصود: انتظارُ مقعدِ رتل الأسئلة يُسلِّم الخيط، فدورٌ قُوطِع أثناءه لا يسأل؛ والمقعدُ يُخلى قبل الرفض وإلّا انتظر الطفلُ التالي أبداً (هـ٢+ 2026-09-07).
    expect(gateBody.match(/if \(aborted\(\)\) (?:return false|\{ releaseApproval\(\); return false \})/gu)).toHaveLength(4)
    expect(gateBody).toContain('abort?.addEventListener("abort", () => {')
    // فرعُ المنح يعود قبل مسار السؤال ولا يعقد وعداً، فقاعدةُ «لا انتظارَ قبل
    // تسجيل الوعد» تُقاس على **مسار السؤال** لا على الجسم كلِّه — وإلّا صارت
    // تمنع إعلاناً لا وعدَ فيه. والدقّةُ هنا تشديدٌ لا تخفيف: الفرعُ نفسُه
    // مُلزَمٌ بإعادة فحص المقاطعة بعد انتظاره، وهو مثبَّتٌ بالعدد أعلاه.
    const askPath = gateBody.slice(gateBody.indexOf("// ask: كتلة موافقة"))
    const mapWrite = askPath.indexOf("pendingApprovals.set(turnId,")
    const firstAwait = askPath.indexOf("await ")
    expect(mapWrite).toBeGreaterThan(0)
    expect(firstAwait).toBeGreaterThan(mapWrite)
    // والفرعُ يقف قبل مسار السؤال فعلاً — لا يتداخلان.
    expect(gateBody.indexOf("StandingGrants.covers(")).toBeLessThan(gateBody.indexOf("// ask: كتلة موافقة"))
    // والإشارةُ نفسها تحسم الوعد رفضاً إن قُطع الدور ونحن ننتظر الدفتر.
    // والمقاطعةُ تُلغي مؤقّتَ المهلة معها — كلُّ خروجٍ من الانتظار ينادِيه.
    expect(gateBody).toContain("if (pendingApprovals.get(turnId)?.resolve === resolve) { pendingApprovals.delete(turnId); settle(); resolve(false) }")

    // (ب٣) وفي المقاطعة: انتزاعُ السجلّ **قبل** الإجهاض. لو انعكس الترتيب
    // لتنحّى المستمعُ بالحلّ وحده وضاع سطرُ القرار من الدفتر بلا صوت.
    const interruptStart = source.indexOf('if (frame.kind === "interrupt") {')
    const interruptBody = source.slice(interruptStart, source.indexOf('if (frame.kind === "steer") {', interruptStart))
    expect(interruptStart).toBeGreaterThan(0)
    const grab = interruptBody.indexOf("pendingApprovals.get(target)")
    const abortCall = interruptBody.indexOf("running.controller.abort()")
    expect(grab).toBeGreaterThan(0)
    expect(abortCall).toBeGreaterThan(grab)

    // (ب٤) محادثةٌ جديدة لا تُلقي دوراً جارياً خلف ظهرها: كانت تترك موافقةً
    // معلّقةً ومقعداً حيّاً في محادثةٍ طُويت، فتنفّذ نقرةُ ✓ كتابةَ دورٍ هُجر.
    const sessionNew = source.indexOf('if (frame.kind === "session-new") {')
    const sessionBody = source.slice(sessionNew, source.indexOf("currentSession = `s-${Date.now()}`", sessionNew))
    expect(sessionNew).toBeGreaterThan(0)
    expect(sessionBody).toContain("if (running !== undefined) {")
    expect(sessionBody).toContain("اقطعه قبل بدء محادثةٍ جديدة")

    // (ج) القرار يُكتب **قبل** الحلّ، فيسبق تسلسلُه إيصالَ الأثر المسموح.
    const decidedLine = source.indexOf('approvalDecidedLine({ request: entry.request, decision: frame.kind === "approve" ? "approved" : "denied" })')
    const resolveCall = source.indexOf('entry.resolve(frame.kind === "approve")')
    expect(decidedLine).toBeGreaterThan(0)
    expect(resolveCall).toBeGreaterThan(decidedLine)

    // (د) قرار المالك المنفَّذ: المقاطعة تحسم الموافقة المعلّقة رفضاً في
    // الحالتين — `pending.resolve(false)` **خارج** حارس المفتاح. لو انزلق
    // داخله لعاد تعليقُ الوعد على المقاطعة عيباً حيّاً مع المفتاح المطفأ.
    expect(source).toMatch(
      /if \(pluginOnNow\("approvalTakeover"\)\) \{\r?\n\s+try \{ await emitEvent\(target!, approvalDecidedLine\(\{ request: pending\.request, decision: "interrupted" \}\)\) \}\r?\n\s+catch \{[^\n]*\}\r?\n\s+\}\r?\n\s+pending\.resolve\(false\)/u,
    )
    expect(source).toContain("const pending = typeof target === \"string\" ? pendingApprovals.get(target) : undefined")

    // (هـ) القشرة: المقعد لم يعد مكتوباً ثابتاً في الصفحة — يُبنى في مِرساة
    // شريط المؤلِّف عند التسجيل ويُهدَم عند الفكّ (IDEA 6). إعادةُ تصليبه في
    // `index.html` تُسقط هذا الاختبار: المِرساة تبقى فارغةً في الشحن.
    expect(desktop).toContain('<div id="slot-composer-bar" data-anchor="composer.bar"></div>')
    expect(desktop).not.toContain('<div id="approvalseat" hidden>')
    expect(approvalMount).toContain('anchor: "composer.bar"')
    expect(approvalMount).toContain('feature: "approvalTakeover"')
    expect(approvalMount).toContain('node.id = "approvalseat"')
    expect(desktop).toContain('#composer.approving > #prompt, #composer.approving > .row { display: none; }')
    // الاستيراد داخل الحارس ومرّةً واحدة: المعطَّل لا يُطلب ملفُّه من القرص.
    const approvalWanted = desktop.indexOf('const approvalWanted = pluginOn("approvalTakeover");')
    const approvalGuard = desktop.indexOf("if (approvalWanted && Approval === null) {", approvalWanted)
    const approvalLoad = desktop.indexOf('await import("./approval-mount.js")', approvalGuard)
    expect(approvalWanted).toBeGreaterThan(0)
    expect(approvalGuard).toBeGreaterThan(approvalWanted)
    expect(approvalLoad).toBeGreaterThan(approvalGuard)
    expect(approvalLoad - approvalGuard).toBeLessThan(120)
    expect(desktop.match(/import\("\.\/approval-mount\.js"\)/gu)).toHaveLength(1)
    expect(desktop).not.toMatch(/<script[^>]+approval(?:-mount)?\.js/u)
    // والإطفاء يفكّ فعلاً — لا «محمولٌ ومُهمَل».
    expect(desktop).toContain('slots.unregisterFeature("approvalTakeover");')
    // ومقعدٌ مشغولٌ لا يُنتزع من تحت المشغّل: الفكّ يُؤجَّل حتى يسكن.
    expect(desktop).toContain('} else if (!approvalWanted && Approval !== null && Approval.pendingTurn(approvalStore) === undefined) {')
    expect(desktop).toContain("if (folded.settled !== undefined) void syncShellPlugins();")
    expect(desktop).toContain('if (Approval !== null && approvalStore.state.kind === "asked") { approvalAct("deny"); e.preventDefault(); return; }')
    // المعطَّل = الكتلة القديمة بحرفها: الترميز الأصلي لم يُحذف ليمرّ اختبار.
    expect(desktop).toContain('row.innerHTML = \'<button class="apv">✓ اسمح</button><button class="dny">✕ ارفض</button>\';')

    // (ز) المعاينة تصل المقعد فعلاً: إطار `diff` لم يكن يُطوى أبداً، فراية
    // `diffSeen` مطفأةٌ دائماً وزرُّ «المعاينة» ميّتٌ في القشرة المشحونة —
    // واختبارُ المُخفِّض أخضرُ فوق وصلةٍ مقطوعة (يبقى أخضر لو حُذف الربط).
    const diffBranch = desktop.indexOf('if (f.kind === "diff") {')
    const approvalBranch = desktop.indexOf('if (f.kind === "approval") {')
    expect(diffBranch).toBeGreaterThan(0)
    expect(approvalBranch).toBeGreaterThan(diffBranch)
    expect(desktop.slice(diffBranch, approvalBranch)).toContain("approvalFold(f);")

    // (ح) الاستيلاء يُقاس بالقيمة النافذة لا بكون الوحدة محمَّلة: تفريغُ
    // الوحدات غير ممكن، فمفتاحٌ أُطفئ كان يترك القشرة مستولية والمحرّك لا
    // يكتب سطر القرار — فيعلق المقعد في «يُقرَّر» والمؤلِّف مقفلٌ حتى المقاطعة.
    expect(desktop).toContain('if (Approval !== null && (pluginOn("approvalTakeover") || Approval.pendingTurn(approvalStore) !== undefined)) {')

    // (ط) التصفير معلَّقٌ على إطار المحرّك لا على النقرة، والموافقة ثالثةُ
    // المخازن الثلاثة — كانت تُنسى، فتُفتح محادثةٌ ومقعدٌ حيٌّ من سابقتها.
    expect(desktop).toContain('clearFeed(); activityReset(); notice(""); refreshSessions();')
    // وتصفيرُه يُسكِن المقعد، فيستأنف كلَّ فكٍّ أُجّل لانشغاله (IDEA 6).
    expect(desktop).toContain(
      "if (Approval !== null) { approvalStore = Approval.empty(); renderApproval(); void syncShellPlugins(); }",
    )
    expect(desktop).toContain('el("newchat").onclick = () => Promise.resolve(window.AbdoDesktopShell?.api.chatWork?.newSession() ?? sendFrame({ kind: "session-new" })).catch(err => notice(String(err)));')
    // (و) مفرداتٌ واحدة: القشرة تطوي على البادئة المُصدَّرة لا على حرفٍ ثانٍ.
    expect(shellApproval).toContain('import { APPROVAL_DECIDED_PREFIX, decisionOfLine, type ApprovalDecision } from "../approval-ledger"')
    expect(shellApproval).not.toContain('"🔐 قرار الموافقة: "')
    expect(registrySource).toContain('name: "approvalTakeover"')
    expect(PLUGINS.find((d) => d.name === "approvalTakeover")).toMatchObject({ defaultOn: true, site: "call", wired: true })
  })

  // IDEA 8 — لسان المسار: قشرةٌ خالصة، صفرُ لمسٍ للمحرّك، وتحميلٌ داخل الحارس.
  test("the trajectory tab is shell-only, lazily imported behind its toggle, and labels a replayed turn", async () => {
    const desktop = await Bun.file(new URL("../../desktop/ui/index.html", import.meta.url)).text()
    const prepare = await Bun.file(new URL("../../desktop/scripts/prepare.ts", import.meta.url)).text()
    const trajectoryMount = await Bun.file(new URL("../src/shells/trajectory-mount.ts", import.meta.url)).text()
    // (أ) صفرُ أثرٍ في المحرّك: لا قارئ ولا اسم في cli.ts.
    expect(source).not.toContain("trajectory")
    expect(PLUGINS.find((d) => d.name === "trajectory")).toMatchObject({ defaultOn: true, site: "panel", wired: true })
    // (ب) اللسان والمنظر: ميزةٌ واحدة، مساهمتان في مِرساتين (IDEA 6). لا
    // شجرةَ ميزةٍ مكتوبةً في الصفحة — مكانَ كلٍّ منهما مِرساةٌ فارغة.
    expect(desktop).toContain('<button id="chattab" class="active">محادثة</button>')
    expect(desktop).toContain('<span id="slot-tab-strip" data-anchor="tab.strip"></span>')
    expect(desktop).toContain('<div id="slot-transcript-node" data-anchor="transcript.node"></div>')
    expect(desktop).not.toContain('<button id="trajtab" hidden>مسار</button>')
    expect(desktop).not.toContain('<section id="trajectory" hidden aria-label="مسار الدور">')
    expect(trajectoryMount).toContain('anchor: "tab.strip"')
    expect(trajectoryMount).toContain('anchor: "transcript.node"')
    expect(trajectoryMount).toContain('node.id = "trajtab"')
    expect(trajectoryMount).toContain('node.setAttribute("aria-label", "مسار الدور")')
    // والمستمعُ المستعار على لسان المحادثة يمرّ بـ`bind` فيُنزع عند الفكّ:
    // كان `onclick` على عقدةٍ لا تملكها الميزة، فيبقى بعد «الإطفاء».
    expect(trajectoryMount).toContain('bind(deps.chatTab, "click", () => deps.showChat())')
    // والفكّ لا يردّ المحادثة إلّا إن كان المنظرُ هو المعروض، وإلى ما قيس
    // **قبل** التركيب — لا إلى «معروضة» مكتوبةٍ بيد تكشف ما أخفاه غيرُه.
    expect(trajectoryMount).toContain("const showing = node.hidden !== true")
    expect(trajectoryMount).toContain("if (showing) deps.restoreChat()")
    expect(desktop).toContain(
      "const feedHidden = feedNode.hidden, chatActive = chatTabNode.classList.contains(\"active\");",
    )
    expect(desktop).toContain(
      'restoreChat: () => { feedNode.hidden = feedHidden; chatTabNode.classList.toggle("active", chatActive); },',
    )
    expect(desktop).not.toContain('restoreChat: () => { el("feed").hidden = false;')
    expect(desktop).not.toContain('el("chattab").onclick = () => trajShow(false);')
    expect(desktop).not.toContain('el("trajtab").onclick =')
    expect(desktop).not.toContain('el("trajturn").onchange =')
    const trajWanted = desktop.indexOf('const trajWanted = pluginOn("trajectory");')
    const trajGuard = desktop.indexOf("if (trajWanted && Trajectory === null) {", trajWanted)
    const trajLoad = desktop.indexOf('await import("./trajectory-mount.js")', trajGuard)
    expect(trajWanted).toBeGreaterThan(0)
    expect(trajGuard).toBeGreaterThan(trajWanted)
    expect(trajLoad).toBeGreaterThan(trajGuard)
    expect(trajLoad - trajGuard).toBeLessThan(120)
    expect(desktop.match(/import\("\.\/trajectory-mount\.js"\)/gu)).toHaveLength(1)
    expect(desktop).not.toMatch(/<script[^>]+trajectory(?:-mount)?\.js/u)
    expect(desktop).toContain('slots.unregisterFeature("trajectory");')
    // (ج) الطيّ يسبق كلّ فرعٍ في onFrame — لا يُعاد بناء اللسان من عقد الشاشة.
    const parse = desktop.indexOf("let f; try { f = JSON.parse(raw); } catch { return; }")
    const trajFold = desktop.indexOf("trajStore = Trajectory.fold(trajStore, f, Date.now())")
    const readyBranch = desktop.indexOf('if (f.kind === "ready") {')
    expect(parse).toBeGreaterThan(0)
    expect(trajFold).toBeGreaterThan(parse)
    expect(trajFold).toBeLessThan(readyBranch)
    // (د) الصمت يُسمّى: دورٌ بأحداثٍ فقط يُعلَن، لا يُترك يوهم بصفر أدوات.
    expect(desktop).toContain("أُعيد من السجلّ: أحداثٌ فقط")
    expect(desktop).toContain("if (turn.eventsOnly) {")
    // (هـ) البناء: حزمةٌ واحدة لكل ميزة تحمل مُخفِّضها الخالص ومساهمتها معاً
    // (جلبةٌ واحدة عند التفعيل، وصفرٌ عند الإطفاء)، والحزمة القديمة زالت.
    for (const module of ["approval", "trajectory", "deliverables"]) {
      expect(prepare).toContain(`"shells", "${module}-mount.ts"`)
      expect(prepare).toContain(`"ui", "${module}-mount.js"`)
      const generated = await Bun.file(new URL(`../../desktop/ui/${module}-mount.js`, import.meta.url)).text()
      expect(generated).toContain(`exports_${module}`)
      expect(generated).toContain(`exports_${module}_mount`)
      expect(await Bun.file(new URL(`../../desktop/ui/${module}.js`, import.meta.url)).exists()).toBe(false)
    }
    // والآليّة نفسها تُبنى وتُستورد ساكنةً: لا مفتاح لها — الآليّة ليست خياراً.
    expect(prepare).toContain(`"shells", "slot-host.ts"`)
    expect(prepare).toContain(`"ui", "slot-host.js"`)
    expect(desktop).toContain('import { SlotHost, ANCHORS } from "./slot-host.js";')
  })

  // IDEA 9 — المسلَّمات: من الحكم الصريح وحده، ومفردةُ «أين» واحدة لا اثنتان.
  test("locations ride the two tool-result emits behind their toggle, reuse turn-memory's vocabulary, and the dead activity toggle is finally obeyed", async () => {
    const desktop = await Bun.file(new URL("../../desktop/ui/index.html", import.meta.url)).text()
    const toolLocations = await Bun.file(new URL("../src/tool-locations.ts", import.meta.url)).text()
    const turnMemory = await Bun.file(new URL("../src/turn-memory.ts", import.meta.url)).text()
    const editMatch = await Bun.file(new URL("../src/edit-match.ts", import.meta.url)).text()
    // (أ) المفتاح بجوار أخيه، ويُقرأ مرةً لكل دور.
    expect(source).toContain('const deliverablesOn = plugins.read("deliverables", "turn")')
    expect(source).toContain('import { locationsFromReceipt } from "./tool-locations"')
    // (ب) الموضعان كلاهما — كما تُثبَّت `allReceipts.push` في موضعَيها.
    expect(source.match(/\.\.\.\(deliverablesOn \? \{ locations: locationsFromReceipt\(/gu)).toHaveLength(2)
    expect(source).toContain("...(deliverablesOn ? { locations: locationsFromReceipt(command, output, verdict) } : {})")
    expect(source).toContain("...(deliverablesOn ? { locations: locationsFromReceipt(cmd, output, verdict) } : {})")
    // (ج) مفردةٌ واحدة: لا تعبير كتابةٍ ثانٍ ولا تعبير خادمٍ ثانٍ.
    expect(toolLocations).toContain('import { SERVED_URL_RE, writeTargetOf } from "./turn-memory"')
    expect(toolLocations).not.toContain("تحت إدارة النواة")
    expect(toolLocations).not.toContain('replace(/^(?:write|edit)')
    expect(turnMemory).toContain("export const writeTargetOf")
    expect(turnMemory).toContain("export const SERVED_URL_RE")
    expect(turnMemory).toContain("const file = writeTargetOf(cmd)")
    // وفرعُ الخادم مثبَّتٌ على إيصال `run` وحده (إصلاح 2026-09-03): كان يطابق
    // الناتج بلا أيّ نصِّ أمر، فناتجٌ يؤلّفه نموذج يمنح «حقيقةً مثبتة».
    expect(turnMemory).toContain("const served = fromRun ? output.match(SERVED_URL_RE) : null")
    expect(turnMemory).toContain("const fromRun = /^run\\s/iu.test(cmd)")
    // والفاصل هو فاصلُ المُحلّل نفسه: `"::"` عارياً كما يقطع به `edit-match`،
    // لا `/\s+::/`. الصيغة المقبولة بلا فراغ كانت تسمّي الصفَّ `<ملف>::قديم`
    // — مساراً لم يُكتب ولا وجود له، ومفتاحَ ذاكرةٍ مشوّهاً معه.
    expect(turnMemory).toContain('.split("::", 1)[0]!.trim()')
    expect(turnMemory).toContain("beforeSeparator.split(/\\s+/, 1)[0]!")
    expect(turnMemory).not.toContain(".split(/\\s+::/, 1)")
    // S13.5: التحليلُ انتقل إلى وحدةٍ خالصة (`edit-match`) مع إصلاح عيب
    // «أوّل موضعٍ بصمت» — والفاصلُ هو هو (`"::"` عارياً)، فيبقى `writeTargetOf`
    // متّفقاً معه. الحرفُ يتبع المحلِّل حيث انتقل، ولا يُحذف.
    expect(source).toContain("const plan = parseEditCommand(rest)")
    expect(editMatch).toContain('const cut = body.indexOf("::")')
    // (ج٢) وبادئةُ التخطّي مثبَّتةٌ على **منتجِها** لا على نفسها: تغييرُ نصّ
    // الإيصال في `cli.ts` كان يقلب «تُخطّى» إلى «كُتب» والسويتُ خضراء —
    // ملفٌّ لم يتغيّر يُعرض كتابةً جديدة. صنفُ الانحراف الذي يحرسه هذا الملف.
    expect(toolLocations).toContain(`export const SKIPPED_WRITE_PREFIX = "${SKIPPED_WRITE_PREFIX}"`)
    expect(source).toContain("okText(`" + SKIPPED_WRITE_PREFIX + "${target}: ")
    // (ج٣) مسارُ السقوط: يقتل خوادمه ويحمل اسم دوره — بدونهما بقي صفُّ
    // «حيّ» يعِد برابطٍ لا مالك له حتى يقتله دورٌ آخر بـstopAll() العامّة.
    // المساران يقتلان خوادمهما **بالشرط نفسِه** — مفتاحُ لوح الخوادم. مطفأً
    // السلوكُ القديم حرفياً على المسارين؛ ومشتعلاً تبقى بين الأدوار ليكون
    // للّوح ما يعرضه. وشرطان مختلفان بين النجاح والسقوط كانا يعنيان خادماً
    // ينجو من دورٍ ويموت في آخر بلا قاعدةٍ يفهمها المشغّل.
    // Chat does not kill a Code server; both Code settlement paths retain the
    // same existing serversPanel lifetime rule.
    expect(source.match(/const stoppedServers = modeAtTurn==='chat' \|\| pluginOnNow\("serversPanel"\) \? undefined : turnServers\.stopAll\(\)/gu)).toHaveLength(2)
    // والدَّينُ الذي رفعُ العمر يوجبه مدفوعٌ عند الخروج الخامل: خروجٌ بلا قتلٍ
    // يترك خادماً يعمل بلا أبٍ ولا لوحةٍ تراه.
    expect(source).toContain("const orphans = turnServers.stopAll()")
    expect(source.slice(source.indexOf("const orphans = turnServers.stopAll()"))).toContain("process.exit(0)")
    expect(source).toContain('emit({ kind: "refused", turnId: turn.id, why: failureText')
    expect(source).toContain("providerFailure?.publicMessage(settingsAtTurn.language)")
    expect(source).toContain("await serveJournal.fail(turn.id, failureText)")
    // والقشرة تطوي ذلك الرفض: بلا هذا الطيّ يبقى الإصلاح في المحرّك وحده،
    // والصفُّ يقول «حيّ» إلى الأبد لأن مسار السقوط لا يصل `done` أبداً.
    // ورُفضٌ يردّ مسوّدةَ الاتصالات معه: خادمٌ أُضيف ورُفضت رقعتُه كان يبقى
    // في القائمة وهو ليس على القرص — والحقيقةُ عند المحرّك لا عند العرض.
    const refusalHandler = desktop.match(/if \(f.kind === "refused"\) \{[\s\S]*?\n {6}\}/u)?.[0]
    expect(refusalHandler).toBeDefined()
    const refusalEffects: unknown[] = []
    // 09-14 ظهراً: الرفضُ يُطوى بسببه («refused») لا بوسم المقاطعة — «قوطع بيد المشغّل» كان يُلصق بخطأ المزوّد (مقيس على 4.0.14).
    new Function("f", "approvalFold", "delivFold", "settle", "notice", "mcpResync", "interruptedTurns", refusalHandler!)(
      { kind: "refused", turnId: "failed-provider", why: "Open provider settings" },
      (frame: unknown) => refusalEffects.push(["approval", frame]),
      (frame: unknown) => refusalEffects.push(["deliverables", frame]),
      (turnId: string, interrupted: boolean, outcome: string) => refusalEffects.push(["settle", turnId, interrupted, outcome]),
      (why: string) => refusalEffects.push(["notice", why]),
      () => refusalEffects.push(["resync"]),
      new Set<string>(),
    )
    expect(refusalEffects).toEqual([
      ["approval", { kind: "refused", turnId: "failed-provider", why: "Open provider settings" }],
      ["deliverables", { kind: "refused", turnId: "failed-provider", why: "Open provider settings" }],
      ["settle", "failed-provider", false, "refused"], ["notice", "Open provider settings"], ["resync"],
    ])
    // (د) القشرة: الاستيراد داخل الحارس، والنيّة لم تعد تُسجَّل مخرجاً.
    const deliverablesMount = await Bun.file(new URL("../src/shells/deliverables-mount.ts", import.meta.url)).text()
    const delivWanted = desktop.indexOf('const delivWanted = pluginOn("deliverables");')
    const delivGuard = desktop.indexOf("if (delivWanted && Deliverables === null) {", delivWanted)
    const delivLoad = desktop.indexOf('await import("./deliverables-mount.js")', delivGuard)
    expect(delivWanted).toBeGreaterThan(0)
    expect(delivGuard).toBeGreaterThan(delivWanted)
    expect(delivLoad).toBeGreaterThan(delivGuard)
    expect(delivLoad - delivGuard).toBeLessThan(120)
    expect(desktop.match(/import\("\.\/deliverables-mount\.js"\)/gu)).toHaveLength(1)
    expect(desktop).not.toMatch(/<script[^>]+deliverables(?:-mount)?\.js/u)
    expect(desktop).toContain('if (Deliverables !== null) recordSource(f.cmd); else recordActivity(f.cmd);')
    // (د٢) الصفُّ لم يعد يستولي على قسمٍ عامّ بتبديل عنوانه — استيلاءٌ لا
    // يُردّ عند الإطفاء. صار له قسمُه في مِرساة لوحة النشاط (IDEA 6)، والقسم
    // العامّ يُخفى ما دام مركَّباً ويُردّ في مفكِّكه.
    expect(desktop).toContain('<div id="slot-activity-section" data-anchor="activity.section"></div>')
    expect(desktop).not.toContain('el("actoutputshead").textContent = "المسلَّمات";')
    expect(deliverablesMount).toContain('anchor: "activity.section"')
    expect(deliverablesMount).toContain('head.textContent = "المسلَّمات"')
    expect(deliverablesMount).toContain("deps.generalSection.hidden = true")
    // والردُّ إلى **المقيس** قبل الإخفاء، لا إلى `false` مكتوبةٍ بيد: قسمٌ
    // وجدته الميزةُ مخفيّاً كان الفكُّ يكشفه.
    expect(deliverablesMount).toContain(
      "const wasHidden = deps.generalSection === null ? undefined : deps.generalSection.hidden",
    )
    expect(deliverablesMount).toContain("deps.generalSection.hidden = wasHidden")
    expect(deliverablesMount).not.toContain("deps.generalSection.hidden = false")
    expect(desktop).toContain('slots.unregisterFeature("deliverables");')
    // (هـ) المفتاح المُعلَن بلا قارئ منذ البداية صار يُطاع — والوصف قُلب معه.
    // وأمرُ المالك (2026-09-04) أطفأ اللوحة، فالإطفاء صار **نزعاً من الشجرة**
    // لا صنفَ `hidden`: عقدةٌ مخفيّةٌ تبقى في شجرة الوصول بثلاثة عناوينَ
    // فارغة، و«المعطَّل لا يُحمَّل» تعني ما تقوله.
    expect(desktop).toContain("activityHome.removeChild(activityNode)")
    expect(desktop).toContain("activityHome.insertBefore(activityNode, activityAnchor)")
    expect(desktop).not.toContain('classList.toggle("hidden", !pluginOn("activity"))')
    // والمرساةُ تُلتقط قبل أوّل إطفاء، وإلا لم يُعرف أين تعود اللوحة.
    expect(desktop).toContain('const activityAnchor = activityNode === null ? null : activityNode.nextSibling')
    expect(PLUGINS.find((d) => d.name === "activity")).toMatchObject({ defaultOn: false, site: "panel", wired: true })
    expect(PLUGINS.find((d) => d.name === "deliverables")).toMatchObject({ defaultOn: false, site: "turn", wired: true })
    expect(registrySource).toContain('name: "deliverables"')
  })

  // ── S14 — الاعتماد في نصّ المحادثة (أمر المالك 2026-09-02) ─────────────────
  // «يجب عند اخبار المستخدم له الحساب كذا و الباسورد كذا دخلهم في كذا يطلع
  // تحذير تدوير الاسرار و يفتحلة ملف نوت باد لادخال الاسرار في خزنة الاسرار».
  test("الترتيب هو الميزة: الكشف والحجب قبل القبول في الدفتر، لا بعده", () => {
    const classify = source.indexOf("const secretScan = classifyInboundSecret(frame.turn.body)")
    const turnConst = source.indexOf("const turn = { id: frame.turn.id, body: secretScan.redacted }")
    const admit = source.indexOf("await serveJournal.admit({ turnId: turn.id, body: turn.body, sessionId: currentSession, attachments:turnAttachments })")
    const attachments = source.indexOf('attached=resolveAttachments(SETTINGS_FILE,currentSession,turnAttachments)')
    const bodies = source.indexOf("turnBodies.set(turn.id, turn.body)")
    const remember = source.indexOf("const taskFact = remember({")
    expect(classify).toBeGreaterThan(0)
    // ⛔ الطفرة (أ): تحريكُ الحارس إلى ما بعد القبول يقلب هذا الترتيب فيسقط.
    expect(turnConst).toBeGreaterThan(classify)
    expect(admit).toBeGreaterThan(turnConst)
    expect(attachments).toBeGreaterThan(turnConst)
    expect(admit).toBeGreaterThan(attachments)
    expect(bodies).toBeGreaterThan(admit)
    expect(remember).toBeGreaterThan(admit)
    // والجسدُ الخام لا يعبر السطر: موضعٌ واحد يقرؤه في الملفّ كلّه، وهو
    // نداء المصنّف نفسه. كلّ ما بعده يقرأ `turn.body` المحجوب.
    expect(source.split("frame.turn.body").length - 1).toBe(1)
    expect(source).not.toContain("body: frame.turn.body")
  })

  test("التحذير ليس خلف مفتاح؛ المحرّر والخزنة وحدهما خلفه", () => {
    const warning = source.indexOf("await emitEvent(turn.id, secretWarning.operator)")
    const toggle = source.indexOf('if (!plugins.read("secretIntake", "turn"))')
    expect(warning).toBeGreaterThan(0)
    // سطرُ التحذير يسبق قراءة المفتاح — فالمعطَّل يحذّر ولا يفتح شيئاً.
    expect(toggle).toBeGreaterThan(warning)
    expect(source).toContain("const secretWarning = secretScan.carriesSecret ? rotationWarning(secretScan.kinds, secretScan.providerHandle) : undefined")
    // المسارُ المُعان: حارسُ المجلّد ثم المحرّر تنفيذياً ثم كتابةُ الخزنة.
    expect(source).toContain("const guarded = await vaultGuard(process.env)")
    expect(source).toContain("editor: editorArgv(process.env, process.platform),")
    expect(source).toContain("store: (name, value) => vaultSet(name, value, process.env),")
    // ⛔ لا صدفةَ ولا `start`: المحرّر تنفيذيٌّ مباشر في كل المنصّات.
    expect(source).not.toContain("cmd /c start")
    expect(source).not.toContain("cmd.exe /c")
    // ولا قيمةَ سرٍّ في أيّ سطر أمرٍ يبنيه المحرّك.
    expect(vaultSource).toContain('stdin: stdin ?? "ignore",')
    expect(vaultSource).toContain('const payload = new TextEncoder().encode(value)')
    expect(vaultSource).not.toMatch(/vaultArgv\([^)]*value/u)
  })

  test("أمرُ المقابض للمستخدم موجودٌ في المساعدة وفي المُوزِّع", () => {
    expect(source).toContain('case "secret": {')
    expect(source).toContain("const out = await secretCommand(rest)")
    expect(source).toContain("secret ...     مقابض الخزنة: where | list | set <مقبض> | forget <مقبض>")
    // القيمة من أنبوبٍ أو محرّر — لا من وسيطٍ أبداً.
    expect(source).toContain("if (process.stdin.isTTY !== true) {")
    expect(source).toContain("const piped = (await Bun.stdin.text()).replace(/[\\r\\n]+$/u, \"\")")
    expect(PLUGINS.find((d) => d.name === "secretIntake")).toMatchObject({ defaultOn: true, site: "turn", wired: true })
    expect(registrySource).toContain('name: "secretIntake"')
  })

  // IDEA 6 — نقاط التعليق: آليّةُ تركيبٍ واحدة تقتل تصليبَ واجهات الميزات في
  // القشرة. هذا الاختبار يسقط إن عادت ميزةٌ تُصلَّب في `index.html` بدل أن
  // تسجّل، أو إن صار للآليّة مفتاح، أو إن نسي فرعٌ فكَّ ما ركّب.
  test("shell features MOUNT through the slot registry — nothing is hard-wired back into the page", async () => {
    const desktop = await Bun.file(new URL("../../desktop/ui/index.html", import.meta.url)).text()
    const slots = await Bun.file(new URL("../src/shells/slots.ts", import.meta.url)).text()
    const host = await Bun.file(new URL("../src/shells/slot-host.ts", import.meta.url)).text()
    const mounts = await Promise.all(
      ["approval", "trajectory", "deliverables"].map((name) =>
        Bun.file(new URL(`../src/shells/${name}-mount.ts`, import.meta.url)).text(),
      ),
    )

    // (أ) المراسي مُعلَنةٌ مرّةً واحدة — الأربع التي سمّاها الجرد وخامسةٌ
    // مقيسةٌ من موضع صفّ المسلَّمات، ولكلٍّ عقدةٌ في القشرة.
    expect([...ANCHORS]).toEqual(["composer.bar", "transcript.node", "tab.strip", "settings.section", "activity.section", "rail.icons", "header.actions", "dock.inline-end", "dock.inline-start", "dock.block-end", "dock.block-start"])
    const nodes: Readonly<Record<string, string>> = {
      "composer.bar": "slot-composer-bar",
      "transcript.node": "slot-transcript-node",
      "tab.strip": "slot-tab-strip",
      "settings.section": "slot-settings-section",
      "activity.section": "slot-activity-section",
      "rail.icons": "slot-rail-icons",
      "header.actions": "slot-header-actions",
      "dock.inline-end": "slot-dock-inline-end",
      "dock.inline-start": "slot-dock-inline-start",
      "dock.block-end": "slot-dock-block-end",
      "dock.block-start": "slot-dock-block-start",
    }
    for (const anchor of ANCHORS) {
      expect(desktop).toContain(`id="${nodes[anchor]}" data-anchor="${anchor}"`)
      expect(desktop).toContain(`"${anchor}": "${nodes[anchor]}",`)
    }
    // ومِرساةٌ مُعلَنةٌ بلا عقدةٍ تُسمّى عند الإقلاع لا حين تُستعمل.
    expect(desktop).toContain('for (const anchor of ANCHORS) if (!el(ANCHOR_NODES[anchor] || "")) notice("مرساة معلَنة بلا عقدة: " + anchor);')
    // والمِرساة وغلافُها بلا صندوق: التخطيط لا يتغيّر بدخولهما.
    expect(desktop).toContain("[data-anchor], [data-slot] { display: contents; }")

    // (ب) الآليّة ليست خياراً: لا مفتاح لها في السجلّ، ولا حارسَ حولها.
    for (const name of PLUGINS.map((d) => d.name)) expect(name).not.toMatch(/slot/iu)
    expect(desktop).toContain('import { SlotHost, ANCHORS } from "./slot-host.js";')
    expect(desktop).not.toMatch(/pluginOn\("[^"]*[Ss]lot[^"]*"\)/u)

    // (ج) الرفضُ مسمّى لا صامت — الاسم يظهر في نصّ الرفض نفسه.
    expect(slots).toContain('return { state, refused: `مرساة غير معروفة: "${anchor}"` }')
    expect(slots).toContain('return { state, refused: `تسجيل مكرّر لنقطة التعليق: "${id}"` }')
    expect(host).toContain('return `مرساة غير موجودة في القشرة: "${contribution.anchor}"`')
    // والترتيب من الرتبة ثم تسلسل التسجيل، لا من ترتيب النداء.
    expect(slots).toContain("a.order === b.order ? a.seq - b.seq : a.order - b.order")
    expect(host).toContain("const ordered = slot(folded.state, contribution.anchor)")
    expect(host).toContain("anchor.insertBefore(wrapper, after === undefined ? null : this.live.get(after.id)!.wrapper)")

    // (د) الهدم آليّةٌ لا قصّة: مفكِّك الميزة، ثم نزعُ كلّ مستمعٍ رُبط، ثم
    // حذفُ الغلاف بكلّ ما تحته — بهذا الترتيب.
    const teardown = host.indexOf("teardown?.()")
    const unbind = host.indexOf("for (const entry of record.listeners) entry.target.removeEventListener")
    const drop = host.indexOf("record.anchor.removeChild(record.wrapper)")
    expect(teardown).toBeGreaterThan(0)
    expect(unbind).toBeGreaterThan(teardown)
    expect(drop).toBeGreaterThan(unbind)
    expect(host).toContain('wrapper.setAttribute("data-slot", contribution.id)')

    // (هـ) الميزات الثلاث تسجّل ولا تُصلَّب: كلُّ عقدةٍ تُبنى في مساهمتها،
    // وكلُّ مستمعٍ يمرّ بـ`bind` — ولا `onclick` في أيّ وحدة تركيب.
    for (const mount of mounts) {
      expect(mount).toContain("mount: (host")
      expect(mount).not.toContain(".onclick")
      expect(mount).not.toContain("document.getElementById")
      expect(mount).not.toContain("innerHTML")
    }
    // ولا شجرةَ ميزةٍ باقيةٌ في الصفحة: المِرساة الفارغة هي كلُّ ما يُشحن.
    for (const orphan of ['id="approvalseat"', 'id="trajtab"', 'id="trajbody"', 'id="trajturn"', 'id="delivrows"']) {
      expect(desktop).not.toContain(orphan)
    }
    // الوحدات الأصلية للقشرة دائمة لأنها هي سطح التطبيق نفسه. وتظل الميزات
    // الاختيارية الثلاث وحدها مركّبة كسولاً خلف سجل الإضافات.
    expect(desktop.match(/^ *import .*\.js";$/gmu)).toEqual([
      '    import { Turns } from "./turns.js";',
      '    import { Shell } from "./shell.js";',
      // جدولُ بياناتٍ لا ميزة: قائمةُ الخوادم التي نشحنها، تُقرأ في لوحة
      // الإعدادات وحدها. لا مفتاحَ لها فلا معنى لكسلها — كـ`Providers` تماماً.
      '    import { McpCatalogue } from "./mcp-catalogue.js";',
      '    import { Providers } from "./providers.js";',
      '    import { providerDisplayLabel } from "./provider-display.js";',
      '    import { createTranscript } from "./native-transcript.js";',
      '    import { mountNativeShell } from "./native-shell.js";',
      '    import { mountNativeSurfaces } from "./native-surfaces.js";',
      '    import { mountChatWork } from "./native-chat-work.js";',
      '    import { mountAutomation } from "./native-automation.js";',
      '    import { mountSettingsSurfaces } from "./native-settings-surfaces.js";',
      '    import { mountLocalSettings } from "./native-local-settings.js";',
      '    import { mountUsageSettings } from "./native-usage-settings.js";',
      '    import { mountExtensionSettings } from "./native-extension-settings.js";',
      '    import { mountWorkspaceSettings } from "./native-workspace-settings.js";',
      '    import { SlotHost, ANCHORS } from "./slot-host.js";',
      // آليّةٌ لا ميزة — كالسجلّ تماماً: تحمل ما لا يملكه السجلّ (مِرساةُ اللوح
      // وتوسيعُه ونقطةُ «جديدٌ لم تره»)، بلا مفتاحٍ فلا معنى لكسلها.
      '    import * as Panels from "./panels.js";',
    ])

    // (و) التبديل يسري في الاتجاهين من نداءٍ واحد — لا فرعَ تحميلٍ ثالث.
    expect(desktop).not.toContain("loadShellPlugins")
    // خمسةُ سائقين: إقلاعٌ، إعداداتٌ، سكونُ المقعد في الدفتر، تصفيرُ محادثةٍ
    // جديدة (يُسكِن المقعد أيضاً)، وإعادةُ التشغيل بعد نداءٍ أُجّل.
    expect(desktop.match(/void syncShellPlugins\(\);/gu)).toHaveLength(5)
    // والحارسُ يُؤجِّل ولا يُسقِط: `return` عارية كانت تبتلع الاستئنافَ
    // الوحيد لفكٍّ مؤجَّل، فيبقى المقعد مركَّباً ومفتاحُه مطفأ.
    expect(desktop).toContain("let syncing = false, resync = false;")
    expect(desktop).toContain("if (syncing) { resync = true; return; }")
    expect(desktop).toContain("if (resync) { resync = false; void syncShellPlugins(); }")
    expect(desktop).not.toMatch(/if \(syncing\) return;/u)
    // وتصفيرُ المحادثة يستأنف الفكَّ المؤجَّل بدوره — لا سطرُ الدفتر وحده.
    expect(desktop).toContain(
      "if (Approval !== null) { approvalStore = Approval.empty(); renderApproval(); void syncShellPlugins(); }",
    )
    for (const feature of ["approvalTakeover", "trajectory", "deliverables"]) {
      expect(desktop).toContain(`slots.unregisterFeature("${feature}");`)
    }
    // (ز) والهدم معزولٌ لكلّ مساهمة: سقوطُ واحدةٍ يُسمّى ولا يُجهض أخواتها،
    // والقيدُ يُمحى **بعد** الحذف البنيويّ فيبقى مقبضٌ تُعاد به المحاولة.
    expect(host).toContain("failures.push(`هدم \"${id}\" سقط: ${message(error)}`)")
    const removal = host.indexOf("record.anchor.removeChild(record.wrapper)")
    const forget = host.indexOf("this.live.delete(id)")
    expect(removal).toBeGreaterThan(0)
    expect(forget).toBeGreaterThan(removal)
    // والسجلُّ يُكتب قبل التركيب: مساهمةٌ تُسجَّل من داخل `mount` لا تُدهس.
    const commit = host.indexOf("this.live.set(contribution.id, record)")
    const mounting = host.indexOf("record.teardown = contribution.mount(wrapper, bind)")
    expect(commit).toBeGreaterThan(0)
    expect(mounting).toBeGreaterThan(commit)
  })
})

test("interface reset waits for explicit confirmation and preserves runtime provider, mode and plugin state", async () => {
  const desktop = await Bun.file(new URL("../../desktop/ui/index.html", import.meta.url)).text()
  const resetSource = desktop.slice(desktop.indexOf('    el("settingsreset").onclick ='), desktop.indexOf('    el("projectchip").onclick ='))
  const runtimeSettings = { model: "qwen-token-plan/qwen3.8-max-preview", mode: "full-access", plugins: { mcpClient: true }, routerGate: "cheap", customProviders: [{ id: "custom", vaultKey: "custom-handle" }] }
  const before = structuredClone(runtimeSettings), calls: string[] = [], applied: unknown[] = []
  let confirmation: (() => Promise<void>) | undefined
  let fail = false
  const resetButton: {onclick?: () => Promise<void>} = {}
  runInNewContext(resetSource, {
    el: () => resetButton, runtimeSettings, settingsDrafts: createSettingsDrafts(),
    window: { AbdoDesktopShell: { api: { L: (en:string) => en, confirmDialog: (_title:string, body:string, action:()=>Promise<void>) => { expect(body).toContain("Provider connections, permissions, projects and Windows settings are retained."); confirmation = action } } } },
    invoke: async (command:string) => { calls.push(command); if(fail) throw Error("native reset rejected"); return {version:1,language:"en",colorScheme:"system"} },
    applyShellSettings: (settings:unknown) => applied.push(settings), fillSettingsControls() {}, notice() {},
    sendFrame: () => { throw Error("interface reset attempted runtime mutation") },
  })
  await resetButton.onclick!()
  expect(calls).toEqual([])
  expect(confirmation).toBeDefined()
  await confirmation!()
  expect(calls).toEqual(["settings_reset"])
  expect(applied).toEqual([{version:1,language:"en",colorScheme:"system"}])
  expect(runtimeSettings).toEqual(before)
  fail = true
  await resetButton.onclick!()
  await expect(confirmation!()).rejects.toThrow("native reset rejected")
  expect(applied).toHaveLength(1)
  expect(runtimeSettings).toEqual(before)
})
