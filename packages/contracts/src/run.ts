/**
 * Unified Run State (Sprint 11) — ONE durable record per task.
 *
 * Before this, a run's truth was scattered: the state machine knew the phase,
 * `run_checkpoints` knew the next action, the tool ledger lived only inside the
 * runtime's in-memory maps, spend was appended as `model.usage` with no run to
 * attribute it to, and the TASK ITSELF existed only as conversation text — which
 * compaction is allowed to prune. A long task therefore leaned on the transcript
 * surviving. That is the failure this file removes.
 *
 * `UnifiedRun` is a DERIVED read-model, folded from the event log alone, and it
 * is folded WITHOUT reading a single byte of message text (see TEXT_EVENTS).
 * Everything a resumer, an auditor or a bill needs — objective, state, tools,
 * spend, evidence, checkpoint, subtasks, next action — is answerable from it.
 *
 * Being derived is also why these are plain interfaces rather than Schemas:
 * schemas guard what crosses a trust boundary; a projection we recompute from
 * our own log has nothing to validate. Drop it and replay.
 */
import type { DomainEvent } from "./event"
import type { RunStopReason } from "./session"
import { isTerminal, type SessionState } from "./state"

/**
 * The canonical event names the unified fold understands.
 *
 * These live HERE, in the pure vocabulary, and `@abdo/session-runtime` imports
 * them for its own `EventTypes` table. Two independent copies of a wire name is
 * how a projection silently stops seeing half the log; `run-event-names.test.ts`
 * asserts the runtime's table and this one still agree.
 */
export const RunEventTypes = {
  Admitted: "run.admitted",
  Preparing: "run.preparing",
  Calling: "run.calling",
  Streaming: "run.streaming",
  AwaitingPermission: "run.awaiting_permission",
  ExecutingTool: "run.executing_tool",
  Compacting: "run.compacting",
  Checkpointed: "run.checkpointed",
  Resumed: "run.resumed",
  Completed: "run.completed",
  Failed: "run.failed",
  Cancelled: "run.cancelled",
  Paused: "run.paused",
  ModelRequestStarted: "model.request.started",
  ToolStarted: "tool.started",
  ToolExecuted: "tool.executed",
  ToolRepeatedCallBlocked: "tool.repeated_call_blocked",
  ToolRedundantStrategyBlocked: "tool.redundant_strategy_blocked",
  ToolRollbackStarted: "tool.rollback_started",
  ToolRollbackCompleted: "tool.rollback_completed",
  ToolRollbackFailed: "tool.rollback_failed",
  MutationEpochStarted: "run.mutation_epoch_started",
  VerificationStarted: "run.verification_started",
  VerificationPassed: "run.verification_passed",
  VerificationFailed: "run.verification_failed",
  VerificationUnavailable: "run.verification_unavailable",
  ControlDecided: "control.decided",
  /** Sprint 11 — the task statement, copied out of the conversation ON PURPOSE. */
  ObjectiveRecorded: "run.objective_recorded",
  /**
   * Sprint 11 — provider usage attributed to the run that spent it.
   *
   * The wire name stays `model.usage`: that event already exists in every log
   * on disk and is what `@abdo/benchmark` reads for real cost. Minting a new
   * name would have zeroed the spend of every run recorded so far and split
   * one fact across two names. What Sprint 11 actually fixed is the payload —
   * it now carries `runId`, so the cost can be attributed at all.
   */
  SpendRecorded: "model.usage",
  /**
   * Sprint 14 — this run ran out of budget and handed the rest of the task to
   * a new one. Recorded on the EXHAUSTED run: the chain is written by the run
   * that gives up, so a continuation can never claim an ancestor it never had.
   */
  ContinuationCreated: "run.continuation_created",
  /** Sprint 11 — a child run claimed by this one. */
  SubtaskSpawned: "run.subtask_spawned",
  /** Sprint 11 — how that child ended. */
  SubtaskResolved: "run.subtask_resolved",
} as const

/**
 * Events whose payload carries human/model prose. The fold MUST NOT read them:
 * the whole point of the unified run is that it survives their loss (pruning,
 * compaction, redaction). They are listed so the rule is enforceable, not
 * merely intended — the Sprint 11 gate deletes them and re-folds.
 */
