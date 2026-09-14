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
