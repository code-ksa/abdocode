/**
 * م11 — علامةُ الأمر المكسورة (مقيس 09-14 على super-120b عبر NIM): الردُّ «نفّ�: image renders/shot_01.png» — حرفُ «ذ» صار
 * U+FFFD — فحكم المحلّلُ «ردٌّ بلا أداة» وأنهى الدورَ. الآن تُشفى العلامةُ في صدر السطر فقط، وتُنفَّذ الأداة؛ والتوأمُ السلبيّ:
 * U+FFFD في وسط نصٍّ لا يصنع أمراً.
 */
import { describe, expect, test } from "bun:test"
import { runTextAgentLoop } from "../src"
import { healCallMarker } from "../src/text-agent-loop"

const drive = async (replies: readonly string[]) => {
  const script = [...replies, "تم"]
  const dispatched: string[] = []
  const result = await runTextAgentLoop({
    input: "راجع الصور", history: [], maxRounds: 6,
    ask: async () => script.shift()!,
    dispatch: async (command) => { dispatched.push(command); return "✓ ok" },
    isCallable: (name: string) => ["image", "read", "list"].includes(name),
  })
  return { result, dispatched }
}

describe("broken call marker", () => {
  test("healCallMarker repairs a leading «نفّ�:» (with or without shadda, bold or bullet) and leaves other text alone", () => {
    expect(healCallMarker("نفّ�: image renders/shot_01.png")).toBe("نفّذ: image renders/shot_01.png")
    expect(healCallMarker("نف� : list .")).toBe("نفّذ: list .")
    expect(healCallMarker("**نفّ�: read a.ts**")).toBe("**نفّذ: read a.ts**")
    expect(healCallMarker("- نفّ�: list .")).toBe("- نفّذ: list .")
    expect(healCallMarker("قرأتُ نفّ�: شيئاً في الوسط")).toBe("قرأتُ نفّ�: شيئاً في الوسط")
    expect(healCallMarker("نفّذ: image x.png")).toBe("نفّذ: image x.png")
  })
  test("the loop dispatches a reply whose only line is the broken marker (measured failure) — and completes after", async () => {
    const { result, dispatched } = await drive(["نفّ�: image renders/shot_01.png"])
    expect(dispatched).toEqual(["image renders/shot_01.png"])
    expect(result.stopReason).toBe("complete")
  })
})
