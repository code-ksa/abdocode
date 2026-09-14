import { describe, expect, test } from "bun:test"
import { modelOutputViolation } from "../src/model-output-guard"

describe("model output completeness gate", () => {
  test("rejects native and compatible output-budget truncation", () => {
    for (const reason of ["length", "max_tokens"]) {
      const failure = modelOutputViolation(reason)
      expect(failure).toContain("لم يُنفّذ أي اقتراح جزئي")
      expect(failure).not.toContain("نفّذ:")
    }
  })
  test("rejects interruptions even if a provider reported stop", () => {
    expect(modelOutputViolation("stop", true)).toContain("انقطع البث")
  })
  test("accepts complete provider responses", () => {
    expect(modelOutputViolation("stop")).toBeUndefined()
    expect(modelOutputViolation("end_turn")).toBeUndefined()
  })
})
