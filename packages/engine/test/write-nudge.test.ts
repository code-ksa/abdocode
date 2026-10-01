/**
 * 10-01 — سبرنتٌ مفتوح يُقرأ ولا يُكتب. مقيس: دورٌ واحد 46 قراءةً بلا كتابة انتهى «duplicate»، ثمّ حقبتان بأداةٍ صفر لأنّ أوّلَ
 * نداءٍ فيهما قراءةٌ مكرَّرة بعد نفاد الإعادة. الخيارُ `writeNudge`: سطرٌ يلحق القراءةَ عند العتبة ثمّ كلَّ `every`، وإشارةٌ
 * قصيرة للمكرَّر بدل قطع الحقبة — والغيابُ = الحلقةُ القديمة بايتاً.
 */
import { describe, expect, test } from "bun:test"
import { duplicatePointerLine, runTextAgentLoop, writeNudgeLine, type TextAgentLoopOptions } from "@abdo/engine-host"

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

describe("wiring", () => {
  test("only an open sprint gets it, behind its own switch, with the streak and pointer budget carried across epochs", () => {
    expect(cliSource).toContain('...(sprintFocusText.length > 0 && plugins.read("writeNudge", "epoch", epoch)')
    // مقيس حيّاً: sprintPlanPending = «خطّةُ السبرنتات غائبة»، فالخيارُ كان مطفأً في كلّ سبرنتٍ مفتوح — الشرطُ نصُّ السبرنت الجاري.
    expect(cliSource).not.toContain('sprintPlanPending && plugins.read("writeNudge"')
    expect(cliSource).toContain('const sprintPlanPending = !sprintPlanReady(')
    expect(cliSource).toContain("prior: readsWithoutWrite, pointerBudget: Math.max(0, WRITE_NUDGE.pointers - duplicatePointersUsed)")
    expect(cliSource).toContain("readsWithoutWrite = loop.readsWithoutWrite ?? 0")
    expect(cliSource).toContain("duplicatePointersUsed += loop.duplicatePointers ?? 0")
    expect(cliSource).toContain("const WRITE_NUDGE = { after: 15, every: 10, pointers: 4 } as const")
  })
})
