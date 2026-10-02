/**
 * 10-01 — سبرنتٌ مفتوح يُقرأ ولا يُكتب. مقيس: دورٌ واحد 46 قراءةً بلا كتابة انتهى «duplicate»، ثمّ حقبتان بأداةٍ صفر لأنّ أوّلَ
 * نداءٍ فيهما قراءةٌ مكرَّرة بعد نفاد الإعادة. الخيارُ `writeNudge`: سطرٌ يلحق القراءةَ عند العتبة ثمّ كلَّ `every`، وإشارةٌ
 * قصيرة للمكرَّر بدل قطع الحقبة — والغيابُ = الحلقةُ القديمة بايتاً.
 */
import { describe, expect, test } from "bun:test"
import { duplicatePointerLine, runTextAgentLoop, shownRead, unchangedReadLine, writeNudgeLine, type TextAgentLoopOptions } from "@abdo/engine-host"

const cliSource = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

const drive = async (replies: readonly string[], extra: Partial<TextAgentLoopOptions> = {}) => {
  const dispatched: string[] = []
  const prompts: string[] = []
  const queue = [...replies]
  const result = await runTextAgentLoop({
    input: "اكمل", history: [], maxRounds: 40,
    isCallable: (name) => ["read", "list", "write", "run"].includes(name),
    ask: async (prompt) => { prompts.push(prompt); return queue.shift() ?? "تم" },
    dispatch: async (command) => { dispatched.push(command); return command.startsWith("write") ? "كُتب الملفّ" : `محتوى ${command}` },
    ...extra,
  })
  return { dispatched, prompts, result }
}
const reads = (n: number, from = 1): string[] => Array.from({ length: n }, (_, i) => `نفّذ: read f${from + i}.ts`)
const NUDGE = { after: 3, every: 2, prior: 0, pointerBudget: 2 }

describe("write nudge — reads in a row without a write", () => {
  test("without the option the prompts carry no nudge and the result has no new fields", async () => {
    const { prompts, result } = await drive(reads(6))
    expect(prompts.some((p) => p.includes("قراءةً متتالية"))).toBe(false)
    expect("readsWithoutWrite" in result).toBe(false)
    expect("duplicatePointers" in result).toBe(false)
  })

  test("the line joins the read result at the threshold and then every `every` reads", async () => {
    // مقيس حيّاً: «اكتب الآن» وحدها أُجيبت نثراً — السطرُ يطلب الاستدعاءَ نفسَه.
    expect(writeNudgeLine(15)).toContain("ردُّك التالي استدعاءٌ واحد يكتب (نفّذ: edit أو write أو patch)")
    const { prompts, result } = await drive(reads(7), { writeNudge: NUDGE })
    // prompts[0] هو الإدخال؛ prompts[i] نتيجةُ القراءة i.
    const nudged = prompts.map((p, i) => (p.includes(writeNudgeLine(i)) ? i : -1)).filter((i) => i > 0)
    expect(nudged).toEqual([3, 5, 7])
    expect(result.readsWithoutWrite).toBe(7)
  })

  test("a write resets the streak, and the prior streak from earlier epochs counts", async () => {
    const reset = await drive([...reads(2), "نفّذ: write a.ts <<<\nx", ...reads(3, 10)], { writeNudge: NUDGE })
    expect(reset.result.readsWithoutWrite).toBe(3)
    expect(reset.prompts.some((p) => p.includes(writeNudgeLine(3)))).toBe(true)
    expect(reset.prompts.some((p) => p.includes(writeNudgeLine(4)))).toBe(false)
    // مقيس: 13 قراءة ثمّ بناءٌ ثمّ 10 قراءات — البناءُ ليس كتابةً فلا يصفّر.
    const built = await drive([...reads(2), "نفّذ: run npm run build", ...reads(1, 10)], { writeNudge: NUDGE })
    expect(built.result.readsWithoutWrite).toBe(3)
    expect(built.prompts.some((p) => p.includes(writeNudgeLine(3)))).toBe(true)
    const carried = await drive(reads(1), { writeNudge: { ...NUDGE, prior: 14, after: 15 } })
    expect(carried.prompts[1]).toContain(writeNudgeLine(15))
  })
})

