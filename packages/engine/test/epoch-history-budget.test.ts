/**
 * 10-11 (مقيس على مهمّة CRM: 75 إعادةَ قراءةٍ لملفٍّ لم يتغيّر بعد حدّ حقبة) — المحمولاتُ تُقصّ من التاريخ بميزانيّة 48KB فيعيد النموذجُ القراءة.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { trimEpochHistory } from "../src/epoch-context"

// خمسُ حقب: كلٌّ تضيف طلبَ متابعةٍ قصيراً وجوابَ ذاكرةٍ يحمل قراءةَ ملفٍّ مختلف (~30KB) — كما يفعل carriedReads.
const epochs = () => {
  const history: { role: "user" | "assistant"; content: string }[] = []
  for (const file of ["src/routes/deals.ts", "prisma/schema.prisma", "src/http/pipeline.ts", "src/routes/pipelines.ts", "test/helpers/world.ts"]) {
    history.push({ role: "user", content: "واصل الهدف الأصلي من نقطة التوقف." })
    history.push({ role: "assistant", content: `⚙ read ${file}\n\nإيصالات القراءة المحفوظة للحقبة التالية:\nنتيجة موثقة لـ«read ${file}»:\n${"x".repeat(30_000)}` })
  }
  return history
}
const carries = (h: readonly { content: string }[], file: string) => h.some((m) => m.content.includes(`نتيجة موثقة لـ«read ${file}»`))

test("with the window-sized budget (131k-token agent ⇒ ~157KB) the first epoch's carried read is still there at epoch 5", () => {
  const kept = trimEpochHistory(epochs(), Math.round(131_072 * 1.2)).kept
  expect(carries(kept, "src/routes/deals.ts")).toBe(true)
  expect(carries(kept, "test/helpers/world.ts")).toBe(true)
})

test("the twin: the old 48KB budget drops it — the measured cause of re-reading an unchanged file", () => {
  const kept = trimEpochHistory(epochs(), 48 * 1024).kept
  expect(carries(kept, "src/routes/deals.ts")).toBe(false)
})

test("cli trims epoch history with the window-sized budget, never below the old 48KB floor", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
  expect(cli).toContain("const epochHistoryBudgetBytes = (): number => Math.max(48 * 1024, Math.round(agentContextTokens() * 1.2))")
  expect(cli).toContain("trimEpochHistory(epochHistory as ChatMessage[], epochHistoryBudgetBytes())")
})
