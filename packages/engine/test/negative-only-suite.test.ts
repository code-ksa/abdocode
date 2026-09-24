/**
 * سويتةٌ سلبيّةٌ كلُّها لا تحرس شيئاً — ومسامير الكشف عنها.
 *
 * قِيس على مشروعٍ حقيقيّ: أربعةُ اختباراتٍ كلُّها تؤكّد الغياب، فبقيت خضراءَ والحارسُ
 * معطَّلٌ بالكامل. وهذا الكاشفُ يمسك النمطَ في الدور الذي يُكتب فيه.
 *
 * ولكلّ منعٍ هنا **توأمُه الإيجابيّ** — وإلّا كان الكاشفُ يشتكي من كلّ ملفّ.
 */
import { describe, expect, test } from "bun:test"
import { MIN_ASSERTIONS, negativeOnlySuite, negativeSuiteNotice, readSuite } from "../src/negative-only-suite"

const BAD = `import { test } from "node:test"
import assert from "node:assert/strict"
import { isBlocked } from "../src/guard.js"

test("النصُّ العاديُّ يمرّ", () => { assert.equal(isBlocked("مرحباً"), false) })
test("نصٌّ عن الطقس يمرّ", () => { assert.equal(isBlocked("الجوُّ معتدل"), false) })
test("نصٌّ فارغ يمرّ", () => { assert.equal(isBlocked(""), false) })
test("ليس نصّاً", () => { assert.equal(isBlocked(null), false) })
`

const GOOD = `${BAD}
test("والممنوعُ يُمنع", () => { assert.equal(isBlocked("سبام"), true) })
`

describe("الكشفُ عن سويتةٍ سلبيّةٍ كلِّها", () => {
  test("🔴 أربعةُ تأكيداتٍ كلُّها غيابٌ ⇦ يُقال بالاسم وبالسبب", () => {
    const why = negativeOnlySuite("test/guard.test.js", BAD)
    expect(why).toBeDefined()
    expect(why!).toContain("test/guard.test.js")
    expect(why!).toContain("4")
    expect(why!).toContain("توأماً إيجابيّاً")
  })

  test("التوأمُ الإيجابيّ: تأكيدٌ واحدٌ يؤكّد الوجود يكفي لتمرّ", () => {
    expect(negativeOnlySuite("test/guard.test.js", GOOD)).toBeUndefined()
  })

  test("وملفٌّ بتأكيدٍ واحدٍ لا يُحكم عليه — قد يكون مسماراً مقصوداً", () => {
    expect(MIN_ASSERTIONS).toBe(2)
    expect(negativeOnlySuite("t.test.ts", `test("x", () => { expect(f()).toBe(false) })`)).toBeUndefined()
  })

  test("وملفٌّ بلا تأكيداتٍ لا يُشتكى منه — ليس سويتةً أصلاً", () => {
    expect(negativeOnlySuite("helper.ts", "export const x = 1\n")).toBeUndefined()
  })
})

describe("التصنيف — والعدُّ يُقاس لا يُخمَّن", () => {
  test("`not.` وكلُّ أشكال الغياب سلبيّة", () => {
    const r = readSuite(`
      expect(a).not.toContain("x")
      expect(b).toBeFalsy()
      expect(c).toBeUndefined()
      expect(d).toBeNull()
      expect(() => e()).toThrow()
      expect(f).toHaveLength(0)
      expect(g).toEqual([])
      assert.notEqual(h, 1)
      assert.throws(() => i())
    `)
    expect(r.total).toBe(9)
    expect(r.positive).toBe(0)
  })

  test("وما يؤكّد الوجودَ إيجابيٌّ — ولو جاور سلبيّاً", () => {
    const r = readSuite(`
      expect(a).toBe(true)
      expect(b).toEqual({ id: 1 })
      expect(c).toHaveLength(3)
      assert.equal(d, "نصّ")
      expect(e).not.toBe(1)
    `)
    expect(r.positive).toBe(4)
    expect(r.negative).toBe(1)
  })

  test("🔴 والتعليقاتُ لا تُحسب — مثالٌ في تعليقٍ ليس تأكيداً يعمل", () => {
    const r = readSuite(`
      // expect(a).toBe(true)
      /* expect(b).toBe(true) */
      expect(c).toBe(false)
      expect(d).toBe(false)
    `)
    expect(r.total).toBe(2)
    expect(r.positive).toBe(0)
    expect(negativeOnlySuite("x.test.ts", `// expect(a).toBe(true)\nexpect(c).toBe(false)\nexpect(d).toBe(false)\n`)).toBeDefined()
  })
})

describe("الإيصال", () => {
  test("لا مشكلةَ ⇦ لا سطر؛ ومشكلاتٌ ⇦ كلُّها تُقال", () => {
    expect(negativeSuiteNotice([])).toBeUndefined()
    const line = negativeSuiteNotice(["أ", "ب"])
    expect(line).toContain("أ")
    expect(line).toContain("ب")
  })
})
