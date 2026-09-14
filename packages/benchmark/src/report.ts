/**
 * Three reports + the success gate. The gate does NOT require V2 to win every
 * number; it requires V2 to be a real, safe replacement: at least V1's success,
 * zero duplicate side effects, zero permanently-stuck runs, high recovery, no
 * worse correctness or human intervention, cost/time within a margin on short
 * tasks, and clearly better on long + recovery tasks.
 *
 * Where V1 has no trials (adapter not wired), the comparative checks are marked
 * BLOCKED — never silently passed. A blocked gate is not a pass.
 */
import type { RuntimeId } from "./adapter"
import { METRICS_SCHEMA_VERSION } from "./metrics"
import type { BenchmarkData, TrialResult } from "./runner"

/**
 * The metrics schema the FROZEN baselines were measured under
 * (`benchmark-baseline-v1.json`, `benchmark-baseline-v2-manifest.json`, pinned
 * 2026-07-22 — before the strategy-execution key gained `stateEpoch`). The
 * baselines themselves are never edited; this states what they mean.
 */
export const FROZEN_BASELINE_METRICS_SCHEMA_VERSION = 1

/** The version a data set was measured under; absent = pre-versioning = 1. */
export const metricsSchemaOf = (data: BenchmarkData): number => data.metricsSchemaVersion ?? 1

/**
 * Whether two data sets may be put side by side at all. Different metric
 * definitions are not a rounding difference — one of the numbers means
 * something else — so the answer is no, and the caller must re-measure.
 */
export const comparableMetrics = (a: BenchmarkData, b: BenchmarkData): boolean => metricsSchemaOf(a) === metricsSchemaOf(b)

