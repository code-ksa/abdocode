/**
 * Batch 7 GATES — S71 the engine and proportional verification, S72 build,
 * S73 the mocking trap, S74 runtime health, S75 the critical path, S76 visual
 * and security diff, S77 acceptance binding.
 */
import { describe, expect, test } from "bun:test"
import {
  decidePersona,
  fold,
  summariseCost,
  TRIVIAL_FILE_LIMIT,
  type ChangeProfile,
  type CheckResult,
} from "../src/engine"
import {
  checkBinding,
  judgeBuild,
  judgeCriticalPath,
  judgeDiff,
  judgeHealth,
  judgeTests,
  judgeVisual,
  reviewDiff,
} from "../src/gates"

const check = (over: Partial<CheckResult>): CheckResult => ({
  id: "c",
  kind: "test",
  status: "passed",
  evidence: "e",
  tokens: 0,
  ...over,
})

describe("S71 GATE — a run with no available check is `unverified`, never PASS", () => {
  test("nothing available is unverified, not passed", () => {
    const result = fold([check({ status: "unavailable" }), check({ id: "d", status: "unavailable" })])
    expect(result.verdict).toBe("unverified")
    expect(result.why).toContain('"could not run" is not "passed"')
  })

  test("no checks configured at all is unverified", () => {
    expect(fold([]).verdict).toBe("unverified")
  })

  test("one failure is not outvoted by nine passes — verification is not a poll", () => {
    const checks = [...Array.from({ length: 9 }, (_, i) => check({ id: `p${i}` })), check({ id: "bad", status: "failed" })]
    expect(fold(checks).verdict).toBe("failed")
  })

  test("a REQUIRED kind that could not run makes the whole thing unverified", () => {
    const result = fold([check({ kind: "lint" }), check({ id: "t", kind: "test", status: "unavailable" })], ["test"])
    expect(result.verdict).toBe("unverified")
    expect(result.why).toContain("the check that mattered is the one that could not run")
  })

  test("an unavailable check that nobody required does not block a pass", () => {
    expect(fold([check({ kind: "test" }), check({ id: "v", kind: "visual", status: "unavailable" })], ["test"]).verdict).toBe("passed")
  })
})

describe("S71 GATE — the verifier persona is spent in proportion to risk", () => {
  const small: ChangeProfile = {
    filesChanged: 1,
    classes: ["local_write"],
    protectedAspects: [],
    mechanicalFloor: "passed",
  }

  test("a small, clean, unprotected edit is verified by the floor alone", () => {
    const decision = decidePersona(small)
    expect(decision.runPersona).toBe(false)
    expect(decision.why).toContain("the floor IS the verdict here")
    // and the skip is RECORDED with what justified it
    expect(decision.skipRecord!.profile.filesChanged).toBe(1)
  })

  test("anything protected runs the persona whatever its size", () => {
    expect(decidePersona({ ...small, protectedAspects: ["database.schema"] }).runPersona).toBe(true)
  })

  test("a mechanically inconclusive floor runs it — that is what judgement is for", () => {
    expect(decidePersona({ ...small, mechanicalFloor: "unverified" }).runPersona).toBe(true)
    expect(decidePersona({ ...small, mechanicalFloor: "failed" }).runPersona).toBe(true)
  })

  test("a risk class beyond a local edit runs it", () => {
    expect(decidePersona({ ...small, classes: ["production_write"] }).runPersona).toBe(true)
    expect(decidePersona({ ...small, classes: ["read", "local_write"] }).runPersona).toBe(false)
  })

  test("past the small-change limit it runs", () => {
    expect(decidePersona({ ...small, filesChanged: TRIVIAL_FILE_LIMIT }).runPersona).toBe(false)
    expect(decidePersona({ ...small, filesChanged: TRIVIAL_FILE_LIMIT + 1 }).runPersona).toBe(true)
  })

  test("the token saving is MEASURED, and the skip rate is reported in both directions", () => {
    const decisions = [
      ...Array.from({ length: 7 }, () => decidePersona(small)),
      ...Array.from({ length: 3 }, () => decidePersona({ ...small, protectedAspects: ["ssh.exec"] })),
    ]
    const cost = summariseCost(decisions, 12_000)
    expect(cost.personaRuns).toBe(3)
    expect(cost.personaSkips).toBe(7)
    // 10 runs would have cost 120k; this cost 36k
    expect(cost.tokens).toBe(36_000)
    expect(cost.skipRate).toBeCloseTo(0.7, 5)

    // near zero means the rule does nothing; near one means it ate the
    // guarantee. Both are visible because the rate is reported.
    expect(summariseCost([], 12_000).skipRate).toBe(0)
  })
})

