import { describe, expect, test } from "bun:test"
import {
  APPROVAL_ASKED_PREFIX,
  APPROVAL_DECIDED_PREFIX,
  approvalAskedLine,
  approvalDecidedLine,
  decisionOfLine,
  type ApprovalDecision,
} from "../src/approval-ledger"

const DECISIONS: readonly ApprovalDecision[] = ["approved", "denied", "interrupted"]

describe("approval ledger — the durable ask/decide pair", () => {
  test("the two lines carry the request, its class and the mode, verbatim", () => {
    expect(approvalAskedLine({ request: "write app/page.tsx", cls: "write", mode: "read-only" }))
      .toBe("🔐 طلب موافقة [write] في نمط read-only: write app/page.tsx")
    expect(approvalDecidedLine({ request: "write app/page.tsx", decision: "approved" }))
      .toBe("🔐 قرار الموافقة: سُمح — write app/page.tsx")
    expect(approvalDecidedLine({ request: "write app/page.tsx", decision: "denied" }))
      .toBe("🔐 قرار الموافقة: رُفض — write app/page.tsx")
    expect(approvalDecidedLine({ request: "run rm -rf build", decision: "interrupted" }))
      .toBe("🔐 قرار الموافقة: أُلغي بالمقاطعة — run rm -rf build")
  })

  test("the decided prefix is a prefix of every decision line and of NO asked line", () => {
    // القشرة تطوي على هذه البادئة وحدها؛ تقاطعُها مع سطر السؤال كان سيُنهي
    // المقعد لحظةَ فتحه — وهو أسوأ من عدم فتحه.
    for (const decision of DECISIONS) {
      expect(approvalDecidedLine({ request: "x", decision })).toStartWith(APPROVAL_DECIDED_PREFIX)
    }
    for (const mode of ["read-only", "auto", "full-access"]) {
      const asked = approvalAskedLine({ request: "x", cls: "network", mode })
      expect(asked).toStartWith(APPROVAL_ASKED_PREFIX)
      expect(asked.startsWith(APPROVAL_DECIDED_PREFIX)).toBe(false)
    }
    expect(APPROVAL_DECIDED_PREFIX.startsWith(APPROVAL_ASKED_PREFIX)).toBe(false)
  })

  test("the reverse read is exact: a decided line names its decision, and nothing else does", () => {
    for (const decision of DECISIONS) {
      expect(decisionOfLine(approvalDecidedLine({ request: "write a.ts", decision }))).toBe(decision)
    }
    // طلبٌ نصُّه يشبه القرار لا يُقرأ قراراً — البادئة تحكم.
    expect(decisionOfLine(approvalAskedLine({ request: "سُمح — كذا", cls: "write", mode: "auto" }))).toBeUndefined()
    expect(decisionOfLine("📐 أحكام الأدوات ح1: —")).toBeUndefined()
    expect(decisionOfLine(undefined)).toBeUndefined()
    expect(decisionOfLine(42)).toBeUndefined()
    // بادئةٌ صحيحة بقرارٍ لا نعرفه: **لا** يُخمَّن سماحاً.
    expect(decisionOfLine(`${APPROVAL_DECIDED_PREFIX}شيءٌ آخر — write a.ts`)).toBeUndefined()
  })

  test("a request containing the separator does not corrupt the reverse read", () => {
    const request = "run echo سُمح — لا شيء"
    expect(decisionOfLine(approvalDecidedLine({ request, decision: "denied" }))).toBe("denied")
  })
})
