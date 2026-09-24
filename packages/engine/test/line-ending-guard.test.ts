/**
 * حارسُ نهايات الأسطر — ولكلّ منعٍ توأمُه الإيجابيّ، وإلّا كان يشتكي من كلّ كتابة.
 *
 * العيبُ المقيس ليس اختيارَ النهاية بل **خلطَها في ملفٍّ واحد**: وقع في المختبر جولةٍ حيّة
 * وفي هذا المستودع نفسِه.
 */
import { describe, expect, test } from "bun:test"
import { lineEndingViolation, readEol } from "../src/line-ending-guard"

const crlf = (n: number) => Array.from({ length: n }, (_, i) => `سطر ${i}`).join("\r\n") + "\r\n"
const lf = (n: number) => Array.from({ length: n }, (_, i) => `سطر ${i}`).join("\n") + "\n"

describe("العدُّ بالبايتات لا بالتقسيم", () => {
  test("النقيُّ يُقرأ نقيّاً، والمختلطُ يُسمّى", () => {
    expect(readEol(crlf(5))).toEqual({ style: "crlf", crlf: 5, lone: 0 })
    expect(readEol(lf(5))).toEqual({ style: "lf", crlf: 0, lone: 5 })
    expect(readEol("أ\r\nب\nج\r\n")).toEqual({ style: "mixed", crlf: 2, lone: 1 })
    expect(readEol("بلا سطر").style).toBe("none")
  })
})

describe("🔴 الخلطُ يُقال بالأرقام — كي يُصلَح بسطرٍ لا بإعادة ترميز", () => {
  test("ملفٌّ كان نقيَّ CRLF فدخله سطرٌ بـLF", () => {
    const after = crlf(10).replace("سطر 4\r\n", "سطر 4\n")
    const why = lineEndingViolation("rules/patterns.js", after, crlf(10))
    expect(why).toBeDefined()
    expect(why!).toContain("مختلطة")
    expect(why!).toContain("rules/patterns.js")
    expect(why!).toContain("نقيَّ CRLF")   // ما كان يُقال، فالاتّجاهُ معروف
    expect(why!).toContain("1 LF عارية")
  })

  test("والعكسُ: ملفٌّ نقيُّ LF دخله CRLF — العيبُ نفسُه في الاتجاه الآخر", () => {
    const after = lf(10).replace("سطر 4\n", "سطر 4\r\n")
    const why = lineEndingViolation("src/cli.ts", after, lf(10))
    expect(why).toBeDefined()
    expect(why!).toContain("1 CRLF")
    expect(why!).toContain("نقيَّ LF")
  })

  test("وملفٌّ جديدٌ مختلطٌ يُقال أيضاً — بلا سابقٍ يُخالَف", () => {
    const why = lineEndingViolation("new.ts", "أ\r\nب\n")
    expect(why).toBeDefined()
    expect(why!).toContain("مختلطة")
    expect(why!).not.toContain("قبل كتابتك")
  })
})

describe("التوأمُ الإيجابيّ: ما يجب أن يمرّ", () => {
  test("النقيُّ يمرّ في الاتجاهين، والملفُّ الجديدُ النقيُّ يمرّ", () => {
    expect(lineEndingViolation("a.ts", crlf(9), crlf(4))).toBeUndefined()
    expect(lineEndingViolation("b.ts", lf(9), lf(4))).toBeUndefined()
    expect(lineEndingViolation("c.ts", crlf(3))).toBeUndefined()
    expect(lineEndingViolation("d.ts", lf(3))).toBeUndefined()
  })

  test("وملفٌّ بلا أسطرٍ لا يُحكم عليه", () => {
    expect(lineEndingViolation("e.txt", "سطرٌ واحدٌ بلا نهاية", "آخرُ بلا نهاية")).toBeUndefined()
  })

  test("🔴 وتحويلُ الملفّ كلِّه يُقال **معلوماتيّاً** لا تحذيراً — قد يكون مقصوداً", () => {
    const why = lineEndingViolation("f.ts", lf(6), crlf(6))
    expect(why).toBeDefined()
    expect(why!.startsWith("ℹ")).toBe(true)
    expect(why!).toContain("CRLF")
    expect(why!).toContain("LF")
    // والخلطُ تحذيرٌ لا معلومة: التمييزُ مقصود.
    expect(lineEndingViolation("g.ts", "أ\r\nب\n", crlf(2))!.startsWith("⚠")).toBe(true)
  })
})

describe("🔴 الرسالةُ تسدّ الطريقَ الخطأ — مقيسٌ حيّاً 09-24", () => {
  test("تنهى عن إعادة ترميز الملفّ كلِّه، وتعطي العدَّ الذي يُتحقّق به", () => {
    // قِيس: النموذجُ قرأ «أصلِح سطراً واحداً» ثمّ حوّل الملفَّ كلَّه إلى LF — فاستبدل
    // العيبَ بعيبٍ مثله. فصار النهيُ صريحاً والتحقّقُ بالعدّ مذكوراً.
    const after = crlf(6).replace("سطر 3\r\n", "سطر 3\n")
    const why = lineEndingViolation("config.ini", after, crlf(6))!
    expect(why).toContain("ولا تُعِد ترميزَ الملفّ كلِّه")
    expect(why).toContain("6 CRLF و0")   // العدُّ المطلوب بعد الإصلاح
    expect(why).toContain("**وحدها**")
  })

  test("وفي الاتّجاه الآخر يُنهى عن التحويل إلى CRLF", () => {
    const after = lf(6).replace("سطر 3\n", "سطر 3\r\n")
    expect(lineEndingViolation("src/cli.ts", after, lf(6))!).toContain("ولا تُعِد ترميزَ الملفّ كلِّه إلى CRLF")
  })
})