describe("S72 GATE — a build failure stops the chain with a classified reason", () => {
  test("a type error is classified as one", () => {
    const result = judgeBuild({ command: "tsc --noEmit", exitCode: 2, output: "src/a.ts(4,2): error TS2345: bad" })
    expect(result.status).toBe("failed")
    expect(result.failureClass).toBe("type_error")
  })

  test("a missing module is classified, so the next step is an install and not a guess", () => {
    expect(judgeBuild({ command: "bun build", exitCode: 1, output: "Cannot find module 'zod'" }).failureClass).toBe("missing_dependency")
  })

  test("a NULL exit code is a failure — killed or dead proves nothing either way", () => {
    const result = judgeBuild({ command: "bun build", exitCode: null, output: "" })
    expect(result.status).toBe("failed")
    expect(result.detail).toContain("nothing was proven either way")
  })

  test("a passing build costs zero tokens, because it is a command and not a model", () => {
    expect(judgeBuild({ command: "bun build", exitCode: 0, output: "done" }).tokens).toBe(0)
  })
})

describe("S73 GATE — '11/11 passed' is refused when the database was stopped", () => {
  test("a suite that declares a dependency it did not have is UNAVAILABLE, not passed", () => {
    const verdict = judgeTests({
      command: "bun test",
      passed: 11,
      failed: 0,
      output: "11 pass 0 fail",
      requires: ["database"],
      available: [],
    })
    expect(verdict.status).toBe("unavailable")
    expect(verdict.detail).toContain("against a system that was not there is not a result")
  })

  test("the same suite with the database up passes", () => {
    expect(
      judgeTests({ command: "bun test", passed: 11, failed: 0, output: "ok", requires: ["database"], available: ["database"] }).status,
    ).toBe("passed")
  })

  test("mock signals are FLAGGED even when the run is legitimately green", () => {
    const verdict = judgeTests({ command: "bun test", passed: 11, failed: 0, output: "using vi.mock('./db')" })
    // honest limit: this cannot detect a mock nobody mentioned, so it flags
    // rather than fails, and the flag is the thing a human reads
    expect(verdict.status).toBe("passed")
    expect(verdict.suspicious).toBe(true)
  })

  test("zero tests ran is not a pass — a suite that selected nothing selected nothing", () => {
    expect(judgeTests({ command: "bun test src/nothing", passed: 0, failed: 0, output: "" }).status).toBe("unavailable")
  })
})

describe("S74 GATE — a green build and an app that does not boot is a FAIL", () => {
  test("an app that never answered fails", () => {
    const result = judgeHealth({ url: "http://localhost:3000/health", error: "ECONNREFUSED" })
    expect(result.status).toBe("failed")
    expect(result.detail).toContain("does not boot is a FAIL, not a PASS")
  })

  test("a 500 fails and a 200 passes", () => {
    expect(judgeHealth({ url: "u", status: 500 }).status).toBe("failed")
    expect(judgeHealth({ url: "u", status: 200 }).status).toBe("passed")
  })

  test("no probe run is unavailable, not healthy", () => {
    expect(judgeHealth({ url: "u" }).status).toBe("unavailable")
  })
})

