import { describe, expect, test } from "bun:test"
import { acceptanceLine, acceptanceSatisfied, gateReceipts, gateShortfall, gateState } from "../src/acceptance-receipt"

// ذ4 — الإيصالُ يفرّق «فشل» عن «لم يُفحص»، وغيرُ المفحوص لا يُحسب نجاحاً أبداً.

describe("حالةُ البوّابة", () => {
  test("ثلاثُ حالاتٍ لا اثنتان: لم يُنفَّذ ⇦ unverified، نُفّذ وسقط ⇦ failed، نُفّذ ونجح ⇦ passed", () => {
    expect(gateState({ ran: false, passed: false })).toBe("unverified")
    // نجاحٌ محفوظٌ بلا تنفيذ على الشيفرة الحاليّة ليس نجاحاً — التعديلُ أبطله.
    expect(gateState({ ran: false, passed: true })).toBe("unverified")
    expect(gateState({ ran: true, passed: false })).toBe("failed")
    expect(gateState({ ran: true, passed: true })).toBe("passed")
  })

  test("الإيصالاتُ للمطلوب وحده، بترتيبٍ ثابت، والدليلُ مع الفاشل وحده", () => {
    const receipts = gateReceipts(
      { build: true, tests: true, typecheck: false },
      { build: { ran: true, passed: false, evidence: "TS2322 … exit 1" }, tests: { ran: false, passed: false }, typecheck: { ran: true, passed: true } },
    )
    expect(receipts.map((r) => `${r.gate}:${r.state}`)).toEqual(["build:failed", "tests:unverified"])
    expect(receipts[0]!.evidence).toBe("TS2322 … exit 1")
    expect(receipts[1]!.evidence).toBeUndefined()
    expect(gateReceipts({}, {})).toEqual([])
  })
})

describe("القاعدةُ ذاتُ الأسنان", () => {
  test("يُرضى بـpassed وحده: الفاشلُ لا، وغيرُ المفحوص لا (الغيابُ رفضٌ لا إذن)", () => {
    expect(acceptanceSatisfied([])).toBe(true)
    expect(acceptanceSatisfied([{ gate: "build", state: "passed" }])).toBe(true)
    expect(acceptanceSatisfied([{ gate: "build", state: "passed" }, { gate: "tests", state: "failed" }])).toBe(false)
    expect(acceptanceSatisfied([{ gate: "build", state: "passed" }, { gate: "tests", state: "unverified" }])).toBe(false)
    expect(acceptanceSatisfied([{ gate: "audit", state: "unverified" }])).toBe(false)
  })

  test("السطرُ يسمّي الحالةَ لكلّ بوّابة، وفارغٌ بلا بوّابات — بايتاً كما كان", () => {
    expect(acceptanceLine([])).toBe("")
    const line = acceptanceLine([
      { gate: "build", state: "failed", evidence: "  error TS2322\n exit 1 " },
      { gate: "typecheck", state: "unverified" },
      { gate: "tests", state: "passed" },
    ])
    expect(line.startsWith("بوابات القبول: ")).toBe(true)
    expect(line).toContain("البناء ✗ فشل (error TS2322 exit 1)")
    expect(line).toContain("الأنواع ○ لم يُفحص")
    expect(line).toContain("الاختبارات ✓ نجح")
  })

  test("تلميحُ النقص يفرّق: الفاشلُ «أصلح ثم أعد»، وغيرُ المفحوص «نفّذ أوّلاً ولا تدّعِ»", () => {
    expect(gateShortfall({ gate: "build", state: "failed", evidence: "exit 1" })).toContain("**فشل**")
    expect(gateShortfall({ gate: "build", state: "failed", evidence: "exit 1" })).toContain("أصلح السبب")
    expect(gateShortfall({ gate: "tests", state: "unverified" })).toContain("**لم يُفحص**")
    expect(gateShortfall({ gate: "tests", state: "unverified" })).toContain("لا تدّعِ نجاحاً لم يُقس")
  })
})

// 2026-09-28 — الحالةُ الرابعة «بلا دليل»: `node test.js` خرج برمز 0 وطبع «ok» بلا عدّ، فقيل للنموذج إنّ الاختبارات **فشلت**
// فأعاد ادّعاءَ الاكتمال مرّتين بلا أداة. الغيابُ ليس نجاحاً (البوّابة لا تُرضى) لكنّه ليس فشلاً (لا «أصلح السبب»).
describe("unproven — ran, exit 0, no evidence in the output", () => {
  test("gateState reads the flag only when the run did not pass", () => {
    expect(gateState({ ran: true, passed: false, unproven: true })).toBe("unproven")
    expect(gateState({ ran: true, passed: true, unproven: true })).toBe("passed")
    expect(gateState({ ran: false, passed: false, unproven: true })).toBe("unverified")
    expect(gateState({ ran: true, passed: false })).toBe("failed")
  })

  test("the receipt carries its evidence, is not satisfied, and the shortfall asks for evidence instead of a fix", () => {
    const receipts = gateReceipts({ tests: true }, { tests: { ran: true, passed: false, unproven: true, evidence: "node test.js ok انتهى الأمر برمز 0" } })
    expect(receipts.map((r) => `${r.gate}:${r.state}`)).toEqual(["tests:unproven"])
    expect(receipts[0]!.evidence).toContain("ok")
    expect(acceptanceSatisfied(receipts)).toBe(false)
    expect(acceptanceLine(receipts)).toContain("الاختبارات △ بلا دليل")
    const shortfall = gateShortfall(receipts[0]!)
    expect(shortfall).toContain("بلا دليلٍ في الخرج")
    expect(shortfall).toContain("6 passed")
    expect(shortfall).not.toContain("**فشل**")
    expect(shortfall).not.toContain("أصلح السبب")
  })
})

describe("preexisting (09-29) — فشلُ التدقيق على اعتمادياتٍ لم تُمسّ يُبلَّغ ولا يحجب", () => {
  test("الحالة تُروى «سابق»، وتُرضي القبول، وتحمل دليلَها؛ وبمسّ الاعتماديات تعود «فشل»", () => {
    const pre = { ran: true, passed: false, evidence: "4 high, 1 critical", preexisting: true }
    expect(gateState(pre)).toBe("preexisting")
    const receipts = gateReceipts({ build: true, audit: true }, { build: { ran: true, passed: true }, audit: pre })
    expect(receipts[1]).toEqual({ gate: "audit", state: "preexisting", evidence: "4 high, 1 critical" })
    expect(acceptanceSatisfied(receipts)).toBe(true)
    expect(acceptanceLine(receipts)).toContain("التدقيق △ سابق — اعتمادياتٌ لم تُمسّ (4 high, 1 critical)")
    expect(gateShortfall(receipts[1]!)).toContain("لم تمسّها هذه الجولة")
    // التوأم: الفشلُ بعد مسّ الاعتماديات يبقى فشلاً يحجب
    const failed = gateReceipts({ audit: true }, { audit: { ran: true, passed: false, evidence: "x" } })
    expect(failed[0]!.state).toBe("failed")
    expect(acceptanceSatisfied(failed)).toBe(false)
    // والنجاحُ يغلب العلامة
    expect(gateState({ ran: true, passed: true, preexisting: true })).toBe("passed")
  })
})