describe("write nudge — a repeated read after the replays run out", () => {
  test("gets a short pointer within its budget instead of ending the epoch, then «duplicate» as before", async () => {
    const same = Array.from({ length: 5 }, () => "نفّذ: read a.ts")
    const { dispatched, prompts, result } = await drive(same, { writeNudge: NUDGE, duplicateReplay: { budget: 0 } })
    expect(dispatched).toEqual(["read a.ts"])
    expect(prompts.filter((p) => p.includes(duplicatePointerLine("read a.ts"))).map((p) => p.slice(-5))).toEqual(["(1/2)", "(2/2)"])
    expect(result.duplicatePointers).toBe(2)
    expect(result.stopReason).toBe("duplicate")
    // التوأم: بلا الخيار يقطع المكرَّرُ الحقبةَ بعد إعادة القراءة الموثّقة مرّةً — بلا إشارة.
    const legacy = await drive(same, { duplicateReplay: { budget: 0 } })
    expect(legacy.prompts.some((p) => p.includes("نفدت إعادةُ الإيصالات"))).toBe(false)
    expect(legacy.prompts.length).toBeLessThan(prompts.length)
    expect(legacy.result.stopReason).toBe("duplicate")
  })
})

describe("write nudge — an unchanged file re-read after a build", () => {
  // مقيس 10-02: البناءُ يقدّم الجيلَ فلا تُعدّ القراءةُ مكرَّرة — والنموذجُ أعاد قراءةَ الخطّة والملفّاتِ نفسِها كلَّ حقبة.
  const body = (tag: string) => `${tag} ${"سطرٌ من الملفّ ".repeat(80)}`
  const run = (outputs: Record<string, string[]>, replies: readonly string[], extra: Partial<TextAgentLoopOptions> = {}) =>
    drive(replies, {
      dispatch: async (command) => (command.startsWith("run") ? "✓ build ok" : outputs[command]!.shift()!),
      ...extra,
    })
  const replies = ["نفّذ: read plan.md", "نفّذ: run npm run build", "نفّذ: read plan.md"]

  test("the same bytes after a build come back as a short line, not the file again — the dispatch still ran", async () => {
    const outputs = { "read plan.md": [body("A"), body("A")] }
    const { prompts } = await run(outputs, replies, { writeNudge: NUDGE })
    expect(outputs["read plan.md"]).toEqual([]) // القراءتان نُفّذتا فعلاً: السطرُ يبدّل ما يُعرض لا التنفيذ
    expect(prompts[3]).toContain(unchangedReadLine("read plan.md"))
    expect(prompts[3]).not.toContain(body("A").slice(0, 400))
  })

  test("twins: changed bytes, no option, or the earlier text not in context ⇒ the full file", async () => {
    // التغييرُ في آخر الملفّ: البادئةُ ظاهرةٌ في السياق، فالمساواةُ بايتاً وحدها تمنع الإشارة.
    const changed = await run({ "read plan.md": [body("A"), `${body("A")} سطرٌ أُضيف`] }, replies, { writeNudge: NUDGE })
    expect(changed.prompts[3]).toContain("سطرٌ أُضيف")
    expect(changed.prompts[3]).not.toContain(unchangedReadLine("read plan.md"))
    const off = await run({ "read plan.md": [body("A"), body("A")] }, replies)
    expect(off.prompts[3]).toContain(body("A").slice(0, 400))
    // إيصالٌ سابق خارج السياق (قُصّ التاريخ): لا يُفترض أنّ النموذجَ يراه.
    const trimmed = await run({ "read plan.md": [body("A")] }, ["نفّذ: read plan.md"], {
      writeNudge: NUDGE,
      priorReceipts: [{ command: "read plan.md", output: body("A") }, { command: "run npm run build", output: "✓ build ok" }],
    })
    expect(trimmed.prompts[1]).toContain(body("A").slice(0, 400))
  })

  test("a carried receipt in the history counts as visible", async () => {
    const { prompts } = await run({ "read plan.md": [body("A")] }, ["نفّذ: read plan.md"], {
      writeNudge: NUDGE,
      history: [{ role: "assistant", content: `إيصالات القراءة المحفوظة للحقبة التالية:\nنتيجة موثقة لـ«read plan.md»:\n${body("A")}` }],
      priorReceipts: [{ command: "read plan.md", output: body("A") }, { command: "run npm run build", output: "✓ build ok" }],
    })
    expect(prompts[1]).toContain(unchangedReadLine("read plan.md"))
  })
})

