import { describe, expect, test } from "bun:test"
import { runTextAgentLoop } from "../src"

/**
 * 10-11 (مقيس على مهمّة CRM: 6 من 16 تصحيحاً كانت «أداة القراءة تقبل سطراً واحداً»، كلٌّ نداءٌ كامل ~11 ث) — سطرُ قراءةٍ تامٌّ يليه شرح.
 * القراءةُ بلا أثرٍ جانبيّ، فيُنفَّذ سطرُها الأوّل بدل ردّه إلى النموذج. والتشغيلُ (run) يبقى صارماً: سطرٌ أوّلُ من برنامجٍ متعدّد الأسطر قد يُنفَّذ ناقصاً.
 */
const drive = async (replies: readonly string[]) => {
  const script = [...replies, "تم"]
  const dispatched: string[] = []
  const prompts: string[] = []
  await runTextAgentLoop({
    input: "اقرأ الملفّات ثمّ أصلح الخلل", history: [], maxRounds: 6,
    ask: async (prompt) => { prompts.push(prompt); return script.shift()! },
    dispatch: async (command) => { dispatched.push(command); return "✓ ok" },
    isCallable: (name) => ["read", "list", "glob", "grep", "run", "write"].includes(name),
  })
  return { dispatched, prompts }
}

describe("a complete read line followed by prose is executed, not bounced back", () => {
  test("the read runs once, with no correction round-trip", async () => {
    const { dispatched, prompts } = await drive(["نفّذ: read src/routes/deals.ts 1 120\nسأبحث هنا عن مسار move ثمّ أضيف السجلّ.\nالمحتوى المتوقّع: export const routes = ["])
    expect(dispatched).toEqual(["read src/routes/deals.ts 1 120"])
    expect(prompts.some((p) => p.includes("أداة القراءة تقبل سطر استدعاء واحداً"))).toBe(false)
  })

  test("list/glob/grep likewise", async () => {
    const { dispatched } = await drive(["نفّذ: grep \"moveDeal\" src\nأتوقّع مطابقتين."])
    expect(dispatched).toEqual(["grep \"moveDeal\" src"])
  })

  test("the twins: run with trailing lines is still refused (nothing executed), and an incomplete read line still is", async () => {
    const run = await drive(["نفّذ: run node -e \"console.log(1)\"\nثمّ سأشغّل الاختبارات"])
    expect(run.dispatched).toEqual([])
    expect(run.prompts.some((p) => p.includes("أداة run تقبل سطر أمر واحداً"))).toBe(true)
    const bare = await drive(["نفّذ: read\nsrc/routes/deals.ts"])
    expect(bare.dispatched).toEqual([])
  })
})
