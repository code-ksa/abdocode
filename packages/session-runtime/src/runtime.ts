/**
 * SessionRuntime — the AbdoCode agent loop.
 *
 * Contract that everything else leans on: **every run lands exactly one terminal
 * event** (run.completed | run.failed | run.cancelled | run.paused), no matter
 * how it exits — normal finish, model rejection, tool failure, cancellation,
 * budget exhaustion, or an unexpected throw. That is what keeps the UI (a
 * projection of these events) out of a phantom "running" state.
 *
 * Input is two-phase for durability: `admit` records it (survives a crash),
 * `run` promotes it and drives the loop. Every state change goes through the
 * Slice-2 transition guard, so an illegal move fails loudly and is caught into
 * a terminal `failed` rather than corrupting the run.
 */
import { createHash } from "crypto"
import { advanceProgress, emptyProgress, foldProgress, type RunProgress } from "@abdo/contracts/run"
import { classifyFailure, type FailureVerdict } from "@abdo/contracts/failure"
import type { AgentMode } from "@abdo/control-contracts/modes"
import { unbackedClaims } from "@abdo/contracts/receipt"
import { checkIdempotency } from "@abdo/contracts/idempotency"
import {
  addPhaseSpend,
  emptyPhaseSpend,
  phaseOfToolCall,
  planStepBudget,
  type PhaseSpend,
  type RunReport,
  type StepBudgetPlan,
} from "@abdo/contracts/budget"
import { CONTROL_CONTRACT_VERSION } from "@abdo/control-contracts"
import { Id } from "@abdo/contracts"
import { LateResponseError, ProviderTimeoutError, RunCancelledError } from "@abdo/contracts/error"
import type { RunStopReason } from "@abdo/contracts/session"
import type { SessionState } from "@abdo/contracts/state"
import { transition } from "@abdo/contracts/transition"
import type { EventStore } from "@abdo/event-store"
import {
  DEFAULT_BUDGETS,
  type Budgets,
  type ContextReconciler,
  type ModelClient,
  type CompletionPolicy,
  type CompletionVerification,
  type ModelInput,
  type EnforcedToolRunner,
  type ExpensiveStrategy,
  type ModelTurn,
  type AbandonedEffect,
  type RunLiveness,
  type StrategyLedgerEntry,
  type StrategyPolicy,
  type StreamSink,
  type ToolRunner,
} from "./ports"
import { BufferedDeltaSink, type DeltaWriter } from "./stream"

export const EventTypes = {
  InputAdmitted: "input.admitted",
  InputPromoted: "input.promoted",
  RunAdmitted: "run.admitted",
  RunPreparing: "run.preparing",
  RunCalling: "run.calling",
  RunStreaming: "run.streaming",
  /** The provider stopped the turn on its output ceiling, not the model on its answer. */
  RunTruncated: "run.truncated",
  RunExecutingTool: "run.executing_tool",
  RunCheckpointed: "run.checkpointed",
  ModelRequestStarted: "model.request.started",
  ToolStarted: "tool.started",
  ToolExecuted: "tool.executed",
  MessageDeltaBatch: "message.delta_batch",
  MessageAppended: "message.appended",
  RunCompleted: "run.completed",
  RunFailed: "run.failed",
  RunCancelled: "run.cancelled",
  RunPaused: "run.paused",
  RunResumed: "run.resumed",
  // Completion protocol (12I.6 fix 5)
  MutationEpochStarted: "run.mutation_epoch_started",
  VerificationRequired: "run.verification_required",
  VerificationStarted: "run.verification_started",
  VerificationPassed: "run.verification_passed",
  VerificationFailed: "run.verification_failed",
  /** No objective check applies. NEVER recorded as passed — the run may still
   *  complete, but its terminal event carries verification:"unavailable". */
  VerificationUnavailable: "run.verification_unavailable",
  NoProgressDetected: "run.no_progress_detected",
  FinalizationRequested: "run.finalization_requested",
  // Guarded per-invocation compensation (visible in the log — the 2026-07-23
  // multi-11 incident was undiagnosable because rollback left no event).
  ToolRollbackStarted: "tool.rollback_started",
  ToolRollbackCompleted: "tool.rollback_completed",
  ToolRollbackFailed: "tool.rollback_failed",
  /** An identical call already produced the IDENTICAL result twice in this epoch
   *  (a no-information repeat — a failing loop OR a succeeding thrash like
   *  `rm -rf && npm install` ×N). The runtime refuses to spawn it again and
   *  returns a structured error. Not a tool execution (no started/executed pair).
   *  Re-allowed by a new mutation epoch, a different result, or a changed state. */
  ToolRepeatedCallBlocked: "tool.repeated_call_blocked",
  /** An expensive STRATEGY (not an identical call) is being repeated while the
   *  state it depends on is unchanged — e.g. a dependency reinstall after an
   *  unrelated tsconfig edit. Refused without spawning a process. Re-allowed
   *  only by a change to that strategy's own semantic state. */
  ToolRedundantStrategyBlocked: "tool.redundant_strategy_blocked",
  /** An explicit human authorization let a redundant strategy run anyway. Logged
   *  so a bypass is never invisible in the record. */
  ToolStrategyOverrideGranted: "tool.strategy_override_granted",
  /** A strategy claim (`tool.started` with no `tool.executed`) whose owning run
   *  is dead or stale was RESOLVED: the effect on the world was classified
   *  (`applied` / `not_applied` / `unknown`) and the claim released. Durable, so
   *  the resolution is replayed on restart instead of re-derived from a world
   *  that has moved on since. */
  ToolStrategyClaimResolved: "tool.strategy_claim_resolved",
  /** CL-01: a control-plane decision recorded on its own, for execution paths
   *  that are not a model tool call (today: the completion verifier). */
  ControlDecided: "control.decided",
  /**
   * CL-16A2-B: the isolation an execution ran under. Written by the controlled
   * launcher BEFORE the process it describes exists, so a crash can leave an
   * applied-with-no-result (safe) but never a process with no isolation record
   * (unsafe). `capability_checked` records what the platform can actually
   * deliver; `failed` records a refusal and means NOTHING was executed.
   *
   * These carry environment key NAMES only. An environment VALUE — a token, a
   * credential — is never written here: a secret in an audit log outlives the
   * run that leaked it.
   */
  /** Sprint 11: the task statement, COPIED out of the conversation on purpose —
   *  compaction may prune the messages, and the run must still know its job. */
  RunObjectiveRecorded: "run.objective_recorded",
  /** Sprint 13: the resumable report a run owes when it stops unfinished. */
  RunReported: "run.reported",
  /** Sprint 13: a phase spent more than it was allocated — recorded, once. */
  RunBudgetPhaseOverrun: "run.budget_phase_overrun",
  /** Sprint 14: the run that takes over from one that ran out. */
  RunContinuationCreated: "run.continuation_created",
  /** Sprint 16: a claim of completion that no receipt supports. */
  RunClaimUnbacked: "run.claim_unbacked",
  /** Sprint 17: a keyed operation that already ran — replayed, not repeated. */
  ToolIdempotentReplay: "tool.idempotent_replay",
  /** Sprint 11: a child run claimed by this one, and how that child ended. */
  RunSubtaskSpawned: "run.subtask_spawned",
  RunSubtaskResolved: "run.subtask_resolved",
  IsolationRequested: "isolation.requested",
  IsolationCapabilityChecked: "isolation.capability_checked",
  IsolationApplied: "isolation.applied",
  IsolationFailed: "isolation.failed",
} as const

export interface RunResult {
  readonly runId: string
  readonly state: SessionState
  readonly reason?: RunStopReason
  readonly text?: string
}

export interface RunOptions {
  readonly signal?: AbortSignal
  /** Called at each stable point during execution — renew the lease here. */
  readonly heartbeat?: () => void | Promise<void>
  /**
   * What this run is for, stated by the caller. Recorded as its own event so
   * the run's purpose survives the conversation being compacted or pruned. With
   * none given the promoted input is lifted instead; with neither, the run is
   * honest about having no objective rather than inferring one.
   */
  readonly objective?: string
  /** Set when this run carries part of another run's work (a subtask). */
  readonly parentRunId?: string
  /**
   * Steps the caller intends this run to take. Recorded on every checkpoint so
   * a resumed run can see the shape of the job it is halfway through. The
   * runtime never invents one: no plan given, no plan claimed.
   */
  readonly plan?: readonly string[]
  /**
   * Sprint 26: the approved plan this run executes under, when there is one.
   * The runtime passes it to the enforcement point; the model never asserts it.
   */
  readonly approvedPlanId?: string
  /**
   * Sprint 25: what this run is allowed to do AT ALL. A ceiling, not a grant —
   * every permit and approval still applies underneath. Defaults to BUILD,
   * which is what an ordinary working run is; a read-only investigation must
   * ask for EXPLORE explicitly, because a default nobody sets is a default
   * nobody notices.
   */
  readonly mode?: AgentMode
  /**
   * The run that ran out and handed this task over (Sprint 14). The link is
   * written on BOTH runs: this one records where it came from, and the
   * exhausted one records who took over — so the chain reads the same from
   * either end, even if the process died between the two.
   */
  readonly continuationOf?: string
}

export interface ContinueOptions {
  readonly runId: string
  readonly attempt: number
  /** State to resume from (the recovered phase). */
  readonly fromState: SessionState
  readonly fromTurn: number
  readonly toolCalls?: number
  readonly reason?: string
  readonly signal?: AbortSignal
  readonly heartbeat?: () => void | Promise<void>
  /** The original run's plan, so a resumed attempt keeps carrying it. */
  readonly plan?: readonly string[]
}

export interface RuntimeDeps {
  readonly store: EventStore
  readonly model: ModelClient
  readonly tools: EnforcedToolRunner
  readonly reconciler?: ContextReconciler
  readonly budgets?: Partial<Budgets>
  /** Max time for a single model.call before it's a provider failure. Default 60s. */
  readonly modelTimeoutMs?: number
  /**
   * Streaming-specific timeouts (config, not domain constants). A healthy long
   * stream that keeps producing chunks is NOT treated as hung:
   *   - firstByteMs: no first event within this window -> abort,
   *   - idleChunkMs: reset on every event; a gap larger than this -> abort,
   *   - totalMs: overall cap (defaults to modelTimeoutMs when unset).
   */
  readonly streamTimeouts?: { readonly firstByteMs?: number; readonly idleChunkMs?: number; readonly totalMs?: number }
  /**
   * Max SAFE mid-stream retries of the model call within a turn (default 2). A
   * broken stream is retried only BEFORE any tool executes (no side effect yet),
   * with a fresh request id so the partial is interrupted and its late chunks are
   * rejected. Retries transport drops AND stream-stall watchdogs (first-byte/
   * idle-chunk). Never retries cancel / total-budget timeout / auth / fatal.
   */
  readonly maxStreamRetries?: number
  /** Byte threshold before a streamed text batch is flushed to the log. Default 2048. */
  readonly deltaFlushBytes?: number
  /**
   * Runtime Completion Protocol (12I.6 fix 5). When set, the runtime refuses a
   * final answer after mutations until `verify` passes for the current mutation
   * epoch, detects no-progress read loops (same tool+args in the same epoch),
   * and closes with a tool-free finalization turn instead of burning the turn
   * budget. Off by default — plain hosts are unchanged.
   */
  readonly completion?: CompletionPolicy
  /**
   * Semantic Strategy Guard — an INDEPENDENT layer above the identical-call
   * block. The repeat guard keys on `workspaceGeneration` (any committed file
   * mutation), which is right for identical commands but re-opens expensive
   * strategies after unrelated edits: install → edit tsconfig → install → edit
   * jest.config → install. This guard keys each expensive strategy on the state
   * it actually depends on. Off by default.
   */
  readonly strategy?: StrategyPolicy
  /**
   * Who can say whether the run holding a strategy claim is still alive. Without
   * it a claim is released only by the staleness backstop
   * (`budgets.strategyClaimTtlMs`), which is slow but never eternal; with it, a
   * dead owner's claim is resolved as soon as the next attempt asks.
   */
  readonly liveness?: RunLiveness
  /**
   * Called after each event is durably appended, with its REAL store sequence.
   * The host fans these out to live subscribers (StreamHub) — the runtime stays
   * unaware of the UI. Never throws into the loop (best-effort).
   */
  readonly publisher?: (event: PersistedEvent) => void
  /** Injectable clock for deterministic budget tests. */
  readonly now?: () => number
}

export interface PersistedEvent {
  readonly sessionId: string
  readonly type: string
  readonly sequence: number
  readonly data: Record<string, unknown>
}

const noopReconciler: ContextReconciler = { reconcile: async () => {} }

