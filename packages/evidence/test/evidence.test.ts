import { expect, test } from "bun:test"
import { createEvidenceReceipt, verifyEvidenceChain } from "../src"
test("creates a verified tamper-evident chain", () => {
  const one = createEvidenceReceipt({ action: "read", result: "ok", verified: true })
  const two = createEvidenceReceipt({ action: "write", result: "saved", verified: true, previousDigest: one.digest })
  expect(verifyEvidenceChain([one, two])).toBeTrue()
  expect(() => createEvidenceReceipt({ action: "run", result: "?", verified: false })).toThrow("unverified_result_refused")
})