export const TEXT_EVENTS: readonly string[] = [
  "message.appended",
  "message.delta_batch",
  "input.admitted",
  "input.promoted",
]

/** Log event -> the run state it drives into. Assignment, not validation (see fold). */
const EVENT_TO_STATE: Readonly<Record<string, SessionState>> = {
  [RunEventTypes.Admitted]: "input_admitted",
  [RunEventTypes.Preparing]: "preparing_context",
  [RunEventTypes.Calling]: "calling_model",
  [RunEventTypes.Streaming]: "streaming",
  [RunEventTypes.AwaitingPermission]: "awaiting_permission",
  [RunEventTypes.ExecutingTool]: "executing_tool",
  [RunEventTypes.Compacting]: "compacting",
  [RunEventTypes.VerificationStarted]: "verifying",
  [RunEventTypes.Completed]: "completed",
  [RunEventTypes.Failed]: "failed",
  [RunEventTypes.Cancelled]: "cancelled",
  [RunEventTypes.Paused]: "paused",
}

/** The durable statement of what this run was asked to do. */
export interface RunObjective {
  readonly text: string
  /** Hash of the FULL text — `text` may be truncated for storage, the hash is not. */
  readonly hash: string
  /** `explicit` = the caller stated it; `input` = lifted from the promoted input. */
  readonly source: "explicit" | "input"
  readonly recordedAt: number
}

/** What the run consumed. Token counts are provider-reported; absent stays 0 with `tokensReported: false`. */
export interface RunSpend {
  readonly modelCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  /** False when no provider reported usage — distinguishes "free" from "unknown". */
  readonly tokensReported: boolean
  readonly toolCalls: number
  readonly toolFailures: number
  /** Calls refused before spawning anything (repeated call / redundant strategy). */
  readonly toolsBlocked: number
  readonly turns: number
  readonly attempts: number
  readonly wallClockMs: number
}

export type RunToolStatus = "running" | "completed" | "failed" | "rolled_back"

export interface RunToolRecord {
  readonly executionId: string
  readonly tool: string
  readonly status: RunToolStatus
  readonly argsHash?: string
  readonly resultHash?: string
  readonly startedAt: number
  readonly finishedAt?: number
  readonly error?: string
  /** Set when the execution committed a file mutation (from its receipt). */
  readonly mutatedPath?: string
}

export type RunEvidenceKind = "verification" | "mutation" | "rollback" | "decision" | "blocked_call"

/**
 * One citable fact. `sequence` is the log position, so any claim the run makes
 * can be traced back to the exact event that supports it — the receipt rule
 * Sprint 16 generalises.
 */
export interface RunEvidence {
  readonly kind: RunEvidenceKind
  readonly sequence: number
  readonly at: number
  readonly label: string
  readonly ok?: boolean
  /** executionId, decisionId or path — whatever identifies the subject. */
  readonly ref?: string
  readonly hash?: string
  readonly detail?: string
}

export interface RunCheckpointPointer {
  readonly phase: string
  readonly nextAction: string
  readonly turn: number
  readonly attempt: number
  readonly sequence: number
  readonly pendingToolExecutionId?: string
  readonly createdAt: number
}

export interface RunSubtask {
  readonly childRunId: string
  readonly objective?: string
  readonly spawnedAt: number
  readonly state: SessionState
  readonly stopReason?: RunStopReason
  readonly resolvedAt?: number
}

/** What a resumer must do next — derived without reading any message text. */
export type RunNextAction =
  | { readonly kind: "none"; readonly why: string }
  | {
      readonly kind: "resume_run"
      readonly fromState: SessionState
      readonly turn: number
      readonly attempt: number
      readonly why: string
    }
  | {
      readonly kind: "verify_tool"
      readonly toolExecutionId: string
      readonly tool: string
      readonly turn: number
      readonly attempt: number
      readonly why: string
    }
  | { readonly kind: "await_subtasks"; readonly pending: readonly string[]; readonly why: string }

