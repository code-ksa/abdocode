/**
 * Batch 2 GATES — S33 suite integrity, S34 regression gate, S35 cost budget,
 * S36 blind comparison.
 *
 * The four are tested together because they are one mechanism: a suite that
 * produces a score, a comparison of scores that blocks, a budget that makes
 * cost part of that score, and a cadence that checks the whole thing against
 * somebody else. Any one of them alone is a number nobody acts on.
 */
import { describe, expect, test } from "bun:test"
import { ABDO_BENCH_V1, BENCH_AXES, checkSuite, isJudgeDecided, type BenchScenario } from "../src/suite-v1"
import {
  compareScorecards,
  evaluateBudget,
  formatScorecard,
  regressionBlocksClose,
  REGRESSION_THRESHOLD,
  type Scorecard,
} from "../src/scorecard"
import {
  assignLabels,
  cadenceDue,
  formatComparison,
  publishComparison,
  unrunComparison,
  type ComparisonRound,
} from "../src/comparison"

describe("S33 GATE — the suite is a measurement, not a demo", () => {
  test("thirty scenarios, every axis covered, no duplicate ids", () => {
    const check = checkSuite()
    expect(check.total).toBe(30)
    expect(check.axesWithoutScenarios).toEqual([])
    expect(check.duplicateIds).toEqual([])
    expect(check.ok).toBe(true)
  })

  test("no scenario is unverifiable — a number nobody can defend is not a result", () => {
    expect(checkSuite().unverifiable).toEqual([])
  })

  test("the mechanical majority is real, and the judged proportion is visible", () => {
    const judged = ABDO_BENCH_V1.filter(isJudgeDecided)
    // a model scoring a model is a measurement whose error moves with the thing
    // it measures, so the count is asserted rather than left to drift
    expect(judged.length).toBeLessThan(ABDO_BENCH_V1.length / 2)
    expect(ABDO_BENCH_V1.length - judged.length).toBeGreaterThanOrEqual(15)
  })

  test("every assertion is a regex that can actually fire", () => {
    // the defect this catches, found in this suite: a word-boundary escape
    // written inside a TS string becomes a BACKSPACE character, so the
    // assertion could never match and the scenario would have passed for
    // ever. An assertion that cannot fire is worse than no assertion.
    for (const s of ABDO_BENCH_V1) {
      for (const pattern of [s.checks?.answerMatches, s.checks?.answerAbsent]) {
        if (pattern === undefined) continue
        expect(() => new RegExp(pattern)).not.toThrow()
        const control = [...pattern].find((c) => c.charCodeAt(0) < 32)
        expect(control).toBeUndefined()
      }
    }
  })

  test("the log assertions name real event types, not invented ones", () => {
    // an expectEvents entry nobody emits is an assertion that fails for ever;
    // a forbidEvents entry nobody emits is one that passes for ever. Both are
    // worse than no assertion, so the shape is held to the log's vocabulary.
    for (const s of ABDO_BENCH_V1) {
      const named = [
        ...(s.checks?.expectEvents ?? []),
        ...(s.checks?.forbidEvents ?? []),
        ...Object.keys(s.checks?.eventCounts ?? {}),
      ]
      for (const type of named) {
        expect(type).toMatch(/^[a-z_]+\.[a-z_]+$/)
      }
    }
  })

  test("every scenario says why it exists", () => {
    for (const s of ABDO_BENCH_V1) {
      expect(s.rationale.length).toBeGreaterThan(20)
      expect(s.timeoutMs).toBeGreaterThan(0)
    }
  })

  test("the suite is deterministic — the same import gives the same suite", () => {
    // the S33 gate is "the same scenario gives the same verdict across runs";
    // the half that lives in data is that the suite itself never varies
    const a = JSON.stringify(ABDO_BENCH_V1)
    const b = JSON.stringify(checkSuite().total === 30 ? ABDO_BENCH_V1 : [])
    expect(a).toBe(b)
    expect(new Set(ABDO_BENCH_V1.map((s) => s.id)).size).toBe(30)
  })

  test("the dangerous scenarios are marked, so they never run unsandboxed by accident", () => {
    const dangerous = ABDO_BENCH_V1.filter((s: BenchScenario) => s.dangerous === true)
    expect(dangerous.length).toBeGreaterThan(0)
    for (const s of dangerous) {
      expect(["ssh", "security", "git"]).toContain(s.axis)
    }
  })
})

