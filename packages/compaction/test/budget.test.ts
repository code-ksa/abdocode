import { describe, expect, test } from "bun:test"
import type { ProviderEnvelope } from "@abdo/context"
import { candidate, isProtected, planBudget, rankOf } from "../src/index"

const env = (over: Partial<ProviderEnvelope> = {}): ProviderEnvelope => ({
  maxInputTokens: 100,
  maxOutputTokens: 50,
  maxRequestBytes: 100000,
  maxMessages: 50,
  safetyMargin: 0,
  ...over,
})

// text sized via the canonical estimator (see @abdo/schema/tokens). The
// divisor is deliberately NOT written here: it moved from 4 to 3 on 2026-08-20
// when four copies were converged, and a comment naming it would go stale.
const tok = (tokens: number) => "a".repeat(tokens * 4)

describe("priority policy", () => {
  test("current user message ranks above project instructions; safety/policy above all", () => {
    expect(rankOf("system_safety")).toBeLessThan(rankOf("tool_policy"))
    expect(rankOf("tool_policy")).toBeLessThan(rankOf("current_user_message"))
    expect(rankOf("current_user_message")).toBeLessThan(rankOf("nearest_instructions"))
    expect(rankOf("nearest_instructions")).toBeLessThan(rankOf("root_instructions"))
    expect(rankOf("root_instructions")).toBeLessThan(rankOf("old_detail"))
  })

  test("the never-compact set is protected", () => {
    for (const k of ["system_safety", "tool_policy", "current_user_message", "pending_tool_call", "pending_tool_result", "active_step", "modified_file"] as const) {
      expect(isProtected(k)).toBe(true)
    }
    expect(isProtected("old_detail")).toBe(false)
    expect(isProtected("historical_tool_output")).toBe(false)
  })
})

describe("planBudget", () => {
  test("a short session fits with nothing evicted", () => {
    const plan = planBudget(
      [candidate("u", "current_user_message", tok(10)), candidate("t", "recent_tail", tok(10))],
      env(),
      { reservedOutputTokens: 0 },
    )
    expect(plan.ok).toBe(true)
    expect(plan.excluded).toHaveLength(0)
    expect(plan.included.map((e) => e.id)).toEqual(["u", "t"])
  })

  test("token overflow evicts the lowest-priority entries first", () => {
    const plan = planBudget(
      [
        candidate("user", "current_user_message", tok(20)),
        candidate("tail", "recent_tail", tok(30)),
        candidate("oldtool", "historical_tool_output", tok(60)),
        candidate("olddetail", "old_detail", tok(60)),
      ],
      env(),
      { reservedOutputTokens: 0 },
    )
    expect(plan.ok).toBe(true)
    expect(plan.included.map((e) => e.id)).toEqual(["user", "tail"])
    expect(plan.excluded.map((e) => e.id).sort()).toEqual(["olddetail", "oldtool"])
    expect(plan.excluded.every((e) => e.reason === "evicted-tokens")).toBe(true)
  })

  test("output tokens are reserved up front", () => {
    const plan = planBudget([candidate("user", "current_user_message", tok(60))], env({ maxInputTokens: 100 }), {
      reservedOutputTokens: 50,
    })
    // usable = 100 - 50 = 50; the 60-token protected message overflows.
    expect(plan.ok).toBe(false)
    expect(plan.overflow?.reason).toBe("tokens")
  })

  test("byte overflow is caught even when tokens fit", () => {
    const plan = planBudget(
      [candidate("user", "current_user_message", "a".repeat(80)), candidate("old", "historical_tool_output", "b".repeat(40))],
      env({ maxInputTokens: 100000, maxRequestBytes: 100 }),
      { reservedOutputTokens: 0 },
    )
    expect(plan.included.map((e) => e.id)).toEqual(["user"])
    expect(plan.excluded[0]?.reason).toBe("evicted-bytes")
  })

  test("nearest project instructions are kept before root instructions under pressure", () => {
    const plan = planBudget(
      [
        candidate("user", "current_user_message", tok(30)),
        candidate("nearest", "nearest_instructions", tok(40)),
        candidate("root", "root_instructions", tok(40)),
      ],
      env(),
      { reservedOutputTokens: 0 },
    )
    expect(plan.included.map((e) => e.id)).toEqual(["user", "nearest"])
    expect(plan.excluded.map((e) => e.id)).toEqual(["root"])
  })

  test("protected content is NEVER evicted; if it alone overflows the plan fails loudly", () => {
    const plan = planBudget([candidate("user", "current_user_message", tok(150))], env(), { reservedOutputTokens: 0 })
    expect(plan.included.map((e) => e.id)).toEqual(["user"]) // kept
    expect(plan.ok).toBe(false) // but flagged
    expect(plan.overflow?.reason).toBe("tokens")
    expect(plan.included[0]?.reason).toBe("protected-over-budget")
  })

  test("a pending tool call/result is protected even when old and large", () => {
    const plan = planBudget(
      [
        candidate("user", "current_user_message", tok(20)),
        candidate("pending", "pending_tool_result", tok(90)), // huge but needed
        candidate("old", "old_detail", tok(10)),
      ],
      env(),
      { reservedOutputTokens: 0 },
    )
    expect(plan.included.map((e) => e.id)).toContain("pending")
    expect(plan.excluded.map((e) => e.id)).toEqual(["old"])
  })
})