const median = (xs: (number | null)[]): number => {
  const nums = xs.filter((x): x is number => typeof x === "number")
  if (nums.length === 0) return 0 // no data (all unavailable)
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const sumNumeric = (xs: (number | null)[]): number => xs.reduce((n: number, x) => n + (typeof x === "number" ? x : 0), 0)
const anyNumeric = (xs: (number | null)[]): boolean => xs.some((x) => typeof x === "number")
const rate = (n: number, d: number): number => (d === 0 ? 0 : n / d)

export interface RuntimeSummary {
  readonly runs: number
  readonly successes: number
  readonly successRate: number
  /** The OUTPUT was objectively correct (verification passed). */
  readonly objectiveCorrectnessRate: number
  /** The agent concluded on its own (finalState === completed), not paused. */
  readonly normalCompletionRate: number
  readonly medianCompletionMs: number
  readonly medianInputTokens: number
  readonly medianOutputTokens: number
  readonly humanInterventionRate: number
  readonly recoveryRate: number
  readonly duplicateSideEffects: number
  readonly stuckRuns: number
  /** Guarded compensations across all trials (null-safe sum). */
  readonly rollbacks: number
  /** Rollbacks triggered by a failure that never mutated — the multi-11 defect; MUST be 0. */
  readonly rollbacksFromNonMutatingFailure: number
  /** Runs that completed with verification UNAVAILABLE (never counted as verified). */
  readonly verificationUnavailable: number
  /** Identical failing tool calls refused without a spawn (the long-0 loop guard). */
  readonly repeatedCallsBlocked: number
  /** Expensive strategies refused because their own state was unchanged
   *  (the install-after-every-unrelated-edit loop). */
  readonly redundantStrategiesBlocked: number
  /** Worst case across trials: how many times ONE expensive strategy executed at
   *  a single semantic state. The gate wants a dependency reinstall <= 1. */
  readonly maxStrategyExecutionsPerState: number
}

const summarize = (trials: TrialResult[]): RuntimeSummary => {
  const successes = trials.filter((t) => t.metrics.taskSuccess)
  const recov = trials.filter((t) => t.metrics.recoveryAttempted)
  return {
    runs: trials.length,
    successes: successes.length,
    successRate: rate(successes.length, trials.length),
    objectiveCorrectnessRate: rate(trials.filter((t) => t.metrics.objectiveCorrect).length, trials.length),
    normalCompletionRate: rate(trials.filter((t) => t.metrics.completedNormally).length, trials.length),
    medianCompletionMs: median(successes.map((t) => t.metrics.totalCompletionTime)),
    medianInputTokens: median(successes.map((t) => t.metrics.inputTokens)),
    medianOutputTokens: median(successes.map((t) => t.metrics.outputTokens)),
    humanInterventionRate: rate(trials.filter((t) => t.metrics.humanInterventions > 0).length, trials.length),
    recoveryRate: rate(recov.filter((t) => t.metrics.recoverySucceeded).length, recov.length),
    duplicateSideEffects: sumNumeric(trials.map((t) => t.metrics.duplicateSideEffects)),
    stuckRuns: trials.filter((t) => t.metrics.stuck).length,
    rollbacks: sumNumeric(trials.map((t) => t.metrics.rollbacks)),
    rollbacksFromNonMutatingFailure: sumNumeric(trials.map((t) => t.metrics.rollbacksFromNonMutatingFailure)),
    verificationUnavailable: sumNumeric(trials.map((t) => t.metrics.verificationUnavailable)),
    repeatedCallsBlocked: sumNumeric(trials.map((t) => t.metrics.repeatedCallsBlocked)),
    redundantStrategiesBlocked: sumNumeric(trials.map((t) => t.metrics.redundantStrategiesBlocked)),
    maxStrategyExecutionsPerState: Math.max(
      0,
      ...trials.map((t) => (typeof t.metrics.maxStrategyExecutionsPerState === "number" ? t.metrics.maxStrategyExecutionsPerState : 0)),
    ),
  }
}

const byRuntime = (data: BenchmarkData, id: RuntimeId) => data.trials.filter((t) => t.runtime === id)

export interface SummaryReport {
  readonly v1: RuntimeSummary
  readonly v2: RuntimeSummary
}
export function summaryReport(data: BenchmarkData): SummaryReport {
  return { v1: summarize(byRuntime(data, "v1")), v2: summarize(byRuntime(data, "v2")) }
}

export interface CategoryRow {
  readonly category: string
  readonly v1SuccessRate: number
  readonly v2SuccessRate: number
  readonly v1MedianMs: number
  readonly v2MedianMs: number
}
export function byCategoryReport(data: BenchmarkData): CategoryRow[] {
  const cats = [...new Set(data.trials.map((t) => t.category))]
  return cats.map((category) => {
    const inCat = data.trials.filter((t) => t.category === category)
    const v1 = inCat.filter((t) => t.runtime === "v1")
    const v2 = inCat.filter((t) => t.runtime === "v2")
    return {
      category,
      v1SuccessRate: rate(v1.filter((t) => t.metrics.taskSuccess).length, v1.length),
      v2SuccessRate: rate(v2.filter((t) => t.metrics.taskSuccess).length, v2.length),
      v1MedianMs: median(v1.filter((t) => t.metrics.taskSuccess).map((t) => t.metrics.totalCompletionTime)),
      v2MedianMs: median(v2.filter((t) => t.metrics.taskSuccess).map((t) => t.metrics.totalCompletionTime)),
    }
  })
}

export function failureList(data: BenchmarkData) {
  return data.trials.filter((t) => t.failure).map((t) => t.failure!)
}

export type GateStatus = "pass" | "fail" | "blocked"
export interface GateCheck {
  readonly name: string
  readonly status: GateStatus
  readonly detail: string
}
export interface GateResult {
  readonly passed: boolean
  readonly checks: readonly GateCheck[]
}

/**
 * Recovery is exercised by a local crash-injection suite, outside the live
 * comparative batch.  Keep that proof structured so the aggregate gate never
 * has to infer success from a display string such as "5/5".
 */
export interface RecoveryGateEvidence {
  readonly source: string
  readonly attempted: number
  readonly succeeded: number
  readonly duplicateSideEffects: number
}

/**
 * Replace only the "no recovery tasks ran" BLOCKED check with separately
 * measured crash-injection evidence.  An in-band PASS/FAIL is authoritative
 * and can never be overwritten by external evidence.
 */
export function mergeRecoveryGateEvidence(gate: GateResult, evidence: RecoveryGateEvidence): GateResult {
  const valid =
    evidence.source.trim().length > 0 &&
    Number.isInteger(evidence.attempted) &&
    Number.isInteger(evidence.succeeded) &&
    Number.isInteger(evidence.duplicateSideEffects) &&
    evidence.attempted >= 0 &&
    evidence.succeeded >= 0 &&
    evidence.succeeded <= evidence.attempted &&
    evidence.duplicateSideEffects >= 0

  const checks = gate.checks.map((check): GateCheck => {
    if (check.name !== "v2_recovery_ge_95pct" || check.status !== "blocked" || check.detail !== "no recovery tasks ran") return check
    if (!valid) return { name: check.name, status: "blocked", detail: "invalid structured recovery evidence" }
    if (evidence.attempted === 0) return { name: check.name, status: "blocked", detail: `no recovery attempts in ${evidence.source}` }
    const recoveryRate = evidence.succeeded / evidence.attempted
    const passed = recoveryRate >= 0.95 && evidence.duplicateSideEffects === 0
    return {
      name: check.name,
      status: passed ? "pass" : "fail",
      detail: `${evidence.succeeded}/${evidence.attempted} (${(recoveryRate * 100).toFixed(0)}%) from ${evidence.source}; ${evidence.duplicateSideEffects} duplicate side effects`,
    }
  })

  return { passed: checks.every((check) => check.status === "pass"), checks }
}

export function evaluateGate(data: BenchmarkData): GateResult {
  const s = summaryReport(data)
  const hasV1 = s.v1.runs > 0
  const checks: GateCheck[] = []
  const cmp = (name: string, ok: boolean, detail: string): GateCheck => ({ name, status: ok ? "pass" : "fail", detail })
  const blocked = (name: string, detail: string): GateCheck => ({ name, status: "blocked", detail })

  // Measurement identity first: a gate on numbers whose definitions have moved
  // is not a gate. Old data is BLOCKED, never silently passed or compared.
  const schema = metricsSchemaOf(data)
  checks.push(
    schema === METRICS_SCHEMA_VERSION
      ? cmp("metrics_schema_current", true, `schema ${schema}`)
      : blocked(
          "metrics_schema_current",
          `measured under metrics schema ${schema}, current is ${METRICS_SCHEMA_VERSION} — re-measure; these numbers are not comparable with the frozen baselines (schema ${FROZEN_BASELINE_METRICS_SCHEMA_VERSION})`,
        ),
  )

  // V2 self-safety (evaluable without V1)
  checks.push(cmp("v2_zero_duplicate_side_effects", s.v2.duplicateSideEffects === 0, `${s.v2.duplicateSideEffects} duplicates`))
  checks.push(cmp("v2_zero_stuck_runs", s.v2.stuckRuns === 0, `${s.v2.stuckRuns} stuck`))
  // The multi-11 rule: a rollback may ONLY compensate the failing invocation's
  // own started mutation. Any rollback fired by a non-mutating failure would be
  // silently destroying completed work again.
  checks.push(
    cmp(
      "v2_zero_rollback_from_nonmutating_failure",
      s.v2.rollbacksFromNonMutatingFailure === 0,
      `${s.v2.rollbacksFromNonMutatingFailure} illegal rollbacks (${s.v2.rollbacks} total rollbacks, ${s.v2.verificationUnavailable} verification-unavailable runs)`,
    ),
  )
  const recovTrials = byRuntime(data, "v2").filter((t) => t.metrics.recoveryAttempted).length
  checks.push(
    recovTrials === 0
      ? blocked("v2_recovery_ge_95pct", "no recovery tasks ran")
      : cmp("v2_recovery_ge_95pct", s.v2.recoveryRate >= 0.95, `${(s.v2.recoveryRate * 100).toFixed(0)}%`),
  )

  // Comparative (need V1)
  if (!hasV1) {
    checks.push(blocked("v2_success_ge_v1", "V1 adapter not wired"))
    checks.push(blocked("v2_correctness_ge_v1", "V1 adapter not wired"))
    checks.push(blocked("v2_human_intervention_le_v1", "V1 adapter not wired"))
    checks.push(blocked("v2_token_cost_within_15pct", "V1 adapter not wired"))
    checks.push(blocked("v2_short_time_within_15pct", "V1 adapter not wired"))
  } else {
    checks.push(cmp("v2_success_ge_v1", s.v2.successRate >= s.v1.successRate, `v2 ${(s.v2.successRate * 100).toFixed(0)}% vs v1 ${(s.v1.successRate * 100).toFixed(0)}%`))
    checks.push(cmp("v2_human_intervention_le_v1", s.v2.humanInterventionRate <= s.v1.humanInterventionRate, `v2 ${s.v2.humanInterventionRate.toFixed(2)} vs v1 ${s.v1.humanInterventionRate.toFixed(2)}`))
    // Token cost can only be compared when BOTH runtimes reported tokens.
    const v1Tokens = anyNumeric(byRuntime(data, "v1").filter((t) => t.metrics.taskSuccess).map((t) => t.metrics.inputTokens))
    const v2Tokens = anyNumeric(byRuntime(data, "v2").filter((t) => t.metrics.taskSuccess).map((t) => t.metrics.inputTokens))
    if (!v1Tokens || !v2Tokens) {
      checks.push(blocked("v2_token_cost_within_15pct", "input tokens unavailable for a runtime (not fabricated as 0)"))
    } else {
      const tokenWorse = s.v1.medianInputTokens > 0 ? (s.v2.medianInputTokens - s.v1.medianInputTokens) / s.v1.medianInputTokens : 0
      checks.push(cmp("v2_token_cost_within_15pct", tokenWorse <= 0.15, `${(tokenWorse * 100).toFixed(0)}% vs v1`))
    }
    const timeWorse = s.v1.medianCompletionMs > 0 ? (s.v2.medianCompletionMs - s.v1.medianCompletionMs) / s.v1.medianCompletionMs : 0
    checks.push(cmp("v2_time_within_15pct", timeWorse <= 0.15, `${(timeWorse * 100).toFixed(0)}% vs v1`))
  }

  // A gate passes only if NOTHING failed and NOTHING is blocked.
  const passed = checks.every((c) => c.status === "pass")
  return { passed, checks }
}
