import { expect, test } from "bun:test"
import { projectTestPassed, recallExecutionFact } from "../src/project-test-acceptance"

test("a test process must exit successfully and run a nonempty passing suite", () => {
  for (const output of ["0 pass\nانتهى الأمر برمز 0", "No tests found\nانتهى الأمر برمز 0", "2 passed\n1 failed\nانتهى الأمر برمز 0", "2 passed\nانتهى الأمر برمز 1", "2 passed"]) expect(projectTestPassed(output)).toBe(false)
  for (const output of ["Tests 12 passed (12)", "12 pass\n0 fail", "# tests 3\n# pass 3\n# fail 0"]) expect(projectTestPassed(`${output}\nانتهى الأمر برمز 0`)).toBe(true)
})
test("long repeated goals cannot hide actual failure evidence on recall", () => {
  const result = recallExecutionFact({ goal: "original goal ".repeat(1000), stopReason: "tool-failed", receipts: [{ command: "run npm test", output: "vitest missing; exit code 1" }] })
  expect(result).toContain("vitest missing")
  expect(result).toContain("tool-failed")
  expect(result.length).toBeLessThan(2000)
})
test("an explicit failing verdict defeats a receipt whose text reads as a passing zero-exit suite", () => {
  const output = "3 passed\nانتهى الأمر برمز 0"
  expect(projectTestPassed(output)).toBe(true)
  expect(projectTestPassed(output, { ok: false, reason: "aborted", denied: false })).toBe(false)
})
test("an explicit ok verdict admits a markerless passing suite; absence still requires the marker; content rules still apply", () => {
  expect(projectTestPassed("3 passed", { ok: true })).toBe(true)
  expect(projectTestPassed("3 passed")).toBe(false)
  expect(projectTestPassed("No tests found", { ok: true })).toBe(false)
})
