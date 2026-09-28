import { expect, test } from "bun:test"
import { classifyModelFailure, QUOTA_EXHAUSTED } from "../src/index"

// Measured 2026-09-25: z.ai answered 429 with this body, and every turn retried seven times as "busy" (~2.5 min).
const ZAI = '{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}'

test("an exhausted balance or quota is its own failure: never retried on the same provider", () => {
  for (const body of [ZAI, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}', "Your credit balance is too low to access the API", "Arrearage: the account is in arrears"]) {
    const failure = classifyModelFailure({ status: 429, body })
    expect(failure.kind).toBe("quota-exhausted")
    expect(failure.retry).toBe("operator-action")
  }
  expect(classifyModelFailure({ status: 402, body: "Payment Required" }).kind).toBe("quota-exhausted")
})

test("the twin: a busy provider (429 without quota words, or 503) is still retried with backoff", () => {
  const busy = classifyModelFailure({ status: 429, body: '{"error":"Too Many Requests, slow down"}', retryAfter: "2" })
  expect(busy.kind).toBe("rate-limited")
  expect(busy.retry).toBe("bounded-backoff")
  expect(busy.retryAfterMs).toBe(2000)
  expect(classifyModelFailure({ status: 429 }).kind).toBe("rate-limited")
  expect(classifyModelFailure({ status: 503, body: ZAI }).kind).toBe("provider-unavailable")
  expect(QUOTA_EXHAUSTED.test("rate limit reached, retry in 2s")).toBe(false)
})
