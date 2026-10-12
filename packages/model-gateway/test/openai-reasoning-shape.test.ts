/**
 * 10-08 — measured with a live OpenAI key: gpt-6.1-sol answered 400 "'max_tokens' is not supported … use 'max_completion_tokens'",
 * gpt-5.5 answered 400 "'temperature' does not support 0"; both answered 200 with max_completion_tokens and no temperature/presence_penalty.
 * gpt-4.1 takes the classic shape.
 */
import { expect, test } from "bun:test"
import { encodeChatRequest, REASONING_OUTPUT_CAP } from "../src/index"

const body = (model: string): Record<string, unknown> =>
  JSON.parse(encodeChatRequest({ model, stream: false, maxOutputTokens: 64, messages: [{ role: "user", content: "hi" }] } as never).body)

test("gpt-5 and later, and the o-series: max_completion_tokens, no temperature, no presence_penalty", () => {
  for (const model of ["gpt-6.1-sol", "gpt-6-luna", "gpt-5.5", "gpt-5.4-mini", "gpt-5", "gpt-7", "o3", "o4-mini", "gpt-5.3-codex"]) {
    const b = body(model)
    expect(b.max_completion_tokens).toBe(64)
    expect("max_tokens" in b).toBe(false)
    expect("temperature" in b).toBe(false)
    expect("presence_penalty" in b).toBe(false)
  }
})

test("classic models keep max_tokens and temperature 0", () => {
  for (const model of ["gpt-4.1", "gpt-4o", "nvidia/nemotron-3-super-120b-a12b", "deepseek-chat", "openai/gpt-5"]) {
    const b = body(model)
    expect(b.max_tokens).toBe(64)
    expect(b.temperature).toBe(0)
  }
  expect(REASONING_OUTPUT_CAP.test("gpt-4o-mini")).toBe(false)
  expect(REASONING_OUTPUT_CAP.test("gpt-50")).toBe(true)
})
