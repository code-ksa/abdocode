import { describe, expect, test } from "bun:test"
import {
  byCategoryReport,
  comparableMetrics,
  evaluateGate,
  failureList,
  FROZEN_BASELINE_METRICS_SCHEMA_VERSION,
  METRICS_SCHEMA_VERSION,
  mergeRecoveryGateEvidence,
  summaryReport,
  type BenchmarkData,
} from "../src/index"
import type { RunMetrics } from "../src/index"
import type { RuntimeId } from "../src/index"
import type { TrialResult } from "../src/index"

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

const trial = (runtime: RuntimeId, category: string, over: Partial<RunMetrics> = {}): TrialResult => ({
  taskId: "t",
  category,
  runtime,
  metrics: metrics(over),
  verification: { passed: over.taskSuccess !== false, score: 1, checks: [], judgeOnly: false },
})

describe("reports", () => {
  test("summaryReport computes success rate, medians, and safety counters", () => {
    const data: BenchmarkData = {
      repoRef: "abc",
      trials: [
        trial("v2", "qa", { totalCompletionTime: 1000, inputTokens: 400 }),
        trial("v2", "qa", { totalCompletionTime: 3000, inputTokens: 600, taskSuccess: false }),
        trial("v1", "qa", { totalCompletionTime: 2000, inputTokens: 500 }),
      ],
    }
    const s = summaryReport(data)
    expect(s.v2.runs).toBe(2)
    expect(s.v2.successRate).toBe(0.5)
    expect(s.v2.medianCompletionMs).toBe(1000) // only the successful run
    expect(s.v1.successRate).toBe(1)
  })

  test("byCategoryReport does not hide per-category differences in an average", () => {
    const data: BenchmarkData = {
      repoRef: "abc",
      trials: [
        trial("v2", "long_multi_tool", { taskSuccess: true }),
        trial("v1", "long_multi_tool", { taskSuccess: false }),
        trial("v2", "qa", { taskSuccess: false }),
        trial("v1", "qa", { taskSuccess: true }),
      ],
    }
    const rows = byCategoryReport(data)
    const long = rows.find((r) => r.category === "long_multi_tool")!
    const qa = rows.find((r) => r.category === "qa")!
    expect(long.v2SuccessRate).toBe(1)
    expect(long.v1SuccessRate).toBe(0)
    expect(qa.v2SuccessRate).toBe(0)
    expect(qa.v1SuccessRate).toBe(1)
  })

  test("failureList surfaces every failed trial", () => {
    const data: BenchmarkData = {
      repoRef: "abc",
      trials: [
        { ...trial("v2", "qa", { taskSuccess: false }), failure: { taskId: "t", runtime: "v2", failureClass: "verification_failed", lastSuccessfulStep: "model call", toolHistory: [], finalState: "completed", repro: "x" } },
      ],
    }
    expect(failureList(data)).toHaveLength(1)
    expect(failureList(data)[0]!.failureClass).toBe("verification_failed")
  })

  test("gate: V2 self-safety passes but comparative checks are BLOCKED when V1 is absent", () => {
    const data: BenchmarkData = {
      repoRef: "abc",
      metricsSchemaVersion: METRICS_SCHEMA_VERSION,
      trials: [trial("v2", "qa"), trial("v2", "single_file_edit")],
    }
    const gate = evaluateGate(data)
    expect(gate.passed).toBe(false) // blocked is not a pass
    expect(gate.checks.find((c) => c.name === "v2_zero_duplicate_side_effects")!.status).toBe("pass")
    expect(gate.checks.find((c) => c.name === "v2_success_ge_v1")!.status).toBe("blocked")
  })

  test("gate fails loudly on a duplicate side effect or a stuck run", () => {
    const dup = evaluateGate({ repoRef: "x", metricsSchemaVersion: METRICS_SCHEMA_VERSION, trials: [trial("v2", "qa", { duplicateSideEffects: 1 })] })
    expect(dup.checks.find((c) => c.name === "v2_zero_duplicate_side_effects")!.status).toBe("fail")
    const stuck = evaluateGate({
      repoRef: "x",
      metricsSchemaVersion: METRICS_SCHEMA_VERSION,
      trials: [trial("v2", "qa", { stuck: true, terminal: false })],
    })
    expect(stuck.checks.find((c) => c.name === "v2_zero_stuck_runs")!.status).toBe("fail")
  })

  test("gate: with both runtimes, v2 success >= v1 is evaluated", () => {
    const data: BenchmarkData = {
      repoRef: "x",
      metricsSchemaVersion: METRICS_SCHEMA_VERSION,
      trials: [trial("v2", "qa"), trial("v2", "qa"), trial("v1", "qa"), trial("v1", "qa", { taskSuccess: false })],
    }
    const gate = evaluateGate(data)
    expect(gate.checks.find((c) => c.name === "v2_success_ge_v1")!.status).toBe("pass") // v2 100% >= v1 50%
  })

  test("gate: structured external recovery evidence resolves only the no-recovery BLOCKED check", () => {
    const data: BenchmarkData = {
      repoRef: "x",
      metricsSchemaVersion: METRICS_SCHEMA_VERSION,
      trials: [trial("v2", "qa"), trial("v1", "qa")],
    }
    const base = evaluateGate(data)
    expect(base.checks.find((c) => c.name === "v2_recovery_ge_95pct")!.status).toBe("blocked")

    const combined = mergeRecoveryGateEvidence(base, {
      source: "local-crash-injection",
      attempted: 5,
      succeeded: 5,
      duplicateSideEffects: 0,
    })
    expect(combined.checks.find((c) => c.name === "v2_recovery_ge_95pct")).toEqual({
      name: "v2_recovery_ge_95pct",
      status: "pass",
      detail: "5/5 (100%) from local-crash-injection; 0 duplicate side effects",
    })
    expect(combined.passed).toBe(true)
  })

  test("gate: external recovery evidence fails on low recovery or duplicates and rejects malformed counts", () => {
    const data: BenchmarkData = {
      repoRef: "x",
      metricsSchemaVersion: METRICS_SCHEMA_VERSION,
      trials: [trial("v2", "qa"), trial("v1", "qa")],
    }
    const base = evaluateGate(data)
    const evidence = { source: "local-crash-injection", attempted: 5, succeeded: 4, duplicateSideEffects: 0 }
    expect(mergeRecoveryGateEvidence(base, evidence).checks.find((c) => c.name === "v2_recovery_ge_95pct")!.status).toBe("fail")
    expect(mergeRecoveryGateEvidence(base, { ...evidence, succeeded: 5, duplicateSideEffects: 1 }).checks.find((c) => c.name === "v2_recovery_ge_95pct")!.status).toBe("fail")
    expect(mergeRecoveryGateEvidence(base, { ...evidence, succeeded: 6 }).checks.find((c) => c.name === "v2_recovery_ge_95pct")!.status).toBe("blocked")
  })

  test("gate: external recovery evidence cannot overwrite an in-band recovery failure", () => {
    const data: BenchmarkData = {
      repoRef: "x",
      metricsSchemaVersion: METRICS_SCHEMA_VERSION,
      trials: [
        trial("v2", "crash_resume", { recoveryAttempted: true, recoverySucceeded: false }),
        trial("v1", "crash_resume"),
      ],
    }
    const base = evaluateGate(data)
    expect(base.checks.find((c) => c.name === "v2_recovery_ge_95pct")!.status).toBe("fail")
    const combined = mergeRecoveryGateEvidence(base, {
      source: "local-crash-injection",
      attempted: 5,
      succeeded: 5,
      duplicateSideEffects: 0,
    })
    expect(combined.checks.find((c) => c.name === "v2_recovery_ge_95pct")!.status).toBe("fail")
  })

  test("gate BLOCKS data measured under an older metrics schema — old numbers never pass as new", () => {
    // The frozen baselines were measured before the strategy-execution key had
    // an epoch. Nothing about that data is wrong; it simply answers a different
    // question, so it cannot clear a gate defined on today's definitions.
    const stale: BenchmarkData = {
      repoRef: "x",
      metricsSchemaVersion: FROZEN_BASELINE_METRICS_SCHEMA_VERSION,
      trials: [trial("v2", "qa"), trial("v1", "qa")],
    }
    const gate = evaluateGate(stale)
    const check = gate.checks.find((c) => c.name === "metrics_schema_current")!
    expect(check.status).toBe("blocked")
    expect(check.detail).toContain(`current is ${METRICS_SCHEMA_VERSION}`)
    expect(gate.passed).toBe(false)
    // Unstamped data is pre-versioning data — treated as schema 1, not as "fine".
    expect(evaluateGate({ repoRef: "x", trials: [trial("v2", "qa")] }).checks.find((c) => c.name === "metrics_schema_current")!.status).toBe("blocked")
    // Current data clears the check.
    const fresh: BenchmarkData = { repoRef: "x", metricsSchemaVersion: METRICS_SCHEMA_VERSION, trials: [trial("v2", "qa")] }
    expect(evaluateGate(fresh).checks.find((c) => c.name === "metrics_schema_current")!.status).toBe("pass")
  })

  test("comparableMetrics refuses to put two schemas side by side", () => {
    const old: BenchmarkData = { repoRef: "x", metricsSchemaVersion: 1, trials: [] }
    const now: BenchmarkData = { repoRef: "x", metricsSchemaVersion: METRICS_SCHEMA_VERSION, trials: [] }
    expect(comparableMetrics(old, now)).toBe(false)
    expect(comparableMetrics(now, now)).toBe(true)
    expect(comparableMetrics(old, { repoRef: "x", trials: [] })).toBe(true) // unstamped == 1
    // The frozen baselines are schema 1 and stay that way — they are never edited.
    expect(FROZEN_BASELINE_METRICS_SCHEMA_VERSION).toBe(1)
  })
})
