import { describe, expect, test } from "bun:test"
import { descriptorFor } from "../src/plugin-registry"
import { AWARENESS_FILE } from "../src/project-awareness"
import { SUMMARY_HEAD } from "@abdo/engine-host"

// الوحدتان مختبَرتان نقيّتين في session-summary.test وproject-awareness.test؛
// هذا الملفّ يثبت أن `cli.ts` **يصل** بهما فعلاً — المسح 2026-09-02 وجد حزماً
// مبنيةً وغير موصولة بالحلقة، فوحدةٌ نقيّة خضراء لا تعني قدرةً حيّة.
const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

const epochInputBlock = (): string => {
  const start = source.indexOf("const epochInput = epoch === 1")
  expect(start).toBeGreaterThan(0)
  const end = source.indexOf("const sprintPlanPending", start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("S13.1/S13.2 — المفتاحان يمرّان بسجلّ المكوّنات وحده", () => {
  test("البطاقتان معلَنتان بموصولٍ صادق وموضع قراءةٍ مقيس", () => {
    for (const name of ["sessionAwareness", "projectAwareness"] as const) {
      const descriptor = descriptorFor(name)!
      expect(descriptor).toMatchObject({ defaultOn: true, applies: "next-turn", site: "turn", wired: true })
      expect(descriptor.requiresVault).toEqual([])
    }
  })

  test("القراءة من الجرد لا من الإعدادات مباشرة، ومرةً واحدة لكل دور", () => {
    expect(source).toContain('const sessionAwarenessOn = plugins.read("sessionAwareness", "turn")')
    expect(source).toContain('const projectAwarenessOn = plugins.read("projectAwareness", "turn")')
    expect(source.match(/plugins\.read\("sessionAwareness"/gu)).toHaveLength(1)
    expect(source.match(/plugins\.read\("projectAwareness"/gu)).toHaveLength(1)
    // لا قراءةً قديمة تتسلّل بجوارهما.
    expect(source).not.toContain("plugins?.sessionAwareness")
    expect(source).not.toContain("plugins?.projectAwareness")
  })
})

describe("S13.1 — الحقن في كل حقبة لا الأولى وحدها", () => {
  test("خلاصة الجلسة تدخل فرعَي تعليمة الحقبة معاً", () => {
    const block = epochInputBlock()
    const firstEpoch = block.slice(block.indexOf("? `"), block.indexOf(": `واصل"))
    const laterEpochs = block.slice(block.indexOf(": `واصل"))
    expect(firstEpoch).toContain("${summaryBrief}")
    expect(laterEpochs).toContain("${summaryBrief}")
    expect(firstEpoch).toContain("${summaryAsk}")
    expect(laterEpochs).toContain("${summaryAsk}")
    // الطفرة (ب): حصرُها في الحقبة الأولى يسقط هذا الاختبار.
    expect(block.match(/\$\{summaryBrief\}/gu)).toHaveLength(2)
  })

  test("الخلاصة تُحسب داخل حلقة الحقب فتتجدّد بها، لا مرةً عند بدء الدور", () => {
    const loopStart = source.indexOf("for (let epoch = 1; epoch <= MAX_AGENT_EPOCHS; epoch++)")
    const compute = source.indexOf("const summaryBrief = rails.sessionSummary && sessionAwarenessOn && sessionSummary !== undefined ? renderSessionSummary(sessionSummary)")
    expect(loopStart).toBeGreaterThan(0)
    expect(compute).toBeGreaterThan(loopStart)
  })

  test("المعطَّل = سلسلتان فارغتان: لا حرفَ يُضاف إلى التعليمة", () => {
    // هـ1: الشرطان يحملان rails.sessionSummary قبل مفتاح الإضافة — المعطَّلُ بأيّهما سلسلةٌ فارغة.
    expect(source).toContain('const summaryBrief = rails.sessionSummary && sessionAwarenessOn && sessionSummary !== undefined ? renderSessionSummary(sessionSummary) : ""')
    expect(source).toContain('const summaryAsk = rails.sessionSummary && sessionAwarenessOn ? `\\n${SUMMARY_INSTRUCTION}` : ""')
  })
})

describe("S13.1 — لا تخزين لادّعاءٍ بلا إيصال", () => {
  test("المراجعة تسبق الدمج، والدمج يسبق الحفظ، والحفظ بمفتاح session:<الجلسة>:summary", () => {
    const verify = source.indexOf("const summaryVerdict = verifySummary(loop.summary, receipts)")
    const merge = source.indexOf("sessionSummary = mergeSessionSummary(sessionSummary, summaryVerdict, epoch, redactSummaryLine)")
    const store = source.indexOf("key: summaryKey, value: sessionSummary", merge)
    expect(verify).toBeGreaterThan(0)
    expect(merge).toBeGreaterThan(verify)
    expect(store).toBeGreaterThan(merge)
    expect(source).toContain("const summaryKey = `session:${currentSession}:summary`")
    // الطفرة (أ): تخزينُ المسوّدة الخام بدل الحكم يسقط هذا السطر.
    expect(source).not.toContain("value: loop.summary")
  })

  test("الخلاصة تمرّ بحاجب الأسرار قبل أن تستقرّ — بالتركيب نفسه الذي يمرّ به سطرُ النيّة", () => {
    const define = source.indexOf(
      "const redactSummaryLine = (text: string): string => sweepResidualSecrets(redactSecretValues(text).text).text",
    )
    expect(define).toBeGreaterThan(0)
    // مفردةٌ واحدة: المفردتان تأتيان من `secret-command-guard` وحده.
    expect(source).toContain('sweepResidualSecrets } from "./secret-command-guard"')
    // ولا يُخزَّن شيءٌ قبل تعريف الحاجب.
    expect(source.indexOf("sessionSummary = mergeSessionSummary(")).toBeGreaterThan(define)
  })

  test("الحفظ والحقن كلاهما خلف المفتاح نفسه", () => {
    expect(source).toContain("if (sessionAwarenessOn && loop.summary !== undefined) {")
    expect(source).toContain("...(sessionAwarenessOn ? { sessionSummary: true } : {}),")
  })
})

describe("S13.2 — القراءة أولاً، والكتابة عند تمام الدور بشرطين", () => {
  test("فهرس المشروع أوّلُ ما يراه النموذج في الدور", () => {
    const block = epochInputBlock()
    const firstEpoch = block.slice(block.indexOf("? `"), block.indexOf(": `واصل"))
    expect(firstEpoch.indexOf("${projectAwareness}")).toBeGreaterThan(-1)
    for (const later of ["${coldMap}", "${priorRecall}", "${secretNotice}", "${turn.body}"]) {
      expect(firstEpoch.indexOf("${projectAwareness}")).toBeLessThan(firstEpoch.indexOf(later))
    }
  })

  test("القراءة من القرص مرةً واحدة لكل دور — لا مرةً لكل حقبة", () => {
    const loopStart = source.indexOf("for (let epoch = 1; epoch <= MAX_AGENT_EPOCHS; epoch++)")
    const read = source.indexOf("const projectAwareness = !projectAwarenessOn ? \"\" : (() => {")
    expect(read).toBeGreaterThan(0)
    expect(read).toBeLessThan(loopStart)
    expect(source.match(/projectAwarenessBrief\(/gu)).toHaveLength(1)
    // سقفُ القراءة يُقصّ به القارئان الرخيصان **وحدهما**: موجزُ الدور
    // (هنا) وجامعُ الطبقات لأمر `awareness`/أداة `recall` (S13.4). كلاهما
    // قراءةٌ لا يُعاد كتابتها؛ ومسارُ الكتابة يقرأ الملفّ كاملاً (الاختبار
    // التالي) — قصُّ ما سيُعاد كتابته يمحو ذيلَ مستودع شخصٍ آخر.
    expect(source.match(/\.slice\(0, AWARENESS_READ_CAP\)/gu)).toHaveLength(2)
    expect(source).toContain("entriesFromProjectAwareness(readFileSync(file, \"utf8\").slice(0, AWARENESS_READ_CAP), projectId)")
    // History privacy is sampled once for the turn. The brief keeps explicit
    // owner instructions while excluding session-derived sections when off.
    expect(source).toContain('const memorySearchEnabled = settingsAtTurn.memorySearchEnabled !== false')
    expect(source).toContain('projectAwarenessBrief(readFileSync(file, "utf8").slice(0, AWARENESS_READ_CAP), 900, memorySearchEnabled)')
  })

  test("مسارُ الكتابة يقرأ الملفّ كاملاً — لا دمجَ فوق قراءةٍ مبتورة", () => {
    // الملفّ يُعاد كتابتُه كلُّه، فقراءةٌ مقصوصة عند 64KiB تمحو ذيلَ مستودع
    // شخصٍ آخر بلا نسخةٍ ولا إنذار.
    expect(source).toContain('const existing = existsSync(file) ? readFileSync(file, "utf8") : ""')
    expect(source).not.toContain('readFileSync(file, "utf8").slice(0, AWARENESS_READ_CAP) : ""\n          const sprintLine')
    const merge = source.indexOf("const merged = mergeProjectAwareness(existing,")
    const read = source.lastIndexOf('const existing = existsSync(file) ? readFileSync(file, "utf8") : ""', merge)
    expect(read).toBeGreaterThan(0)
    expect(merge).toBeGreaterThan(read)
  })

  test("مجلَّدُ المشروع مُجمَّد عند بدء الدور: القراءة والكتابة على المجلَّد نفسه", () => {
    // `project-set` يقلب PROJECT_DIR وسط دورٍ يعمل منفصلاً؛ بلا تجميدٍ تُلحَق
    // حقائقُ مشروعٍ بملفّ مشروعٍ آخر.
    const snapshot = source.indexOf("let turnProjectDir = resolve(PROJECT_DIR)")
    expect(snapshot).toBeGreaterThan(0)
    // قيس 2026-09-06: الرفضُ مشروطٌ بغياب نيّة إنشاءٍ في رسالة المستخدم (turnIntent) — لا مطلقاً.
    expect(source).toContain('if (projectSelected && !createIntent) return denied("A project is already selected.')
    expect(source).toContain('Finish the active turn before switching projects.')
    expect(source.match(/let turnProjectDir = resolve\(PROJECT_DIR\)/gu)).toHaveLength(1)
    expect(source.match(/join\(turnProjectDir, AWARENESS_FILE\)/gu)).toHaveLength(2)
    expect(source).not.toContain("join(PROJECT_DIR, AWARENESS_FILE)")
    expect(source).toContain("isTrusted(turnProjectDir)")
    expect(source.slice(source.indexOf("if (projectAwarenessOn && isTrusted(turnProjectDir))"),source.indexOf("if (projectAwarenessOn && isTrusted(turnProjectDir))")+1300)).not.toContain("isTrusted(PROJECT_DIR)")
  })

  test("الكتابة خلف المفتاح **و** ثقة المشروع معاً، وعند تمام الدور", () => {
    const guard = source.indexOf("if (projectAwarenessOn && isTrusted(turnProjectDir)) {")
    const write = source.indexOf('writeFileSync(file, merged.text, "utf8")', guard)
    const finished = source.indexOf("durableMemory.verify(finishedTask.id)")
    expect(guard).toBeGreaterThan(0)
    // الطفرة (د): نزعُ الشرط يسقط هذا الاختبار.
    expect(write).toBeGreaterThan(guard)
    expect(guard).toBeGreaterThan(finished)
    // الطفرة (ج): الدهس بدل الدمج يسقط هذا — النصّ المكتوب من الدمج وحده.
    expect(source).toContain("const merged = mergeProjectAwareness(existing, awarenessUpdateFrom(sessionSummary, sprintLine))")
    expect(source).toContain("else if (merged.changed) {")
    expect(source.match(/writeFileSync\(file, merged\.text/gu)).toHaveLength(1)
    expect(source).not.toContain("writeFileSync(file, rendered")
  })

  test("الرفضُ عند بقاء ما يشبه سرّاً لا يُكتب ولا يُبتلع", () => {
    expect(source).toContain("if (awarenessRefused(merged)) await emitEvent(turn.id, `🧭 ${merged.refused}`)")
    expect(source).toContain(`\${AWARENESS_FILE}`)
    expect(AWARENESS_FILE).toBe("ABDO-AWARENESS.md")
  })
})

describe("S13.1/S13.2 — إثباتُ الكلفة في المسار الحيّ", () => {
  test("لا نداء نموذجٍ أُضيف: مواضع ask ونداء الحلقة كما كانت", () => {
    // قيس على 85a253ee (قبل S13.1/S13.2) وبعدهما: الأرقام هي هي.
    // ستّة `await ask(` (استئناف، خطة، حقبة، محكّم دلالي، توجيه، أمر مباشر)
    // + `return ask(` واحد + `gateAsk` واحدة — ولا ثامنَ للخلاصة.
    // S13.5 أضاف السابع **عن قصدٍ معلَن**: نداءُ الوكيل المفوَّض. ووضع
    // Super Abdo أضاف الثامن للمراجعة المستقلة بلا أدوات. كلاهما يمرّ من
    // `ask` ودفتر الكلفة نفسيهما؛ ولا نداء خفيّ أو مسار تسعير ثانٍ.
    // Chat now has one isolated direct-provider branch. It reuses ask and its
    // charging owner; it never enters the Code agent loop or adds a second call.
    // هـ2 (2026-09-07): العاشرُ والحادي عشر عن قصدٍ معلَن — الوكيلُ الموجِّه قبل الحقبة الأولى (الأوضاعُ فوق الأساسيّ) وأطفالُ team
    // المتوازون — كلاهما يمرّ من `ask` ودفتر الكلفة والعدّاد نفسها؛ الأساسيُّ لا يستدعيهما.
    expect(source).toContain("if(modeAtTurn==='chat'){")
    expect(source).toContain('const answer=await ask(secretNotice+turn.body,hooks,conversation,turnSelection)')
    expect(source).toContain('return {answer,completed:true}')
    expect(source).toContain("const text = await ask(prompt, { ...hooks, toolAllowlist: allowlist }, history, childModel,")
    expect(source).toContain("ask(buildVerifierPrompt(effectiveGoal, loop.answer, allReceipts), {")
    // 4.0.46 (2026-09-17): الثاني عن قصدٍ معلَن — `ask` يلفّ `askOnce` ويعيد نداءَ نفسِه مرّةً بعد تصعيد الازدحام
    // (provider_unavailable ⇦ الدرجة التالية من السلّم)؛ الكلفةُ في الدفتر نفسه، ولا مسارَ تسعيرٍ ثانٍ. كان المسمارُ أحمر منذها بلا قياس.
    expect(source.match(/\breturn ask\(/gu)).toHaveLength(2)
    expect(source).toContain("outageRoute = { from: outageRoute?.from ?? sel.ref, to: outcome.to }")
    expect(source.match(/runTextAgentLoop\(\{/gu)).toHaveLength(1)
    expect(source.match(/await gateAsk\(/gu)).toHaveLength(1)
  })

  test("الخلاصة تأتي من الردّ نفسه (loop.summary) لا من نداءٍ ثانٍ", () => {
    expect(source).toContain("loop.summary")
    expect(source).not.toMatch(/ask\([^)]*SUMMARY_INSTRUCTION/u)
    expect(source).not.toMatch(/ask\([^)]*summaryBrief/u)
    // رأسُ الكتلة لا يُكتب في المحرّك حرفياً: يأتي من الوحدة وحدها.
    expect(source).not.toContain(SUMMARY_HEAD)
  })
})

    // هـ3 (2026-09-07): الثاني عشر معلَن — التفنيدُ العدائيّ في وضع «أقصى» (نداءٌ واحدٌ في خريطة العدسات الثلاث)،
    // بدفتر الكلفة والعدّاد نفسيهما، وكلفتُه تُعلَن قبل إنفاقها ويُسلَّم الدورُ عند موضعه إن تربت الميزانية.
    // م9ح (2026-09-14): الثالث عشر معلَن — حارةُ المراجعة «review» (نداءٌ واحدٌ في خريطة العدسات الثلاث بلا أدوات وبسياقٍ منفصل).
    expect(source.match(/\bawait ask\(/gu)).toHaveLength(13)
    expect(source).toContain("const reply = await ask(buildReviewPrompt(reviewGoal, diff.text, lens), { ...hooks, onDelta: undefined, toolAllowlist: [], reviewSystem: REVIEW_SYSTEM }, [], turnSelection)")