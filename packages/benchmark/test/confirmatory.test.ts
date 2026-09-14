import { describe, expect, test } from "bun:test"
import {
  CONFIRMATORY_DESIGN,
  CONFIRMATORY_FINGERPRINT,
  CONFIRMATORY_SMOKE_TASKS,
  CONFIRMATORY_SUITE,
  ConfirmatoryDataError,
  ConfirmatorySuiteError,
  assertConfirmatorySuite,
  checkDistribution,
  confirmatoryStatistics,
  FULL_SUITE,
  METRICS_SCHEMA_VERSION,
  nonInferiorDecision,
  SAMPLE_SUITE,
  STRATEGY_PROBE_TASKS,
  suiteFingerprint,
  type BenchmarkData,
  type ConfirmatoryTask,
  type RunMetrics,
  type TrialResult,
} from "../src/index"

// --- test fixtures (same convention as report.test.ts) ---------------------

const metrics = (over: Partial<RunMetrics> = {}): RunMetrics => ({
  taskSuccess: true,
  objectiveCorrect: over.taskSuccess ?? true,
  completedNormally: over.taskSuccess ?? true,
  correctnessScore: 1,
  finalState: "completed",
  terminal: true,
  stuck: false,
  timeToFirstToken: 100,
  totalCompletionTime: 1000,
  inputTokens: 500,
  outputTokens: 200,
  providerRequests: 2,
  toolCalls: 3,
  failedToolCalls: 0,
  repeatedToolCalls: 0,
  duplicateSideEffects: 0,
  humanApprovals: 0,
  humanInterventions: 0,
  filesRead: 1,
  filesModified: 1,
  recoveryAttempted: false,
  recoverySucceeded: false,
  rollbacks: 0,
  rollbacksFromNonMutatingFailure: 0,
  rollbackDetails: [],
  verificationUnavailable: 0,
  repeatedCallsBlocked: 0,
  redundantStrategiesBlocked: 0,
  maxStrategyExecutionsPerState: 0,
  ...over,
})

const trial = (taskId: string, category: string, runtime: "v1" | "v2", success: boolean, over: Partial<RunMetrics> = {}): TrialResult => ({
  taskId,
  category,
  runtime,
  metrics: metrics({ taskSuccess: success, ...over }),
  verification: { passed: success, score: success ? 1 : 0, checks: [], judgeOnly: false },
})

/** A complete synthetic 250-pair dataset: one V1 + one V2 trial per confirmatory task. */
const pairedData = (outcome: (i: number) => { v1: boolean; v2: boolean }, over: Partial<BenchmarkData> = {}): BenchmarkData => ({
  repoRef: "confirmatory-test",
  metricsSchemaVersion: METRICS_SCHEMA_VERSION,
  trials: CONFIRMATORY_SUITE.flatMap((t, i) => {
    const o = outcome(i)
    return [trial(t.id, t.category, "v1", o.v1), trial(t.id, t.category, "v2", o.v2)]
  }),
  ...over,
})

const allConcordantSuccess = pairedData(() => ({ v1: true, v2: true }))

// The live-only prior ids that live in packages/host/scripts/bench-live.ts
// (pilot/canary/hard). They are listed here as DATA because the benchmark
// package must not import from the host package.
const HOST_SIDE_PRIOR_IDS = [
  "pilot-edit",
  "pilot-create",
  "pilot-rename",
  "pilot-fix-value",
  "pilot-qa",
  "canary-tests",
  "hard-rename-3files",
  "hard-move-fn",
  "hard-two-config",
  "hard-scaffold-test",
  "hard-fix-multi",
]

const isMechanical = (t: ConfirmatoryTask): boolean => {
  const v = t.verification
  return Boolean(v.typecheck || v.test || v.build || v.expectPaths || v.requireContains || v.requireAbsent)
}

// ---------------------------------------------------------------------------