export interface UnifiedRun {
  readonly runId: string
  readonly sessionId: string
  readonly parentRunId?: string
  /** The run this one took over from when that one ran out (Sprint 14). */
  readonly continuedFromRunId?: string
  /** The run that took over from this one. */
  readonly continuationRunId?: string
  readonly objective?: RunObjective
  readonly state: SessionState
  readonly terminal: boolean
  readonly stopReason?: RunStopReason
  readonly startedAt: number
  readonly updatedAt: number
  readonly finishedAt?: number
  readonly attempt: number
  readonly turn: number
  readonly spend: RunSpend
  readonly tools: readonly RunToolRecord[]
  readonly evidence: readonly RunEvidence[]
  readonly checkpoint?: RunCheckpointPointer
  readonly subtasks: readonly RunSubtask[]
  /** Highest log sequence folded into this view — the projection's watermark. */
  readonly lastSequence: number
  readonly nextAction: RunNextAction
}

interface Draft {
  runId: string
  sessionId: string
  parentRunId?: string
  continuedFromRunId?: string
  continuationRunId?: string
  objective?: RunObjective
  state: SessionState
  stopReason?: RunStopReason
  startedAt: number
  updatedAt: number
  finishedAt?: number
  attempt: number
  turn: number
  modelCalls: number
  inputTokens: number
  outputTokens: number
  tokensReported: boolean
  toolFailures: number
  toolsBlocked: number
  turns: number
  tools: Map<string, RunToolRecord>
  evidence: RunEvidence[]
  checkpoint?: RunCheckpointPointer
  subtasks: Map<string, RunSubtask>
  lastSequence: number
}

type Data = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

/**
 * Fold every run in a session's log.
 *
 * Deliberately NOT `transition()`-validated. A run's own slice of the log can
 * legitimately begin mid-lifecycle — `continueRun` resumes an existing runId
 * from a recovered state, so its first event may be `run.calling`, which is an
 * illegal move from `idle` and would make a strict fold throw on a perfectly
 * healthy log. Validation belongs to the write path, which already refuses
 * illegal moves; a reader's job is to report what the log says happened.
 */
