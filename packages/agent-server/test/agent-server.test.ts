import { expect, test } from "bun:test"
import { reduceAgentRequest } from "../src"
test("reduces validated session requests idempotently", () => {
  const initial = { sessionId: "s1", acceptedRequestIds: [], interrupted: false, afterSequence: 0 } as const
  const request = { version: 1, kind: "submit", requestId: "r1", sessionId: "s1", input: "hello" } as const
  const accepted = reduceAgentRequest(initial, request)
  expect(reduceAgentRequest(accepted, request)).toBe(accepted)
  expect(() => reduceAgentRequest(initial, { ...request, sessionId: "other" })).toThrow("agent_session_mismatch")
})
