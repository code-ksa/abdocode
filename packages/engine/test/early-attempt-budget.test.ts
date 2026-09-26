import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CLOUD_EARLY_ATTEMPT_TIMEOUT_MS, MAX_BUDGETED_OUTPUT_TOKENS, earlyAttemptBudgetMs } from "../src/attempt-budget"
import { encodeChatRequest } from "@abdo/model-gateway"

/**
 * 🔴 **مهلةٌ ثابتةٌ لا تعرف حجمَ ما طلبناه تقطع نداءً مشروعاً ثمّ تسمّيه انقطاعاً.**
 *
 * كانت المحاولاتُ الستُّ الأولى تُقطع عند 150 ثانيةً مهما كان المطلوب، والقطعُ يُصنَّف
 * «transport failed before response» فيُعاد النداءُ بالسياق نفسِه فيُقطع ثانيةً — سبعَ
 * مرّات. وقِيس: **خمسون «سقطةَ مزوّد» في مسحٍ كامل** كانت هذا، وليلتان قبله. والسجلُّ
 * لم يكن يقول السبب حتى صار يحمله: `tool timed out after 150000ms`.
 *
 * ⚠ **وأوّلُ إصلاحٍ لها كان ميّتاً**: قرأ `max_tokens` من نصِّ الجسم، والجسمُ المتوافق
 * مع OpenAI **لم يكن يرسله أصلاً** — فمرّت أربعةُ مساميرَ خضراءَ والقياسُ الحيُّ يقول
 * 150000ms كما كان. فهنا مسمارانِ لا واحد: الرقمُ يُؤخذ من مصدره، **والجسمُ يحمله**.
 *
 * والزمنُ مقيسٌ على المزوّد بلا تدفّق (كما ينادي عاملُ Rust): 2000 توكنَ إخراجٍ = 26ث ·
 * 4000 = 49ث · 8000 ≈ 100ث. فالكلفةُ تتبع **الإخراجَ المطلوب** لا السياق.
 */
describe("the early-attempt deadline follows the output budget the request was built with", () => {
  const FLOOR = CLOUD_EARLY_ATTEMPT_TIMEOUT_MS

  test("no cap keeps the floor — absence is a refusal, not an open deadline", () => {
    expect(earlyAttemptBudgetMs(undefined)).toBe(FLOOR)
    expect(earlyAttemptBudgetMs(0)).toBe(FLOOR)
  })

  test("the deadline grows with the requested output, measured at 25ms per token", () => {
    expect(earlyAttemptBudgetMs(2000)).toBe(FLOOR + 50_000)
    expect(earlyAttemptBudgetMs(4000)).toBe(FLOOR + 100_000)
    expect(earlyAttemptBudgetMs(8000)).toBe(FLOOR + 200_000)
  })

  test("A MEASURED CALL FITS (the positive twin): the agent epoch's 8192 tokens gets room", () => {
    // حقبةُ الوكيل تحجز 8192 — وهو الرقمُ الذي كان يُقطع عند 150ث.
    expect(earlyAttemptBudgetMs(8192)).toBeGreaterThan(100_000 * 3)
    // ونداءٌ صغيرٌ يبقى مكشوفاً مبكراً: التعليقُ بلا بايت لا يدفع خمسَ دقائق.
    expect(earlyAttemptBudgetMs(256)).toBeLessThan(160_000)
  })

  test("a malformed or absurd cap cannot open the deadline indefinitely", () => {
    expect(earlyAttemptBudgetMs(-5)).toBe(FLOOR)
    expect(earlyAttemptBudgetMs(Number.NaN)).toBe(FLOOR)
    expect(earlyAttemptBudgetMs(1.5)).toBe(FLOOR)
    expect(earlyAttemptBudgetMs(Number.POSITIVE_INFINITY)).toBe(FLOOR)
    expect(earlyAttemptBudgetMs(10_000_000)).toBe(FLOOR + MAX_BUDGETED_OUTPUT_TOKENS * 25)
  })

  test("THE BODY CARRIES THE CAP (the twin the first fix lacked): an OpenAI-shaped request sends max_tokens", () => {
    const base = { wire: "openai-compatible" as const, model: "m", messages: [{ role: "user" as const, content: "hi" }], stream: false }
    const withCap = encodeChatRequest({ ...base, maxOutputTokens: 8192 })
    expect(JSON.parse(withCap.body).max_tokens).toBe(8192)
    // وبلا سقفٍ لا يُخترع رقمٌ: الحقلُ يغيب كما كان — لا 4096 مُفترضة.
    const without = encodeChatRequest({ ...base })
    expect("max_tokens" in JSON.parse(without.body)).toBe(false)
    // والشكلُ الأنثروبيّ كان يرسله دائماً، ويبقى كما هو.
    const anthropic = encodeChatRequest({ ...base, wire: "anthropic", maxOutputTokens: 8192 })
    expect(JSON.parse(anthropic.body).max_tokens).toBe(8192)
  })

  test("the call site passes the cap it built the request with — not a re-read of the body", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
    expect(cli).toContain("earlyAttemptBudgetMs(requestOutputCap)")
    expect(cli).not.toContain("earlyAttemptBudgetMs(body)")
  })
})
