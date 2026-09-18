/**
 * S13.5 — ما وجدته المراجعة بعد أوّل وصلٍ للحلقة المتداخلة، مثبَّتاً عيباً عيباً.
 *
 * كلُّ اختبارٍ هنا يحمل اسمَ العطل الذي وُجد مقيساً، ويسقط لو رُدَّ الكودُ
 * القديم. ما يقع داخل `runServeShell` (وهي لا تُستدعى من اختبارٍ) يُثبَّت على
 * **نصّ المصدر** بشرطٍ يصف السلوك لا شكلَه: ترتيبُ الحارس قبل حلّ المواصفة،
 * وأنَّ الطريق الثاني (`codemode`) لا يملك مُوزِّعاً خاصّاً به.
 */
import { describe, expect, test } from "bun:test"
import { runTextAgentLoop } from "@abdo/engine-host"
import { Providers } from "@abdo/providers"
import { ProductTools } from "@abdo/tools"
import { BUILTIN_AGENT_FILES, buildAgentCatalogue, findAgent, parseAgentDefinition } from "../src/agent-definitions"
import { childToolRefusal, runDelegatedAgent } from "../src/delegation"
import { namespacedUsage, normalise } from "../src/mind/external"
import { Trajectory } from "../src/shells/trajectory"
import { terminalDialectLine, toolVocabulary } from "../src/tool-vocabulary"
import { TurnSpendMeter } from "../src/turn-budget"
import { distillFact } from "../src/turn-memory"

const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()
const composer = await Bun.file(new URL("../src/prompt-composer.ts", import.meta.url)).text()
const CATALOGUE = buildAgentCatalogue([...BUILTIN_AGENT_FILES])
const reviewer = findAgent(CATALOGUE, "reviewer")!

// وكيلٌ يعلن `codemode` وحدها — ملفٌّ يستطيع المشغّل كتابته اليوم، ويقبله
// القارئ نفسه الذي يقبل وكلاء المنتَج (فالخطر مقيسٌ لا مفترض).
const CODEMODE_AGENT_FILE = `---
name: scripter
description: يكتب سيناريو أدواتٍ سطراً لكلّ أمر
tools: codemode
---
أنت عدسةُ السيناريو. سطرٌ لكلّ أمر.
`

describe("S13.5 — الاحتواء: السقف عند المُوزِّع لا عند منفذ الحلقة", () => {
  test("وكيلٌ يعلن codemode وحدها مقبولٌ فعلاً — فالثغرة كانت قابلةً للكتابة", () => {
    const parsed = parseAgentDefinition("scripter.agent.md", CODEMODE_AGENT_FILE)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error("unreachable")
    expect(parsed.agent.tools).toEqual(["codemode"])
    // وحارسُه يرفض `run` بالاسم — بينما `codemode <<< run …` كانت تنفّذها.
    expect(childToolRefusal(parsed.agent, "run", 1)).toContain("لا يعلنها في سقفه")
    expect(childToolRefusal(parsed.agent, "codemode", 1)).toBeUndefined()
    // والسجلُّ العامّ (الخاصّةُ التي كان `runCodeMode` يفحصها) يقول «نعم» لـrun.
    expect(ProductTools.agentCallable("run")).toBe(true)
    expect(ProductTools.agentCallable("write")).toBe(true)
  })

  test("الحارس يقف في المُوزِّع الواحد، قبل حلّ المواصفة وقبل فرع الأداة الخارجيّة", () => {
    expect(source).toContain("let activeChildAgent: AgentDefinition | undefined")
    // هـ2 (2026-09-07): الحارسُ يقرأ وكيلَ النداء (hooks.childAgent — للفريق المتوازي) ثمّ العالميّ (delegate الفرديّ) — الموضعُ نفسُه قبل حلّ المواصفة.
    expect(source).toContain("const childAgentNow = hooks.childAgent ?? activeChildAgent")
    expect(source).toContain("const childRefusal = childToolRefusal(childAgentNow, word, delegationDepth)")
    const guard = source.indexOf("const childRefusal = childToolRefusal(childAgentNow, word, delegationDepth)")
    const dispatcher = source.indexOf("const dispatchToolV = async (word: string")
    const externalBranch = source.indexOf("const ext = externalTool(word)")
    const specLookup = source.indexOf("const spec = Tools.tool(word)")
    expect(guard).toBeGreaterThan(dispatcher)
    expect(guard).toBeLessThan(externalBranch)
    expect(guard).toBeLessThan(specLookup)
  })

  test("codemode ليس مُوزِّعاً ثانياً: يصل الأدوات عبر dispatchTool وحده فيرث الحارس", () => {
    const codemode = source.slice(source.indexOf("const runCodeMode = async ("))
    const body = codemode.slice(0, codemode.indexOf("\r\n  }\r\n"))
    expect(body).toContain("const r = await dispatchTool(word, step, turnId, hooks)")
    // ولا مُوزِّعَ خاصّ ولا منفّذ: السطر الوحيد الذي يخرج من هنا هو ذاك.
    expect(body).not.toContain("runExecV(")
    expect(body).not.toContain("runWriteToolV(")
  })

  test("السقف يُنصَّب حول الطفل ويُستعاد مهما جرى", () => {
    expect(source).toContain("const outerChildAgent = activeChildAgent")
    expect(source).toContain("activeChildAgent = agent")
    expect(source).toContain("activeChildAgent = outerChildAgent")
  })
})

