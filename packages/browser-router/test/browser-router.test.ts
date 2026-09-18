import { expect, test } from "bun:test"
import { nextBrowserLane, requireBrowserVerification } from "../src"
test("uses the deterministic fallback ladder", () => {
  expect(nextBrowserLane([])).toBe("api")
  expect(nextBrowserLane([{ lane: "api", outcome: "unsupported" }])).toBe("dom")
  expect(() => nextBrowserLane([{ lane: "vision", outcome: "failed" }])).toThrow("browser_ladder_order_violation")
  expect(() => requireBrowserVerification([])).toThrow("browser_action_unverified")
})