export function foldRuns(events: readonly DomainEvent[]): Map<string, UnifiedRun> {
  const drafts = new Map<string, Draft>()

  for (const event of events) {
    if (TEXT_EVENTS.includes(event.type)) continue // never read prose — see TEXT_EVENTS
    const data = (event.data ?? {}) as Data
    const runId = str(data.runId)
    if (runId === undefined) continue // pre-run events (inputs) belong to no run

    const seq = Number(event.sequence)
    const at = event.occurredAt
    let d = drafts.get(runId)
    if (d === undefined) {
      d = {
        runId,
        sessionId: event.aggregateId,
        state: "idle",
        startedAt: at,
        updatedAt: at,
        attempt: 1,
        turn: 0,
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        tokensReported: false,
        toolFailures: 0,
        toolsBlocked: 0,
        turns: 0,
        tools: new Map(),
        evidence: [],
        subtasks: new Map(),
        lastSequence: seq,
      }
      drafts.set(runId, d)
    }
    d.updatedAt = at
    d.lastSequence = Math.max(d.lastSequence, seq)

    const target = EVENT_TO_STATE[event.type]
    if (target !== undefined) d.state = target

    const turn = num(data.turn)
    if (turn !== undefined) d.turn = Math.max(d.turn, turn)

    switch (event.type) {
      case RunEventTypes.Admitted: {
        d.startedAt = at
        const parent = str(data.parentRunId)
        if (parent !== undefined) d.parentRunId = parent
        const continuedFrom = str(data.continuedFromRunId)
        if (continuedFrom !== undefined) d.continuedFromRunId = continuedFrom
        break
      }

      case RunEventTypes.ContinuationCreated: {
        const next = str(data.continuationRunId)
        if (next !== undefined) d.continuationRunId = next
        break
      }

      case RunEventTypes.ObjectiveRecorded: {
        const text = str(data.text)
        const hash = str(data.hash)
        if (text !== undefined && hash !== undefined) {
          d.objective = {
            text,
            hash,
            source: data.source === "explicit" ? "explicit" : "input",
            recordedAt: num(data.recordedAt) ?? at,
          }
        }
        break
      }

      case RunEventTypes.Resumed: {
        d.attempt = Math.max(d.attempt, num(data.attempt) ?? d.attempt)
        break
      }

      case RunEventTypes.Calling: {
        d.turns++
        break
      }

      case RunEventTypes.ModelRequestStarted: {
        d.modelCalls++
        break
      }

      case RunEventTypes.SpendRecorded: {
        const inTok = num(data.inputTokens)
        const outTok = num(data.outputTokens)
        if (inTok !== undefined || outTok !== undefined) d.tokensReported = true
        d.inputTokens += inTok ?? 0
        d.outputTokens += outTok ?? 0
        break
      }

      case RunEventTypes.ToolStarted: {
        const executionId = str(data.toolExecutionId)
        if (executionId === undefined) break
        const argsHash = str(data.argsHash)
        d.tools.set(executionId, {
          executionId,
          tool: str(data.tool) ?? "unknown",
          status: "running",
          startedAt: at,
          ...(argsHash !== undefined ? { argsHash } : {}),
        })
        break
      }

      case RunEventTypes.ToolExecuted: {
        const executionId = str(data.toolExecutionId)
        if (executionId === undefined) break
        const prev = d.tools.get(executionId)
        const ok = data.ok === true
        if (!ok) d.toolFailures++
        const mutation = (data.mutation ?? undefined) as
          | { path?: string; afterHash?: string; mutationCommitted?: boolean }
          | undefined
        const resultHash = str(data.resultHash)
        const error = str(data.error)
        const record: RunToolRecord = {
          executionId,
          tool: str(data.tool) ?? prev?.tool ?? "unknown",
          status: ok ? "completed" : "failed",
          startedAt: prev?.startedAt ?? at,
          finishedAt: at,
          ...(prev?.argsHash !== undefined ? { argsHash: prev.argsHash } : {}),
          ...(resultHash !== undefined ? { resultHash } : {}),
          ...(!ok && error !== undefined ? { error } : {}),
          ...(mutation?.mutationCommitted === true && typeof mutation.path === "string"
            ? { mutatedPath: mutation.path }
            : {}),
        }
        d.tools.set(executionId, record)
        if (mutation?.mutationCommitted === true) {
          d.evidence.push({
            kind: "mutation",
            sequence: seq,
            at,
            label: `${record.tool} mutated ${mutation.path ?? "(unknown path)"}`,
            ok: true,
            ref: executionId,
            ...(typeof mutation.afterHash === "string" ? { hash: mutation.afterHash } : {}),
          })
        }
        break
      }

      case RunEventTypes.ToolRepeatedCallBlocked:
      case RunEventTypes.ToolRedundantStrategyBlocked: {
        d.toolsBlocked++
        const ref = str(data.toolExecutionId)
        d.evidence.push({
          kind: "blocked_call",
          sequence: seq,
          at,
          label: `${str(data.tool) ?? str(data.strategy) ?? "call"} refused (${event.type.split(".").pop()})`,
          ok: false,
          ...(ref !== undefined ? { ref } : {}),
        })
        break
      }

      case RunEventTypes.ToolRollbackCompleted:
      case RunEventTypes.ToolRollbackFailed: {
        const executionId = str(data.toolExecutionId)
        const completed = event.type === RunEventTypes.ToolRollbackCompleted
        if (executionId !== undefined && completed) {
          const prev = d.tools.get(executionId)
          if (prev !== undefined) d.tools.set(executionId, { ...prev, status: "rolled_back" })
        }
        const path = str(data.path)
        const restoredHash = str(data.restoredHash)
        d.evidence.push({
          kind: "rollback",
          sequence: seq,
          at,
          label: `rollback ${completed ? "completed" : "failed"} for ${str(data.tool) ?? "tool"}`,
          ok: completed,
          ...(executionId !== undefined ? { ref: executionId } : {}),
          ...(path !== undefined ? { detail: path } : {}),
          ...(restoredHash !== undefined ? { hash: restoredHash } : {}),
        })
        break
      }

      case RunEventTypes.VerificationPassed:
      case RunEventTypes.VerificationFailed:
      case RunEventTypes.VerificationUnavailable: {
        const verdict = event.type.split(".").pop() ?? "unknown"
        const detail = str(data.detail)
        d.evidence.push({
          kind: "verification",
          sequence: seq,
          at,
          label: `verification ${verdict} (epoch ${num(data.epoch) ?? 0})`,
          // `unavailable` is NEITHER pass nor fail — `ok` stays undefined so a
          // consumer can never read "no verifier applied" as "verified".
          ...(event.type === RunEventTypes.VerificationPassed
            ? { ok: true }
            : event.type === RunEventTypes.VerificationFailed
              ? { ok: false }
              : {}),
          ...(detail !== undefined ? { detail } : {}),
        })
        break
      }

      case RunEventTypes.ControlDecided: {
        const ref = str(data.decisionId)
        const detail = str(data.ruleId)
        d.evidence.push({
          kind: "decision",
          sequence: seq,
          at,
          label: `${str(data.action) ?? "decided"} ${str(data.capability) ?? ""}`.trim(),
          ok: data.action === "allow",
          ...(ref !== undefined ? { ref } : {}),
          ...(detail !== undefined ? { detail } : {}),
        })
        break
      }

      case RunEventTypes.Checkpointed: {
        const phase = str(data.phase)
        const nextAction = str(data.nextAction)
        if (phase === undefined || nextAction === undefined) break
        const pendingToolExecutionId = str(data.pendingToolExecutionId)
        const cp: RunCheckpointPointer = {
          phase,
          nextAction,
          turn: num(data.turn) ?? 0,
          attempt: num(data.attempt) ?? d.attempt,
          sequence: num(data.sequence) ?? seq,
          createdAt: num(data.createdAt) ?? at,
          ...(pendingToolExecutionId !== undefined ? { pendingToolExecutionId } : {}),
        }
        // Later checkpoint wins; a replayed older one never rewinds the pointer.
        if (d.checkpoint === undefined || cp.sequence >= d.checkpoint.sequence) d.checkpoint = cp
        break
      }

      case RunEventTypes.SubtaskSpawned: {
        const childRunId = str(data.childRunId)
        if (childRunId === undefined) break
        const objective = str(data.objective)
        if (!d.subtasks.has(childRunId)) {
          d.subtasks.set(childRunId, {
            childRunId,
            spawnedAt: at,
            state: "input_admitted",
            ...(objective !== undefined ? { objective } : {}),
          })
        }
        break
      }

      case RunEventTypes.SubtaskResolved: {
        const childRunId = str(data.childRunId)
        if (childRunId === undefined) break
        const prev = d.subtasks.get(childRunId)
        const state = (str(data.state) ?? "failed") as SessionState
        const reason = str(data.reason)
        d.subtasks.set(childRunId, {
          childRunId,
          spawnedAt: prev?.spawnedAt ?? at,
          state,
          resolvedAt: at,
          ...(prev?.objective !== undefined ? { objective: prev.objective } : {}),
          ...(reason !== undefined ? { stopReason: reason as RunStopReason } : {}),
        })
        break
      }

      case RunEventTypes.Completed:
      case RunEventTypes.Failed:
      case RunEventTypes.Cancelled:
      case RunEventTypes.Paused: {
        d.finishedAt = at
        const reason = str(data.reason)
        if (reason !== undefined) d.stopReason = reason as RunStopReason
        break
      }
    }
  }

  const out = new Map<string, UnifiedRun>()
  for (const [runId, d] of drafts) out.set(runId, finish(d))
  return out
}

