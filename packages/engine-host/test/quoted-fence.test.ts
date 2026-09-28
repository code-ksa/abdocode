/**
 * الاقتباسُ ممّا قُرئ دليلٌ لا اختلاق (قياسٌ حيّ 2026-09-28): جوابٌ صحيحٌ اقتبس سطرَ AGENTS.md الذي قرأه في كتلةٍ مسيّجة
 * فرُفض «عرضتَ محتوى ملفٍّ بلا أداة» تسعَ مرّاتٍ حتى المهلة. والتوائم: كتلةٌ لم تُقرأ تبقى رفضاً، وادّعاءُ الكتابة يبقى رفضاً.
 */
import { expect, test } from "bun:test"
import { runTextAgentLoop } from "../src"
import { quotedOrExampleBlock } from "../src/text-agent-loop"

const FILE = "## القواعد\n- لا `git add -A` أبداً — أضف ملفاتك أنت وحدها\n- الدفع إلى main نشرٌ للإنتاج\n"

async function answerAfterRead(answer: string) {
  const answers = ["نفّذ: read AGENTS.md", answer]
  return runTextAgentLoop({
    input: "هل يجوز git add -A عندنا؟",
    history: [],
    // الرفضُ يطلب تصحيحاً: النموذجُ المكتوبُ يكرّر ردَّه الأخير.
    ask: async () => (answers.length > 1 ? answers.shift()! : answers[0]!),
    dispatch: async () => FILE,
    isCallable: () => true,
    maxRounds: 3,
  })
}

test("a fenced quote of what the turn read is an answer, not a fabricated file", async () => {
  const result = await answerAfterRead("لا — القاعدةُ في AGENTS.md:\n```\n- لا `git add -A` أبداً — أضف ملفاتك أنت وحدها\n```\nأضف ملفّاتك بأسمائها.")
  expect(result.stopReason).toBe("complete")
  expect(result.answer).toContain("أضف ملفّاتك بأسمائها")
})

test("a short command example in a fence is an answer too", async () => {
  const result = await answerAfterRead("لا. أضف ملفّاتك وحدها:\n```bash\ngit add src/a.ts src/b.ts\ngit commit -m \"…\"\n```")
  expect(result.stopReason).toBe("complete")
})

test("the twins: source the turn never read is still refused, and a write claim is still refused", async () => {
  const unread = await answerAfterRead("هذا هو الملف:\n```ts\nexport const guard = () => true\nexport default guard\n```")
  expect(unread.stopReason).toBe("invalid-command")
  const claim = await answerAfterRead("تم كتابة الملف بنجاح")
  expect(claim.stopReason).toBe("invalid-command")
})

test("the block rule itself: quote, example, neither", () => {
  expect(quotedOrExampleBlock("- الدفع إلى main نشرٌ للإنتاج\n", FILE)).toBe(true)
  expect(quotedOrExampleBlock("$ git status\n# ثمّ\nnpm test", "")).toBe(true)
  expect(quotedOrExampleBlock("- الدفع إلى main نشرٌ للإنتاج\n- سطرٌ لم يُقرأ قطّ", FILE)).toBe(false)
  expect(quotedOrExampleBlock("const x = 1", "")).toBe(false)
  expect(quotedOrExampleBlock("git a\ngit b\ngit c\ngit d\ngit e", "")).toBe(false)
})
