/**
 * The comparative runner. For every task it runs BOTH runtimes, each in its own
 * fresh worktree + db, applying the identical fixture, then verifies objectively
 * and records full metrics + any failure. The run ORDER is swapped per task so
 * neither runtime is favoured by cache warmth or ordering.
 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { extractEventMetrics, METRICS_SCHEMA_VERSION, type RunMetrics } from "./metrics"
import { verifyTask, type VerificationResult } from "./verify"
import { applyFixture, changedFiles, createWorktree, type Exec } from "./isolation"
import { AdapterNotWiredError, type RuntimeAdapter, type RuntimeId, type TaskContext } from "./adapter"
import type { BenchTask } from "./tasks"

export interface FailureRecord {
  readonly taskId: string
  readonly runtime: RuntimeId
  readonly failureClass: string
  readonly lastSuccessfulStep: string
  readonly toolHistory: readonly string[]
  readonly finalState: string
  readonly repro: string
}

export interface TrialResult {
  readonly taskId: string
  readonly category: string
  readonly runtime: RuntimeId
  readonly metrics: RunMetrics
  readonly verification: VerificationResult
  readonly failure?: FailureRecord
}

export interface BenchmarkData {
  readonly trials: readonly TrialResult[]
  readonly repoRef: string
  /**
   * The metric DEFINITIONS these numbers were produced under. Absent means 1 —
   * anything measured before the version existed. Results carrying different
   * versions describe different things and must not be pooled or compared; the
   * gate enforces that rather than trusting the reader to notice.
   */
  readonly metricsSchemaVersion?: number
}

export interface RunnerDeps {
  readonly repoRoot: string
  readonly ref: string
  readonly exec: Exec
  readonly tmpBase?: string
  readonly dbFileFor?: (taskId: string, runtime: RuntimeId) => string
  /** Progress callback after each completed trial (order-swap preserved). */
  readonly onTrial?: (result: TrialResult) => void
}

export async function runComparative(
  suite: readonly BenchTask[],
  adapters: { readonly v1: RuntimeAdapter; readonly v2: RuntimeAdapter },
  deps: RunnerDeps,
): Promise<BenchmarkData> {
  const trials: TrialResult[] = []

  for (let i = 0; i < suite.length; i++) {
    const task = suite[i]!
    // Swap order per task so warmth/order can't bias the comparison.
    const order: RuntimeAdapter[] = i % 2 === 0 ? [adapters.v2, adapters.v1] : [adapters.v1, adapters.v2]
    for (const adapter of order) {
      const result = await runTrial(task, adapter, deps)
      trials.push(result)
      deps.onTrial?.(result)
    }
  }
  return { trials, repoRef: deps.ref, metricsSchemaVersion: METRICS_SCHEMA_VERSION }
}

