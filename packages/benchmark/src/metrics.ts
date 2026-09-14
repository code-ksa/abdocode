/**
 * Per-run metrics. The headline metric is the COST AND TIME OF A SUCCESSFUL TASK
 * — not time-to-first-token. A runtime may be a little slower to first byte yet
 * finish in fewer attempts with fewer tokens.
 *
 * Event-derived fields are read from the run's own event log (provider requests,
 * tool calls, failures, repeats, duplicate side effects, terminal state). Timing,
 * files-changed, correctness, and human-intervention counts are supplied by the
 * runner/adapter around the run.
 */
import { EventTypes } from "@abdo/session-runtime"

/** A metric value that a runtime may not expose. `null` = UNAVAILABLE, never 0 —
 *  reporting an unmeasured metric as 0 would distort the comparison. */
export type MetricValue = number | null

export interface RunMetrics {
  // outcome — reported as TWO separate signals, never merged into one number:
  taskSuccess: boolean
  /** The objective verification passed (the OUTPUT is correct). */
  objectiveCorrect: boolean
  /** The run concluded on its own as `completed` (agent AUTONOMY, not paused). */
  completedNormally: boolean
  correctnessScore: number // 0..1 from objective verification
  finalState: string
  terminal: boolean
  stuck: boolean
  // timing (ms)
  timeToFirstToken: MetricValue
  totalCompletionTime: number
  // tokens (a runtime may not expose these -> unavailable)
  inputTokens: MetricValue
  outputTokens: MetricValue
  // provider / tools
  providerRequests: MetricValue
  toolCalls: number
  failedToolCalls: number
  repeatedToolCalls: MetricValue
  duplicateSideEffects: MetricValue
  // human
  humanApprovals: number
  humanInterventions: number
  // files
  filesRead: number
  filesModified: number
  // build/test
  buildPassed?: boolean
  testPassed?: boolean
  // recovery
  recoveryAttempted: boolean
  recoverySucceeded: boolean
  // guarded rollback visibility (null = the runtime cannot measure these)
  rollbacks: MetricValue
  rollbacksFromNonMutatingFailure: MetricValue
  rollbackDetails: EventMetrics["rollbackDetails"]
  verificationUnavailable: MetricValue
  repeatedCallsBlocked: MetricValue
  redundantStrategiesBlocked: MetricValue
  maxStrategyExecutionsPerState: MetricValue
}

export interface EventLike {
  readonly type: string
  readonly data: unknown
}

/** Fields derivable from a runtime's own event stream. Adapters may set the
 *  values a runtime cannot expose to `null` (unavailable). extractEventMetrics
 *  (the V2 path) always returns numbers. */
export interface EventMetrics {
  providerRequests: MetricValue
  toolCalls: number
  failedToolCalls: number
  repeatedToolCalls: MetricValue
  duplicateSideEffects: MetricValue
  inputTokens: MetricValue
  outputTokens: MetricValue
  filesRead: number
  filesModified: number
  terminal: boolean
  finalState: string
  /** Guarded compensations that ran (tool.rollback_completed/failed). null = runtime cannot measure. */
  rollbacks: MetricValue
  /** Rollbacks whose receipt says the failing call never mutated — MUST be 0.
   *  (The 2026-07-23 multi-11 defect: such a rollback destroys completed work.) */
  rollbacksFromNonMutatingFailure: MetricValue
  /** Per-rollback detail for the gate report. */
  rollbackDetails: { executionId?: string; path?: string; reason?: string; mutationStarted?: boolean; mutationCommitted?: boolean; status: string }[]
  /** run.verification_unavailable events — completed but never objectively verified. */
  verificationUnavailable: MetricValue
  /** tool.repeated_call_blocked events — identical repeats (fail-loop or success-thrash) refused (no spawn). */
  repeatedCallsBlocked: MetricValue
  /** tool.redundant_strategy_blocked events — an expensive STRATEGY refused
   *  because the state it depends on had not changed (the install-after-every-
   *  unrelated-edit loop). Expected to be >0 only in runs that try to spin. */
  redundantStrategiesBlocked: MetricValue
  /** The most times ONE expensive strategy actually EXECUTED at a single
   *  semantic state. The gate reads this: a dependency reinstall must not run
   *  more than once per dependency state. */
  maxStrategyExecutionsPerState: MetricValue
}

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "paused"])
const READ_TOOLS = new Set(["read_file", "list_dir", "read"])
const WRITE_TOOLS = new Set(["write_file", "edit_file"])