/**
 * Per-run mutable state + the emit/advance/finish/checkpoint choke points.
 * Extracted so run() and continueRun() share one loop and one terminal guarantee.
 */
class RunContext {
  state: SessionState = "idle"
  finished = false
  lastSeq = -1
  /**
   * The work done so far — files changed, commands completed, tests, the
   * current blocker. Folded forward as the run emits (see emit) and written
   * into every checkpoint, so a resumer learns what happened from the
   * checkpoint instead of replaying the log to find out.
   */
  progress: RunProgress
  /** The objective this run recorded, kept so a report can state it. */
  objective?: string
  /** Sprint 25: the ceiling this run executes under. */
  mode: AgentMode = "BUILD"
  /** Sprint 26: the approved plan covering this run, if any. */
  approvedPlanId?: string

  constructor(
    private readonly store: EventStore,
    readonly sessionId: string,
    readonly runId: string,
    readonly attempt: number,
    readonly signal: AbortSignal | undefined,
    private readonly clock: () => number,
    private readonly publisher?: (event: PersistedEvent) => void,
    plan: readonly string[] = [],
  ) {
    this.progress = emptyProgress(plan)
  }

  aborted(): boolean {
    return this.signal?.aborted === true
  }

  /**
   * `idempotencyKey` makes an emit safe to repeat: the store dedupes it, so a
   * retry or a resume that replays the same logical event appends it once. Only
   * pass a key that is DERIVED from execution identity, never a content hash of
   * something that can legitimately recur.
   */
  async emit(type: string, data: Record<string, unknown> = {}, idempotencyKey?: string) {
    // `attempt` rides on EVERY event for the same reason `runId` does: without
    // it, an execution orphaned by a crashed attempt is indistinguishable from
    // one this attempt abandoned, and a guard cannot tell a stale artifact from
    // a live lie.
    const fullData = { runId: this.runId, attempt: this.attempt, ...data }
    const r = await this.store.append({
      aggregateKind: "session",
      aggregateId: this.sessionId,
      type,
      data: fullData,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    })
    const sequence = Number(r.event.sequence)
    this.lastSeq = sequence
    // Every durable fact this run produces passes through here, so this is the
    // only place progress can be accumulated without a second bookkeeping path
    // that could disagree with the log.
    this.progress = advanceProgress(this.progress, type, fullData, Number(r.event.occurredAt))
    // Live fan-out with the REAL sequence — best-effort, never breaks the loop.
    if (this.publisher) {
      try {
        this.publisher({ sessionId: this.sessionId, type, sequence, data: fullData })
      } catch {
        // a subscriber/hub problem must never fail a durable run
      }
    }
    return r
  }

  async advance(target: SessionState, type: string, data: Record<string, unknown> = {}): Promise<void> {
    this.state = transition(this.state, target)
    await this.emit(type, data)
  }

  /** The single terminal choke point — idempotent and transition-error-proof. */
  async finish(
    target: SessionState,
    type: string,
    reason?: RunStopReason,
    data: Record<string, unknown> = {},
  ): Promise<RunResult> {
    if (this.finished) return { runId: this.runId, state: this.state, reason }
    this.finished = true
    try {
      this.state = transition(this.state, target)
    } catch {
      this.state = target
    }
    await this.emit(type, { ...data, ...(reason ? { reason } : {}) })
    return { runId: this.runId, state: this.state, reason, text: typeof data.text === "string" ? data.text : undefined }
  }

  async checkpoint(
    phase: string,
    nextAction: string,
    turn: number,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.emit(EventTypes.RunCheckpointed, {
      attempt: this.attempt,
      sequence: this.lastSeq,
      phase,
      turn,
      nextAction,
      createdAt: this.clock(),
      // Sprint 12: the checkpoint IS the work record. Without this a resumer
      // knows where to re-enter the loop and nothing about what it would be
      // repeating.
      progress: this.progress,
      ...extra,
    })
  }
}

/** Deterministic key ordering so logically-equal arguments hash identically. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** SHA-256 of canonical arguments — the identity used to reason about "same call" across a restart. */
/** Objective text kept on the event; the hash beside it covers the full string. */
const OBJECTIVE_TEXT_LIMIT = 2000

function hashArgs(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(input ?? null))).digest("hex")
}

/**
 * Tools that only LOOK.
 *
 * Deliberately a small, explicit list rather than "anything not known to
 * mutate": the exploration budget must never fire on a tool nobody told it
 * about, because an unrecognised tool is an unknown, and an unknown counted as
 * harmless is how a guard starts punishing correct work.
 */
const READ_TOOLS = /^(read_file|list_dir|grep|search|find_files|glob|ripgrep|cat|stat)$/

export class SessionRuntime {
  private readonly store: EventStore
  private readonly model: ModelClient
  private readonly tools: ToolRunner
  private readonly reconciler: ContextReconciler
  private readonly budgets: Budgets
  private readonly modelTimeoutMs: number
  private readonly streamTimeouts?: { firstByteMs?: number; idleChunkMs?: number; totalMs?: number }
  private readonly maxStreamRetries: number
  private readonly deltaFlushBytes: number
  private readonly completion?: CompletionPolicy
  private readonly strategy?: StrategyPolicy
  private readonly liveness?: RunLiveness
  private readonly publisher?: (event: PersistedEvent) => void
  private readonly now: () => number

  constructor(deps: RuntimeDeps) {
    this.store = deps.store
    this.model = deps.model
    this.tools = deps.tools
    this.reconciler = deps.reconciler ?? noopReconciler
    this.budgets = { ...DEFAULT_BUDGETS, ...deps.budgets }
    this.modelTimeoutMs = deps.modelTimeoutMs ?? 60_000
    this.streamTimeouts = deps.streamTimeouts
    this.maxStreamRetries = deps.maxStreamRetries ?? 2
    this.deltaFlushBytes = deps.deltaFlushBytes ?? 2048
    this.completion = deps.completion
    this.strategy = deps.strategy
    this.liveness = deps.liveness
    this.publisher = deps.publisher
    this.now = deps.now ?? Date.now
  }

  /** Phase 1: durably record an input. Returns its id. Drives no run state. */
  async admit(sessionId: string, text: string): Promise<string> {
    const inputId = "inp_" + Math.random().toString(36).slice(2)
    await this.store.append({
      aggregateKind: "session",
      aggregateId: sessionId,
      type: EventTypes.InputAdmitted,
      data: { inputId, text },
    })
    return inputId
  }

  /** Phase 2: promote pending inputs and drive the loop to a terminal event. */
  async run(sessionId: string, options: RunOptions = {}): Promise<RunResult> {
    const runId = Id.RunID.create()
    const startedAt = this.now()
    const ctx = new RunContext(this.store, sessionId, runId, 1, options.signal, this.now, this.publisher, options.plan ?? [])
    let outcome: RunResult | undefined
    try {
      const promoted = await this.promote(sessionId)
      ctx.mode = options.mode ?? "BUILD"
      ctx.approvedPlanId = options.approvedPlanId
      await ctx.advance("input_admitted", EventTypes.RunAdmitted, {
        mode: ctx.mode,
        ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
        ...(options.continuationOf ? { continuedFromRunId: options.continuationOf } : {}),
      })
      if (options.continuationOf) {
        await this.store.append({
          aggregateKind: "session",
          aggregateId: sessionId,
          type: EventTypes.RunContinuationCreated,
          data: { runId: options.continuationOf, continuationRunId: runId },
        })
      }
      // The objective is COPIED here, not referenced. An explicit one wins; with
      // none, the promoted input is lifted. Either way the run stops depending
      // on messages that compaction is allowed to delete later.
      const objective = (options.objective ?? promoted.join("\n")).trim()
      if (objective.length > 0) {
        ctx.objective = objective.slice(0, OBJECTIVE_TEXT_LIMIT)
        await ctx.emit(EventTypes.RunObjectiveRecorded, {
          text: objective.slice(0, OBJECTIVE_TEXT_LIMIT),
          // Hash covers the FULL text, so truncation for storage never hides a
          // difference between two objectives that share a prefix.
          hash: createHash("sha256").update(objective).digest("hex"),
          source: options.objective ? "explicit" : "input",
          recordedAt: this.now(),
        })
      }
      // The parent learns about its subtask on its OWN timeline, so either end
      // of the link answers "what work was delegated" without a join.
      if (options.parentRunId) {
        await this.store.append({
          aggregateKind: "session",
          aggregateId: sessionId,
          type: EventTypes.RunSubtaskSpawned,
          data: {
            runId: options.parentRunId,
            childRunId: runId,
            ...(objective.length > 0 ? { objective: objective.slice(0, OBJECTIVE_TEXT_LIMIT) } : {}),
          },
        })
      }
      if (ctx.aborted()) {
        outcome = await ctx.finish("cancelled", EventTypes.RunCancelled, "cancelled")
        return outcome
      }
      await ctx.advance("preparing_context", EventTypes.RunPreparing)
      await this.reconciler.reconcile(sessionId)
      await ctx.checkpoint("input_promoted", "call_model", 0)
      outcome = await this.driveTurns(ctx, 0, 0, startedAt, options.heartbeat)
      return outcome
    } catch (error) {
      outcome = await this.finishFromError(ctx, error)
      return outcome
    } finally {
      if (!ctx.finished) {
        outcome = await ctx.finish("failed", EventTypes.RunFailed, "provider_error", { error: "run ended without terminal" })
      }
      // A spawned subtask that never reports back leaves the parent waiting for
      // ever, so resolution is emitted on the way out — including the failure
      // paths, which are exactly the ones a parent must not miss.
      if (options.parentRunId) {
        await this.store.append({
          aggregateKind: "session",
          aggregateId: sessionId,
          type: EventTypes.RunSubtaskResolved,
          data: {
            runId: options.parentRunId,
            childRunId: runId,
            state: outcome?.state ?? ctx.state,
            ...(outcome?.reason ? { reason: outcome.reason } : {}),
          },
        })
      }
    }
  }

  /**
   * Resume an existing run to a terminal/paused state. The caller (host) has
   * already acquired the lease and reconciled the recovery decision; this just
   * continues the agent loop from the recovered state. A fresh model turn has no
   * side effect, and any already-completed tool is recorded — so continuing
   * never duplicates work.
   */
  async continueRun(sessionId: string, options: ContinueOptions): Promise<RunResult> {
    const startedAt = this.now()
    const ctx = new RunContext(this.store, sessionId, options.runId, options.attempt, options.signal, this.now, this.publisher)
    // Rebuild what the dead attempt had already done, from the log it left
    // behind. A resumed run that started from an empty progress would write a
    // checkpoint claiming nothing had happened yet — the exact lie Sprint 12
    // exists to prevent.
    ctx.progress = foldProgress(await this.store.read("session", sessionId), options.runId, options.plan ?? [])
    ctx.state = options.fromState
    try {
      await ctx.emit(EventTypes.RunResumed, { attempt: options.attempt, reason: options.reason })
      return await this.driveTurns(ctx, options.fromTurn, options.toolCalls ?? 0, startedAt, options.heartbeat)
    } catch (error) {
      return await this.finishFromError(ctx, error)
    } finally {
      if (!ctx.finished) {
        await ctx.finish("failed", EventTypes.RunFailed, "provider_error", { error: "resume ended without terminal" })
      }
    }
  }