describe("long reads — the cut is declared, and the cap follows the engine's read budget", () => {
  // مقيس 10-02: الخطّةُ (25 ألف حرف) قُصّت عند 14,000 وسط سطر بلا إعلان، فضاع «البقيّة: read …» الذي يكتبه المحرّك في آخرها.
  const long = Array.from({ length: 1200 }, (_, i) => `سطر ${i + 1} من الخطّة`).join("\n") + "\n…[قُصّ عند السطر 600 من 900 — البقيّة: read plan.md 601 900]"
  const once = (extra: Partial<TextAgentLoopOptions>) =>
    drive(["نفّذ: read plan.md"], { dispatch: async () => long, ...extra })

  test("past the default cap: cut at a line end and the cut is named — never mid-line and silent", async () => {
    const { prompts } = await once({})
    const shown = shownRead(long)
    expect(shown.length).toBeLessThan(long.length)
    expect(shown).toContain(`حرفاً من ${long.length} — ما بعده لم يُعرض`)
    expect(shown.split("\n…[عُرض")[0]!.endsWith("من الخطّة")).toBe(true)
    expect(prompts[1]).toContain(shown)
  })

  test("with readShowChars above the output the engine's own «rest: read …» line reaches the model", async () => {
    const { prompts } = await once({ readShowChars: long.length + 100 })
    expect(prompts[1]).toContain("البقيّة: read plan.md 601 900")
    expect(prompts[1]).not.toContain("ما بعده لم يُعرض")
  })

  test("a read batch is cut the same way", async () => {
    const { prompts } = await drive(["نفّذ: read plan.md\nنفّذ: read notes.md"], { dispatch: async () => long })
    expect(prompts[1]).toContain("هذه آخرُ نتائج حزمة القراءة")
    expect(prompts[1]).toContain(shownRead(long))
  })

  test("a short read is byte for byte as before", () => {
    expect(shownRead("قصير")).toBe("قصير")
  })

  test("cli passes the cap from its read budget", () => {
    expect(cliSource).toContain("readShowChars: Math.max(14_000, readBudgetChars() + 1_000),")
  })
})

describe("wiring", () => {
  test("only an open sprint gets it, behind its own switch, with the streak and pointer budget carried across epochs", () => {
    expect(cliSource).toContain('...(sprintFocusText.length > 0 && plugins.read("writeNudge", "epoch", epoch)')
    // مقيس حيّاً: sprintPlanPending = «خطّةُ السبرنتات غائبة»، فالخيارُ كان مطفأً في كلّ سبرنتٍ مفتوح — الشرطُ نصُّ السبرنت الجاري.
    expect(cliSource).not.toContain('sprintPlanPending && plugins.read("writeNudge"')
    expect(cliSource).toContain('const sprintPlanPending = !sprintPlanReady(')
    expect(cliSource).toContain("prior: readsWithoutWrite, pointerBudget: Math.max(0, WRITE_NUDGE.pointers - duplicatePointersUsed)")
    expect(cliSource).toContain("readsWithoutWrite = loop.readsWithoutWrite ?? 0")
    expect(cliSource).toContain("duplicatePointersUsed += loop.duplicatePointers ?? 0")
    // مقيس: دورٌ كامل لم يُعرف أكان الخيارُ حيّاً — إيصالُه في سطر الحقبة حين يعمل، وغيابُه غيابُ الخيار.
    expect(cliSource).toContain("${loop.readsWithoutWrite === undefined ? \"\" : ` · قراءات بلا كتابة=${loop.readsWithoutWrite} · إشارات المكرَّر=${loop.duplicatePointers ?? 0}`}")
    expect(cliSource).toContain("const WRITE_NUDGE = { after: 15, every: 10, pointers: 4 } as const")
  })
})
