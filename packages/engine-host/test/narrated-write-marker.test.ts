/**
 * 09-30 — مقيس على مهمّة «أكمل موقع OpenRouter»: خطّةُ السبرنتات كُتبت كاملةً في ردٍّ يبدأ بـ«⚙ write ABDO-SPRINTS.md <<<»
 * فرُفض سطرَ سجلّ وضاعت. الردُّ الذي يبدأ بـ`⚙ write <ملف> <<<` وحمولتُه ثلاثةُ أسطرٍ فأكثر يُنفَّذ؛ وإيصالٌ منسوخ (سطرٌ واحد) لا.
 */
import { describe, expect, test } from "bun:test"
import { runTextAgentLoop } from "../src"
import { healNarratedWrite } from "../src/text-agent-loop"

const drive = async (replies: readonly string[]) => {
  const script = [...replies, "تم"]
  const dispatched: string[] = []
  await runTextAgentLoop({
    input: "اكتب الخطّة", history: [], maxRounds: 6,
    ask: async () => script.shift()!,
    dispatch: async (command) => { dispatched.push(command); return "✓ ok" },
    isCallable: (name: string) => ["write", "read", "run"].includes(name),
  })
  return dispatched
}

const PLAN = "⚙ write ABDO-SPRINTS.md <<< # ABDO-SPRINTS.md — خطة تنفيذ OpenRouter Clone\n## سبرنت 1 — الشريط العلويّ\n- المعيار: الصفحة 200\n## سبرنت 2 — صفحة النموذج\n- المعيار: npm run build ✓"

describe("a whole write narrated with the receipt glyph", () => {
  test("the measured reply is executed as the write it is", async () => {
    const dispatched = await drive([PLAN])
    expect(dispatched.length).toBe(1)
    expect(dispatched[0]!.startsWith("write ABDO-SPRINTS.md <<<")).toBe(true)
    expect(dispatched[0]).toContain("## سبرنت 2 — صفحة النموذج")
  })

  test("measured on installed 4.0.98: a broken character before the glyph («�⚙», «��⚙», ⚙️) does not hide the write", async () => {
    const body = "\nimport * as React from 'react'\nimport { cva } from 'class-variance-authority'\nexport function Badge() { return null }"
    for (const head of ["\uFFFD⚙ write src/components/ui/badge.tsx <<<", "\uFFFD\uFFFD⚙ write src/components/ui/avatar.tsx <<<", "⚙\uFE0F write src/components/ui/separator.tsx <<<", "\u200F⚙ write a.tsx <<<"]) {
      const dispatched = await drive([head + body])
      expect(dispatched.length).toBe(1)
      expect(dispatched[0]!.startsWith("write ")).toBe(true)
    }
    expect(healNarratedWrite("\uFFFD⚙ write a.md <<< # only the receipt line")).toBe("\uFFFD⚙ write a.md <<< # only the receipt line")
  })

  test("the twin: a copied write receipt (first line only) is never executed — it would wipe the file", async () => {
    expect(healNarratedWrite("⚙ write ABDO-SPRINTS.md <<< # ABDO-SPRINTS.md — خطة")).toBe("⚙ write ABDO-SPRINTS.md <<< # ABDO-SPRINTS.md — خطة")
    expect(healNarratedWrite("⚙ write a.md <<< # t\none line")).toBe("⚙ write a.md <<< # t\none line")
    expect(await drive(["⚙ write ABDO-SPRINTS.md <<< # ABDO-SPRINTS.md — خطة"])).toEqual([])
  })

  test("other receipt glyph lines stay refused, and a glyph in the middle of prose is not a call", async () => {
    expect(await drive(["⚙ run npm test\n✓ 12 pass\nline\nline"])).toEqual([])
    const prose = "كتبتُ الخطّة:\n⚙ write PLAN.md <<<\n# a\n# b\n# c"
    expect(healNarratedWrite(prose)).toBe(prose)
  })
})