  /** The shared turn loop used by both run() and continueRun(). */
  private async driveTurns(
    ctx: RunContext,
    startTurn: number,
    startToolCalls: number,
    startedAt: number,
    heartbeat?: () => void | Promise<void>,
  ): Promise<RunResult> {
    let turn = startTurn
    let toolCalls = startToolCalls
    let consecutiveToolFailures = 0
    let consecutiveDenials = 0
    let readOnlyTurns = 0
    let explorationWarned = false
    let finalVerified = false
    // Sprint 13: the budget is divided before the work starts. `spendable` is
    // what the model may consume; the remainder is reserved so a checkpoint, a
    // rollback and a report stay reachable however the work turns out.
    const budgetPlan = planStepBudget(this.budgets.maxToolCalls)
    const runMode: AgentMode = ctx.mode
    const planId = ctx.approvedPlanId
    let phaseSpend: PhaseSpend = emptyPhaseSpend()
    const overrunReported = new Set<string>()

    // ---- Completion protocol state (12I.6 fix 5) ----
    // A mutation epoch opens on the FIRST mutation after a verified/clean state
    // and absorbs subsequent mutations until verification passes — so N edits
    // before a check cost ONE verification, and any edit after a pass opens a
    // new epoch (the old verification is invalidated).
    const completion = this.completion
    let mutationEpoch = 0
    let verifiedEpoch = 0
    /** The epoch whose completion has already been checked proactively — at most one check per real change. */
    let proactiveEpoch = 0
    let verifyAttempts = 0
    let noProgressTurns = 0
    let finalizing = false
    /** What the LAST verification actually established for the terminal event. */
    let lastVerification: "none" | "passed" | "unavailable" = "none"
    const fingerprints = new Set<string>()
    /**
     * Workspace generation: bumps on every COMMITTED file mutation (a tool
     * outcome whose receipt has `mutationCommitted: true` — edit_file/write_file,
     * and later recovery). It is the "real project state changed" signal the
     * repeat-block keys on, so a genuine edit BETWEEN two identical commands
     * re-allows them even though they share one mutation epoch (multiple edits
     * live in ONE epoch). Shell does NOT bump it (shell is the thing being
     * deduplicated); general shell workspace-change detection is a later step.
     */
    let workspaceGeneration = 0
    /**
     * Identical-result ledger, keyed `tool:argsHash:generation`. TWO calls with
     * the same PROGRESS-hash (a FAILURE's precise resultHash — the `npx jest` ×6
     * loop; or the coarse "ok" of a SUCCESS — the `rm -rf && npm install` ×8
     * thrash, whose stdout is non-deterministic so only exit-success is compared)
     * => the third is BLOCKED (no process) with a structured error. Re-allowed by:
     *   - a NEW workspace generation (a real edit) — a different key,
     *   - a DIFFERENT failure resultHash — new information, resets the count,
     *   - DIFFERENT args — a different key.
     * A success's stdout is deliberately NOT part of the identity (it is noisy);
     * a success re-run is re-allowed by a real state change (generation), never by
     * output jitter. Outcomes without a resultHash (edit/write/read success) do
     * not participate — mutations bump the generation, reads use the fingerprint
     * set — so a real file mutation is never mistaken for a thrash.
     */
    const progressHashOf = (ok: boolean, resultHash: string | undefined): string | undefined =>
      resultHash === undefined ? undefined : ok ? "ok" : resultHash
    const resultLedger = new Map<string, { progressHash: string; count: number; ok: boolean }>()
    /**
     * Semantic Strategy Ledger, keyed `strategy:scope` (the scope carries the
     * target identity) — a SECOND, independent layer, and a projection of the
     * session log rather than of this run. The result ledger asks "is this exact
     * call repeating?";
     * this one asks "is this expensive PLAN repeating while the state it depends
     * on is unchanged?". That is the loop the generation key cannot see:
     *   install ok -> edit tsconfig (new generation) -> install -> edit jest.config -> install
     * Every one of those installs is a different ledger key for the repeat guard
     * but the SAME key here, because dependencies/lockfile never moved.
     * Rules (per key): a first attempt is allowed; one retry after a failure is
     * allowed (a different failure is new information); a prior SUCCESS blocks
     * immediately (one success is enough — nothing changed since); two failures
     * block (blind repetition). A real change to that strategy's own state is a
     * NEW key, so a legitimate reinstall after editing dependencies is untouched.
     */
    const strategyLedger = new Map<string, StrategyLedgerEntry>()
    // SCOPE is part of the key: one strategy can legitimately run in several
    // package roots. Installing in packages/frontend must never block
    // packages/backend, and a child manifest edit must re-allow that child only.
    // A composed policy packs its targetIdentity into `scope`, so the key is
    // `strategy + scope + targetIdentity` — one entry per thing acted on.
    const strategyKey = (strategy: string, scope: string) => `${strategy}:${scope}`
    const strategyEntry = (strategy: string, scope: string): StrategyLedgerEntry => {
      const key = strategyKey(strategy, scope)
      let e = strategyLedger.get(key)
      if (!e) {
        e = { strategy, scope, stateEpoch: 0, states: new Map() }
        strategyLedger.set(key, e)
      }
      return e
    }
    /** Counts live per EPOCH as well as per state: a new epoch is a fresh start,
     *  not a lookup into what this strategy did before the world moved. */
    const strategyStateKey = (epoch: number, state: string) => `${epoch}:${state}`
    /**
     * Apply one observed state to the ledger's view of the world. Called ONLY by
     * the log fold — the writer — never by a decision. TRANSITIONS decide, not
     * values:
     *
     *   1. The state the previous successful run PRODUCED itself (a regenerated
     *      lockfile, a downloaded artifact) moves nothing: it was this
     *      strategy's own hand, and the entry stays where it is.
     *   2. Any other difference from the last observed state IS the world
     *      moving — a new epoch, even when the hash is one seen before. That is
     *      the deletion case: removing a fetched file returns the destination to
     *      the very "missing" hash the first fetch started from, and it is a NEW
     *      missing, so the fetch must be allowed again.
     *   3. An unchanged state moves nothing; the repetition rules
     *      (`strategyEvaluate`) then apply inside the standing epoch — one
     *      success is enough, two blind failures are enough.
     *
     * Invariant that keeps 1 and 2 from ever competing: whenever
     * `lastPostStateHash` is set, `lastObservedStateHash` equals it, so a state
     * matching the post-state can never also look like an external change.
     */
    const strategyObserve = (e: StrategyLedgerEntry, state: string): void => {
      if (e.lastPostStateHash !== undefined && state === e.lastPostStateHash) return
      if (e.lastObservedStateHash === undefined || state !== e.lastObservedStateHash) {
        // First sighting starts epoch 0; every later change turns the epoch.
        if (e.lastObservedStateHash !== undefined) e.stateEpoch++
        e.lastObservedStateHash = state
        e.lastPostStateHash = undefined
        // The world moved on. An unresolved effect from a dead run is a
        // statement about the epoch it was left in, not a permanent mark.
        e.abandonedUnknown = undefined
      }
    }
    /**
     * The same three rules as `strategyObserve`, asked WITHOUT moving anything:
     * why this attempt must be refused at `state`, and the epoch it belongs to.
     *
     * Deciding and recording are split because the ledger is a projection of the
     * LOG, not of this process. A decision reads; only the fold below writes, and
     * it writes from the events the decision goes on to append. Were the decision
     * to mutate as well, the fold would later apply the same `tool.started` a
     * second time and turn a spurious epoch.
     */
    const strategyEvaluate = (e: StrategyLedgerEntry, state: string): { reason?: string; epoch: number } => {
      // An execution was abandoned here and nothing could see whether it wrote.
      // Retrying blindly after a POSSIBLE side effect is forbidden — but this is
      // a refusal, not a lock: the claim is already released, an explicit
      // authorization passes it, and a real change to the world clears it.
      if (e.abandonedUnknown && e.abandonedUnknown.epoch === e.stateEpoch && e.abandonedUnknown.state === state)
        return { reason: "abandoned_execution_unknown_effect", epoch: e.stateEpoch }
      if (e.lastPostStateHash !== undefined && state === e.lastPostStateHash)
        return { reason: "state_produced_by_prior_run", epoch: e.stateEpoch }
      if (e.lastObservedStateHash === undefined) return { epoch: e.stateEpoch }
      // The world moved: this attempt lands in the epoch that change opens.
      if (state !== e.lastObservedStateHash) return { epoch: e.stateEpoch + 1 }
      const at = e.states.get(strategyStateKey(e.stateEpoch, state))
      if (at) {
        if (at.successes >= 1) return { reason: "already_succeeded", epoch: e.stateEpoch }
        if (at.failures >= 2) return { reason: "repeated_failure", epoch: e.stateEpoch }
      }
      return { epoch: e.stateEpoch }
    }
    /**
     * Record what an execution did, in the epoch it was evaluated in. A success
     * that reports a post-state makes that state the ledger's current view of
     * the world — the strategy itself moved it, so returning there is rule 1
     * above, not new information. A success with no observable post-state
     * (`observeState` absent, as for a verification that changes nothing) leaves
     * the view where it was.
     */
    const strategyRecord = (
      e: StrategyLedgerEntry,
      epoch: number,
      state: string,
      ok: boolean,
      postState: string | undefined,
      resultHash: string | undefined,
    ) => {
      const key = strategyStateKey(epoch, state)
      const at = e.states.get(key) ?? { successes: 0, failures: 0 }
      // An execution that reported supersedes an earlier one that never did.
      e.abandonedUnknown = undefined
      if (ok) {
        at.successes++
        if (postState) {
          e.lastPostStateHash = postState
          e.lastObservedStateHash = postState
        }
      } else {
        at.failures++
        at.lastResultHash = resultHash
      }
      e.states.set(key, at)
    }
    /**
     * The strategy ledger is a PROJECTION OF THE SESSION LOG, across every run —
     * not a map that lives in one process. A second runtime, a second run, or a
     * resume of this one all reason from the same events, so the guard cannot be
     * reset by starting again.
     *
     * `tool.started` is therefore also a durable CLAIM: a started with no
     * `tool.executed` yet is an execution in flight, and another run must not
     * launch the same strategy at the same target beside it — that is one world
     * being changed twice. The claim is released by the execution's own
     * `tool.executed`, or by its run reaching a terminal event.
     *
     * A run that dies without either would otherwise hold the strategy FOR EVER,
     * which trades a duplicate side effect for a permanent deadlock. So a claim
     * whose owner is dead (`RunLiveness`) or stale (`budgets.strategyClaimTtlMs`)
     * is ABANDONED, and abandonment is RESOLVED rather than ignored: the effect
     * on the world is classified — `applied` / `not_applied` / `unknown` — the
     * verdict is written to the log, and only then is the claim released. An
     * `unknown` effect releases the claim but still refuses the next attempt,
     * because retrying blindly after a possible side effect is the thing the
     * rules forbid; that refusal is overridable by an explicit authorization,
     * and a live claim never is.
     */
    const strategyStarts = new Map<string, { runId: string; strategy: string; scope: string; state: string; epoch: number }>()
    const strategyInFlight = new Map<
      string,
      { runId: string; strategy: string; scope: string; state: string; epoch: number; startedAt: number }
    >()
    /** Highest sequence already folded, so each pass reads only what is new. */
    let strategyFoldedThrough = -1
    const foldStrategyLog = async () => {
      const events = await this.store.read("session", ctx.sessionId, strategyFoldedThrough + 1)
      for (const ev of events) {
        strategyFoldedThrough = Math.max(strategyFoldedThrough, Number(ev.sequence))
        const d = ev.data as {
          runId?: string
          toolExecutionId?: string
          ok?: boolean
          resultHash?: string
          strategy?: string
          scope?: string
          semanticStateHash?: string
          postSemanticStateHash?: string
        }
        if (ev.type === EventTypes.ToolStarted && d.strategy && d.toolExecutionId) {
          // The classification is REPLAYED from the log, never recomputed: the
          // semantic state was read from disk at classification time, so hashing
          // today's files here would mis-key yesterday's history.
          const entry = strategyEntry(d.strategy, d.scope ?? "")
          const state = d.semanticStateHash ?? ""
          strategyObserve(entry, state)
          const info = { runId: d.runId ?? "", strategy: d.strategy, scope: d.scope ?? "", state, epoch: entry.stateEpoch }
          strategyStarts.set(d.toolExecutionId, info)
          // `occurredAt` is the claim's own timestamp, read from the log rather
          // than from this process's clock — a resumed run must age a claim from
          // when it was really made, not from when it was re-read.
          strategyInFlight.set(d.toolExecutionId, { ...info, startedAt: Number(ev.occurredAt ?? this.now()) })
          continue
        }
        if (ev.type === EventTypes.ToolExecuted && d.toolExecutionId) {
          strategyInFlight.delete(d.toolExecutionId)
          const s = strategyStarts.get(d.toolExecutionId)
          if (!s) continue
          // The post-state is read off the event — recorded by the run that
          // produced it. An execution that never reported one (a crash between
          // started and executed) contributes NOTHING: no success, and above all
          // no post-state, which would silently refuse the retry the crash makes
          // necessary.
          strategyRecord(
            strategyEntry(s.strategy, s.scope),
            s.epoch,
            s.state,
            d.ok === true,
            typeof d.postSemanticStateHash === "string" ? d.postSemanticStateHash : undefined,
            d.resultHash,
          )
          continue
        }
        if (ev.type === EventTypes.ToolStrategyClaimResolved && d.toolExecutionId) {
          // Replayed, never re-derived: the effect was classified against the
          // world as it stood then, and the world has moved on since.
          strategyInFlight.delete(d.toolExecutionId)
          const s = strategyStarts.get(d.toolExecutionId)
          const effect = (ev.data as { effect?: AbandonedEffect }).effect
          if (s && effect === "unknown") {
            strategyEntry(s.strategy, s.scope).abandonedUnknown = { toolExecutionId: d.toolExecutionId, state: s.state, epoch: s.epoch }
          }
          continue
        }
        if (ev.type === EventTypes.RunCompleted || ev.type === EventTypes.RunFailed || ev.type === EventTypes.RunCancelled) {
          // A finished run holds nothing: whatever it started is over, however
          // it ended. (A PAUSE is not terminal — the run may still resume.)
          for (const [id, claim] of strategyInFlight) if (claim.runId === d.runId) strategyInFlight.delete(id)
        }
      }
    }
    /** A claim held by ANOTHER run on the same strategy+scope, or undefined.
     *  This run's own claims are excluded: a resume re-attempting the tool it
     *  died inside is the recovery path, not a second executor. */
    const foreignStrategyClaim = (strategy: string, scope: string) => {
      for (const [toolExecutionId, claim] of strategyInFlight) {
        if (claim.runId !== ctx.runId && claim.strategy === strategy && claim.scope === scope) return { toolExecutionId, ...claim }
      }
      return undefined
    }
    /**
     * Is the run behind this claim still working, or has it gone?
     *
     * `RunLiveness` is the precise answer and is asked first. Without it — or
     * when it says `unknown` — the claim is judged by AGE alone, and the default
     * TTL is deliberately long: a cold `npm install` runs for minutes, and
     * stealing a claim from a live install manufactures the very duplicate the
     * guard exists to prevent. A liveness port is what makes this fast; the
     * timer is only what makes it non-eternal.
     */
    const claimIsAbandoned = async (claim: { runId: string; startedAt: number }): Promise<boolean> => {
      if (this.liveness) {
        let status: "live" | "dead" | "unknown"
        try {
          status = await this.liveness.status(claim.runId)
        } catch {
          status = "unknown" // a broken liveness source never declares a run dead
        }
        if (status === "live") return false
        if (status === "dead") return true
      }
      return this.now() - claim.startedAt >= this.budgets.strategyClaimTtlMs
    }
    /**
     * Classify what an abandoned execution DID, write the verdict to the log,
     * and release the claim.
     *
     * The verifier is the strategy's own state observer when the family has one
     * (`observeState` — it can see its own writes), and otherwise the state the
     * policy classified for the attempt now asking. Three outcomes, and the
     * third is not a failure of the design but the honest answer:
     *
     *   applied      — the state moved: the execution reached the world. The
     *                  attempt now asking lands in a new epoch, which is a fresh
     *                  decision, not a blind retry.
     *   not_applied  — a family that CAN see its own writes reports the state it
     *                  started from: nothing landed, so the retry is clean.
     *   unknown      — the state is unchanged but this family cannot see its own
     *                  writes, or the observer failed. It MAY have written. The
     *                  claim is released, and the next attempt is refused until a
     *                  human authorizes it or the world moves.
     */
    const resolveAbandonedClaim = async (
      claim: { toolExecutionId: string; runId: string; strategy: string; scope: string; state: string; epoch: number; startedAt: number },
      currentState: string,
    ): Promise<AbandonedEffect> => {
      const canObserve = typeof this.strategy?.observeState === "function"
      let observed: string | undefined = currentState
      if (canObserve) {
        try {
          observed = await this.strategy!.observeState!({ strategy: claim.strategy, scope: claim.scope })
        } catch {
          observed = undefined // an observer that throws has told us nothing
        }
      }
      const effect: AbandonedEffect =
        observed === undefined ? "unknown" : observed !== claim.state ? "applied" : canObserve ? "not_applied" : "unknown"

      await ctx.emit(
        EventTypes.ToolStrategyClaimResolved,
        {
          toolExecutionId: claim.toolExecutionId,
          abandonedRunId: claim.runId,
          strategy: claim.strategy,
          scope: claim.scope,
          stateEpoch: claim.epoch,
          claimedStateHash: claim.state,
          ...(observed !== undefined ? { observedStateHash: observed } : {}),
          effect,
          verifier: canObserve ? "strategy_observe_state" : "classified_state_comparison",
          claimAgeMs: this.now() - claim.startedAt,
          detail:
            effect === "applied"
              ? "the state moved while the run was gone: the execution reached the world"
              : effect === "not_applied"
                ? "the strategy's own observer reports the state it started from: nothing landed"
                : "the effect could not be determined; a blind retry is refused until authorized or the world moves",
        },
        // Idempotent by execution identity: two runs racing to resolve the same
        // abandoned claim write one verdict, not two.
        `strategy_claim_resolved:${claim.toolExecutionId}`,
      )
      strategyInFlight.delete(claim.toolExecutionId)
      const entry = strategyEntry(claim.strategy, claim.scope)
      if (effect === "unknown") {
        entry.abandonedUnknown = { toolExecutionId: claim.toolExecutionId, state: claim.state, epoch: claim.epoch }
      } else if (effect === "applied" && observed !== undefined) {
        // The world moved by a hand that never reported. Adopt what is actually
        // there, so the next evaluation sees the transition it really is.
        strategyObserve(entry, observed)
      }
      return effect
    }
    if ((completion || this.strategy) && startTurn > 0) {
      // Resume-safe: rebuild epochs/verifications/generation/result-ledger for
      // THIS run from the log so a crash never re-runs tools, the verifier, or a
      // blocked identical call.
      // The STRATEGY ledger is deliberately absent here: it is not run-scoped
      // state, so it is rebuilt by `foldStrategyLog` from every run's events.
      const events = await this.store.read("session", ctx.sessionId)
      const startedInfo = new Map<string, { tool: string; argsHash: string }>()
      for (const e of events) {
        const d = e.data as { runId?: string; epoch?: number; tool?: string; argsHash?: string; toolExecutionId?: string; ok?: boolean; resultHash?: string; strategy?: string; scope?: string; semanticStateHash?: string; postSemanticStateHash?: string; mutation?: { mutationCommitted?: boolean } }
        if (d.runId !== ctx.runId) continue
        if (e.type === EventTypes.MutationEpochStarted) mutationEpoch = Math.max(mutationEpoch, Number(d.epoch ?? 0))
        if (e.type === EventTypes.VerificationPassed) {
          verifiedEpoch = Math.max(verifiedEpoch, Number(d.epoch ?? 0))
          lastVerification = "passed"
        }
        // Unavailable unblocked completion for its epoch but is never a pass.
        if (e.type === EventTypes.VerificationUnavailable) {
          verifiedEpoch = Math.max(verifiedEpoch, Number(d.epoch ?? 0))
          lastVerification = "unavailable"
        }
        // Epoch evolves during the ordered replay, so each read's fingerprint
        // lands in the epoch it actually happened in.
        if (e.type === EventTypes.ToolStarted && d.tool && d.argsHash) {
          fingerprints.add(`${d.tool}:${d.argsHash}:${mutationEpoch}`)
          if (d.toolExecutionId) startedInfo.set(d.toolExecutionId, { tool: d.tool, argsHash: d.argsHash })
        }
        if (e.type === EventTypes.ToolExecuted && d.toolExecutionId) {
          const s = startedInfo.get(d.toolExecutionId)
          const ph = progressHashOf(d.ok === true, d.resultHash)
          if (s && ph !== undefined) {
            const key = `${s.tool}:${s.argsHash}:${workspaceGeneration}`
            const prior = resultLedger.get(key)
            if (prior && prior.progressHash === ph) prior.count++
            else resultLedger.set(key, { progressHash: ph, count: 1, ok: d.ok === true })
          }
          // A committed mutation advances the generation AFTER its own record.
          if (d.mutation?.mutationCommitted === true) workspaceGeneration++
        }
      }
    }
    /** Run the objective verifier once for the current epoch. Returns a terminal
     *  RunResult when attempts are exhausted; otherwise the verification result
     *  (a failure is fed back to the model as new information). */
    const runVerification = async (opts?: {
      readonly charged?: boolean
      /**
       * Emitted just before the failure feedback, so the conversation reads
       * in the order it happened: the answer, then its rejection.
       *
       * FOUND BY REVIEW (2026-08-20). The rejected answer was appended AFTER
       * `runVerification` returned — that is, after the feedback message the
       * verification had already written — so the conversation ended with the
       * very answer the runtime had just refused, and the model read it as
       * the latest thing said. It is placed here rather than before the call
       * because the other exit from that block is Sprint 16's unbacked-claim
       * refusal, whose guarantee is that a completion claim nothing can prove
       * is never recorded as an answer.
       */
      readonly beforeFeedback?: () => Promise<void>
    }): Promise<CompletionVerification | RunResult> => {
      /**
       * Only a verification the MODEL provoked draws down the repair budget.
       *
       * FOUND BY AUDIT (2026-08-20). `maxVerificationAttempts` (3) is a bound on
       * repair cycles after a completion claim. The no-progress detector also
       * calls the verifier — to hand an unfinished run some information — and
       * that was charged to the same counter. Three read-loops and the run was
       * dead at turn 10 of 80 with 98% of its wall clock unspent, reported as
       * `verification_exhausted`: a phrase that says the model failed to repair
       * something, about a model that had never claimed to be done.
       *
       * A forced check is not a repair attempt. It cannot end the run either;
       * it is bounded by the turn budget, since each one costs three
       * no-progress turns and the checks themselves cost no tokens.
       */
      const charged = opts?.charged !== false
      // CL-01 (CL-00A bypass 4.1): the verifier is an execution path, so it now
      // states its decision in the contract too. The command is a constant in
      // code — no model input reaches it — which is exactly what the rule id and
      // reason code record. When verify commands become configurable this MUST
      // become a real PDP call, not an assertion.
      await ctx.emit(
        EventTypes.ControlDecided,
        {
          version: CONTROL_CONTRACT_VERSION,
          action: "allow",
          phase: "final",
          decisionId: `dec_verify_${ctx.runId}_${mutationEpoch}_${verifyAttempts}`,
          ruleId: "runtime.verification_constant_command",
          reasonCode: "runtime_verification_constant_command",
          capability: "code.execute",
          provenance: ["runtime_verification"],
          epoch: mutationEpoch,
        },
        // Idempotent per (run, epoch, attempt): a resumed run re-entering the
        // same verification attempt records it once, not twice.
        `dec_verify_${ctx.runId}_${mutationEpoch}_${verifyAttempts}`,
      )
      await ctx.emit(EventTypes.VerificationRequired, { epoch: mutationEpoch })
      // The state machine has a first-class `verifying` state: streaming (an
      // intercepted final) and executing_tool (the no-progress path) both may
      // enter it, and it exits to calling_model (feedback) or completed.
      await ctx.advance("verifying", EventTypes.VerificationStarted, { epoch: mutationEpoch, attempt: verifyAttempts + 1 })
      if (charged) verifyAttempts++
      let res: CompletionVerification
      try {
        res = await completion!.verify({ sessionId: ctx.sessionId, epoch: mutationEpoch })
      } catch (e) {
        res = { ok: false, detail: e instanceof Error ? e.message : String(e) }
      }
      if (res.ok && res.ran === false) {
        // No objective check applies. That is NOT a pass — it is recorded
        // honestly as unavailable. The run may still complete (a policy with no
        // applicable verifier must not brick the task), but nothing downstream
        // may treat this run as "verified".
        verifiedEpoch = mutationEpoch
        lastVerification = "unavailable"
        await ctx.emit(EventTypes.VerificationUnavailable, { epoch: mutationEpoch, detail: (res.detail ?? "").slice(0, 500) })
      } else if (res.ok) {
        verifiedEpoch = mutationEpoch
        lastVerification = "passed"
        await ctx.emit(EventTypes.VerificationPassed, { epoch: mutationEpoch })
      } else {
        // Sprint 15: a failed check is a TEST failure — the work is wrong, and
        // the agent is the one who can fix it. That is a repair, not a retry of
        // the same call and not a wall, and the log now says so.
        const verdict = classifyFailure({ message: res.detail ?? "verification failed" }, "verification")
        await ctx.emit(EventTypes.VerificationFailed, {
          epoch: mutationEpoch,
          detail: (res.detail ?? "").slice(0, 2000),
          failure: { class: verdict.failureClass, disposition: verdict.disposition, code: verdict.code },
        })
        if (charged && verifyAttempts >= (completion!.maxVerificationAttempts ?? 3)) {
          // Repair was tried and did not converge, so the disposition changes:
          // repeating it again is the loop this bound exists to stop.
          return await ctx.finish("failed", EventTypes.RunFailed, "verification_exhausted", {
            detail: (res.detail ?? "").slice(0, 500),
            failure: { class: "UNRECOVERABLE", disposition: "stop", code: "verification_exhausted" },
          })
        }
        // The objective failure IS new information — feed it back and continue.
        await opts?.beforeFeedback?.()
        await ctx.emit(EventTypes.MessageAppended, {
          role: "user",
          // The message has to fit what actually happened. It used to say "Fix
          // the problem, then finish. The runtime verifies for you — do not
          // re-read files to double-check", which is right after a change was
          // made and WRONG when nothing has been changed at all: there is no
          // problem to fix yet, and telling a model that still has to read the
          // file in order to edit it that re-reading is discouraged pushes it
          // toward the exact loop the failure came from.
          //
          // Measured: a live run received that text three times, read the same
          // file ten times, wrote nothing, and exhausted verification in
          // fifteen seconds.
          text:
            mutationEpoch === 0
              ? `The objective is NOT met and you have not changed anything yet:\n${(res.detail ?? "").slice(0, 2000)}\n` +
                `Stop inspecting and make the change. Use write_file to create a file, or edit_file to modify one. ` +
                `Reading more will not satisfy this — only an actual edit will.`
              : `Objective verification FAILED:\n${(res.detail ?? "").slice(0, 2000)}\n` +
                `Fix the problem, then finish. The runtime verifies for you — do not re-read files to double-check.`,
        })
        noProgressTurns = 0
      }
      return res
    }

    while (true) {
      turn++
      await ctx.advance("calling_model", EventTypes.RunCalling, { turn })
      if (ctx.aborted()) return await ctx.finish("cancelled", EventTypes.RunCancelled, "cancelled")
      if (this.now() - startedAt > this.budgets.wallClockMs) {
        return await this.stopUnfinished(ctx, "wall_clock_budget", "resume the run from the last checkpoint", "budget_exhausted", turn, {
          plan: budgetPlan,
          spent: toolCalls,
          bySpend: phaseSpend,
          turnsUsed: turn,
          wallClockMs: this.now() - startedAt,
        })
      }
      await heartbeat?.()

      // The model call, with SAFE mid-stream retry. This happens BEFORE any tool
      // executes this turn, so no side effect exists yet: a broken stream is
      // retried with a FRESH request id, which interrupts the partial response and
      // (via a newer model.request.started) rejects its late chunks. Never retries
      // cancel / timeout / auth / fatal, and is capped.
      let result: ModelTurn | undefined
      let requestId = ""
      let streamError: unknown
      for (let streamAttempt = 0; streamAttempt <= this.maxStreamRetries; streamAttempt++) {
        requestId = "req_" + crypto.randomUUID()
        await ctx.emit(EventTypes.ModelRequestStarted, {
          requestId,
          attempt: ctx.attempt,
          turn,
          streamAttempt,
          requestHash: hashArgs({ sessionId: ctx.sessionId, runId: ctx.runId, attempt: ctx.attempt, turn }),
        })

        let batchIndex = 0
        const active = requestId
        const writer: DeltaWriter = {
          write: async (text) => {
            if (ctx.finished || !(await this.isActiveRequest(ctx.sessionId, ctx.runId, active))) return false
            await ctx.emit(EventTypes.MessageDeltaBatch, { requestId: active, attempt: ctx.attempt, turn, index: batchIndex++, text })
            return true
          },
        }
        const sink = new BufferedDeltaSink(writer, this.deltaFlushBytes)

        try {
          result = await this.callModel(
            { sessionId: ctx.sessionId, runId: ctx.runId, turn, ...(finalizing ? { phase: "finalize" as const } : {}) },
            ctx.signal,
            sink,
          )
          await sink.flush()
          streamError = undefined
          break
        } catch (e) {
          await sink.flush().catch(() => {}) // persist accepted (interrupted) text
          if (this.isRetryableStreamError(e) && streamAttempt < this.maxStreamRetries && !ctx.aborted() && !ctx.finished) {
            streamError = e
            await new Promise((r) => setTimeout(r, Math.round(250 * 2 ** streamAttempt * (0.5 + Math.random() * 0.5))))
            continue
          }
          // Degraded close (STRICT): only in a finalization turn (work already
          // verified for the CURRENT epoch, no pending tools — a finalize turn
          // is pre-tool by construction) when the provider breaks and retries
          // are exhausted. Never on cancellation. Excluded from normal
          // completion by reason (`completed_degraded`).
          if (finalizing && completion && mutationEpoch === verifiedEpoch && !(e instanceof RunCancelledError) && !ctx.aborted() && !ctx.finished) {
            const msg = e instanceof Error ? e.message : String(e)
            return await ctx.finish("completed", EventTypes.RunCompleted, "completed_degraded", {
              degraded: true,
              error: msg.slice(0, 300),
              verification: lastVerification,
            })
          }
          throw e
        }
      }
      if (!result) throw streamError ?? new LateResponseError({ requestId })

      // Reject the response if this request is no longer the active one (a newer
      // attempt started) or the run already ended.
      if (ctx.finished || !(await this.isActiveRequest(ctx.sessionId, ctx.runId, requestId))) {
        throw new LateResponseError({ requestId })
      }
      await ctx.advance("streaming", EventTypes.RunStreaming, { turn })

      /**
       * The provider ran out of output room. That is not an answer.
       *
       * FOUND BY AUDIT (2026-08-20). The finish reason was assembled and never
       * read, so a sentence cut off mid-word reached this point as a final
       * answer: it was verified, it failed, and a repair attempt was spent on a
       * model that had not finished speaking. Meanwhile a turn cut off
       * mid-arguments handed a half-built tool call to the executor.
       *
       * Both are now the same fact with the same answer — say so in the log,
       * keep what did arrive, and ask for the rest. It costs one turn, and the
       * turn budget bounds it; the alternative costs a repair attempt and
       * blames the model for our ceiling.
       */
      if (result.truncated) {
        if (result.kind === "final" && result.text.length > 0) {
          await ctx.emit(EventTypes.MessageAppended, { role: "assistant", text: result.text })
        }
        await ctx.emit(EventTypes.RunTruncated, { turn, kind: result.kind, chars: result.kind === "final" ? result.text.length : 0 })
        await ctx.emit(EventTypes.MessageAppended, {
          role: "user",
          text:
            "Your previous message was cut off before it finished — the output limit was reached, not your turn. " +
            "Continue from exactly where it stopped. Do not repeat what you already sent, and prefer smaller steps " +
            "(one file edit per message) so the next one fits.",
        })
        await ctx.checkpoint("turn_completed", "call_model", turn)
        continue
      }

      if (result.kind === "final") {
        // Early-final interception: after mutations, a final answer is NOT
        // accepted until the objective verifier passes for the current epoch.
        // On pass the INTERCEPTED final is accepted as-is (no extra model call);
        // on failure the result is fed back and the loop continues.
        // FOUND BY A LIVE RUN (2026-08-19), and it is the exact failure this
        // whole programme exists to prevent: the condition used to be
        // `mutationEpoch > verifiedEpoch`, so a run that mutated NOTHING was
        // never verified. It read eight files, said "done", and the runtime
        // reported `completed` — while the acceptance criteria, checked
        // independently afterwards, said the file had never been created.
        //
        // A RUN CAN COMPLETE BY DOING NOTHING. That is a fake completion living
        // in the runtime, and no amount of verification machinery elsewhere
        // helps while the one path that reports success can skip it.
        //
        // So a final answer is now verified whenever a completion policy
        // exists, whether or not anything changed. A policy with nothing to
        // check answers `ran: false`, which the runtime already records as
        // "never objectively verified" rather than as a pass — so read-only
        // work is not punished, and work that claimed to be done has to prove
        // it.
        if (completion && !finalizing && (mutationEpoch > verifiedEpoch || !finalVerified)) {
          const v = await runVerification({
            // The rejected answer is recorded just before the feedback that
            // rejects it, so the conversation reads in the order it happened.
            beforeFeedback: async () => {
              await ctx.emit(EventTypes.MessageAppended, { role: "assistant", text: result.text })
            },
          })
          if ("runId" in v) return v // verification_exhausted terminal
          if (!v.ok) {
            /**
             * A REJECTED answer stays in the history.
             *
             * FOUND BY AUDIT (2026-08-20): the assistant message was appended
             * only on the way out, after verification passed — so an answer
             * that was rejected left no trace, and the next turn began with the
             * model unable to see what it had just proposed. It wrote the same
             * answer again, was rejected again, and the repair budget drained
             * on a loop the log made invisible.
             *
             * Appended HERE and not before the verification, because the other
             * exit from this block is Sprint 16's unbacked-claim refusal, whose
             * whole guarantee is that a completion claim nothing can prove is
             * never recorded as an answer. Both rules are right; they just
             * describe different moments.
             */
            await ctx.checkpoint("verification_failed", "call_model", turn)
            continue
          }
          finalVerified = true
        }
        // Sprint 16: no claim of completion over work that cannot be proved. An
        // execution that started and never reported means the world may have
        // moved with nothing to show for it — saying "done" there is the exact
        // unbacked claim this program exists to make impossible.
        const unbacked = unbackedClaims(await this.store.read("session", ctx.sessionId), ctx.runId, ctx.attempt)
        if (unbacked.length > 0) {
          await ctx.emit(EventTypes.RunClaimUnbacked, { claims: unbacked, at: "completion" })
          return await ctx.finish("failed", EventTypes.RunFailed, "provider_error", {
            error: `refusing to report completion: ${unbacked.map((c) => c.detail).join("; ")}`,
            failure: { class: "DATA", disposition: "repair", code: "unbacked_completion_claim" },
            claims: unbacked,
          })
        }
        await ctx.emit(EventTypes.MessageAppended, { role: "assistant", text: result.text })
        await ctx.checkpoint("model_completed", "finalize_turn", turn)
        return await ctx.finish("completed", EventTypes.RunCompleted, "completed", {
          text: result.text,
          // `unavailable` must be visible on the terminal event: consumers that
          // only look at status/reason must still be able to see this run was
          // never objectively verified.
          verification: lastVerification,
        })
      }

      // A finalization turn carries no tools; a model that still emits tool
      // calls cannot make progress — close degraded (work is already verified).
      if (finalizing && completion) {
        return await ctx.finish("completed", EventTypes.RunCompleted, "completed_degraded", {
          degraded: true,
          error: "model kept requesting tools during finalization",
          verification: lastVerification,
        })
      }

      await ctx.checkpoint("model_completed", "continue_after_tool_result", turn)
      await ctx.advance("executing_tool", EventTypes.RunExecutingTool, { turn })
      let toolFailed = false
      let turnProgress = false
      // Whether this turn CHANGED anything, as opposed to having merely learned
      // something. The proactive completion check below needs the difference.
      let turnProgressWasMutation = false
      for (const call of result.calls) {
        toolCalls++
        // The model may spend up to `spendable`; the rest is the reserve that
        // keeps a checkpoint, a rollback and a report reachable no matter how
        // the work went.
        if (toolCalls > budgetPlan.spendable) {
          return await this.stopUnfinished(
            ctx,
            "tool_budget",
            `resume the run and re-issue ${call.name}`,
            "budget_exhausted",
            turn,
            { plan: budgetPlan, spent: toolCalls - 1, bySpend: phaseSpend, turnsUsed: turn, wallClockMs: this.now() - startedAt },
            // The refused call, so the next run re-issues THIS step rather than
            // guessing which one the budget cut off.
            { tool: call.name, input: call.input },
          )
        }
        const callPhase = phaseOfToolCall(undefined, call.name)
        phaseSpend = addPhaseSpend(phaseSpend, callPhase)
        // The allocations are a plan, not a cap — stopping useful work because a
        // phase ran long would trade a real result for a tidy number. But an
        // overrun nobody records is a plan nobody can improve, so it is written
        // down once per phase, the first time it happens.
        if (phaseSpend[callPhase] > budgetPlan.phases[callPhase] && !overrunReported.has(callPhase)) {
          overrunReported.add(callPhase)
          await ctx.emit(EventTypes.RunBudgetPhaseOverrun, {
            phase: callPhase,
            allocated: budgetPlan.phases[callPhase],
            spent: phaseSpend[callPhase],
            turn,
          })
        }
        if (ctx.aborted()) return await ctx.finish("cancelled", EventTypes.RunCancelled, "cancelled")

        const argsHash = hashArgs(call.input)
        // Keyed on workspaceGeneration (NOT epoch): a real edit between two
        // identical commands bumps the generation and re-allows them, even though
        // many edits share one mutation epoch.
        const ledgerKey = `${call.name}:${argsHash}:${workspaceGeneration}`

        // Repeated-identical-CALL block: a call that already produced the IDENTICAL
        // result TWICE at the current workspace generation is refused WITHOUT
        // spawning a process — whether it FAILED (the `npx jest` ×6 loop) or
        // SUCCEEDED with no real change (the `rm -rf && npm install` ×8 thrash).
        // Re-running it adds zero information. The model gets a structured error
        // telling it to change approach or finish; a blocked repeat is NO
        // progress, so persistence drives forced finalization (then the objective
        // verifier decides) — never a hard tool_failed spiral. It is NOT a tool
        // execution (no tool.started/tool.executed, no process). A real edit (new
        // generation), a different failure result, or different args re-allow it.
        const prior = completion ? resultLedger.get(ledgerKey) : undefined
        // Two chances for a failure (it may be transient) or a noisy success,
        // but ONE for a write that provably changed nothing: the file already
        // holds those exact bytes, and no repeat can make that more true.
        const repeatLimit = prior?.progressHash === "no_change" ? 1 : 2
        if (prior && prior.count >= repeatLimit) {
          const blockedId = "tex_" + crypto.randomUUID()
          const what =
            prior.progressHash === "no_change"
              ? "wrote content the file already contained, changing nothing"
              : prior.ok
                ? "succeeded with no change to the project state"
                : "failed with the identical result"
          await ctx.emit(EventTypes.ToolRepeatedCallBlocked, {
            toolExecutionId: blockedId,
            tool: call.name,
            args: call.input,
            argsHash,
            progressHash: prior.progressHash,
            generation: workspaceGeneration,
            epoch: mutationEpoch,
            priorCount: prior.count,
            priorOutcome: prior.ok ? "succeeded" : "failed",
            ...(call.id ? { providerToolCallId: call.id } : {}),
            error: {
              code: "repeated_identical_tool_result",
              message: `This exact ${call.name} call already ${what} ${prior.count} times, and nothing has changed in the project since. Re-running it unchanged produces the same result and adds no information. Do something DIFFERENT — change the input, edit a file, take a different step, or finish and clearly state any limitation (e.g. the verifier is unavailable). It will be allowed again after a real change (a file edit) or if the result differs.`,
            },
          })
          await ctx.checkpoint("tool_completed", "continue_after_tool_result", turn)
          await heartbeat?.()
          continue // no spawn, no progress
        }

        // ---- Semantic Strategy Guard (independent layer) ----
        // Classified BEFORE execution so the hash reflects the state right now
        // (an edit to package.json one turn ago is already visible). A policy
        // throw is never fatal: an unclassifiable call is simply not guarded.
        let classified: ExpensiveStrategy | undefined
        if (this.strategy) {
          try {
            classified = await this.strategy.classify({ tool: call.name, args: call.input })
          } catch {
            classified = undefined
          }
        }
        // The epoch this attempt is EVALUATED in. Its outcome must be recorded
        // there, not wherever the ledger has moved to by the time it finishes.
        let strategyEpoch = 0
        if (classified) {
          const scope = classified.scope ?? ""
          // Read the log FIRST: another run may have executed — or may right now
          // be executing — this very strategy since the last decision. The
          // ledger is refreshed from the events, then asked.
          await foldStrategyLog()
          const ledgerEntry = strategyEntry(classified.strategy, scope)
          let claim = foreignStrategyClaim(classified.strategy, scope)
          // A claim only blocks while its owner is ALIVE. One whose run is dead
          // or long stale is abandoned, and an abandoned claim is resolved here
          // and now — classified, logged, released — rather than left to hold the
          // strategy for ever. What it leaves behind is a verdict, not a lock.
          if (claim && (await claimIsAbandoned(claim))) {
            await resolveAbandonedClaim(claim, classified.semanticStateHash)
            claim = foreignStrategyClaim(classified.strategy, scope)
          }
          const verdict = strategyEvaluate(ledgerEntry, classified.semanticStateHash)
          strategyEpoch = verdict.epoch
          // A live claim outranks every other verdict: the other executor has
          // not finished, so nothing that could re-allow this attempt is known
          // yet, and running beside it changes one world twice.
          const reason = claim ? "concurrent_execution_in_flight" : verdict.reason
          if (reason) {
            const at = ledgerEntry.states.get(strategyStateKey(strategyEpoch, classified.semanticStateHash)) ?? { successes: 0, failures: 0 }
            const entry = { successes: at.successes, failures: at.failures }
            // Explicit human authorization can let a refused strategy run once
            // ("reinstall anyway — node_modules is corrupted"). It is opt-in,
            // one-shot by contract, and ALWAYS logged, so a bypass is auditable.
            // It is NOT offered against a live claim: no authorization makes two
            // simultaneous installs of one thing safe, and the other execution
            // has not reported yet, so there is nothing to authorize past.
            let override: { granted: boolean; reason?: string } = { granted: false }
            if (!claim && this.strategy?.authorizeRetry) {
              try {
                override = await this.strategy.authorizeRetry({
                  sessionId: ctx.sessionId,
                  runId: ctx.runId,
                  strategy: classified.strategy,
                  scope,
                  semanticStateHash: classified.semanticStateHash,
                  reason,
                  successes: entry.successes,
                  failures: entry.failures,
                })
              } catch {
                override = { granted: false } // a failing authorizer denies
              }
            }
            if (override.granted) {
              await ctx.emit(EventTypes.ToolStrategyOverrideGranted, {
                tool: call.name,
                strategy: classified.strategy,
                scope,
                semanticStateHash: classified.semanticStateHash,
                blockedReason: reason,
                successes: entry.successes,
                failures: entry.failures,
                ...(override.reason ? { authorization: override.reason } : {}),
              })
            }
            if (!override.granted) {
              const blockedId = "tex_" + crypto.randomUUID()
              const where = scope === "" ? "" : ` in ${scope}`
              const what =
                reason === "already_succeeded"
                  ? `already completed successfully ${entry.successes}× and the state it depends on has not changed since`
                  : reason === "repeated_failure"
                    ? `already failed ${entry.failures}× with the state it depends on unchanged`
                    : reason === "concurrent_execution_in_flight"
                      ? `is ALREADY RUNNING right now in another run of this session`
                      : reason === "abandoned_execution_unknown_effect"
                        ? `was started by a run that died before reporting, and whether it changed anything could not be determined`
                        : `already ran successfully, and the only change since is the one that run made itself (e.g. it regenerated its own lockfile)`
              const advice =
                reason === "concurrent_execution_in_flight"
                  ? `Two of these against the same target would fight over the same files. Wait for it and use its result, or do something else in the meantime.`
                  : reason === "abandoned_execution_unknown_effect"
                    ? `It may have half-finished, so repeating it blindly is not safe. Check the state yourself first (list the directory, read the lockfile), or ask for explicit authorization to run it anyway.`
                    : `Repeating it cannot change the outcome — edits to unrelated files (tsconfig, test config, source) do not affect it. Use the project's existing commands, or report the limitation clearly (e.g. the verifier is unavailable). It will be allowed again once the state this strategy depends on actually changes.`
              await ctx.emit(EventTypes.ToolRedundantStrategyBlocked, {
                toolExecutionId: blockedId,
                tool: call.name,
                args: call.input,
                argsHash,
                strategy: classified.strategy,
                scope,
                semanticStateHash: classified.semanticStateHash,
                // The epoch the refusal belongs to: repetition is only ever
                // judged within one, so the log has to say which.
                stateEpoch: strategyEpoch,
                reason,
                successes: entry.successes,
                failures: entry.failures,
                generation: workspaceGeneration,
                epoch: mutationEpoch,
                ...(call.id ? { providerToolCallId: call.id } : {}),
                error: {
                  code: "redundant_expensive_strategy",
                  strategy: classified.strategy,
                  scope,
                  message: [`This is the "${classified.strategy}" strategy${where}, which ${what}.`, classified.guidance ?? "", advice]
                    .filter((s) => s.length > 0)
                    .join(" "),
                },
              })
              await ctx.checkpoint("tool_completed", "continue_after_tool_result", turn)
              await heartbeat?.()
              continue // no spawn, no side effect, no progress
            }
          }
        }

        // Sprint 17: a keyed operation executes AT MOST ONCE. The key was
        // recorded on the events since the first slice and never consulted
        // before dispatch, so "guards double-execution on retry" was a comment,
        // not a behaviour. A completed prior execution is REPLAYED — the model
        // sees the same result it would have seen, and the world is not touched
        // twice. An in-flight one is neither replayed nor re-run: that is the
        // crash case, and only a verifier can say whether it landed.
        if (call.idempotencyKey) {
          const verdict = checkIdempotency(await this.store.read("session", ctx.sessionId), call.idempotencyKey)
          if (verdict.decision === "replay" || verdict.decision === "verify_first") {
            const replayId = "tex_" + crypto.randomUUID()
            await ctx.emit(EventTypes.ToolIdempotentReplay, {
              toolExecutionId: replayId,
              tool: call.name,
              idempotencyKey: call.idempotencyKey,
              originalOperationId: verdict.entry.operationId,
              decision: verdict.decision,
              turn,
            })
            // The pair is still written, so the model sees a result and the
            // receipt is complete — but both carry `replayOf`, so nobody can
            // mistake this for a second execution of the operation.
            await ctx.emit(EventTypes.ToolStarted, {
              toolExecutionId: replayId,
              tool: call.name,
              args: call.input,
              argsHash,
              idempotencyKey: call.idempotencyKey,
              replayOf: verdict.entry.operationId,
            })
            const replayed =
              verdict.decision === "replay"
                ? { ok: true, output: verdict.entry.output }
                : {
                    ok: false,
                    error:
                      `operation ${call.idempotencyKey} was started by ${verdict.entry.operationId} and never reported; ` +
                      "its effect must be verified before it is attempted again",
                    failure: { class: "DATA", disposition: "repair", code: "idempotent_operation_unverified" },
                  }
            await ctx.emit(EventTypes.ToolExecuted, {
              toolExecutionId: replayId,
              tool: call.name,
              idempotencyKey: call.idempotencyKey,
              replayOf: verdict.entry.operationId,
              ...replayed,
            })
            // A replay produces no new information about the world, so it must
            // not reset the no-progress counter: a model looping on the same
            // keyed call would otherwise never reach finalization.
            await heartbeat?.()
            continue
          }
        }

        // The constraints this execution will run under, previewed from the same
        // deterministic decision the enforcement point will reach. Recorded on
        // tool.started (kinds + env key NAMES, never values) so a crash between
        // start and completion still shows what the execution began under — the
        // durable decision alone proves what was decided, not that the overlay
        // bound this attempt.
        let enforcedConstraints: readonly { kind: string; envKeys?: readonly string[] }[] = []
        try {
          enforcedConstraints = this.tools.describeEnforcement?.(call) ?? []
        } catch {
          enforcedConstraints = []
        }
        // tool.started BEFORE running; a start with no executed = died mid-tool.
        const toolExecutionId = "tex_" + crypto.randomUUID()
        await ctx.emit(EventTypes.ToolStarted, {
          toolExecutionId,
          tool: call.name,
          args: call.input,
          argsHash,
          ...(enforcedConstraints.length > 0 ? { constraints: enforcedConstraints } : {}),
          // Persisted so a resumed run rebuilds the strategy ledger from the log
          // instead of re-hashing today's files against yesterday's attempts.
          ...(classified
            ? {
                strategy: classified.strategy,
                scope: classified.scope ?? "",
                semanticStateHash: classified.semanticStateHash,
                stateEpoch: strategyEpoch,
              }
            : {}),
          ...(call.id ? { providerToolCallId: call.id } : {}),
          ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
        })
        await ctx.checkpoint("tool_pending", "verify_tool", turn, { pendingToolExecutionId: toolExecutionId })

        const outcome = await this.tools.run(call, {
          signal: ctx.signal,
          executionId: toolExecutionId,
          mode: runMode,
          // Sprint 26: the file count comes from the run's OWN progress (S12),
          // not from anything the model said — the fast path is measured.
          plan: {
            ...(planId !== undefined ? { approvedPlanId: planId } : {}),
            filesChangedSoFar: ctx.progress.filesChanged.length,
          },
          // CL-01: every decision — allow, ask AND deny — is durably recorded
          // BEFORE the tool can do anything. Storing it only on tool.executed
          // loses it whenever the process dies mid-tool, which is exactly when
          // knowing what was authorised matters most.
          // CL-16A2-B: the isolation proof. The launcher AWAITS this before it
          // spawns, so the record lands before the effect — the same rule as
          // `onDecision` and `onRollbackStart`. If the append throws, the
          // launcher refuses and nothing runs.
          onIsolation: async (event) => {
            await ctx.emit(event.type, { ...event, toolExecutionId, tool: call.name })
          },
          onDecision: async (record) => {
            // Idempotent by decisionId (execution identity + phase): a retry or
            // a resume that replays this decision appends it exactly once.
            await ctx.emit(
              EventTypes.ControlDecided,
              { ...record, toolExecutionId, tool: call.name, provenance: ["model_tool_call"] },
              record.decisionId,
            )
          },
          // A rollback is durably logged BEFORE it touches the disk. The receipt
          // carries hashes and a backup path, never file content.
          onRollbackStart: async (receipt) => {
            await ctx.emit(EventTypes.ToolRollbackStarted, {
              toolExecutionId,
              tool: call.name,
              path: receipt.path,
              beforeHash: receipt.beforeHash,
              receipt,
            })
          },
        })
        // resultHash identifies the RESULT (not the call): a failure with the
        // same hash as its prior attempt is a no-information repeat — whether it
        // failed OR succeeded (a thrash). Prefer the tool's own stable fingerprint
        // (shell excludes duration; present on success AND failure); for a failure
        // without one, fall back to hashing the structured error. A success
        // WITHOUT a fingerprint (edit/write/read) has no resultHash: those are
        // governed by mutation epochs and the read fingerprint set, not this
        // ledger — so a real file mutation is never mistaken for a thrash.
        const resultHash = outcome.resultFingerprint ?? (outcome.ok ? undefined : hashArgs({ tool: call.name, error: outcome.error }))
        // The state this run LEAVES BEHIND, read straight after it finished. It
        // is persisted on the event so a resumed run replays it instead of
        // re-hashing today's files, and so a self-inflicted change (a
        // regenerated lockfile) can never be mistaken for real new information.
        let postStateHash: string | undefined
        if (classified && outcome.ok && this.strategy?.observeState) {
          try {
            postStateHash = await this.strategy.observeState({ strategy: classified.strategy, scope: classified.scope ?? "" })
          } catch {
            postStateHash = undefined // unobservable state simply is not recorded
          }
        }
        await ctx.emit(EventTypes.ToolExecuted, {
          ...(postStateHash ? { postSemanticStateHash: postStateHash } : {}),
          toolExecutionId,
          tool: call.name,
          ok: outcome.ok,
          ...(outcome.redactions ? { redactions: outcome.redactions } : {}),
          ...(outcome.ok
            ? { output: outcome.output }
            : {
                error: outcome.error,
                ...(outcome.output !== undefined ? { output: outcome.output } : {}),
                // Sprint 15: a failed tool says what KIND of failure it was and
                // what may be done. `tool` phase, so an unrecognised error is
                // never classified as retryable — the call may already have
                // changed the world before it failed.
                failure: (() => {
                  // The denial discriminator travels INTO the classifier. It
                  // exists so nobody sniffs error strings, and stripping it
                  // here made the classifier do exactly that — then miss.
                  const v = classifyFailure(
                    { message: outcome.error, ...(outcome.denied === true ? { denied: true } : {}) },
                    "tool",
                  )
                  return { class: v.failureClass, disposition: v.disposition, code: v.code }
                })(),
              }),
          ...(resultHash ? { resultHash } : {}),
          // Advisory rides on the tool's OWN result (e.g. "this project uses
          // bun") — one tool result per call, never a second synthetic one.
          ...(classified?.advisory ? { advisory: classified.advisory, strategy: classified.strategy } : {}),
          // The mutation receipt is part of the durable record: crash recovery
          // and audits can verify hashes before ever considering compensation.
          ...(outcome.mutation ? { mutation: outcome.mutation } : {}),
          // CL-01: the decision travels with the execution — rule, reason code
          // and decision hash, so the log alone explains why this ran.
          ...(outcome.control ? { control: outcome.control } : {}),
          ...(call.id ? { providerToolCallId: call.id } : {}),
          ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
        })
        // Live result ledger (mirrors the resume rebuild): an outcome with a
        // progress-hash whose value equals its prior attempt at this
        // (tool,args,generation) => ++count; a different value resets to 1. A
        // SUCCESS compares coarsely ("ok", stdout ignored — non-deterministic);
        // a FAILURE compares its precise resultHash (a changed error is new info).
        // Outcomes without a resultHash don't participate.
        // The STRATEGY ledger is NOT updated here. Both events this execution
        // wrote — the started that claimed the epoch and the executed that
        // reports its outcome and post-state — are already durable, and the next
        // decision folds them from the log. One writer, one order, no second
        // copy of the rules to drift.
        /**
         * A committed mutation that wrote the bytes it found changed NOTHING.
         *
         * FOUND BY A LIVE RUN (2026-08-20): a 9B rewrote the whole of server.js
         * FOUR times with byte-identical content — same 21,783 bytes, same
         * argsHash — and nothing stopped it. Each rewrite is ~5,400 generated
         * tokens, about 110 seconds on this hardware, so the four ate seven
         * minutes of a twenty-minute budget and the run was cancelled on the
         * wall clock with its objective already met.
         *
         * The guard could not see it by construction. `write_file` returns no
         * result fingerprint, so its outcomes never entered the ledger at all —
         * the comment above says so and gives the reason: "a real file mutation
         * is never mistaken for a thrash". That reasoning is right about a
         * DIFFERENT write and wrong about an IDENTICAL one, and the receipt has
         * always carried the evidence: `afterHash === beforeHash`.
         *
         * Worse, such a write BUMPED the workspace generation — the signal that
         * re-allows previously blocked calls. An agent in a loop could free
         * itself by writing a file with content it already had.
         */
        const noChangeMutation =
          outcome.mutation?.mutationCommitted === true &&
          typeof outcome.mutation.beforeHash === "string" &&
          outcome.mutation.afterHash === outcome.mutation.beforeHash

        const progressHash = noChangeMutation ? "no_change" : progressHashOf(outcome.ok, resultHash)
        let identicalRepeat = false
        if (completion && progressHash !== undefined) {
          const existing = resultLedger.get(ledgerKey)
          if (existing && existing.progressHash === progressHash) {
            existing.count++
            identicalRepeat = true
          } else {
            resultLedger.set(ledgerKey, { progressHash, count: 1, ok: outcome.ok })
          }
        }
        // A committed file mutation advances the workspace generation — the
        // "project state really changed" signal that re-allows previously-blocked
        // identical commands (a new key). Placed AFTER this call's own ledger
        // record so the record lands at the generation it actually ran in.
        if (completion && outcome.mutation?.mutationCommitted === true && !noChangeMutation) workspaceGeneration++
        if (!outcome.ok && outcome.rollback) {
          await ctx.emit(
            outcome.rollback.status === "completed" ? EventTypes.ToolRollbackCompleted : EventTypes.ToolRollbackFailed,
            {
              toolExecutionId,
              tool: call.name,
              path: outcome.rollback.receipt.path,
              beforeHash: outcome.rollback.receipt.beforeHash,
              restoredHash: outcome.rollback.status === "completed" ? outcome.rollback.receipt.beforeHash : undefined,
              reason: outcome.rollback.reason,
              ...(outcome.rollback.error ? { error: outcome.rollback.error } : {}),
            },
          )
        }
        await ctx.checkpoint("tool_completed", "continue_after_tool_result", turn)
        if (completion) {
          if (completion.isMutating(call.name, call.input)) {
            // A new epoch opens on the first mutation after a clean/verified
            // state OR after a failed verification (the fix invalidates the
            // failed attempt and resets the attempt budget). Mutations before
            // any verification share the current epoch — N edits, ONE check.
            // So `verification_exhausted` only hits a model that re-finalizes
            // WITHOUT new mutations.
            if (mutationEpoch === verifiedEpoch || verifyAttempts > 0) {
              mutationEpoch++
              verifyAttempts = 0
              finalVerified = false
              await ctx.emit(EventTypes.MutationEpochStarted, { epoch: mutationEpoch })
            }
            // A mutating call that produced the IDENTICAL result as a prior
            // attempt (a succeeding thrash like `rm -rf && npm install` ×N) is
            // NOT progress — otherwise an interleaved thrash keeps resetting the
            // no-progress counter and never reaches finalization.
            turnProgress = !identicalRepeat
            if (!identicalRepeat) turnProgressWasMutation = true
          } else {
            // A read adds information only once per (tool,args,epoch). After a
            // mutation the epoch changes, so re-reading is progress again —
            // within an epoch only reads ran, so identical args imply identical
            // content (the fingerprint subsumes a content hash).
            const fp = `${call.name}:${hashArgs(call.input)}:${mutationEpoch}`
            if (!fingerprints.has(fp)) {
              fingerprints.add(fp)
              turnProgress = true
            }
          }
        }
        if (!outcome.ok) {
          // A tool error is NOT a run failure: it's fed back to the model (as a
          // tool result on the next turn) so the model can correct or give up.
          //
          // A POLICY DENIAL is not even that. Found by the first live run: four
          // consecutive denials tripped the tool-FAILURE budget and killed the
          // run, so the agent died rather than choosing another way to do the
          // work. "You may not" is information to adapt to; "it broke" is
          // something that went wrong. Counting them together makes every gate
          // a run-killer, which is the strongest possible pressure to turn the
          // gates off.
          //
          // Denials still have a ceiling -- a model that keeps asking for the
          // same forbidden thing is not adapting either -- but it is its own
          // ceiling, and the terminal reason SAYS `policy_denied` so nobody
          // reading the log concludes a tool was broken.
          toolFailed = true
          if (outcome.denied === true) {
            consecutiveDenials++
            if (consecutiveDenials > this.budgets.maxConsecutiveDenials) {
              return await ctx.finish("failed", EventTypes.RunFailed, "policy_denied", {
                tool: call.name,
                error: outcome.error,
                consecutiveDenials,
              })
            }
          } else {
            consecutiveToolFailures++
            if (consecutiveToolFailures > this.budgets.maxConsecutiveToolFailures) {
              return await ctx.finish("failed", EventTypes.RunFailed, "tool_failed", { tool: call.name, error: outcome.error })
            }
          }
        } else {
          consecutiveToolFailures = 0
          consecutiveDenials = 0
        }
        await heartbeat?.()
      }
      if (!toolFailed) consecutiveToolFailures = 0

      // EXPLORATION BUDGET. Found by a live run: 91 tool calls, 84 of them
      // reads, 80 turns, and not one byte written. The no-progress guard below
      // could not see it, because it detects a REPEATED call and every read was
      // of a different file — so "I looked at something new" counted as
      // progress for eighty turns.
      //
      // Looking is not working. A turn that called tools and mutated nothing is
      // exploration, and exploration has a budget like everything else here.
      // The first threshold TELLS the model what it has done, because an agent
      // that does not know it is looping cannot stop looping. The second stops
      // the run with a reason that names the behaviour rather than blaming the
      // turn budget it happened to hit.
      /**
       * WHEN THE OBJECTIVE IS MET, SAY SO. Do not wait to be asked.
       *
       * FOUND BY THE ONE-HOUR ENDURANCE RUN (2026-08-20), and it is the single
       * biggest cost in it. Cycle 4 finished its task on TURN 2 and then spent
       * twenty-six more turns reading and rewriting; the same task took 34
       * seconds in another cycle and 901 here, and the run was cancelled on the
       * wall clock with its criteria long since satisfied. Cycle 6 did the same
       * on the larger task, at a median of 2.18 MILLION input tokens.
       *
       * The runtime knew. Verification is mechanical and costs nothing, and it
       * passed from turn 2 onward — but it only ran when the model volunteered
       * a final answer or after three no-progress turns, and neither happened:
       * the model interleaved reads with edits, so the exploration counter
       * reset on every edit and the no-progress counter reset on every read of
       * a new file. Both guards were disarmed by the same alternation.
       *
       * So the check is made once the work of an epoch has landed and the model
       * spends a turn NOT changing anything. Bounded to ONCE PER EPOCH, so its
       * cost is one verification per real change, not one per turn — and an
       * epoch only advances on a committed mutation.
       */
      if (completion && !finalizing && result.calls.length > 0 && !turnProgressWasMutation && mutationEpoch > verifiedEpoch && mutationEpoch !== proactiveEpoch) {
        proactiveEpoch = mutationEpoch
        const v = await runVerification({ charged: false })
        if ("runId" in v) return v
        if (v.ok) {
          finalizing = true
          await ctx.emit(EventTypes.FinalizationRequested, { epoch: mutationEpoch, reason: "objective_met" })
          await ctx.emit(EventTypes.MessageAppended, {
            role: "user",
            text:
              "The objective has been verified as MET by the runtime — every acceptance criterion passes against the " +
              "current state of the project. Stop working and give your final answer now: what you changed, and any " +
              "limitation worth stating. Do not read or edit anything further.",
          })
          await ctx.checkpoint("turn_completed", "call_model", turn)
          continue
        }
      }

      if (result.calls.length > 0) {
        // A turn counts as EXPLORATION only when every call in it is a tool we
        // positively recognise as looking. The first version asked
        // `completion.isMutating` instead and treated "not known to mutate" as
        // "did not mutate" — which broke the 1,000-step gate, whose custom
        // `do_step` tool the completion policy has never heard of. That is the
        // same mistake this codebase keeps refusing elsewhere: "I do not know
        // what this is" is not "this is harmless". An unrecognised tool is
        // never counted against the agent.
        const exploringThisTurn = result.calls.length > 0 && result.calls.every((c) => READ_TOOLS.test(c.name))
        if (!exploringThisTurn) {
          readOnlyTurns = 0
          explorationWarned = false
        } else {
          readOnlyTurns++
          const limit = this.budgets.maxReadOnlyTurns
          if (readOnlyTurns >= limit && !explorationWarned) {
            explorationWarned = true
            await ctx.emit(EventTypes.MessageAppended, {
              role: "user",
              text:
                `You have taken ${readOnlyTurns} turns of reading and inspection and have not changed anything yet. ` +
                `Make the smallest concrete change that moves the task forward now — write or edit one file — ` +
                `or say plainly that you cannot and why. More reading will not be treated as progress.`,
            })
          }
          // The hard stop is at THREE times the warning, not two. A run can be
          // legitimately read-only — "what does this project do?" is answered
          // by reading — and an existing budget test that spends its whole tool
          // allowance on reads caught the first version cutting honest work
          // short. The guard exists for an eighty-turn loop, not for a
          // twenty-turn investigation.
          /**
           * ...and it has to be REACHABLE in the configuration that ships.
           *
           * FOUND BY REVIEW (2026-08-20): the defaults are `maxTurns: 16` and
           * `maxReadOnlyTurns: 8`, so a hard stop at 3x could never fire — the
           * turn budget always ended the run first, under the generic reason
           * `turn_budget`. A guard that cannot be reached in its own default
           * configuration is a comment describing behaviour that does not
           * exist, which this codebase treats as a defect in its own right.
           *
           * So the stop is also bounded by the turn budget it lives inside: a
           * run that has spent three quarters of its turns looking has answered
           * the question, and it says so by NAME rather than by whichever
           * ceiling it happened to touch. With the stage-A budgets (80 turns)
           * the 3x rule still governs, exactly as before.
           */
          const hardStop = Math.min(limit * 3, Math.max(limit + 1, Math.ceil(this.budgets.maxTurns * 0.75)))
          if (readOnlyTurns >= hardStop) {
            return await this.stopUnfinished(
              ctx,
              "exploration_exhausted",
              "the run inspected without changing anything; give it a narrower objective or a smaller first step",
              "budget_exhausted",
              turn,
              {
                plan: budgetPlan,
                spent: toolCalls,
                bySpend: phaseSpend,
                turnsUsed: turn,
                wallClockMs: this.now() - startedAt,
              },
            )
          }
        }
      }

      // No-progress detection: a turn whose tools produced NO new information
      // (no mutation, no unseen read, no tool error being worked) moves the run
      // toward forced finalization instead of burning the turn budget.
      if (completion && result.calls.length > 0) {
        if (turnProgress || toolFailed) noProgressTurns = 0
        else {
          noProgressTurns++
          await ctx.emit(EventTypes.NoProgressDetected, { count: noProgressTurns, epoch: mutationEpoch })
          if (noProgressTurns >= (completion.maxNoProgressTurns ?? 3)) {
            // THE SAME HOLE, IN A SECOND PLACE. The condition was
            // `mutationEpoch > verifiedEpoch`, so a run that changed nothing
            // skipped verification here too — and then set `finalizing`, which
            // the acceptance site trusts to mean "already verified". A run that
            // the runtime had just detected as going nowhere was handed a
            // straight path to reporting success.
            //
            // Fixing one site and not the other is how a defect survives its
            // own fix, so the rule is identical in both: verify before a final
            // claim, whether or not anything moved.
            if (mutationEpoch > verifiedEpoch || !finalVerified) {
              const v = await runVerification({ charged: false })
              if ("runId" in v) return v // verification_exhausted terminal
              if (!v.ok) {
                // the objective is unmet: the feedback IS progress, and this
                // run has not earned finalization
                noProgressTurns = 0
                continue
              }
              finalVerified = true
            }
            if (mutationEpoch === verifiedEpoch) {
              finalizing = true
              await ctx.emit(EventTypes.FinalizationRequested, { epoch: mutationEpoch, noProgressTurns })
            }
          }
        }
      }

      await ctx.checkpoint("turn_completed", "call_model", turn)
      if (turn >= this.budgets.maxTurns) {
        return await this.stopUnfinished(ctx, "turn_budget", "resume the run from the last checkpoint", "budget_exhausted", turn, {
          plan: budgetPlan,
          spent: toolCalls,
          bySpend: phaseSpend,
          turnsUsed: turn,
          wallClockMs: this.now() - startedAt,
        })
      }
    }
  }

