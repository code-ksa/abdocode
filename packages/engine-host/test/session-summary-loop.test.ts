import { describe, expect, test } from "bun:test"
import { SUMMARY_HEAD, SUMMARY_LABELS, SUMMARY_WITH_COMMAND, runTextAgentLoop, type TextAgentMessage } from "../src"

const block = (lines: readonly string[]): string => [SUMMARY_HEAD, ...lines].join("\n")

type Captured = { prompt: string; history: TextAgentMessage[] }

/** يشغّل الحلقة على ردودٍ مكتوبة سلفاً — بلا نموذج حيّ — ويعدّ نداءات ask. */
const run = async (replies: readonly string[], sessionSummary: boolean) => {
  const queue = [...replies]
  const calls: Captured[] = []
  const rejections: string[] = []
  const result = await runTextAgentLoop({
    input: "اكتب الصفحة",
    history: [],
    maxRounds: 8,
    ask: async (prompt, history) => { calls.push({ prompt, history: [...history] }); return queue.shift() ?? "تم" },
    dispatch: async (command) => `✍ نُفّذ «${command.split("\n", 1)[0]}»\nانتهى الأمر برمز 0`,
    isCallable: (name) => name === "write" || name === "read",
    onProposalRejected: (why) => { rejections.push(why) },
    ...(sessionSummary ? { sessionSummary: true as const } : {}),
  })
  return { result, calls, rejections }
}

describe("S13.1 في الحلقة — الرفع قبل تحليل الأمر، وبلا نداء إضافي", () => {
  const closing = `أنجزت الخطوة.\n${block([
    `${SUMMARY_LABELS.done}: كتبت app/page.tsx`,
    `${SUMMARY_LABELS.decided}: أكمل بالتنسيق`,
  ])}`

  test("الكتلة تُرفع وتصل النتيجة، ولا تعود إلى النموذج في الأثر ولا في الذاكرة ولا في الجواب", async () => {
    const { result } = await run(["نفّذ: write app/page.tsx <<<\nx", closing], true)
    expect(result.summary).toEqual({
      done: ["كتبت app/page.tsx"],
      understood: [],
      decided: ["أكمل بالتنسيق"],
      blocked: [],
    })
    expect(result.answer).not.toContain(SUMMARY_HEAD)
    expect(result.memory[1].content).not.toContain(SUMMARY_HEAD)
    for (const message of result.continuation) expect(message.content).not.toContain(SUMMARY_HEAD)
    expect(result.stopReason).toBe("complete")
  })

  test("الجمعُ بين استدعاءٍ وخلاصة يُرفض باسمه — فلا حمولةَ تُبتر ولا خلاصةَ تُخزَّن", async () => {
    const combined = `نفّذ: write app/page.tsx <<<\nx\n${block([`${SUMMARY_LABELS.done}: كتبت app/page.tsx`])}`
    const { result, rejections } = await run([combined, "تم"], true)
    expect(rejections).toContain(SUMMARY_WITH_COMMAND)
    expect(result.summary).toBeUndefined()
    expect(result.commands).toEqual([])
  })

  test("المعطَّل = الإرث حرفياً: النتيجة نفسها بايتاً بلا حقل summary", async () => {
    const replies = ["نفّذ: write app/page.tsx <<<\nx", closing]
    const on = await run(replies, true)
    const off = await run(replies, false)
    expect(off.result.summary).toBeUndefined()
    // الفرقُ الوحيد هو الكتلة المرفوعة — كلُّ ما عداها مطابق.
    expect(off.result.answer).toContain(SUMMARY_HEAD)
    expect(off.result.commands).toEqual(on.result.commands)
    expect(off.result.stopReason).toBe(on.result.stopReason)
    expect(off.result.trailChars).toBeGreaterThanOrEqual(on.result.trailChars)
  })

  test("ردٌّ بلا كتلة: المفعَّل والمعطَّل متطابقان بايتاً في كل حقل", async () => {
    const replies = ["نفّذ: read app/page.tsx", "تمّت القراءة."]
    const on = await run(replies, true)
    const off = await run(replies, false)
    expect(on.result.answer).toBe(off.result.answer)
    expect(on.result.memory).toEqual(off.result.memory)
    expect(on.result.continuation).toEqual(off.result.continuation)
    expect(on.result.summary).toBeUndefined()
  })
})

describe("S13.1 — إثباتُ الكلفة: صفرُ نداءٍ إضافيّ", () => {
  test("عددُ نداءات ask متطابقٌ بين المفعَّل والمعطَّل على الردود نفسها", async () => {
    const scripts: readonly (readonly string[])[] = [
      ["تم"],
      [`تم\n${block([`${SUMMARY_LABELS.done}: كتبت a.ts`])}`],
      ["نفّذ: write a.ts <<<\nx", `انتهيت\n${block([`${SUMMARY_LABELS.done}: كتبت a.ts`])}`],
      ["نفّذ: write a.ts <<<\nx", "نفّذ: read a.ts", `انتهيت\n${block([`${SUMMARY_LABELS.done}: كتبت a.ts`, `${SUMMARY_LABELS.blocked}: لا مانع`])}`],
    ]
    const measured: { on: number; off: number }[] = []
    for (const script of scripts) {
      const on = await run(script, true)
      const off = await run(script, false)
      measured.push({ on: on.calls.length, off: off.calls.length })
    }
    // القياس، لا الادّعاء: النداءات متساوية في كل سيناريو.
    expect(measured.map((m) => m.on)).toEqual(measured.map((m) => m.off))
    expect(measured.map((m) => m.on)).toEqual([1, 1, 2, 3])
  })

  test("الكتلة تركب الردّ نفسه: نداءُ الحقبة الأخير هو الذي حملها", async () => {
    const { result, calls } = await run([`تم\n${block([`${SUMMARY_LABELS.done}: كتبت a.ts`])}`], true)
    expect(calls).toHaveLength(1)
    expect(result.summary?.done).toEqual(["كتبت a.ts"])
  })
})
