import { describe, expect, test } from "bun:test"
import { runTextAgentLoop } from "../src"

/**
 * مقيسٌ 2026-09-13 على التطبيق المثبَّت: كوين توكين بلان تحت القضبان الرفيعة كتب
 * «سأبدأ بإنشاء المشروع ثم تصفّح الموقع لتحليل بنيته.\n\n**نفّذ: project-create testawy**»
 * في حقبتين، فحكم المحلّل «ردٌّ بلا أداة» — صفرُ أدواتٍ والمهمّةُ انتهت وهي في أوّل خطوة.
 */
const drive = async (replies: readonly string[], callable = (name: string) => ["project-create", "read", "write"].includes(name)) => {
  const script = [...replies, "تم"]
  const dispatched: string[] = []
  const result = await runTextAgentLoop({
    input: "أنشئ مشروع testawy", history: [], maxRounds: 6,
    ask: async () => script.shift()!,
    dispatch: async (command) => { dispatched.push(command); return "✓ ok" },
    isCallable: callable,
  })
  return { result, dispatched }
}

describe("a tool call wrapped in Markdown, or preceded by a sentence, is still a tool call", () => {
  test("bold-wrapped call executes exactly once with the wrapper stripped", async () => {
    const { dispatched } = await drive(["**نفّذ: project-create testawy**"])
    expect(dispatched).toEqual(["project-create testawy"])
  })

  test("narration line + bold call (the measured Qwen reply) executes the call", async () => {
    const { dispatched } = await drive(["سأبدأ بإنشاء المشروع ثم تصفّح الموقع لتحليل بنيته.\n\n**نفّذ: project-create testawy**"])
    expect(dispatched).toEqual(["project-create testawy"])
  })

  test("bold prefix only, backticks, bullet, and a missing shadda are all unwrapped", async () => {
    const { dispatched } = await drive(["**نفّذ:** read README.md", "`نفّذ: read a.ts`", "- نفذ: read b.ts"])
    expect(dispatched).toEqual(["read README.md", "read a.ts", "read b.ts"])
  })

  test("twin: narration that claims a file was written, or carries a code fence, is still refused", async () => {
    const a = await drive(["تم إنشاء الملف index.html بنجاح.\n\nنفّذ: read index.html"])
    expect(a.dispatched).toEqual([])
    const b = await drive(["هذا المحتوى:\n```html\n<h1>x</h1>\n```\n\nنفّذ: write index.html <<<\n<h1>x</h1>"])
    expect(b.dispatched).toEqual([])
  })

  test("twin: two calls in one reply are still refused, and long essays before a call are not narration", async () => {
    const two = await drive(["نفّذ: read a.ts\nنفّذ: write b.ts <<<\nx"])
    expect(two.dispatched).toEqual([])
    const essay = await drive([Array.from({ length: 9 }, (_, i) => `سطر شرح رقم ${i}`).join("\n") + "\n\nنفّذ: read a.ts"])
    expect(essay.dispatched).toEqual([])
  })
})