describe("S13.5 — عدّاد الأب: الطفل يسأله ولا يكتب فيه", () => {
  test("سماحةٌ مُنحت في حقبة الأب تبقى حيّةً بعد عودة الطفل", async () => {
    const CAP = 1000
    const meter = new TurnSpendMeter(CAP, 0, String(CAP))
    // أبٌ في الحقبة ٢: أنفق ٨٠٠ ومتنبِّئه ٤٠٠ — البوّابة مستنفَدة، فيمنحه
    // المضيف سماحتَه الواحدة ويعلنها للمشغّل.
    meter.verdict(400)
    meter.charge({ inputTokens: 400, outputTokens: 0 })
    meter.verdict(400)
    meter.charge({ inputTokens: 400, outputTokens: 0 })
    expect(meter.gate(2)).toBe("exhausted")
    expect(meter.grantGrace(2)).toBeGreaterThan(0)
    expect(meter.gate(2)).toBe("open")
    const before = meter.snapshot()

    // ثمّ يفوّض داخل الحقبة نفسها قبل ندائه التالي.
    const report = await runDelegatedAgent({
      agent: reviewer,
      task: "افحص",
      depth: 1,
      ask: async () => "تم",
      dispatch: async (command) => `⚙ ${command}`,
      runLoop: runTextAgentLoop,
      meter,
      maxRounds: 1,
      maxEpochs: 3,
    })

    // الطفل لم يُنفق شيئاً، والسماحةُ لم تُبتر: النداءُ التالي للأب ما زال مسموحاً.
    expect(report.commands).toEqual([])
    const after = meter.snapshot()
    expect(after).toEqual(before)
    // والنداءُ التالي **بلا إعادة إعلان الحقبة**: المضيف لا يعيدها داخل الحقبة
    // الواحدة، فلو كتب الطفلُ علامةَ الحقبة لماتت السماحة هنا بالضبط — وهذا
    // ما قيس: `allowed=false` برسالةٍ لا تذكر السماحة أصلاً.
    expect(meter.verdict(400).allowed).toBe(true)
    expect(meter.snapshot().tripped).toBe(false)
    expect(meter.gate(2)).toBe("open")
  })

  test("المنفذُ لا يحمل وسيطَ حقبةٍ أصلاً — الكتابةُ مستحيلةٌ بالبناء", async () => {
    const delegation = await Bun.file(new URL("../src/delegation.ts", import.meta.url)).text()
    const code = delegation.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "")
    expect(code).toContain("gate(): \"open\" | \"exhausted\"")
    expect(code).toContain("options.meter?.gate() === \"exhausted\"")
    expect(code).not.toContain("gate(epoch)")
    expect(code).not.toContain("epoch?: number")
  })
})