  /**
   * Stop without finishing — the only way a run may run out.
   *
   * Order matters and is the whole sprint: checkpoint first (so the resume
   * point is durable), then the report (so it describes a state that is
   * already saved), then the terminal event. A run that paused before writing
   * these left the next session to reconstruct it from prose.
   */
  private async stopUnfinished(
    ctx: RunContext,
    reason: RunStopReason,
    nextAction: string,
    phase: string,
    turn: number,
    detail: { plan: StepBudgetPlan; spent: number; bySpend: PhaseSpend; turnsUsed: number; wallClockMs: number },
    pending?: { tool: string; input?: unknown },
  ): Promise<RunResult> {
    await ctx.checkpoint(phase, "call_model", turn)
    const progress = ctx.progress
    const report: RunReport = {
      runId: ctx.runId,
      reason,
      ...(ctx.objective !== undefined ? { objective: ctx.objective } : {}),
      filesChanged: progress.filesChanged,
      commandsCompleted: progress.commandsCompleted.map((c) => `${c.tool}${c.ok ? "" : " (failed)"}`),
      tests: progress.tests.map((t) => t.verdict),
      ...(progress.blocker !== undefined ? { blocker: `${progress.blocker.kind}: ${progress.blocker.detail}` } : {}),
      nextAction,
      ...(pending !== undefined ? { pending } : {}),
      budget: detail,
      at: this.now(),
    }
    await ctx.emit(EventTypes.RunReported, { report })
    return await ctx.finish("paused", EventTypes.RunPaused, reason, { nextAction, report })
  }

