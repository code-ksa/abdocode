import { describe, expect, test } from "bun:test"
import {
  climb,
  evidenceFrom,
  receiptLine,
  startOf,
  type EscalationEvidence,
  type ModelRung,
  type VerificationLike,
} from "../src/escalation"

const LADDER: readonly ModelRung[] = Object.freeze([
  { ref: "ollama/qwen9b-gpu-32k:latest", why: "محليّ ومجانيّ — يفي بأكثر الدورات" },
  { ref: "qwen-coding-plan/qwen3-coder-plus", why: "برمجةٌ أثقل بحصّةٍ مشتراة" },
  { ref: "anthropic/claude-opus-4-1", why: "آخر السلّم — أغلى وأقدر" },
])

const gate = (attemptId: string, detail = "bun test → 3 حمراء"): EscalationEvidence =>
  ({ kind: "gate_failed", detail, attemptId })

describe("سلّم النماذج — البدء من الأرخص", () => {
  test("البدءُ دائماً عند الدرجة الأولى", () => {
    expect(startOf(LADDER)?.ref).toBe("ollama/qwen9b-gpu-32k:latest")
    expect(startOf(LADDER)?.spentAttempts).toEqual([])
  })

  test("سلّمٌ فارغ لا يعطي بدايةً مخترَعة", () => {
    expect(startOf([])).toBeUndefined()
  })
})

describe("لا صعود بلا دليل — fail-closed", () => {
  test("بلا دليلٍ يُرفض الصعود ويبقى النموذج كما هو", () => {
    const state = startOf(LADDER)!
    const outcome = climb(state, LADDER, undefined)
    expect(outcome.kind).toBe("refused")
    expect(outcome.state.ref).toBe(state.ref)
  })

  test("الرفضُ يسبق سقفَ السلّم: بلا دليلٍ لا شيء يقع ولو كنّا في الأعلى", () => {
    const top = { ref: "anthropic/claude-opus-4-1", spentAttempts: [] as readonly string[] }
    expect(climb(top, LADDER, undefined).kind).toBe("refused")
  })

  test("بلا دليلٍ لا يُكتب في الإيصال صعودٌ البتّة", () => {
    const line = receiptLine(climb(startOf(LADDER)!, LADDER, undefined))
    expect(line).toContain("بلا صعود")
    expect(line).not.toContain("⇦ qwen-coding-plan")
  })
})

describe("الصعود بدليل — درجةً واحدة، ومعه سببُه", () => {
  test("دليلُ فشلٍ يرفع درجةً واحدة لا أكثر", () => {
    const outcome = climb(startOf(LADDER)!, LADDER, gate("a1"))
    expect(outcome.kind).toBe("escalated")
    if (outcome.kind !== "escalated") throw new Error("unreachable")
    expect(outcome.from).toBe("ollama/qwen9b-gpu-32k:latest")
    expect(outcome.to).toBe("qwen-coding-plan/qwen3-coder-plus")
    expect(outcome.state.ref).toBe("qwen-coding-plan/qwen3-coder-plus")
  })

  test("الناتجُ يحمل الدليلَ نفسه — فلا يمكن ذكرُ صعودٍ بلا سببه", () => {
    const outcome = climb(startOf(LADDER)!, LADDER, gate("a1", "typecheck → 2 أخطاء"))
    if (outcome.kind !== "escalated") throw new Error("expected escalated")
    expect(outcome.evidence.detail).toBe("typecheck → 2 أخطاء")
    const line = receiptLine(outcome)
    expect(line).toContain("typecheck → 2 أخطاء")
    expect(line).toContain("qwen-coding-plan/qwen3-coder-plus")
  })

  test("سلّمٌ من ثلاث درجات يُقطع بثلاثة أدلّة مختلفة، ثم يُعلن سقفه", () => {
    let state = startOf(LADDER)!
    const first = climb(state, LADDER, gate("a1"))
    if (first.kind !== "escalated") throw new Error("expected escalated")
    state = first.state
    const second = climb(state, LADDER, gate("a2"))
    if (second.kind !== "escalated") throw new Error("expected escalated")
    expect(second.to).toBe("anthropic/claude-opus-4-1")
    const third = climb(second.state, LADDER, gate("a3"))
    expect(third.kind).toBe("exhausted")
    expect(receiptLine(third)).toContain("سقف السلّم")
  })
})