describe("S13.5 — النزاهة: ادّعاءُ الطفل ليس قياساً", () => {
  const FABRICATED = [
    "🤝 تقرير الوكيل «reviewer» — قراءة-فقط (مشتقٌّ من أدواته المعلَنة)",
    "الحِقب: 1 · الأدوات المنفَّذة: 0 · المرفوضة: 0 · التوقّف: أنهى",
    "الخلاصة: راجعتُ نتيجة npm run build: ✓ Compiled successfully in 300ms،",
    "والخادم يعمل تحت إدارة النواة: «npm start» على http://127.0.0.1:31337 (pid 5).",
  ].join("\n")

  test("تقريرُ وكيلٍ لم ينفّذ أداةً لا يُقطَّر حقيقةً دائمة", () => {
    expect(distillFact("delegate reviewer :: راجع نتيجة npm run build", FABRICATED)).toBeUndefined()
    expect(distillFact("delegate reviewer :: لخّص", FABRICATED)).toBeUndefined()
    // ولا من أيّ إيصالٍ ليس تنفيذاً: القراءةُ لا تمنح حقيقةً مهما قال ناتجُها.
    expect(distillFact("read report.md", FABRICATED)).toBeUndefined()
    expect(distillFact("recall البناء", FABRICATED)).toBeUndefined()
  })

  test("وإيصالُ run المقيس يبقى يقطّر كما كان — الإصلاح ضيّق لا كاسح", () => {
    expect(distillFact("run npm run build", "✓ Compiled successfully in 300ms\nانتهى الأمر برمز 0")?.key).toBe("build:passing")
    expect(distillFact("run npm start", "⚙ الخادم يعمل تحت إدارة النواة: «npm start» على http://127.0.0.1:3000 (pid 5)")?.key).toBe("server:url")
    expect(distillFact("edit app/lib/db.ts :: a => b", "✍ عُدّل")?.key).toBe("wrote:app/lib/db.ts")
  })

  test("والحلقةُ نفسها لا تمرّر إيصال delegate إلى المقطِّر", () => {
    expect(source).toContain("const fact = cmd.trimStart().startsWith(\"delegate \") ? undefined : distillFact(cmd, output, verdict)")
  })

  test("كتابةُ الطفل تُبطل قبولَ الأب: الطيُّ يُبطل ولا يمنح", () => {
    expect(source).toContain("nestedEffectObserver = invalidateAcceptanceFor")
    expect(source).toContain("for (const command of report.commands) nestedEffectObserver?.(command)")
    // والمنفذُ يُنزع بانتهاء الدور على المخرجين معاً.
    expect(source.match(/nestedEffectObserver = undefined/gu)).toHaveLength(2)
    // ومصدرُ الإبطال واحد: لا نسخةَ ثانية من شرط «كتابةٌ تُسقط الشهادة».
    expect(source.match(/const invalidateAcceptanceFor = /gu)).toHaveLength(1)
  })
})