/* ────────────────────────── Sprint 14: continuation ──────────────────────────
 *
 * A task bigger than one budget is not one run — it is a CHAIN of them, each
 * picking up where the last ran out. The chain is the unit a human cares about
 * ("did the task finish?"), while each run stays an honest record of only the
 * work it did itself. Aggregating is a read-time job, done here, so no run ever
 * claims its predecessor's files as its own.
 */

export interface RunChain {
  /** Runs in execution order, oldest first. */
  readonly runs: readonly UnifiedRun[]
  readonly objective?: RunObjective
  /** True when the LAST run in the chain finished the work. */
  readonly completed: boolean
  readonly totalToolCalls: number
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly filesChanged: readonly string[]
  /** Chain-wide next step: the last run's, since only it can still move. */
  readonly nextAction: RunNextAction
}

/**
 * The whole chain a run belongs to, walked to both ends.
 *
 * Given any run in the chain — the first, the last, or one in the middle — the
 * answer is the same. A resumer that only knows the run id it was handed should
 * not have to find the head itself.
 */
export function foldChain(runId: string, events: readonly DomainEvent[]): RunChain | undefined {
  const runs = foldRuns(events)
  let head = runs.get(runId)
  if (head === undefined) return undefined

  const guard = new Set<string>([head.runId])
  while (head.continuedFromRunId !== undefined) {
    const prev = runs.get(head.continuedFromRunId)
    // A cycle would mean a corrupt log; stop rather than spin.
    if (prev === undefined || guard.has(prev.runId)) break
    guard.add(prev.runId)
    head = prev
  }

  // A FRESH visited set for the forward walk: the backward pass already put
  // every ancestor in `guard`, so reusing it would make a fold started from the
  // middle of a chain stop at the very first hop.
  const seen = new Set<string>([head.runId])
  const ordered: UnifiedRun[] = [head]
  let cursor = head
  while (cursor.continuationRunId !== undefined) {
    const next = runs.get(cursor.continuationRunId)
    if (next === undefined || seen.has(next.runId)) break
    seen.add(next.runId)
    ordered.push(next)
    cursor = next
  }

  const last = ordered[ordered.length - 1]!
  // Paths only — the evidence label is a sentence for humans, not an identifier.
  const files = new Set<string>()
  for (const run of ordered) for (const t of run.tools) if (t.mutatedPath !== undefined) files.add(t.mutatedPath)

  return {
    runs: ordered,
    ...(ordered.find((r) => r.objective !== undefined)?.objective !== undefined
      ? { objective: ordered.find((r) => r.objective !== undefined)!.objective }
      : {}),
    completed: last.state === "completed",
    totalToolCalls: ordered.reduce((n, r) => n + r.spend.toolCalls, 0),
    totalInputTokens: ordered.reduce((n, r) => n + r.spend.inputTokens, 0),
    totalOutputTokens: ordered.reduce((n, r) => n + r.spend.outputTokens, 0),
    filesChanged: [...files],
    nextAction: last.nextAction,
  }
}