describe("S75 GATE — a UI sprint proves the critical path", () => {
  const path = { path: "checkout", steps: [{ name: "open", done: true }, { name: "pay", done: true }], consoleClean: true }

  test("a UI sprint with no defined path is UNAVAILABLE, so it cannot pass", () => {
    expect(judgeCriticalPath({ path: "checkout", steps: [], consoleClean: true }, true).status).toBe("unavailable")
  })

  test("a stopped step fails and names where it stopped", () => {
    const result = judgeCriticalPath(
      { ...path, steps: [{ name: "open", done: true }, { name: "pay", done: false, why: "the button never enabled" }] },
      true,
    )
    expect(result.status).toBe("failed")
    expect(result.detail).toContain("the button never enabled")
  })

  test("a completed path with a dirty console still fails", () => {
    expect(judgeCriticalPath({ ...path, consoleClean: false }, true).status).toBe("failed")
  })

  test("a sprint that did not touch the interface skips it honestly", () => {
    expect(judgeCriticalPath(path, false).status).toBe("skipped")
  })
})

describe("S76 GATE — a visual change over the limit or a secret in the diff is a FAIL", () => {
  test("over the limit fails, and a failure with no artefact says so", () => {
    const withEvidence = judgeVisual({ screen: "home", changed: 0.2, baselineExists: true, artefact: "diffs/home.png" })
    expect(withEvidence.status).toBe("failed")
    expect(withEvidence.detail).toContain("diffs/home.png")

    const without = judgeVisual({ screen: "home", changed: 0.2, baselineExists: true })
    expect(without.detail).toContain("cannot be judged or dismissed")
  })

  test("no baseline records one rather than passing", () => {
    expect(judgeVisual({ screen: "home", changed: 0, baselineExists: false }).status).toBe("unavailable")
  })

  test("a secret in the added lines fails the diff review", () => {
    const review = reviewDiff(
      [
        { file: "src/db.ts", line: 'const url = "postgres://app:hunter2pass@db/prod"' },
        { file: "src/ok.ts", line: "const x = 1" },
      ],
      [],
    )
    expect(review.secrets.length).toBeGreaterThan(0)
    expect(judgeDiff(review).status).toBe("failed")
  })

  test("a dangerous path and an out-of-scope file are both reported", () => {
    const review = reviewDiff(
      [
        { file: ".github/workflows/deploy.yml", line: "run: rm -rf /" },
        { file: "src/unrelated.ts", line: "const y = 2" },
      ],
      ["src/config.ts"],
    )
    expect(review.dangerousPaths).toContain(".github/workflows/deploy.yml")
    expect(review.outOfScope).toContain("src/unrelated.ts")
    expect(judgeDiff(review).detail).toContain("out of scope")
  })

  test("a clean diff passes", () => {
    expect(judgeDiff(reviewDiff([{ file: "src/a.ts", line: "export const a = 1" }], ["src"])).status).toBe("passed")
  })
})

describe("S77 GATE — a sprint with no checkable criterion does not enter RUNNING", () => {
  test("an unbound criterion blocks the start", () => {
    const verdict = checkBinding([
      { id: "c1", text: "the loader works", checks: ["unit"] },
      { id: "c2", text: "it feels fast", checks: [] },
    ])
    expect(verdict.mayStart).toBe(false)
    expect(verdict.unbound).toEqual(["c2"])
    expect(verdict.why).toContain("declared met by whoever is tired at the end")
  })

  test("no criteria at all is refused — a sprint that cannot fail is not a sprint", () => {
    const verdict = checkBinding([])
    expect(verdict.mayStart).toBe(false)
    expect(verdict.why).toContain("cannot fail")
  })

  test("fully bound criteria may start", () => {
    expect(checkBinding([{ id: "c1", text: "x", checks: ["unit", "e2e"] }]).mayStart).toBe(true)
  })
})
