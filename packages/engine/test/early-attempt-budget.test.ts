import { describe, expect, test } from "bun:test"
import { earlyAttemptBudgetMs } from "../src/attempt-budget"

/**
 * 🔴 **مهلةٌ ثابتةٌ لا تعرف طولَ ما طلبناه تقطع نداءً مشروعاً ثمّ تسمّيه انقطاعاً.**
 *
 * كانت المحاولاتُ الستُّ الأولى تُقطع عند 150 ثانيةً مهما كان المطلوب، والقطعُ يُصنَّف
 * «transport failed before response» فيُعاد النداءُ بالسياق نفسِه فيُقطع ثانيةً — سبعَ
 * مرّات. وقِيس: **خمسون «سقطةَ مزوّد» في مسحٍ كامل** كانت هذا، وليلتان قبله. والسجلُّ
 * لم يكن يقول السبب حتى صار يحمله، فبان نصُّه: `tool timed out after 150000ms`.
 *
 * والزمنُ مقيسٌ على هذا المزوّد **بلا تدفّق** (كما ينادي عاملُ Rust): 2000 توكنَ
 * إخراجٍ = 26ث · 4000 = 49ث · 8000 ≈ 100ث. فالكلفةُ تتبع **الإخراجَ المطلوب**.
 */
describe("the early-attempt deadline follows the output budget it was given", () => {
  const FLOOR = 150_000

  test("no budget in the body keeps the floor — absence is a refusal, not an open deadline", () => {
    expect(earlyAttemptBudgetMs("{}")).toBe(FLOOR)
    expect(earlyAttemptBudgetMs('{"model":"x","messages":[]}')).toBe(FLOOR)
  })

  test("the deadline grows with the requested output, measured at 25ms per token", () => {
    expect(earlyAttemptBudgetMs('{"max_tokens":2000}')).toBe(FLOOR + 50_000)
    expect(earlyAttemptBudgetMs('{"max_tokens":8000}')).toBe(FLOOR + 200_000)
    // وبالتنسيق المتباعد كما يكتبه المُسلسِل أحياناً.
    expect(earlyAttemptBudgetMs('{ "max_tokens" : 4000 , "model": "x" }')).toBe(FLOOR + 100_000)
  })

  test("A MEASURED CALL FITS (the positive twin): 8000 output tokens took ~100s and now has room", () => {
    // القياسُ الحيّ: 8000 إخراجاً ≈ 100 ثانية. المهلةُ القديمة 150ث كانت تكفيه بالكاد،
    // ومع السياق الأطول تسقط — والجديدة تعطيه 350ث.
    expect(earlyAttemptBudgetMs('{"max_tokens":8000}')).toBeGreaterThan(100_000 * 3)
    // ونداءٌ صغيرٌ يبقى مكشوفاً مبكراً: التعليقُ بلا بايت لا يدفع خمسَ دقائق.
    expect(earlyAttemptBudgetMs('{"max_tokens":256}')).toBeLessThan(160_000)
  })

  test("a malformed or absurd budget cannot open the deadline indefinitely", () => {
    expect(earlyAttemptBudgetMs('{"max_tokens":"lots"}')).toBe(FLOOR)
    expect(earlyAttemptBudgetMs('{"max_tokens":-5}')).toBe(FLOOR)
    // والقصُّ النهائيُّ على سقف الطلب يقع عند المُنادي (`Math.min(timeoutMs, …)`)،
    // فحتى رقمٌ ضخمٌ هنا لا يتجاوز سقفَ عامل Rust المستورَد.
    expect(earlyAttemptBudgetMs('{"max_tokens":9999999}')).toBeGreaterThan(FLOOR)
  })
})