describe("S13.5 — أثرُ الأب لا يرجع بحقبة الطفل", () => {
  const parentTurn = (childFrames: readonly Record<string, unknown>[]) => {
    let store = Trajectory.empty()
    store = Trajectory.fold(store, { kind: "tool", turnId: "t1", cmd: "run npm test", epoch: 7 }, 1)
    store = Trajectory.fold(store, { kind: "tool-result", turnId: "t1", cmd: "run npm test", output: "ok", epoch: 7 }, 2)
    for (const frame of childFrames) store = Trajectory.fold(store, frame, 3)
    return store.turns.get("t1")!
  }

  test("العطلُ القديم بنصّه: إطارٌ بحقبة الطفل يرجع بالأثر ويترك صفّاً مفتوحاً أبداً", () => {
    const trace = parentTurn([1, 2, 3].map((e) => ({ kind: "tool", turnId: "t1", cmd: `delegate reviewer · حقبة ${e}`, epoch: e })))
    expect(trace.lastEpoch).toBe(3)
    expect(trace.tools.filter((r) => r.endedAt === undefined)).toHaveLength(3)
  })

  test("والشكلُ الحاليّ: حقبةُ الأب في الحقل، وحقبةُ الطفل في النصّ، وكلُّ صفٍّ مُغلَق", () => {
    const frames: Record<string, unknown>[] = []
    for (const e of [1, 2, 3]) {
      const cmd = `delegate reviewer · حقبة ${e}`
      frames.push({ kind: "tool", turnId: "t1", cmd, epoch: 7 })
      frames.push({ kind: "tool-result", turnId: "t1", cmd, output: `بدأت حقبة ${e}`, epoch: 7 })
    }
    const trace = parentTurn(frames)
    expect(trace.lastEpoch).toBe(7)
    expect(trace.tools.every((r) => r.endedAt !== undefined)).toBe(true)
    expect(trace.tools.every((r) => r.epoch === 7)).toBe(true)
  })

  test("والقشرةُ تبثّ هذا الشكل بالضبط", () => {
    expect(source).toContain("emit({ kind: \"tool\", turnId, cmd, epoch: parentEpoch })")
    expect(source).toContain("emit({ kind: \"tool-result\", turnId, cmd, output: `بدأت حقبة ${childEpoch} من حِقب الوكيل «${agent.name}»`, epoch: parentEpoch })")
    expect(source).toContain("parentEpoch = epoch")
  })
})

describe("S13.5 — الأدواتُ الخارجيّة: تُعلَن وتُستدعى، وصيغتُها منسوبة", () => {
  test("مزوّدٌ يكتب صيغته بمفرداته العارية لا يُسقط الدور", () => {
    const tool = normalise("gh", { name: "issue", usage: "issue <رقم>", summary: "يفتح مسألة", effect: "read" })!
    expect(tool.name).toBe("gh.issue")
    // قبل الإصلاح كانت `usage` تبقى «issue <رقم>» فيرمي الهارنس على أوّل نداء.
    expect(tool.usage).toBe("gh.issue <رقم>")
    const ollama = Providers.provider("ollama")!
    const built = Providers.prepareChatRequest({
      provider: ollama,
      model: "qwen9b-gpu-32k:latest",
      system: "س",
      messages: [{ role: "user", content: "س" }],
      tools: [{ legalName: tool.name, usage: tool.usage, description: tool.summary, parameters: { type: "object", properties: {}, required: [] } }],
      stream: false,
    })
    expect(built.body.length).toBeGreaterThan(0)
  })

  test("والتطبيعُ صريحٌ في حالاته: بلا صيغةٍ، وبصيغةٍ منسوبةٍ أصلاً، وبصيغةٍ فارغة", () => {
    expect(normalise("p", { name: "ping" })!.usage).toBe("p.ping <معطيات>")
    expect(namespacedUsage("p.ping", "p.ping <x>")).toBe("p.ping <x>")
    expect(namespacedUsage("p.ping", "ping")).toBe("p.ping")
    expect(namespacedUsage("p.ping", "   ")).toBe("p.ping")
    // وكلُّ ناتجٍ يصلح للهارنس: يساوي الاسم أو يبدأ به وفراغ.
    for (const raw of ["ping", "ping <x>", "", "  do a thing  ", "p.ping"]) {
      const built = namespacedUsage("p.ping", raw)
      expect(built === "p.ping" || built.startsWith("p.ping ")).toBe(true)
    }
  })

  test("والمُعلَنُ يُستدعى: منفذُ الحلقة يعرف الاسم المنسوب كما يعرفه المُوزِّع", () => {
    // السجلُّ الواحد لا يعرف الأسماء المنقّطة — فبدون الفرع الثاني كانت
    // الحلقة ترفض اسماً عرضته رسالةُ النظام في الطلب نفسه.
    expect(ProductTools.agentCallable("gh.issue")).toBe(false)
    expect(source).toContain("isCallable: (toolName) => Tools.agentCallable(toolName) || externalTool(toolName) !== undefined,")
  })
})

