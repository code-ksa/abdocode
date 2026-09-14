import { describe, expect, test } from "bun:test"
import { parseSuperAbdoReview, resolveSuperAbdo, SUPER_ABDO_DEFAULTS, superAbdoInstruction, superAbdoVerificationProblem, validateSuperAbdo } from "../src/super-abdo"

const enabled = { ...SUPER_ABDO_DEFAULTS, enabled: true }

describe("Super Abdo strategy", () => {
  test("absence and malformed state disable the mode; authority is not an option", () => {
    expect(resolveSuperAbdo(undefined).enabled).toBe(false)
    expect(resolveSuperAbdo({ enabled: "true" }).enabled).toBe(false)
    expect(superAbdoInstruction(SUPER_ABDO_DEFAULTS)).toBe("")
    expect(validateSuperAbdo({ ...enabled, autoApprove: true })).toContain("unknown")
    expect(validateSuperAbdo({ ...enabled, maxRepairPasses: 5 })).toBeUndefined()
    for (const maxRepairPasses of [-1, 6, 1.5, "2", NaN]) {
      expect(validateSuperAbdo({ ...enabled, maxRepairPasses })).toBeDefined()
    }
    const source = { ...enabled }
    const snapshot = resolveSuperAbdo(source)
    source.enabled = false
    expect(snapshot.enabled).toBe(true)
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  test("completion checks enforce evidence after a change and fail closed on a failed latest check", () => {
    const write = { command: "write app.ts", mutated: true, passed: true }
    const successful = { command: "run bun test", passed: true }
    const failed = { command: "run bun test", passed: false }
    expect(superAbdoVerificationProblem(enabled, [])).toBeUndefined()
    expect(superAbdoVerificationProblem(enabled, [write])).toContain("No verification")
    expect(superAbdoVerificationProblem(enabled, [successful, write])).toContain("No verification")
    expect(superAbdoVerificationProblem(enabled, [write, successful])).toBeUndefined()
    expect(superAbdoVerificationProblem(enabled, [write, successful, failed])).toContain("failed")
    expect(superAbdoVerificationProblem(enabled, [write, failed, { command: "run bun run lint", passed: true }])).toContain("failed")
    expect(superAbdoVerificationProblem(enabled, [write, failed, successful])).toBeUndefined()
    expect(superAbdoVerificationProblem(enabled, [write, { command: "run bun test security.test.ts", passed: false }, { command: "run bun test trivial.test.ts", passed: true }])).toContain("failed")
    expect(superAbdoVerificationProblem(enabled, [write, { command: 'run echo "tests passed"', passed: true }])).toContain("No verification")
    expect(superAbdoVerificationProblem(enabled, [write, successful, write])).toContain("No verification")
    expect(superAbdoVerificationProblem(SUPER_ABDO_DEFAULTS, [write])).toBeUndefined()
    expect(superAbdoVerificationProblem({ ...enabled, verifyResults: false }, [write])).toBeUndefined()
  })

  test("review requires an explicit status and an actual reason", () => {
    expect(parseSuperAbdoReview("COMPLETE\nThe requested text-only answer is supplied and no effects were claimed.")?.status).toBe("COMPLETE")
    expect(parseSuperAbdoReview("INCOMPLETE\nThe last write has no verification receipt.")?.status).toBe("INCOMPLETE")
    for (const reply of ["COMPLETE", "COMPLETE\n— المقيس: دخل 12 توكيناً", "COMPLETE\nبلا سبب مذكور", "A review follows\nCOMPLETE\nAll good", "INCOMPLETE\nCOMPLETE"]) {
      expect(parseSuperAbdoReview(reply)).toBeUndefined()
    }
  })

  test("common language-specific verification commands count, unrelated successful tools do not", () => {
    const mutated = { command: "some.typed-operation", mutated: true, passed: true }
    for (const command of ["run npm run build", "run pnpm test", "run bun run typecheck", "run cargo test", "run python -m pytest -q", "run dotnet test", "run go test ./...", "run npx playwright test"]) {
      expect(superAbdoVerificationProblem(enabled, [mutated, { command, passed: true }])).toBeUndefined()
    }
    expect(superAbdoVerificationProblem(enabled, [mutated, { command: "read package.json", passed: true }])).toContain("No verification")
  })
})