const card = (label: string, scores: Partial<Record<string, number>>): Scorecard => ({
  label,
  axes: BENCH_AXES.filter((a) => scores[a] !== undefined).map((axis) => ({
    axis,
    score: scores[axis]!,
    scenarios: 3,
    unverified: 0,
  })),
  at: 0,
})

describe("S34 GATE — a measured regression stops the close", () => {
  const before = card("s33", { code_edit: 0.9, navigation: 0.8, security: 1.0, recovery: 0.7 })

  test("fixing one axis while breaking another does not pass", () => {
    const after = card("s34", { code_edit: 0.95, navigation: 0.6, security: 1.0, recovery: 0.7 })
    const verdict = compareScorecards(before, after)
    expect(verdict.regressed.map((r) => r.axis)).toEqual(["navigation"])
    expect(verdict.blocked).toBe(true)
    expect(regressionBlocksClose(verdict).allowed).toBe(false)
    expect(regressionBlocksClose(verdict).why).toContain("explain it or fix it")
  })

  test("noise below the threshold is not a regression", () => {
    const after = card("s34", {
      code_edit: 0.9 - REGRESSION_THRESHOLD / 2,
      navigation: 0.8,
      security: 1.0,
      recovery: 0.7,
    })
    expect(compareScorecards(before, after).blocked).toBe(false)
  })

  test("an axis that stopped being measured blocks — silence is not a pass", () => {
    const after = card("s34", { code_edit: 0.95, navigation: 0.85, security: 1.0 })
    const verdict = compareScorecards(before, after)
    expect(verdict.unmeasured).toEqual(["recovery"])
    expect(verdict.blocked).toBe(true)
    expect(verdict.reason).toContain("no longer measured")
  })

  test("an explanation must name the axes it explains", () => {
    const after = card("s34", { code_edit: 0.95, navigation: 0.6, security: 0.7, recovery: 0.7 })
    const verdict = compareScorecards(before, after)

    const blanket = regressionBlocksClose(verdict, {
      axes: ["navigation"],
      why: "we deliberately traded navigation speed for correctness this sprint",
      by: "owner",
    })
    expect(blanket.allowed).toBe(false)
    expect(blanket.why).toContain("says nothing about security")

    const complete = regressionBlocksClose(verdict, {
      axes: ["navigation", "security"],
      why: "both regressions come from the new plan gate refusing operations the suite assumed were free",
      by: "owner",
    })
    expect(complete.allowed).toBe(true)
  })

  test("an explanation too short to be one is refused", () => {
    const after = card("s34", { code_edit: 0.9, navigation: 0.5, security: 1.0, recovery: 0.7 })
    const verdict = compareScorecards(before, after)
    expect(regressionBlocksClose(verdict, { axes: ["navigation"], why: "known", by: "me" }).allowed).toBe(false)
  })

  test("a clean run closes, and a new axis is not a regression", () => {
    const after = card("s34", { code_edit: 0.9, navigation: 0.8, security: 1.0, recovery: 0.7, git: 0.5 })
    const verdict = compareScorecards(before, after)
    expect(verdict.blocked).toBe(false)
    expect(verdict.changes.find((c) => c.axis === "git")!.kind).toBe("new")
    expect(formatScorecard(verdict)).toContain("ok:")
  })
})

describe("S35 GATE — a doubling is announced, never passed over", () => {
  test("within budget passes quietly", () => {
    const verdict = evaluateBudget("small", { tokens: 20_000, ms: 90_000 })
    expect(verdict.tokens).toBe("within")
    expect(verdict.mustJustify).toBe(false)
  })

  test("over budget is reported but does not by itself demand a justification", () => {
    const verdict = evaluateBudget("small", { tokens: 30_000, ms: 90_000 })
    expect(verdict.tokens).toBe("over")
    expect(verdict.mustJustify).toBe(false)
  })

  test("a doubling must be justified or refused", () => {
    const verdict = evaluateBudget("small", { tokens: 60_000, ms: 90_000 })
    expect(verdict.tokens).toBe("doubled")
    expect(verdict.tokenRatio).toBe(2.4)
    expect(verdict.mustJustify).toBe(true)
    expect(verdict.reason).toContain("justified or refused")
  })

  test("latency doubles independently of cost", () => {
    const verdict = evaluateBudget("medium", { tokens: 10_000, ms: 700_000 })
    expect(verdict.tokens).toBe("within")
    expect(verdict.latency).toBe("doubled")
    expect(verdict.mustJustify).toBe(true)
  })

  test("UNMEASURED never passes as within budget", () => {
    const verdict = evaluateBudget("medium", { tokens: null, ms: 100_000 })
    expect(verdict.tokens).toBe("unmeasured")
    expect(verdict.mustJustify).toBe(true)
    expect(verdict.reason).toContain("not measured")
  })
})