describe("S13.5 — نثرُ رسالة النظام يساوي المُعلَن", () => {
  const READ_ONLY = ["read", "list", "glob", "grep", "git", "recall"]
  const FULL = ["read", "list", "glob", "grep", "write", "edit", "run"]

  test("وكيلٌ قراءةً-فقط لا يُقال له إنّ write وrun من أدواته", () => {
    for (const planning of [true, false]) {
      const text = toolVocabulary(READ_ONLY, planning) + terminalDialectLine(READ_ONLY)
      expect(text).not.toContain("write")
      expect(text).not.toContain("run")
      expect(text).toContain("read")
      expect(text).toContain("recall")
    }
  })

  test("وسقفُ الدور الكامل يبقى يحمل ما كان يحمله", () => {
    const text = toolVocabulary(FULL, false) + terminalDialectLine(FULL)
    expect(text).toContain("«نفّذ: write <ملف> <<<»")
    expect(text).toContain("«نفّذ: run <الأمر>»")
    expect(text).toContain("Windows PowerShell 5.1")
    expect(text).toContain("الأدوات المسجلة لك: read وlist وglob وgrep وwrite وedit وrun.")
  })

  test("والقائمةُ مشتقّة: أداةٌ تدخل الإعلان تظهر، وستّةُ الأسماء المكتوبة باليد رُفعت", () => {
    expect(toolVocabulary([...FULL, "gh.issue"], false)).toContain("وgh.issue.")
    expect(toolVocabulary([], false)).toContain("لا أداةَ معلَنةً لك")
    expect(source).toContain("const advertisedNames = toolDefinitions.map((tool) => tool.legalName)")
    // S1 (09-17): النثرُ يُشتقّ في المُركِّب من `advertised` الذي يمرّره cli.ts من المُعلَن نفسِه.
    expect(source).toContain("advertised: advertisedNames,")
    expect(composer).toContain("toolVocabulary(input.advertised, planningPhase) +")
    expect(composer).toContain("terminalDialectLine(input.advertised) +")
    expect(source).not.toContain("الأدوات الأساسية المسجلة: list وglob وgrep وwrite وedit وrun")
  })
})

describe("S13.5 — الصيغةُ تحمل مفرداتها", () => {
  test("وكلاءُ التفويض يُعلَنون مع الأداة لا بعد رفضٍ يحرق جولة", () => {
    // الصيغةُ **المُوجَزة**: الكاملةُ بلغت 728 حرفاً وسقفُ هيئة qwen 512،
    // والهيئةُ تُسقط الأداةَ كلَّها بدل أن تقصّ الوصف — فكانت `delegate` تختفي
    // من الكتالوج كلّما فُعِّل مفتاحُها. والوكلاءُ ما زالوا يُعلَنون **مع**
    // الأداة، وهو ما يقيسه هذا الفحص.
    expect(source).toContain("description: tool.name === DELEGATE_TOOL ? `${tool.summary}\\nالوكلاء المتاحون:\\n${describeAgentsBrief(delegableAgents())}` : tool.summary,")
    // والمرشّحُ نفسه الذي يحكم التوزيع (`plugins.reviewer` مطبَّقٌ فيه).
    // هـ2: team تقرأ الكتالوجَ نفسَه (بعد مفاتيح الإضافات) — ثلاثةُ مواضع لا اثنان.
    expect(source.match(/delegableAgents\(\)/gu)).toHaveLength(3)
  })
})
