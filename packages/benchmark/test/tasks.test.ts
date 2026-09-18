import { describe, expect, test } from "bun:test"
import { STRATEGY_PROBE_TASKS } from "../src/index"
import { CATEGORY_DISTRIBUTION, FULL_SUITE, SAMPLE_SUITE, checkDistribution } from "../src/index"

describe("task suite", () => {
  test("the category distribution sums to 100", () => {
    expect(Object.values(CATEGORY_DISTRIBUTION).reduce((a, b) => a + b, 0)).toBe(100)
  })

  test("the sample suite has one real task per category, verified objectively (not 'say hello')", () => {
    const cats = new Set(SAMPLE_SUITE.map((t) => t.category))
    expect(cats.size).toBe(Object.keys(CATEGORY_DISTRIBUTION).length)
    // every non-QA/git task has at least one mechanical check
    for (const t of SAMPLE_SUITE) {
      const v = t.verification
      const mechanical = v.typecheck || v.test || v.build || v.expectPaths || v.requireContains || v.requireAbsent
      const judged = v.judgePrompt
      expect(Boolean(mechanical || judged)).toBe(true)
    }
  })

  test("checkDistribution reports the sample is below the 100-task target and what is missing", () => {
    const c = checkDistribution(SAMPLE_SUITE)
    expect(c.total).toBe(SAMPLE_SUITE.length)
    expect(c.matchesTarget).toBe(false) // sample < 100
    expect(c.missing.single_file_edit).toBe(CATEGORY_DISTRIBUTION.single_file_edit - 1)
  })

  test("the FULL generated suite is exactly 100 tasks and meets the distribution", () => {
    const c = checkDistribution(FULL_SUITE)
    expect(c.total).toBe(100)
    expect(c.matchesTarget).toBe(true)
    for (const [cat, target] of Object.entries(CATEGORY_DISTRIBUTION)) expect(c.byCategory[cat]).toBe(target)
  })

  test("every task id in the full suite is unique", () => {
    const ids = FULL_SUITE.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("the majority of tasks are objectively verifiable (not judge-only)", () => {
    const mechanical = FULL_SUITE.filter((t) => {
      const v = t.verification
      return v.typecheck || v.test || v.build || v.expectPaths || v.requireContains || v.requireAbsent
    })
    expect(mechanical.length).toBeGreaterThan(FULL_SUITE.length / 2)
  })
})

describe("strategy-guard probe tasks", () => {
  test("the probes are OUTSIDE the frozen suite (the baseline must not move)", () => {
    const suiteIds = new Set(FULL_SUITE.map((t) => t.id))
    for (const t of STRATEGY_PROBE_TASKS) expect(suiteIds.has(t.id)).toBe(false)
    expect(checkDistribution(FULL_SUITE).total).toBe(100)
  })

  test("both probes are objectively verifiable, not judge-only", () => {
    expect(STRATEGY_PROBE_TASKS.map((t) => t.id)).toEqual(["install-thrash-unseen", "monorepo-two-package-installs"])
    for (const t of STRATEGY_PROBE_TASKS) {
      const v = t.verification
      expect(Boolean(v.typecheck || v.test || v.expectPaths || v.requireContains)).toBe(true)
      expect(v.judgePrompt).toBeUndefined()
    }
  })

  test("the bun probe ships a bun lockfile and the monorepo probe ships two packages", () => {
    const bunProbe = STRATEGY_PROBE_TASKS.find((t) => t.id === "install-thrash-unseen")!
    expect(Object.keys(bunProbe.fixture!)).toContain("bun.lock")
    const mono = STRATEGY_PROBE_TASKS.find((t) => t.id === "monorepo-two-package-installs")!
    expect(Object.keys(mono.fixture!)).toContain("packages/api/package.json")
    expect(Object.keys(mono.fixture!)).toContain("packages/web/package.json")
  })
})