  private async finishFromError(ctx: RunContext, error: unknown): Promise<RunResult> {
    if (error instanceof RunCancelledError || ctx.aborted()) {
      return await ctx.finish("cancelled", EventTypes.RunCancelled, "cancelled")
    }
    if (error instanceof LateResponseError) {
      // Superseded by a newer attempt — drop this invocation without failing the run.
      return await ctx.finish("cancelled", EventTypes.RunCancelled, "cancelled", { superseded: true })
    }
    // Only NON-retryable timeouts reach here (total budget, or watchdog retries exhausted).
    void (error instanceof ProviderTimeoutError)
    // Only a real message counts. `String(error)` on an object whose facts live
    // in fields is the literal text "[object Object]" — non-empty, so an
    // emptiness check passes it straight through, and the reader gets a string
    // that says nothing where the number was. The same trap, caught twice in
    // the classifier and once more here.
    const raw = (error as { message?: unknown } | null)?.message
    const message = typeof raw === "string" && raw !== "" ? raw : typeof error === "string" ? error : ""
    // Sprint 15: a failed run says WHAT kind of failure and what may be done —
    // `provider_error` with a message told a reader nothing they could act on.
    const failure = classifyFailure(error, "model")
    // FOUND TWICE IN ONE DAY, the second time by a live 64k run. A tagged error
    // whose facts live in FIELDS has an empty `.message`, so the terminal event
    // read `"error": ""` beside `model_timeout_total` — the class of the fault
    // and not one number a reader could act on. `classifyFailure` had already
    // composed that sentence; the event dropped it on the way out, which is the
    // same shape as the command repair that was computed, validated and then
    // discarded. A description that is produced and not carried is not a
    // description.
    return await ctx.finish("failed", EventTypes.RunFailed, "provider_error", {
      error: message !== "" ? message : (failure.detail ?? ""),
      failure: {
        class: failure.failureClass,
        disposition: failure.disposition,
        code: failure.code,
        ...(failure.detail !== undefined ? { detail: failure.detail } : {}),
      },
    })
  }

