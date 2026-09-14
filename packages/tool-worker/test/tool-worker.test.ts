import { expect, test } from "bun:test"
import { validateToolWorkerRequest } from "../src"
test("accepts structured bounded worker requests", () => {
  expect(validateToolWorkerRequest({ version: 1, requestId: "r1", tool: "format", argv: ["--check"], timeoutMs: 1000 }).argv).toEqual(["--check"])
  expect(() => validateToolWorkerRequest({ version: 1, requestId: "r1", tool: "x", argv: [], timeoutMs: 0 })).toThrow("tool_worker_timeout_invalid")
})
