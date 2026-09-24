import { describe, expect, test } from "bun:test"
import { projectTestPassed, recallExecutionFact } from "../src/project-test-acceptance"

test("a test process must exit successfully and run a nonempty passing suite", () => {
  for (const output of ["0 pass\nانتهى الأمر برمز 0", "No tests found\nانتهى الأمر برمز 0", "2 passed\n1 failed\nانتهى الأمر برمز 0", "2 passed\nانتهى الأمر برمز 1", "2 passed"]) expect(projectTestPassed(output)).toBe(false)
  for (const output of ["Tests 12 passed (12)", "12 pass\n0 fail", "# tests 3\n# pass 3\n# fail 0"]) expect(projectTestPassed(`${output}\nانتهى الأمر برمز 0`)).toBe(true)
})
test("long repeated goals cannot hide actual failure evidence on recall", () => {
  const result = recallExecutionFact({ goal: "original goal ".repeat(1000), stopReason: "tool-failed", receipts: [{ command: "run npm test", output: "vitest missing; exit code 1" }] })
  expect(result).toContain("vitest missing")
  expect(result).toContain("tool-failed")
  expect(result.length).toBeLessThan(2000)
})
test("an explicit failing verdict defeats a receipt whose text reads as a passing zero-exit suite", () => {
  const output = "3 passed\nانتهى الأمر برمز 0"
  expect(projectTestPassed(output)).toBe(true)
  expect(projectTestPassed(output, { ok: false, reason: "aborted", denied: false })).toBe(false)
})
test("an explicit ok verdict admits a markerless passing suite; absence still requires the marker; content rules still apply", () => {
  expect(projectTestPassed("3 passed", { ok: true })).toBe(true)
  expect(projectTestPassed("3 passed")).toBe(false)
  expect(projectTestPassed("No tests found", { ok: true })).toBe(false)
})

describe("🔴 عدّاءُ نود المدمج — لم يكن معروفاً قطّ (قِيس 2026-09-24)", () => {
  // الصيغُ المقبولة كانت تطلب **العددَ قبل الكلمة** («3 passed») أو بادئةَ TAP، ونودُ يطبع
  // الكلمةَ قبل العدد: `ℹ pass 4` و`ℹ fail 0`. فكان خرجُه لا ناجحاً ولا فاشلاً ⇦ غيرَ ناجح.
  // والأثرُ أوسعُ من سوبر عبده: بوّابةُ الاختبارات تنادي هذه الدالّةَ نفسَها، فمشروعٌ
  // يختبر بـ`node --test` لم يُعتمد له اختبارٌ ناجحٌ أبداً وسويتتُه خضراء.

  test("سويتةُ نود الناجحة تُعَدُّ ناجحة — و`fail 0` ليس فشلاً", () => {
    expect(projectTestPassed("$ node --test\nℹ tests 4\nℹ suites 0\nℹ pass 4\nℹ fail 0\nℹ cancelled 0\nانتهى الأمر برمز 0", { ok: true })).toBe(true)
  })

  test("🔴 وسويتةٌ فيها فاشلٌ واحدٌ تُعَدُّ فاشلةً ولو مرّ ثلاثة", () => {
    expect(projectTestPassed("$ node --test\nℹ tests 4\nℹ pass 3\nℹ fail 1\nانتهى الأمر برمز 1", { ok: false })).toBe(false)
    expect(projectTestPassed("$ node --test\nℹ tests 4\nℹ pass 3\nℹ fail 1\nانتهى الأمر برمز 1", { ok: true })).toBe(false)
  })

  test("🔴 و`pass 0` ليس نجاحاً — جولةٌ فارغةٌ ليست سويتةً محقَّقة", () => {
    expect(projectTestPassed("$ node --test\nℹ tests 0\nℹ pass 0\nℹ fail 0\nانتهى الأمر برمز 0", { ok: true })).toBe(false)
  })

  test("والصيغُ القديمة تبقى كما هي — التوسيعُ لا يكسر ما كان", () => {
    expect(projectTestPassed("3 passed", { ok: true })).toBe(true)
    expect(projectTestPassed("# pass 3", { ok: true })).toBe(true)
    expect(projectTestPassed("2 failed, 1 passed", { ok: true })).toBe(false)
    expect(projectTestPassed("# fail 2", { ok: true })).toBe(false)
    expect(projectTestPassed("No tests found", { ok: true })).toBe(false)
  })
})

describe("🔴 والمطابقُ لا يعبر سطراً — الفخُّ الذي كاد يُدفع (قِيس 2026-09-24)", () => {
  // خرجُ bun الحقيقيّ: «0 fail» ثمّ في السطر التالي «1 expect() calls». وكان النمطُ يستعمل
  // \s+ فابتلعت السطرَ الجديد وقرأت «fail … 1» فشلاً — فصارت كلُّ سويتةِ bun ناجحةٍ
  // تُعَدُّ فاشلة، وسقط اختبارٌ حيٌّ 3/3 في المستودع العامّ بعد أن كان 3/3 أخضر. والحدُّ:
  // العددُ يُقرأ **من السطر نفسِه** — \t و\u0020 لا \s.
  const BUN_PASS = ["bun test v1.3.14 (0d9b296a)", "", " 1 pass", " 0 fail", " 1 expect() calls", "Ran 1 test across 1 file. [89.00ms]"].join("\n")
  const BUN_FAIL = ["bun test v1.3.14", "", " 0 pass", " 1 fail", " 2 expect() calls"].join("\n")
  const NODE_PASS = ["$ node --test", "ℹ pass 4", "ℹ fail 0", "ℹ cancelled 0"].join("\n")
  const NODE_FAIL = ["$ node --test", "ℹ pass 3", "ℹ fail 1", "ℹ cancelled 0"].join("\n")

  test("سويتةُ bun الناجحة تُعَدُّ ناجحة — ولا يُقرأ العددُ من السطر التالي", () => {
    expect(projectTestPassed(BUN_PASS, { ok: true })).toBe(true)
  })

  test("وسويتةُ bun الفاشلة تُعَدُّ فاشلة", () => {
    expect(projectTestPassed(BUN_FAIL, { ok: false })).toBe(false)
    expect(projectTestPassed(BUN_FAIL, { ok: true })).toBe(false)
  })

  test("وصيغةُ نود تبقى مقروءةً — الحدُّ لم يكسر ما أُصلح", () => {
    expect(projectTestPassed(NODE_PASS, { ok: true })).toBe(true)
    expect(projectTestPassed(NODE_FAIL, { ok: true })).toBe(false)
  })
})