describe("C1 — the fresh paired confirmatory suite", () => {
  test("exactly 250 tasks, none of them crash_resume", () => {
    expect(CONFIRMATORY_SUITE.length).toBe(250)
    expect(CONFIRMATORY_SUITE.filter((t) => t.category === "crash_resume")).toHaveLength(0)
  })

  test("cohort annotation: exactly 150 known-template and 100 unseen-template (40%, inside the 30–40% band)", () => {
    const known = CONFIRMATORY_SUITE.filter((t) => t.cohort === "known-template")
    const unseen = CONFIRMATORY_SUITE.filter((t) => t.cohort === "unseen-template")
    expect(known).toHaveLength(150)
    expect(unseen).toHaveLength(100)
    expect(unseen.length / CONFIRMATORY_SUITE.length).toBe(0.4)
    expect(unseen.length / CONFIRMATORY_SUITE.length).toBeGreaterThanOrEqual(0.3)
    expect(unseen.length / CONFIRMATORY_SUITE.length).toBeLessThanOrEqual(0.4)
    // every task carries the annotation — it is mechanically checkable, not prose
    expect(CONFIRMATORY_SUITE.every((t) => t.cohort === "known-template" || t.cohort === "unseen-template")).toBe(true)
    expect(CONFIRMATORY_SUITE.every((t) => typeof t.template === "string" && t.template.length > 0)).toBe(true)
  })

  test("covers all eight live categories and a mechanical-verification majority", () => {
    const cats = new Set(CONFIRMATORY_SUITE.map((t) => t.category))
    for (const c of ["qa", "read_search", "single_file_edit", "multi_file_edit", "typescript_fix", "tests_diagnose", "git_analysis", "long_multi_tool"]) {
      expect(cats.has(c as never)).toBe(true)
    }
    expect(cats.has("crash_resume" as never)).toBe(false)
    const mechanical = CONFIRMATORY_SUITE.filter(isMechanical)
    expect(mechanical.length).toBeGreaterThan(CONFIRMATORY_SUITE.length / 2) // the requirement
    expect(mechanical).toHaveLength(200) // the pre-registered composition
  })

  test("all ids unique and disjoint from every prior suite", () => {
    const ids = CONFIRMATORY_SUITE.map((t) => t.id)
    expect(new Set(ids).size).toBe(250)
    const prior = new Set([...FULL_SUITE, ...SAMPLE_SUITE, ...STRATEGY_PROBE_TASKS].map((t) => t.id))
    for (const id of ids) expect(prior.has(id)).toBe(false)
    for (const id of HOST_SIDE_PRIOR_IDS) expect(ids).not.toContain(id)
    // the prior 95 live pairs are FULL_SUITE minus crash_resume — covered by the FULL_SUITE check above
    expect(FULL_SUITE.filter((t) => t.category !== "crash_resume")).toHaveLength(95)
  })

  test("the frozen SHA-256 fingerprint matches the suite definitions", () => {
    expect(suiteFingerprint(CONFIRMATORY_SUITE)).toBe(CONFIRMATORY_FINGERPRINT)
    expect(() => assertConfirmatorySuite()).not.toThrow()
  })

  test("task-definition drift without a deliberate fingerprint update FAILS mechanically", () => {
    const driftedMessage = CONFIRMATORY_SUITE.map((t, i) => (i === 0 ? { ...t, messages: ["tampered prompt"] } : t))
    expect(suiteFingerprint(driftedMessage)).not.toBe(CONFIRMATORY_FINGERPRINT)
    expect(() => assertConfirmatorySuite(driftedMessage)).toThrow(/fingerprint drift/)
    const driftedFixture = CONFIRMATORY_SUITE.map((t, i) => (i === 0 ? { ...t, fixture: { "src/tampered.ts": "x" } } : t))
    expect(suiteFingerprint(driftedFixture)).not.toBe(CONFIRMATORY_FINGERPRINT)
  })

  test("structural violations are refused before any fingerprint comparison", () => {
    expect(() => assertConfirmatorySuite(CONFIRMATORY_SUITE.slice(0, 249))).toThrow(/exactly 250/)
    const cohortFlip = CONFIRMATORY_SUITE.map((t, i) => (i === 0 ? { ...t, cohort: "unseen-template" as const } : t))
    expect(() => assertConfirmatorySuite(cohortFlip)).toThrow(/known-template cohort/)
    const crashTask = CONFIRMATORY_SUITE.map((t, i) => (i === 0 ? ({ ...t, category: "crash_resume" } as ConfirmatoryTask) : t))
    expect(() => assertConfirmatorySuite(crashTask)).toThrow(/crash_resume/)
    const dupId = CONFIRMATORY_SUITE.map((t, i) => (i === 1 ? { ...t, id: CONFIRMATORY_SUITE[0]!.id } : t))
    expect(() => assertConfirmatorySuite(dupId)).toThrow(/duplicate confirmatory task id/)
    expect(new ConfirmatorySuiteError("x")).toBeInstanceOf(Error)
  })

  test("FULL_SUITE is UNCHANGED: exactly 100 tasks, distribution intact", () => {
    expect(FULL_SUITE).toHaveLength(100)
    const c = checkDistribution(FULL_SUITE)
    expect(c.matchesTarget).toBe(true)
    expect(c.total).toBe(100)
  })
})