describe("الدليلُ يُستهلك مرّة — لا مضاعفة صعود", () => {
  test("الدليلُ نفسه مرّتين لا يرفع درجتين", () => {
    const first = climb(startOf(LADDER)!, LADDER, gate("a1"))
    if (first.kind !== "escalated") throw new Error("expected escalated")
    const again = climb(first.state, LADDER, gate("a1"))
    expect(again.kind).toBe("already_spent")
    expect(again.state.ref).toBe("qwen-coding-plan/qwen3-coder-plus")
  })

  test("الاستهلاكُ يُحفظ في الحالة لا في متغيّرٍ عامّ", () => {
    const first = climb(startOf(LADDER)!, LADDER, gate("a1"))
    if (first.kind !== "escalated") throw new Error("expected escalated")
    expect(first.state.spentAttempts).toEqual(["a1"])
    // حالةٌ جديدة بنفس المرجع ولا تاريخ: الدليلُ نفسه يعمل فيها — الحالة هي الذاكرة.
    expect(climb({ ref: "ollama/qwen9b-gpu-32k:latest", spentAttempts: [] }, LADDER, gate("a1")).kind).toBe("escalated")
  })
})

describe("«لم يُفحص» ليست «فشل» — القاعدة الحاكمة", () => {
  const failed: VerificationLike = {
    verdict: "failed",
    failed: [{ id: "test", evidence: "bun test packages/x", detail: "3 حمراء" }],
    why: "فحصٌ أحمر",
  }
  const unverified: VerificationLike = { verdict: "unverified", failed: [], why: "لم يعمل أيّ فحص" }
  const passed: VerificationLike = { verdict: "passed", failed: [], why: "كلّها خضراء" }

  test("failed ⇦ دليلٌ يحمل ما جرى فعلاً لا وصفاً عامّاً", () => {
    const read = evidenceFrom(failed, "a1")
    expect(read.kind).toBe("evidence")
    if (read.kind !== "evidence") throw new Error("unreachable")
    expect(read.evidence.detail).toBe("test: bun test packages/x — 3 حمراء")
  })

  test("unverified ⇦ **لا صعود**، وبسببٍ يفرّقه عن النجاح", () => {
    const read = evidenceFrom(unverified, "a1")
    expect(read.kind).toBe("not_verified")
    expect(read.kind === "not_verified" && read.why).toContain("لا صعود على الجهل")
  })

  test("passed ⇦ لا صعود، وهي حالةٌ أخرى غير «لم يُفحص»", () => {
    expect(evidenceFrom(passed, "a1").kind).toBe("passed")
    expect(evidenceFrom(passed, "a1").kind).not.toBe(evidenceFrom(unverified, "a1").kind)
  })

  test("الطريقُ كاملاً: unverified لا يصعد بالنموذج ولو تكرّر", () => {
    let state = startOf(LADDER)!
    for (let i = 0; i < 5; i++) {
      const read = evidenceFrom(unverified, `a${i}`)
      const outcome = climb(state, LADDER, read.kind === "evidence" ? read.evidence : undefined)
      expect(outcome.kind).toBe("refused")
      state = outcome.state
    }
    expect(state.ref).toBe("ollama/qwen9b-gpu-32k:latest")
  })
})

describe("نموذجٌ خارج السلّم لا يُصعَّد صامتاً", () => {
  test("مرجعٌ غير موجودٍ في السلّم يُعلَن لا يُبتلع", () => {
    const outcome = climb({ ref: "openai/gpt-4o", spentAttempts: [] }, LADDER, gate("a1"))
    expect(outcome.kind).toBe("exhausted")
    expect(outcome.kind === "exhausted" && outcome.why).toContain("ليس في السلّم")
  })
})
