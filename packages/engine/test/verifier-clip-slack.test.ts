/**
 * 10-11 (مقيس على m11 بالمثبَّت 4.0.143): «release-check: FAIL — 2/3 مرحلة [... حُذف 13 حرفاً من الوسط ...]» — قصٌّ وفّر 13 حرفاً وأخفى اسمَ
 * المرحلة الفاشلة فحجب المحكّمُ الاكتمال. فيضٌ صغير يُعرض كاملاً، وسطورُ الفشل في الوسط المحذوف تُحمل في علامة القصّ.
 */
import { expect, test } from "bun:test"
import { clipKeepCause } from "../src/semantic-verifier"

test("a small overflow is shown whole — the failing stage name is not cut for 13 characters", () => {
  const receipt = `release-check: FAIL — 2/3 مرحلة\n✓ build\n✗ headers: STAGE_THAT_FAILED missing Content-Security-Policy\n✓ tests ${"·".repeat(640)}`
  const out = clipKeepCause(receipt, receipt.length - 13)
  expect(out).toBe(receipt)
  expect(out).toContain("STAGE_THAT_FAILED")
})

test("a big clip carries the failure lines of what it dropped", () => {
  const middle = Array.from({ length: 80 }, (_, i) => i === 40 ? "✗ headers: STAGE_THAT_FAILED missing CSP" : `line ${i} ok ${"·".repeat(30)}`).join("\n")
  const out = clipKeepCause(`HEAD\n${middle}\nTAIL`, 700)
  expect(out.length).toBeLessThan(1100)
  expect(out).toContain("سطورُ الفشل منه: ✗ headers: STAGE_THAT_FAILED missing CSP")
})

test("the twin: a big clip with no failure in the middle carries none", () => {
  const middle = Array.from({ length: 80 }, (_, i) => `line ${i} ok ${"·".repeat(30)}`).join("\n")
  const out = clipKeepCause(`HEAD\n${middle}\nTAIL`, 700)
  expect(out).toContain("حرفاً من الوسط ...]")
  expect(out).not.toContain("سطورُ الفشل")
})