/* ─────────────────────────── Sprint 12: progress ───────────────────────────
 *
 * A checkpoint used to be a cursor: phase, turn, next action. That is enough to
 * re-enter the loop and nothing else — a resumer still had to replay the whole
 * log to learn what had already been changed, what had already been run, what
 * was proved, and what was in the way. So the answer to "where were we?" lived
 * in the log, and the checkpoint could only say "here".
 *
 * `RunProgress` is the work itself, accumulated as the run emits and written
 * INTO every checkpoint. The reducer below is the single definition of that
 * accumulation: the runtime folds it forward as it writes, and a reader folds
 * the same function over the log. One rule, two directions — a writer and a
 * reader that disagree about progress is the bug this shape forbids.
 */

export interface RunCommandRecord {
  readonly executionId: string
  readonly tool: string
  readonly ok: boolean
}

export interface RunTestRecord {
  readonly verdict: "passed" | "failed" | "unavailable"
  readonly detail?: string
}

/** What is in the way RIGHT NOW. Cleared the moment the run gets past it. */
export interface RunBlocker {
  readonly kind: "tool_failed" | "verification_failed"
  readonly detail: string
  readonly ref?: string
  readonly since: number
  /**
   * The Sprint 15 verdict, copied from the event that recorded the failure.
   * A blocker that does not say whether it can be retried, repaired or only
   * escalated leaves the reader to guess — which is the guessing the taxonomy
   * removed everywhere else.
   */
  readonly failureClass?: string
  readonly disposition?: "retry" | "repair" | "stop"
}