  /** True if `requestId` is still the newest model request for this run. */
  private async isActiveRequest(sessionId: string, runId: string, requestId: string): Promise<boolean> {
    const events = await this.store.read("session", sessionId)
    let newest: string | undefined
    for (const e of events) {
      if (e.type !== EventTypes.ModelRequestStarted) continue
      const d = e.data as { runId?: string; requestId?: string }
      if (d.runId === runId && d.requestId) newest = d.requestId
    }
    return newest === requestId
  }

  /**
   * Call the model with a real abort: a per-call AbortController fires on the
   * timeout OR the run's cancellation, so an honoring client cancels the actual
   * request. The race also rejects on abort, so a late/hung response can never
   * be applied after the run has moved on.
   */
  /**
   * A stream/model error is SAFELY retryable when it is a transient transport
   * problem OR a stream-stall watchdog (first_byte/idle_chunk — the request was
   * aborted before completing, no side effect exists yet). NOT retryable: a
   * cancellation, the total-call budget timeout, a superseded response, an
   * auth/validation failure, or a provider-declared non-retryable failure.
   * Retrying is only ever done before a tool executes, so nothing is duplicated.
   * (12I.6 fix 1: watchdog stalls were the #1 cause of terminal `failed` runs
   * whose file state was already correct — see docs/slice-12i6-reliability-hardening.md.)
   */
  private isRetryableStreamError(e: unknown): boolean {
    // Sprint 15: the decision comes from the shared taxonomy, so "is this worth
    // another try?" has ONE answer in the codebase instead of one per call site.
    // `model` phase: this only ever runs before a tool has executed.
    return classifyFailure(e, "model").disposition === "retry"
  }