async function runTrial(task: BenchTask, adapter: RuntimeAdapter, deps: RunnerDeps): Promise<TrialResult> {
  const worktree = await createWorktree(deps.repoRoot, deps.ref, deps.exec, deps.tmpBase)
  // The event db lives OUTSIDE the worktree so it never pollutes the task's git
  // diff (a bug the live pilot surfaced: the db counted as a changed file).
  const dbFile = deps.dbFileFor
    ? deps.dbFileFor(task.id, adapter.id)
    : join(deps.tmpBase ?? tmpdir(), `abdo-bench-db-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.db`)
  try {
    await applyFixture(worktree.dir, task.fixture)
    // Commit the fixture as the trial baseline so `git status` afterwards shows
    // ONLY the runtime's real changes (an untracked fixture file would otherwise
    // satisfy expectPaths for free — an edit task must actually edit).
    if (task.fixture && Object.keys(task.fixture).length > 0) {
      await deps.exec(["git", "add", "-A"], worktree.dir)
      await deps.exec(["git", "commit", "-m", "fixture", "--no-verify"], worktree.dir)
    }
    const ctx: TaskContext = { taskId: task.id, workdir: worktree.dir, dbFile, messages: task.messages, timeoutMs: task.timeoutMs }

    let finalState = "unknown"
    let events: { type: string; data: unknown }[] = []
    let adapterEventMetrics: import("./metrics").EventMetrics | undefined
    let ttft: number | null = 0
    let total = 0
    let approvals = 0
    let interventions = 0
    let recoveryAttempted = false
    let recoverySucceeded = false
    let hardFailure: string | undefined

    try {
      const r = await adapter.run(ctx)
      finalState = r.finalState
      events = [...(r.events ?? [])]
      adapterEventMetrics = r.eventMetrics
      ttft = r.timeToFirstTokenMs
      total = r.totalMs
      approvals = r.humanApprovals
      interventions = r.humanInterventions
      recoveryAttempted = r.recoveryAttempted
      recoverySucceeded = r.recoverySucceeded
    } catch (e) {
      hardFailure = e instanceof AdapterNotWiredError ? "not_wired" : e instanceof Error ? e.message : String(e)
      finalState = hardFailure === "not_wired" ? "not_wired" : "error"
    }

    // V2 supplies raw abdo events; V1 supplies eventMetrics directly (its events
    // are shaped differently, and it marks unmeasurable metrics as unavailable).
    const em = adapterEventMetrics ?? extractEventMetrics(events)
    const verification = hardFailure ? { passed: false, score: 0, checks: [], judgeOnly: false } : await verifyTask(worktree.dir, task.verification, deps.exec)
    const modified = hardFailure ? [] : await changedFiles(worktree.dir, deps.exec)

    const buildCheck = verification.checks.find((c) => c.name === "build")
    const testCheck = verification.checks.find((c) => c.name === "test")
    // Task ACCOMPLISHMENT: a mechanically-verified task succeeds when the objective
    // verification passes AND the run did not hard-fail (failed/cancelled/stuck).
    // A run that produced verified-correct output but ended `paused` (the model
    // looped without concluding) still accomplished the task — the code is correct.
    // Judge-only tasks (no objective check) still require a clean `completed`.
    const stuck = !em.terminal && !hardFailure
    const hardFail = stuck || finalState === "failed" || finalState === "cancelled" || finalState === "error" || finalState === "not_wired"
    // Two SEPARATE signals (never merged): output correctness vs agent autonomy.
    const objectiveCorrect = !hardFail && (verification.passed || (verification.judgeOnly && finalState === "completed"))
    const completedNormally = finalState === "completed"
    const taskSuccess = objectiveCorrect

    const metrics: RunMetrics = {
      taskSuccess,
      objectiveCorrect,
      completedNormally,
      correctnessScore: verification.score,
      finalState: em.finalState !== "unknown" ? em.finalState : finalState,
      terminal: em.terminal,
      stuck,
      timeToFirstToken: ttft,
      totalCompletionTime: total,
      inputTokens: em.inputTokens,
      outputTokens: em.outputTokens,
      providerRequests: em.providerRequests,
      toolCalls: em.toolCalls,
      failedToolCalls: em.failedToolCalls,
      repeatedToolCalls: em.repeatedToolCalls,
      duplicateSideEffects: em.duplicateSideEffects,
      humanApprovals: approvals,
      humanInterventions: interventions,
      filesRead: em.filesRead,
      filesModified: modified.length,
      buildPassed: buildCheck?.passed,
      testPassed: testCheck?.passed,
      recoveryAttempted,
      recoverySucceeded,
      rollbacks: em.rollbacks,
      rollbacksFromNonMutatingFailure: em.rollbacksFromNonMutatingFailure,
      rollbackDetails: em.rollbackDetails,
      verificationUnavailable: em.verificationUnavailable,
      repeatedCallsBlocked: em.repeatedCallsBlocked,
      redundantStrategiesBlocked: em.redundantStrategiesBlocked,
      maxStrategyExecutionsPerState: em.maxStrategyExecutionsPerState,
    }

    const failure: FailureRecord | undefined = taskSuccess
      ? undefined
      : {
          taskId: task.id,
          runtime: adapter.id,
          failureClass: hardFailure ?? classifyFailure(metrics, verification),
          lastSuccessfulStep: lastStep(events),
          toolHistory: toolHistory(events),
          finalState: metrics.finalState,
          repro: `abdo-bench run --task ${task.id} --runtime ${adapter.id} --ref ${deps.ref}`,
        }

    return { taskId: task.id, category: task.category, runtime: adapter.id, metrics, verification, failure }
  } finally {
    await worktree.remove()
    if (!deps.dbFileFor) {
      try {
        // [CL-00A:ALLOW benchmark_trial_cleanup]
        rmSync(dbFile, { force: true })
        // [CL-00A:ALLOW benchmark_trial_cleanup]
        rmSync(dbFile + "-wal", { force: true })
        // [CL-00A:ALLOW benchmark_trial_cleanup]
        rmSync(dbFile + "-shm", { force: true })
      } catch {}
    }
  }
}

function classifyFailure(m: RunMetrics, v: VerificationResult): string {
  if (m.stuck) return "stuck"
  if (m.finalState === "failed") return "provider_or_tool_error"
  if (m.finalState === "cancelled") return "cancelled"
  if (typeof m.duplicateSideEffects === "number" && m.duplicateSideEffects > 0) return "duplicate_side_effect"
  if (!v.passed && !v.judgeOnly) return "verification_failed"
  if (v.judgeOnly) return "needs_judge"
  return "unknown"
}

function toolHistory(events: readonly { type: string; data: unknown }[]): string[] {
  return events.filter((e) => e.type === "tool.executed").map((e) => String((e.data as { tool?: string }).tool ?? "?"))
}
function lastStep(events: readonly { type: string; data: unknown }[]): string {
  const tools = events.filter((e) => e.type === "tool.executed")
  if (tools.length) return `tool ${(tools[tools.length - 1]!.data as { tool?: string }).tool}`
  return events.some((e) => e.type === "model.request.started") ? "model call" : "start"
}