export interface RunProgress {
  /** Steps the caller stated up front. Empty when nobody planned. */
  readonly plan: readonly string[]
  /** Paths whose mutation COMMITTED — not paths a tool merely opened. */
  readonly filesChanged: readonly string[]
  readonly commandsCompleted: readonly RunCommandRecord[]
  readonly tests: readonly RunTestRecord[]
  readonly blocker?: RunBlocker
}

/** Lift the {class, disposition} an event carries, if it carries one. */
function verdictOf(raw: unknown): { failureClass?: string; disposition?: "retry" | "repair" | "stop" } {
  const f = raw as { class?: unknown; disposition?: unknown } | undefined
  const failureClass = typeof f?.class === "string" ? f.class : undefined
  const disposition =
    f?.disposition === "retry" || f?.disposition === "repair" || f?.disposition === "stop" ? f.disposition : undefined
  return {
    ...(failureClass !== undefined ? { failureClass } : {}),
    ...(disposition !== undefined ? { disposition } : {}),
  }
}

export const emptyProgress = (plan: readonly string[] = []): RunProgress => ({
  plan,
  filesChanged: [],
  commandsCompleted: [],
  tests: [],
})

/**
 * Fold one event into progress. Pure, total, and order-dependent by design —
 * the blocker is CURRENT, so a later success clears an earlier failure rather
 * than accumulating a list of everything that ever went wrong.
 */
export function advanceProgress(
  progress: RunProgress,
  type: string,
  data: Record<string, unknown>,
  at: number,
): RunProgress {
  switch (type) {
    case RunEventTypes.ToolExecuted: {
      const executionId = str(data.toolExecutionId)
      if (executionId === undefined) return progress
      const tool = str(data.tool) ?? "unknown"
      const ok = data.ok === true
      const mutation = (data.mutation ?? undefined) as { path?: string; mutationCommitted?: boolean } | undefined
      const path = mutation?.mutationCommitted === true ? str(mutation.path) : undefined
      const commandsCompleted = progress.commandsCompleted.some((c) => c.executionId === executionId)
        ? progress.commandsCompleted
        : [...progress.commandsCompleted, { executionId, tool, ok }]
      return {
        ...progress,
        commandsCompleted,
        filesChanged:
          path !== undefined && !progress.filesChanged.includes(path)
            ? [...progress.filesChanged, path]
            : progress.filesChanged,
        // A failure becomes the blocker; a success clears one left by this tool.
        ...(ok
          ? progress.blocker?.kind === "tool_failed"
            ? { blocker: undefined }
            : {}
          : {
              blocker: {
                kind: "tool_failed" as const,
                detail: str(data.error) ?? `${tool} failed`,
                ref: executionId,
                since: at,
                ...verdictOf(data.failure),
              },
            }),
      }
    }

    case RunEventTypes.ToolRollbackCompleted: {
      // A rolled-back mutation is no longer a change the world carries.
      const path = str(data.path)
      return path === undefined
        ? progress
        : { ...progress, filesChanged: progress.filesChanged.filter((f) => f !== path) }
    }

    case RunEventTypes.VerificationPassed:
      return { ...progress, tests: [...progress.tests, { verdict: "passed" }], blocker: undefined }

    case RunEventTypes.VerificationFailed: {
      const detail = str(data.detail) ?? "objective verification failed"
      return {
        ...progress,
        tests: [...progress.tests, { verdict: "failed", detail }],
        blocker: { kind: "verification_failed", detail, since: at, ...verdictOf(data.failure) },
      }
    }

    case RunEventTypes.VerificationUnavailable:
      // NOT a pass and NOT a failure — recorded so nobody can read the silence
      // as proof (the same rule the evidence fold keeps).
      return { ...progress, tests: [...progress.tests, { verdict: "unavailable" }] }

    default:
      return progress
  }
}

/** Progress as of the end of a log slice — the reader's direction of the fold. */
export function foldProgress(
  events: readonly DomainEvent[],
  runId: string,
  plan: readonly string[] = [],
): RunProgress {
  let progress = emptyProgress(plan)
  for (const event of events) {
    if (TEXT_EVENTS.includes(event.type)) continue
    const data = (event.data ?? {}) as Data
    if (str(data.runId) !== runId) continue
    progress = advanceProgress(progress, event.type, data, event.occurredAt)
  }
  return progress
}