describe("S36 GATE — the comparison is blind, and a loss is published like a win", () => {
  const round = (scores: Record<string, Record<string, number>>): ComparisonRound => ({
    round: 1,
    afterSprint: 36,
    labels: assignLabels([{ id: "abdo" }, { id: "rival-a" }, { id: "verdent" }], 1),
    axes: Object.entries(scores).map(([axis, s]) => ({ axis: axis as never, scores: s })),
    tasksPerAxis: 20,
    at: 0,
  })

  test("labels are deterministic and hide identity during scoring", () => {
    const first = assignLabels([{ id: "abdo" }, { id: "rival-a" }], 1)
    const again = assignLabels([{ id: "abdo" }, { id: "rival-a" }], 1)
    expect(first).toEqual(again)
    // a later round does not reuse the same mapping
    expect(assignLabels([{ id: "abdo" }, { id: "rival-a" }], 2)).not.toEqual(first)
    // the scoring surface carries labels, not names
    expect(first.map((l) => l.label).sort()).toEqual(["A", "B"])
  })

  test("losses appear in the published result and cannot be omitted", () => {
    const labels = assignLabels([{ id: "abdo" }, { id: "rival-a" }, { id: "verdent" }], 1)
    const our = labels.find((l) => l.contestantId === "abdo")!.label
    const rival = labels.find((l) => l.contestantId === "verdent")!.label
    const third = labels.find((l) => l.contestantId === "rival-a")!.label

    const published = publishComparison(
      {
        ...round({}),
        labels,
        axes: [
          { axis: "security", scores: { [our]: 0.95, [rival]: 0.6, [third]: 0.7 } },
          { axis: "code_edit", scores: { [our]: 0.62, [rival]: 0.88, [third]: 0.8 } },
          { axis: "navigation", scores: { [our]: 0.5, [rival]: 0.9, [third]: 0.85 } },
        ],
      },
      "abdo",
    )

    expect(published.losses).toEqual(["code_edit", "navigation"])
    expect(published.wins).toEqual(["security"])
    // the identity is revealed only now, after the scores were fixed
    expect(published.lines.find((l) => l.axis === "code_edit")!.winner).toBe("verdent")
    expect(published.headline).toContain("2 loss(es)")

    // the report prints losses FIRST — burying them is a report for the author
    const text = formatComparison(published)
    expect(text.indexOf("LOST")).toBeLessThan(text.indexOf("held"))
    expect(text).toContain("behind by 40 points")
  })

  test("an axis that did not run is stated, not dropped", () => {
    const labels = assignLabels([{ id: "abdo" }, { id: "verdent" }], 1)
    const our = labels.find((l) => l.contestantId === "abdo")!.label
    const published = publishComparison(
      {
        ...round({}),
        labels,
        axes: [{ axis: "security", scores: { [our]: 0.9, B: 0.5 } }],
        notRun: [{ axis: "ssh", why: "no authorised remote host in the comparison environment" }],
      },
      "abdo",
    )
    expect(published.notRun).toHaveLength(1)
    expect(formatComparison(published)).toContain("not run — no authorised remote host")
  })

  test("the cadence fires every ten sprints and not before it was declared", () => {
    expect(cadenceDue(30, undefined)).toBe(false)
    expect(cadenceDue(36, undefined)).toBe(true)
    expect(cadenceDue(40, 36)).toBe(false)
    expect(cadenceDue(46, 36)).toBe(true)
  })

  test('an unrun comparison publishes "not measured" rather than an absence', () => {
    const published = unrunComparison(36, "no provider budget has been authorised")
    expect(published.headline).toContain("no claim of superiority is supported by measurement")
    expect(published.wins).toEqual([])
    expect(published.losses).toEqual([])
  })
})
