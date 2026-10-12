/**
 * 10-08 — measured with gpt-6.1-sol: «run $env:TEST_BASE_URL='http://127.0.0.1:3002'; npm test; if ($LASTEXITCODE -eq 0) { npm run test:unit }»
 * passed (1/1 and 55/55) and was not counted, so `sprint done 15` was refused twice for "no test run after the last edit".
 */
import { expect, test } from "bun:test"
import { newEvidenceClock, noteEvidence, sprintEvidenceRefusal } from "../src/sprint-evidence"

test("the measured test run with a PowerShell env prefix counts", () => {
  const clock = newEvidenceClock()
  noteEvidence(clock, "edit src/app/page.tsx :: a => b", true, 1_000)
  noteEvidence(clock, "run $env:TEST_BASE_URL='http://127.0.0.1:3002'; npm test; if ($LASTEXITCODE -eq 0) { npm run test:unit }", true, 2_000, "# pass 1\n# fail 0\n Test Files  11 passed (11)\n Tests  55 passed (55)")
  expect(clock.testAt).toBe(2_000)
  expect(sprintEvidenceRefusal("npm test: 1/1 ناجح؛ npm run test:unit: 55/55", clock)).toBeUndefined()
})

test("POSIX env prefixes and cd also count; a failing run still does not", () => {
  const clock = newEvidenceClock()
  noteEvidence(clock, "run NODE_ENV=production npm run build", true, 1_000, "✓ Compiled successfully")
  expect(clock.buildAt).toBe(1_000)
  noteEvidence(clock, "run cd web && npm test", true, 2_000, "# pass 3\n# fail 0")
  expect(clock.testAt).toBe(2_000)
  noteEvidence(clock, "run $env:CI='1'; npm test", true, 3_000, "# pass 2\n# fail 1")
  expect(clock.testAt).toBe(2_000)
  noteEvidence(clock, "run echo npm test", true, 4_000, "npm test")
  expect(clock.testAt).toBe(2_000)
})
