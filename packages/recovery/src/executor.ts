/**
 * RecoveryExecutor — turns a RecoveryDecision into a SAFE action that moves the
 * run forward, never duplicating a side effect.
 *
 *   verify_tool  -> ask a per-tool verifier what actually happened, then record
 *                   a recovered success / allow a safe retry / stop for approval
 *   retry_model  -> abandon the crashed attempt, open a NEW attempt (the model
 *                   call has no side effect, so a fresh request is safe)
 *   continue     -> resume from the next sequence
 *
 * Recovery is modelled as ATTEMPTS: the crashed attempt is marked abandoned and
 * a new one is opened, rather than mutating the old attempt as if nothing broke.
 */
import type { EventStore } from "@abdo/event-store"
import { UnknownToolOutcomeError } from "./errors"
import type { PendingTool, RecoveryDecision } from "./reconciler"

export const RecoveryEventTypes = {
  Abandoned: "run.abandoned",
  Resumed: "run.resumed",
  ToolRecovered: "tool.executed", // recorded with recovered:true so the pending tool is resolved
} as const

export type VerifyResult =
  | { readonly state: "applied"; readonly result?: unknown }
  | { readonly state: "not_applied" }
  | { readonly state: "partially_applied"; readonly details?: unknown }
  | { readonly state: "unknown"; readonly reason: string }

export interface ToolRecoveryVerifier {
  /** Inspect the real world to decide what the crashed tool actually did. */
  verify(pending: PendingTool): Promise<VerifyResult>
}

export type RecoveryResult =
  | { readonly kind: "recovered_tool"; readonly runId: string; readonly toolExecutionId: string }
  | { readonly kind: "retryable_tool"; readonly runId: string; readonly toolExecutionId: string }
  | { readonly kind: "needs_approval"; readonly runId: string; readonly reason: string }
  | { readonly kind: "model_retry_scheduled"; readonly runId: string; readonly attempt: number }
  | { readonly kind: "continue"; readonly runId: string; readonly fromSequence: number }

export interface ExecutorOptions {
  readonly verifier?: ToolRecoveryVerifier
}

export class RecoveryExecutor {
  constructor(
    private readonly store: EventStore,
    private readonly sessionId: string,
    private readonly options: ExecutorOptions = {},
  ) {}

  async execute(decision: RecoveryDecision): Promise<RecoveryResult> {
    switch (decision.kind) {
      case "verify_tool":
        return this.executeVerifyTool(decision.runId, decision.pendingTool)
      case "retry_model":
        return this.executeRetryModel(decision.runId)
      case "continue":
        return { kind: "continue", runId: decision.runId, fromSequence: decision.fromSequence }
      case "mark_failed":
        await this.emit(decision.runId, "run.failed", { reason: decision.reason })
        return { kind: "needs_approval", runId: decision.runId, reason: decision.reason }
    }
  }

  private async executeVerifyTool(runId: string, pending: PendingTool): Promise<RecoveryResult> {
    const verifier = this.options.verifier
    if (!verifier) {
      return { kind: "needs_approval", runId, reason: `no verifier for tool ${pending.tool}` }
    }
    const outcome = await verifier.verify(pending)
    switch (outcome.state) {
      case "applied": {
        // The side effect DID happen — record the completion we lost, idempotently,
        // so the tool is no longer pending and we never run it again.
        await this.emit(
          runId,
          "tool.executed",
          {
            toolExecutionId: pending.toolExecutionId,
            tool: pending.tool,
            ok: true,
            recovered: true,
            ...(pending.idempotencyKey ? { idempotencyKey: pending.idempotencyKey } : {}),
          },
          pending.idempotencyKey ? `recovered:${pending.idempotencyKey}` : undefined,
        )
        return { kind: "recovered_tool", runId, toolExecutionId: pending.toolExecutionId }
      }
      case "not_applied":
        // Nothing happened — re-running once is safe (no duplication possible).
        return { kind: "retryable_tool", runId, toolExecutionId: pending.toolExecutionId }
      case "partially_applied":
        // Ambiguous partial state — require a human/rollback decision.
        return { kind: "needs_approval", runId, reason: `tool ${pending.tool} partially applied` }
      case "unknown":
        throw new UnknownToolOutcomeError(runId, pending.toolExecutionId, outcome.reason)
    }
  }

  private async executeRetryModel(runId: string): Promise<RecoveryResult> {
    // Mark the crashed attempt abandoned. continueRun (host) opens the new one
    // via run.resumed, so the crashed attempt is never mutated back to running.
    const prior = await this.attemptCount(runId)
    await this.emit(runId, RecoveryEventTypes.Abandoned, { attempt: prior, reason: "crash: model in flight" })
    return { kind: "model_retry_scheduled", runId, attempt: prior + 1 }
  }

  /** Current attempt number = 1 + number of abandoned attempts for this run. */
  private async attemptCount(runId: string): Promise<number> {
    const events = await this.store.read("session", this.sessionId)
    return (
      1 +
      events.filter(
        (e) => e.type === RecoveryEventTypes.Abandoned && (e.data as { runId?: string }).runId === runId,
      ).length
    )
  }

  private emit(runId: string, type: string, data: Record<string, unknown>, idempotencyKey?: string) {
    return this.store.append({
      aggregateKind: "session",
      aggregateId: this.sessionId,
      type,
      data: { runId, ...data },
      ...(idempotencyKey ? { idempotencyKey } : {}),
    })
  }
}
