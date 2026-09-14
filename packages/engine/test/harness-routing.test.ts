import { describe, expect, test } from "bun:test"
import { harnessInstruction, selectHarness } from "../src/harness-routing"

describe("harness routing — S8", () => {
  test("routes each model family to its harness", () => {
    expect(selectHarness("ollama/empero-qwen3.8-9b-gpu").harnessId).toBe("abdo-native")
    expect(selectHarness("ollama/qwen9b-gpu-64k:latest").harnessId).toBe("qwen-style")
    expect(selectHarness("ollama/deepseek-r1:14b").harnessId).toBe("deepseek-style")
    expect(selectHarness("anthropic/claude-sonnet").harnessId).toBe("claude-style")
    expect(selectHarness("openai/gpt-4o").harnessId).toBe("codex-style")
  })

  test("small local models get partial-call repair; abdo-native does not", () => {
    expect(selectHarness("ollama/qwen9b-gpu-64k").repairPartialCalls).toBe(true)
    expect(selectHarness("ollama/empero-qwen3.8-9b-gpu").repairPartialCalls).toBe(false)
  })

  test("an unknown family defaults to the tolerant harness", () => {
    const c = selectHarness("some/unknown-model")
    expect(c.repairPartialCalls).toBe(true)
    expect(c.harnessId).toBe("qwen-style")
  })

  test("recovery instruction is real text that forbids repeating the call", () => {
    const recovery = harnessInstruction("ollama/deepseek-r1:14b", "recovery")
    expect(recovery.length).toBeGreaterThan(10)
    expect(recovery).not.toContain("{assistant}")
  })
})