/**
 * The identity a strategy execution is counted under. EXPORTED because it is
 * part of the measurement definition, not an implementation detail: changing it
 * changes what `maxStrategyExecutionsPerState` means, and a number measured
 * under one definition may not be compared with a number measured under another.
 */
export const STRATEGY_EXECUTION_KEY_FORMAT = "strategy:scope:stateEpoch:semanticStateHash"

/**
 * Version of the EVENT-METRIC DEFINITIONS — bump it whenever the meaning of a
 * metric changes, not when the code around it moves.
 *
 *   1 — original. Strategy executions keyed `strategy:scope:semanticStateHash`.
 *   2 — 2026-07-23 (CL-09). The key gained `stateEpoch`: a state legitimately
 *       RETURNED to after the world moved is a new epoch, so a correct re-run no
 *       longer scores as a guard failure. Runs measured under 1 and under 2 are
 *       therefore NOT interchangeable on that metric.
 *
 * `evaluateGate` refuses to pass data stamped with anything but the current
 * version, so new results can never be quietly compared against old baselines.
 */
export const METRICS_SCHEMA_VERSION = 2

export function extractEventMetrics(events: readonly EventLike[]): EventMetrics {
  const argsHashCounts = new Map<string, number>()
  const idemCounts = new Map<string, number>()
  let providerRequests = 0
  let toolCalls = 0
  let failedToolCalls = 0
  // Real provider usage only (model.usage events). null = the provider did not
  // report usage — NEVER an estimate, so the V1<->V2 token comparison is honest.
  let inputTokens: number | null = null
  let outputTokens: number | null = null
  let filesRead = 0
  let filesModified = 0
  let finalState = "unknown"
  let terminalSeen = false
  let rollbacks = 0
  let rollbacksFromNonMutatingFailure = 0
  const rollbackDetails: EventMetrics["rollbackDetails"] = []
  let verificationUnavailable = 0
  let repeatedCallsBlocked = 0
  let redundantStrategiesBlocked = 0
  // How often each `strategy:scope:stateEpoch:semanticStateHash` actually
  // EXECUTED. tool.started carries the classification, so this counts attempts
  // that really spawned.
  //
  // The EPOCH belongs in the key because the ledger is transition-aware: when
  // the world moves a strategy's state, the epoch turns, and the hash may
  // legitimately return to a value seen before (deleting a fetched file puts
  // its destination back at the "missing" hash the first fetch started from).
  // Those two executions are one-per-state each, not a repeat — keying without
  // the epoch would score a correct re-run as a guard failure. Events written
  // before the epoch existed carry none and default to 0, so old runs measure
  // exactly as they did.
  const strategyStateCounts = new Map<string, number>()
  // tool.executed receipts by execution id — rollback events are matched back
  // to the failing call's own receipt to prove per-invocation compensation.
  const receiptByExecution = new Map<string, { mutationStarted?: boolean; mutationCommitted?: boolean }>()

  for (const e of events) {
    const d = e.data as Record<string, unknown>
    switch (e.type) {
      case EventTypes.ModelRequestStarted:
        providerRequests++
        break
      case EventTypes.ToolStarted: {
        const h = d.argsHash as string | undefined
        if (h) argsHashCounts.set(h, (argsHashCounts.get(h) ?? 0) + 1)
        const name = String(d.tool)
        if (READ_TOOLS.has(name)) filesRead++
        if (WRITE_TOOLS.has(name)) filesModified++
        if (typeof d.strategy === "string") {
          // Scoped: two installs in two different packages are not a repeat.
          // The format is STRATEGY_EXECUTION_KEY_FORMAT — see it before changing
          // this line: a different key is a different metric definition and owes
          // a METRICS_SCHEMA_VERSION bump.
          const k = `${d.strategy}:${String(d.scope ?? "")}:${Number(d.stateEpoch ?? 0)}:${String(d.semanticStateHash ?? "")}`
          strategyStateCounts.set(k, (strategyStateCounts.get(k) ?? 0) + 1)
        }
        break
      }
      case EventTypes.ToolExecuted: {
        toolCalls++
        if (d.ok === false) failedToolCalls++
        const key = d.idempotencyKey as string | undefined
        if (key) idemCounts.set(key, (idemCounts.get(key) ?? 0) + 1)
        const receipt = d.mutation as { mutationStarted?: boolean; mutationCommitted?: boolean } | undefined
        const tex = d.toolExecutionId as string | undefined
        if (receipt && tex) receiptByExecution.set(tex, receipt)
        break
      }
      case EventTypes.ToolRollbackCompleted:
      case EventTypes.ToolRollbackFailed: {
        rollbacks++
        const tex = d.toolExecutionId as string | undefined
        const receipt = tex ? receiptByExecution.get(tex) : undefined
        if (!receipt || receipt.mutationStarted !== true) rollbacksFromNonMutatingFailure++
        rollbackDetails.push({
          executionId: tex,
          path: typeof d.path === "string" ? d.path : undefined,
          reason: typeof d.reason === "string" ? d.reason : undefined,
          mutationStarted: receipt?.mutationStarted,
          mutationCommitted: receipt?.mutationCommitted,
          status: e.type === EventTypes.ToolRollbackCompleted ? "completed" : "failed",
        })
        break
      }
      case EventTypes.VerificationUnavailable:
        verificationUnavailable++
        break
      case EventTypes.ToolRepeatedCallBlocked:
        repeatedCallsBlocked++
        break
      case EventTypes.ToolRedundantStrategyBlocked:
        redundantStrategiesBlocked++
        break
      case "model.usage": {
        // REAL usage from the provider response — sum across turns.
        const it = typeof d.inputTokens === "number" ? d.inputTokens : 0
        const ot = typeof d.outputTokens === "number" ? d.outputTokens : 0
        inputTokens = (inputTokens ?? 0) + it
        outputTokens = (outputTokens ?? 0) + ot
        break
      }
      case EventTypes.RunCompleted:
      case EventTypes.RunFailed:
      case EventTypes.RunCancelled:
      case EventTypes.RunPaused:
        terminalSeen = true
        finalState = e.type.replace("run.", "")
        // A degraded close (work verified, final answer lost) is a SEPARATE
        // final state: objective correctness still measured, but it NEVER
        // counts as normal completion (`completedNormally` requires exactly
        // "completed").
        if (e.type === EventTypes.RunCompleted && d.reason === "completed_degraded") finalState = "completed_degraded"
        break
    }
  }

  return {
    providerRequests,
    toolCalls,
    failedToolCalls,
    // a repeat = the same tool argsHash issued more than once (wasted work)
    repeatedToolCalls: [...argsHashCounts.values()].reduce((n, c) => n + (c > 1 ? c - 1 : 0), 0),
    // a duplicate side effect = an idempotency key that executed more than once (must be 0)
    duplicateSideEffects: [...idemCounts.values()].filter((c) => c > 1).length,
    inputTokens,
    outputTokens,
    filesRead,
    filesModified,
    terminal: terminalSeen,
    finalState,
    rollbacks,
    rollbacksFromNonMutatingFailure,
    rollbackDetails,
    verificationUnavailable,
    repeatedCallsBlocked,
    redundantStrategiesBlocked,
    maxStrategyExecutionsPerState: strategyStateCounts.size === 0 ? 0 : Math.max(...strategyStateCounts.values()),
  }
}

export const isTerminalState = (s: string): boolean => TERMINAL_STATES.has(s)
