/**
 * RecoveryReconciler — the startup answer to "where did we stop, and what
 * actually ran?"
 *
 * It replays the event log (the source of truth) and, for every run that lacks
 * a terminal event, classifies how to resume SAFELY:
 *   - a tool.started with no tool.executed => the process died mid-tool; the
 *     side effect may or may not have applied, so VERIFY, never blind re-run
 *   - model in flight (last event run.calling/streaming, no tool pending) =>
 *     retry the model on a fresh attempt (a model call has no side effect)
 *   - otherwise continue from the next sequence
 *
 * Nothing here executes anything; it only decides. The host acts on the decision.
 */
import { isTerminalRunEvent } from "@abdo/contracts/event"
import type { DomainEvent } from "@abdo/contracts/event"
import type { EventStore } from "@abdo/event-store"
import { EventTypes } from "@abdo/session-runtime"

export interface PendingTool {
  readonly toolExecutionId: string
  readonly tool: string
  readonly argsHash?: string
  readonly idempotencyKey?: string
}

export interface UnfinishedRun {
  readonly runId: string
  readonly sessionId: string
  readonly lastSequence: number
  /** The last run.* lifecycle event type seen (e.g. "run.executing_tool"). */
  readonly lastRunEvent?: string
  /** A tool that started but has no completion — the dangerous case. */
  readonly pendingTool?: PendingTool
}

export type RecoveryDecision =
  | { readonly kind: "continue"; readonly runId: string; readonly fromSequence: number }
  | { readonly kind: "verify_tool"; readonly runId: string; readonly pendingTool: PendingTool }
  | { readonly kind: "retry_model"; readonly runId: string }
  | { readonly kind: "mark_failed"; readonly runId: string; readonly reason: string }

const runIdOf = (e: DomainEvent): string | undefined => (e.data as { runId?: string } | null)?.runId

export class RecoveryReconciler {
  constructor(private readonly store: EventStore) {}

  /** Every run in a session that never reached a terminal event. */
  async unfinishedRuns(sessionId: string): Promise<UnfinishedRun[]> {
    const events = await this.store.read("session", sessionId)
    const byRun = new Map<string, DomainEvent[]>()
    for (const e of events) {
      const rid = runIdOf(e)
      if (!rid) continue
      const list = byRun.get(rid) ?? []
      list.push(e)
      byRun.set(rid, list)
    }

    const out: UnfinishedRun[] = []
    for (const [runId, runEvents] of byRun) {
      if (runEvents.some((e) => isTerminalRunEvent(e.type))) continue // finished

      const last = runEvents[runEvents.length - 1]!
      const lastRunEvent = [...runEvents].reverse().find((e) => e.type.startsWith("run."))?.type

      // tool.started without a matching tool.executed (same toolExecutionId)
      const completed = new Set(
        runEvents
          .filter((e) => e.type === EventTypes.ToolExecuted)
          .map((e) => (e.data as { toolExecutionId?: string }).toolExecutionId),
      )
      const started = runEvents.filter((e) => e.type === EventTypes.ToolStarted)
      const orphanStart = started.find((e) => !completed.has((e.data as { toolExecutionId?: string }).toolExecutionId))
      const pendingTool = orphanStart
        ? (() => {
            const d = orphanStart.data as PendingTool
            return {
              toolExecutionId: d.toolExecutionId,
              tool: d.tool,
              argsHash: d.argsHash,
              idempotencyKey: d.idempotencyKey,
            }
          })()
        : undefined

      out.push({ runId, sessionId, lastSequence: Number(last.sequence), lastRunEvent, pendingTool })
    }
    return out
  }

  /** One recovery decision per unfinished run. */
  async decideForSession(sessionId: string): Promise<RecoveryDecision[]> {
    const runs = await this.unfinishedRuns(sessionId)
    return runs.map((run) => this.decide(run))
  }

  decide(run: UnfinishedRun): RecoveryDecision {
    if (run.pendingTool) {
      // A side effect may have applied without being recorded — verify, don't re-run.
      return { kind: "verify_tool", runId: run.runId, pendingTool: run.pendingTool }
    }
    if (run.lastRunEvent === EventTypes.RunCalling || run.lastRunEvent === EventTypes.RunStreaming) {
      // Model call was in flight; it has no side effect, so a fresh attempt is safe.
      return { kind: "retry_model", runId: run.runId }
    }
    return { kind: "continue", runId: run.runId, fromSequence: run.lastSequence + 1 }
  }
}
