import { describe, expect, test } from "bun:test"
import { estimateTokens, tokensFromChars } from "../src"
import { canonical, recorder, verify, volatileValue } from "../src/golden-trace"

describe("owned schema primitives", () => {
  test("uses one conservative estimator for text and pre-counted characters", () => {
    expect(estimateTokens("abcdefg")).toBe(3)
    expect(tokensFromChars(7)).toBe(3)
  })

  test("golden traces are deterministic and reject undeclared volatility", () => {
    const stable = recorder("model-route")
    stable.record("selected", { lane: "agent", ref: "ollama/empero-qwen3.8-9b-gpu:latest" })
    const rendered = canonical(stable.trace())
    expect(rendered.ok).toBeTrue()
    if (rendered.ok) expect(verify(stable.trace(), rendered.text)).toEqual({ ok: true })

    const unstable = recorder("volatile")
    unstable.record("started", { at: "2026-08-29T10:00:00Z" })
    expect(canonical(unstable.trace()).ok).toBeFalse()
    unstable.record("declared", { at: volatileValue("started-at") })
  })
})