describe("C2 — the frozen pre-registered design", () => {
  test("fixes suite identity, 250 pairs, cohort split, endpoint/model, pairing, confidence, margin, CI method", () => {
    expect(CONFIRMATORY_DESIGN.suiteId).toBe("abdo-confirmatory")
    expect(CONFIRMATORY_DESIGN.suiteVersion).toBe(2)
    expect(CONFIRMATORY_DESIGN.pairs).toBe(250)
    expect(CONFIRMATORY_DESIGN.knownTemplateTasks).toBe(150)
    expect(CONFIRMATORY_DESIGN.unseenTasks).toBe(100)
    expect(CONFIRMATORY_DESIGN.provider).toBe("qwen-local")
    expect(CONFIRMATORY_DESIGN.model).toBe("qwen3.5:4b")
    // the SAME model behind both runtimes — the comparison is runtime vs runtime
    expect(CONFIRMATORY_DESIGN.v1Model).toBe("ollama/qwen3.5:4b")
    expect(CONFIRMATORY_DESIGN.orderSwap).toBe(true)
    expect(CONFIRMATORY_DESIGN.confidence).toBe(0.95)
    expect(CONFIRMATORY_DESIGN.zCritical).toBe(1.959963984540054)
    expect(CONFIRMATORY_DESIGN.nonInferiorityMargin).toBe(-0.05)
    expect(CONFIRMATORY_DESIGN.ciMethod.length).toBeGreaterThan(0)
    expect(CONFIRMATORY_DESIGN.decisionRule).toContain("ciLower > -0.05")
  })

  test("the smoke subset is a small, separately-labeled part of the suite", () => {
    expect(CONFIRMATORY_SMOKE_TASKS.length).toBeGreaterThan(0)
    expect(CONFIRMATORY_SMOKE_TASKS.length).toBeLessThanOrEqual(10)
    const suiteIds = new Set(CONFIRMATORY_SUITE.map((t) => t.id))
    for (const t of CONFIRMATORY_SMOKE_TASKS) expect(suiteIds.has(t.id)).toBe(true)
    expect(new Set(CONFIRMATORY_SMOKE_TASKS.map((t) => t.id)).size).toBe(CONFIRMATORY_SMOKE_TASKS.length)
  })
})

