import { expect, test } from "bun:test"
import { grepRegex } from "../src/grep-pattern"

// 🔴 2026-09-28: «كلمة\\|أخرى» عاد «لا مطابقة» عن ملفٍّ يحمل الكلمةَ تسعَ مرّات — `\\|` تناوبٌ كما في grep.
test("grepRegex: \\| is alternation as in GNU grep, an escaped backslash is kept, and a literal pipe is [|]", () => {
  const alt = grepRegex("الخزنة\\|الأسرار", false)!
  expect(alt.translated).toBe(true)
  expect(alt.re.test("قرار: الخزنة قبل السؤال")).toBe(true)
  expect(alt.re.test("الأسرار لا تُعرض")).toBe(true)
  expect(alt.re.test("لا شيء هنا")).toBe(false)
  // التوأم: نمطٌ بلا \\| لا يُمسّ، وقوسٌ مهروبٌ يبقى حرفيّاً.
  const plain = grepRegex("fn\\(x", true)!
  expect(plain.translated).toBe(false)
  expect(plain.re.test("FN(x)")).toBe(true)
  // خطٌّ مائلٌ مهروبٌ ثمّ أنبوب: الخطُّ حرفيّ والأنبوبُ تناوبٌ في JS أصلاً — لا ترجمة.
  const escaped = grepRegex("a\\\\|b", false)!
  expect(escaped.translated).toBe(false)
  expect(escaped.re.test("a\\")).toBe(true)
  expect(escaped.re.test("b")).toBe(true)
  expect(grepRegex("[|]", false)!.re.test("x | y")).toBe(true)
  expect(grepRegex("(", false)).toBeUndefined()
})