/** Fold a single run out of a session's log. `undefined` when the run is absent. */
export function foldRun(runId: string, events: readonly DomainEvent[]): UnifiedRun | undefined {
  return foldRuns(events).get(runId)
}

function finish(d: Draft): UnifiedRun {
  const tools = [...d.tools.values()].sort((a, b) => a.startedAt - b.startedAt)
  const subtasks = [...d.subtasks.values()].sort((a, b) => a.spawnedAt - b.spawnedAt)
  const spend: RunSpend = {
    modelCalls: d.modelCalls,
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    tokensReported: d.tokensReported,
    toolCalls: tools.length,
    toolFailures: d.toolFailures,
    toolsBlocked: d.toolsBlocked,
    turns: d.turns,
    attempts: d.attempt,
    // For a live run this is "so far"; for a finished one it is final.
    wallClockMs: Math.max(0, (d.finishedAt ?? d.updatedAt) - d.startedAt),
  }
  return {
    runId: d.runId,
    sessionId: d.sessionId,
    ...(d.parentRunId !== undefined ? { parentRunId: d.parentRunId } : {}),
    ...(d.continuedFromRunId !== undefined ? { continuedFromRunId: d.continuedFromRunId } : {}),
    ...(d.continuationRunId !== undefined ? { continuationRunId: d.continuationRunId } : {}),
    ...(d.objective !== undefined ? { objective: d.objective } : {}),
    state: d.state,
    terminal: isTerminal(d.state),
    ...(d.stopReason !== undefined ? { stopReason: d.stopReason } : {}),
    startedAt: d.startedAt,
    updatedAt: d.updatedAt,
    ...(d.finishedAt !== undefined ? { finishedAt: d.finishedAt } : {}),
    attempt: d.attempt,
    turn: d.turn,
    spend,
    tools,
    evidence: d.evidence,
    ...(d.checkpoint !== undefined ? { checkpoint: d.checkpoint } : {}),
    subtasks,
    lastSequence: d.lastSequence,
    nextAction: deriveNextAction(d, tools, subtasks),
  }
}

function deriveNextAction(
  d: Draft,
  tools: readonly RunToolRecord[],
  subtasks: readonly RunSubtask[],
): RunNextAction {
  if (isTerminal(d.state)) {
    return { kind: "none", why: `run is ${d.state}${d.stopReason ? ` (${d.stopReason})` : ""}` }
  }

  // A tool that started and never reported is the sharpest resume signal there
  // is: the world may already have changed, so the resumer must CLASSIFY it
  // before doing anything else.
  const pendingId = d.checkpoint?.pendingToolExecutionId
  const pending = pendingId !== undefined ? tools.find((t) => t.executionId === pendingId) : undefined
  if (pending !== undefined && pending.status === "running") {
    return {
      kind: "verify_tool",
      toolExecutionId: pending.executionId,
      tool: pending.tool,
      turn: d.checkpoint?.turn ?? d.turn,
      attempt: d.attempt,
      why: "a tool started and never reported — classify its effect before continuing",
    }
  }

  const unresolved = subtasks.filter((s) => s.resolvedAt === undefined).map((s) => s.childRunId)
  if (unresolved.length > 0) {
    return { kind: "await_subtasks", pending: unresolved, why: `${unresolved.length} subtask(s) unresolved` }
  }

  if (d.state === "paused") {
    return {
      kind: "resume_run",
      fromState: d.state,
      turn: d.checkpoint?.turn ?? d.turn,
      attempt: d.attempt,
      why: `paused${d.stopReason ? ` on ${d.stopReason}` : ""} — resume when budget allows`,
    }
  }

  return {
    kind: "resume_run",
    fromState: d.state,
    turn: d.checkpoint?.turn ?? d.turn,
    attempt: d.attempt,
    why: `run left non-terminal in ${d.state} — no terminal event was ever written`,
  }
}