describe("C3 — paired non-inferiority statistics", () => {
  test("all-concordant successes: zero difference, zero-width interval, passes", () => {
    const { stats } = confirmatoryStatistics(allConcordantSuccess)
    expect(stats.pairs).toBe(250)
    expect(stats.concordantBothSuccess).toBe(250)
    expect(stats.concordantBothFail).toBe(0)
    expect(stats.discordantV1Only).toBe(0)
    expect(stats.discordantV2Only).toBe(0)
    expect(stats.observedDifference).toBe(0)
    expect(stats.standardError).toBe(0)
    expect(stats.ciLower).toBe(0)
    expect(stats.ciUpper).toBe(0)
    expect(stats.nonInferior).toBe(true)
    expect(stats.method).toBe(CONFIRMATORY_DESIGN.ciMethod)
  })

  test("a PASSING case: 10 V2-only discordant pairs (expected values derived from the pre-registered formula)", () => {
    // 240 concordant successes + 10 pairs where V2 succeeds and V1 fails.
    const data = pairedData((i) => ({ v1: i >= 10, v2: true }))
    const { stats } = confirmatoryStatistics(data)
    expect(stats.v1Successes).toBe(240)
    expect(stats.v2Successes).toBe(250)
    expect(stats.discordantV2Only).toBe(10)
    expect(stats.observedDifference).toBe(0.04)
    expect(stats.standardError).toBe(0.012418408411301325)
    expect(stats.ciLower).toBe(0.015660366768540133)
    expect(stats.ciUpper).toBe(0.06433963323145987)
    expect(stats.nonInferior).toBe(true)
  })

  test("a FAILING case: 30 V1-only discordant pairs put the lower bound far below the margin", () => {
    // 220 concordant successes + 30 pairs where V1 succeeds and V2 fails.
    const data = pairedData((i) => ({ v1: true, v2: i >= 30 }))
    const { stats } = confirmatoryStatistics(data)
    expect(stats.v1Successes).toBe(250)
    expect(stats.v2Successes).toBe(220)
    expect(stats.discordantV1Only).toBe(30)
    expect(stats.observedDifference).toBe(-0.12)
    expect(stats.ciLower).toBe(-0.16036271548180894)
    expect(stats.ciUpper).toBe(-0.07963728451819105)
    expect(stats.nonInferior).toBe(false)
  })

  test("the strict-margin boundary: one extra discordant pair flips the verdict at -0.05", () => {
    // 7 V1-only discordant pairs: lower = -0.04849087790616857 > -0.05 → PASS.
    const seven = confirmatoryStatistics(pairedData((i) => ({ v1: true, v2: i >= 7 }))).stats
    expect(seven.ciLower).toBe(-0.04849087790616857)
    expect(seven.nonInferior).toBe(true)
    // 8 V1-only discordant pairs: lower = -0.05386055004597402 < -0.05 → FAIL.
    const eight = confirmatoryStatistics(pairedData((i) => ({ v1: true, v2: i >= 8 }))).stats
    expect(eight.ciLower).toBe(-0.05386055004597402)
    expect(eight.nonInferior).toBe(false)
  })

  test("the decision rule is STRICT: a lower bound exactly at the margin does not pass", () => {
    expect(nonInferiorDecision(-0.05, -0.05)).toBe(false)
    expect(nonInferiorDecision(-0.049999999, -0.05)).toBe(true)
    expect(nonInferiorDecision(0, -0.05)).toBe(true)
  })

  test("secondary facts (stuck, duplicates, interventions) are reported WITHOUT rewriting the primary outcome", () => {
    const data = pairedData((i) => ({ v1: i >= 10, v2: true }))
    const tampered: BenchmarkData = {
      ...data,
      trials: data.trials.map((t, i) =>
        i === 1 ? { ...t, metrics: { ...t.metrics, stuck: true, terminal: false, duplicateSideEffects: 1, humanInterventions: 2, completedNormally: false } } : t,
      ),
    }
    const { stats, secondary } = confirmatoryStatistics(tampered)
    expect(stats.nonInferior).toBe(true) // primary unchanged by abnormal secondary facts
    expect(secondary.v2.stuckRuns).toBe(1)
    expect(secondary.v2.duplicateSideEffects).toBe(1)
    expect(secondary.v2.humanInterventions).toBe(2)
    expect(secondary.v2.normalCompletionRate).toBe(249 / 250)
    expect(secondary.v1.stuckRuns).toBe(0)
    expect(secondary.v1.duplicateSideEffects).toBe(0)
    expect(secondary.v1.normalCompletionRate).toBe(240 / 250) // the 10 failed V1 trials complete abnormally
  })

  test("refuses a duplicate side — never silently drops or overwrites a pair", () => {
    const trials = [...allConcordantSuccess.trials]
    const first = trials[0]!
    trials[1] = { ...first } // task 0 now has TWO v1 sides
    expect(() => confirmatoryStatistics({ ...allConcordantSuccess, trials })).toThrow(/duplicate v1 side/)
  })

  test("refuses a missing side", () => {
    const trials = allConcordantSuccess.trials.slice(1) // drop task 0's v1 trial
    expect(() => confirmatoryStatistics({ ...allConcordantSuccess, trials })).toThrow(/missing v1 side/)
    const noV2 = allConcordantSuccess.trials.filter((t, i) => i !== 1) // keep task 0's v1 only
    expect(() => confirmatoryStatistics({ ...allConcordantSuccess, trials: noV2 })).toThrow(/missing v2 side/)
  })

  test("refuses unknown task ids", () => {
    const trials = allConcordantSuccess.trials.map((t, i) => (i === 0 ? { ...t, taskId: "not-a-confirmatory-task" } : t))
    expect(() => confirmatoryStatistics({ ...allConcordantSuccess, trials })).toThrow(/unknown task id/)
  })

  test("refuses data measured under a stale (or absent) metrics schema", () => {
    expect(() => confirmatoryStatistics({ ...allConcordantSuccess, metricsSchemaVersion: 1 })).toThrow(/stale metrics schema/)
    const unstamped: BenchmarkData = { repoRef: "x", trials: allConcordantSuccess.trials }
    expect(() => confirmatoryStatistics(unstamped)).toThrow(/stale metrics schema/)
    expect(new ConfirmatoryDataError("x")).toBeInstanceOf(Error)
  })

  test("refuses a non-250 dataset (a dropped pair is not quietly accepted)", () => {
    const trials = allConcordantSuccess.trials.slice(2) // 249 pairs
    expect(() => confirmatoryStatistics({ ...allConcordantSuccess, trials })).toThrow(/exactly 250 paired tasks, got 249/)
  })
})
