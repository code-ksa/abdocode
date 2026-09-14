import { describe, expect, test } from "bun:test"
import { agentEpochBudget, DEFAULT_AGENT_EPOCHS, MAX_CONFIGURABLE_AGENT_EPOCHS } from "../src/agent-epoch-budget"

describe("agent epoch budget", () => {
  test("keeps the default when the setting is absent", () => {
    expect(agentEpochBudget(undefined)).toBe(DEFAULT_AGENT_EPOCHS)
  })

  test("accepts a longer objective budget", () => {
    expect(agentEpochBudget("64")).toBe(64)
    expect(agentEpochBudget(" 40 ")).toBe(40)
    expect(agentEpochBudget(String(MAX_CONFIGURABLE_AGENT_EPOCHS))).toBe(MAX_CONFIGURABLE_AGENT_EPOCHS)
  })

  // An unreadable setting must not widen the bound: absence is refusal.
  test("refuses unparsable, negative, zero and out-of-range values", () => {
    for (const raw of ["", "   ", "abc", "-5", "0", "1e3", "12.5", String(MAX_CONFIGURABLE_AGENT_EPOCHS + 1), "999999"]) {
      expect(agentEpochBudget(raw)).toBe(DEFAULT_AGENT_EPOCHS)
    }
  })
})