  private async callModel(input: ModelInput, runSignal?: AbortSignal, sink?: StreamSink): Promise<ModelTurn> {
    const controller = new AbortController()
    const streaming = Boolean(this.model.stream && sink)
    const st = this.streamTimeouts
    const totalMs = streaming ? (st?.totalMs ?? this.modelTimeoutMs) : this.modelTimeoutMs
    let timedOut = false
    const cancel = new RunCancelledError()
    const relayCancel = () => controller.abort(cancel)
    if (runSignal) {
      if (runSignal.aborted) controller.abort(cancel)
      else runSignal.addEventListener("abort", relayCancel, { once: true })
    }
    const fire = (kind: "first_byte" | "idle_chunk" | "total", ms: number) => () => {
      timedOut = true
      controller.abort(new ProviderTimeoutError({ timeoutMs: ms, kind }))
    }
    const totalTimer = setTimeout(fire("total", totalMs), totalMs)

    // Idle-chunk watchdog for streams: a healthy stream that keeps emitting
    // resets it, so a long-but-live response is never treated as hung; a real
    // stall (or no first byte) aborts.
    const idleMs = streaming ? st?.idleChunkMs : undefined
    const firstMs = streaming ? (st?.firstByteMs ?? st?.idleChunkMs) : undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const armIdle = (ms: number | undefined, kind: "first_byte" | "idle_chunk") => {
      if (ms === undefined) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(fire(kind, ms), ms)
    }
    armIdle(firstMs, "first_byte")
    const guardedSink: StreamSink | undefined =
      streaming && sink
        ? {
            onEvent: async (e) => {
              armIdle(idleMs, "idle_chunk")
              await sink.onEvent(e)
            },
          }
        : sink

    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          const reason = controller.signal.reason
          reject(
            reason instanceof RunCancelledError || reason instanceof ProviderTimeoutError
              ? reason
              : timedOut
                ? new ProviderTimeoutError({ timeoutMs: totalMs, kind: "total" })
                : cancel,
          )
        },
        { once: true },
      )
    })
    try {
      // Stream when the client supports it (identical ModelTurn downstream);
      // otherwise the non-streaming call. Same abort race guards both.
      const invoke =
        streaming && guardedSink
          ? this.model.stream!(input, { signal: controller.signal, sink: guardedSink })
          : this.model.call(input, { signal: controller.signal })
      return await Promise.race([invoke, aborted])
    } finally {
      clearTimeout(totalTimer)
      if (idleTimer) clearTimeout(idleTimer)
      if (runSignal) runSignal.removeEventListener("abort", relayCancel)
    }
  }

  /** Append input.promoted for every admitted input not yet promoted. */
  /** Promote pending inputs; returns their texts so a run can lift an objective. */
  private async promote(sessionId: string): Promise<string[]> {
    const events = await this.store.read("session", sessionId)
    const promoted = new Set(
      events
        .filter((e) => e.type === EventTypes.InputPromoted)
        .map((e) => (e.data as { inputId?: string }).inputId),
    )
    const texts: string[] = []
    for (const e of events) {
      if (e.type !== EventTypes.InputAdmitted) continue
      const { inputId, text } = e.data as { inputId?: string; text?: string }
      if (inputId && !promoted.has(inputId)) {
        await this.store.append({
          aggregateKind: "session",
          aggregateId: sessionId,
          type: EventTypes.InputPromoted,
          data: { inputId },
        })
        if (typeof text === "string" && text.length > 0) texts.push(text)
      }
    }
    return texts
  }
}
