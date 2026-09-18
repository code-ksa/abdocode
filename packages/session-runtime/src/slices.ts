/**
 * The slice executor (Sprint 18).
 *
 * A slice is precondition → mutation → postcondition → rollback, and this runs
 * them in that order, writing each step to the log as it goes so a crash in the
 * middle is legible afterwards.
 *
 * Two rules it will not bend:
 *
 *  1. A failing postcondition rolls back THAT slice and stops. Earlier slices
 *     are committed work; undoing them because a later step went wrong turns
 *     one bad change into a cascade.
 *  2. A slice that changed something and cannot put it back is `stuck`, never
 *     `rolled_back`. Reporting an un-undone change as undone is the most
 *     dangerous lie available here, because everything downstream — the report,
 *     the receipts, the human reading them — would then be wrong in the same
 *     direction.
 */
import { SliceEventTypes, type SliceCheck, type SliceState } from "@abdo/contracts/slice"
import type { EventStore } from "@abdo/event-store"

export interface SliceMutationResult {
  readonly ok: boolean
  /** Tool executions this mutation performed, so the slice cites its receipts. */
  readonly operationIds?: readonly string[]
  readonly error?: string
  readonly output?: unknown
}

export interface Slice {
  readonly id: string
  readonly description?: string
  /** May this run at all, given the state right now? Absent = yes. */
  precondition?(): Promise<SliceCheck> | SliceCheck
  /** The change itself. */
  mutate(): Promise<SliceMutationResult> | SliceMutationResult
  /** Is the state now what the change was supposed to produce? Absent = assumed. */
  postcondition?(): Promise<SliceCheck> | SliceCheck
  /** How to put it back. Absent means a failed postcondition leaves it STUCK. */
  rollback?(): Promise<SliceCheck> | SliceCheck
}

export interface SliceOutcome {
  readonly sliceId: string
  readonly state: SliceState
  readonly precondition?: SliceCheck
  readonly postcondition?: SliceCheck
  readonly rollback?: SliceCheck
  readonly operationIds: readonly string[]
  readonly error?: string
  readonly output?: unknown
}

export interface SliceContext {
  readonly store: EventStore
  readonly sessionId: string
  readonly runId: string
  readonly now?: () => number
}

const asCheck = async (fn: (() => Promise<SliceCheck> | SliceCheck) | undefined): Promise<SliceCheck | undefined> =>
  fn === undefined ? undefined : await fn()

export class SliceExecutor {
  constructor(private readonly ctx: SliceContext) {}

  private emit(type: string, data: Record<string, unknown>): Promise<unknown> {
    return this.ctx.store.append({
      aggregateKind: "session",
      aggregateId: this.ctx.sessionId,
      type,
      data: { runId: this.ctx.runId, ...data },
    })
  }

  /** Run one slice to a terminal state, writing every step to the log. */
  async run(slice: Slice): Promise<SliceOutcome> {
    const sliceId = slice.id
    await this.emit(SliceEventTypes.Started, {
      sliceId,
      ...(slice.description !== undefined ? { description: slice.description } : {}),
    })

    // ── precondition ──────────────────────────────────────────────────
    let precondition: SliceCheck | undefined
    try {
      precondition = await asCheck(slice.precondition?.bind(slice))
    } catch (e) {
      precondition = { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
    if (precondition !== undefined) {
      await this.emit(SliceEventTypes.PreconditionChecked, { sliceId, result: precondition })
      if (!precondition.ok) {
        // Nothing was changed, so there is nothing to undo — a refusal is a
        // clean outcome, not a failure to clean up after.
        return { sliceId, state: "refused", precondition, operationIds: [] }
      }
    }

    // ── mutation ──────────────────────────────────────────────────────
    let mutation: SliceMutationResult
    try {
      mutation = await slice.mutate()
    } catch (e) {
      mutation = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    const operationIds = [...(mutation.operationIds ?? [])]
    await this.emit(SliceEventTypes.Mutated, { sliceId, ok: mutation.ok, operationIds })

    if (!mutation.ok) {
      // The mutation itself failed. Whether it left anything behind is the
      // tool's receipt to answer; the slice attempts its rollback if one exists,
      // because "failed" and "changed nothing" are not the same claim.
      const undone = await this.undo(slice, sliceId)
      const state: SliceState = slice.rollback === undefined ? "failed" : undone?.ok ? "rolled_back" : "stuck"
      await this.emit(SliceEventTypes.Failed, {
        sliceId,
        state,
        error: mutation.error ?? "mutation failed",
        ...(undone !== undefined ? { rollback: undone } : {}),
      })
      return {
        sliceId,
        state,
        ...(precondition !== undefined ? { precondition } : {}),
        ...(undone !== undefined ? { rollback: undone } : {}),
        operationIds,
        ...(mutation.error !== undefined ? { error: mutation.error } : {}),
      }
    }

    // ── postcondition ─────────────────────────────────────────────────
    let postcondition: SliceCheck | undefined
    try {
      postcondition = await asCheck(slice.postcondition?.bind(slice))
    } catch (e) {
      postcondition = { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
    if (postcondition !== undefined) {
      await this.emit(SliceEventTypes.PostconditionChecked, { sliceId, result: postcondition })
    }

    if (postcondition !== undefined && !postcondition.ok) {
      // The change applied and produced the wrong state. THIS is the case the
      // old per-tool compensation could never see, because the tool reported
      // success.
      const undone = await this.undo(slice, sliceId)
      const state: SliceState = undone?.ok === true ? "rolled_back" : "stuck"
      if (state === "stuck") {
        await this.emit(SliceEventTypes.Failed, {
          sliceId,
          state,
          error:
            slice.rollback === undefined
              ? "postcondition failed and this slice has no rollback: the change stands"
              : `postcondition failed and the rollback did not succeed: ${undone?.detail ?? "unknown"}`,
        })
      }
      return {
        sliceId,
        state,
        ...(precondition !== undefined ? { precondition } : {}),
        postcondition,
        ...(undone !== undefined ? { rollback: undone } : {}),
        operationIds,
      }
    }

    await this.emit(SliceEventTypes.Completed, { sliceId, operationIds })
    return {
      sliceId,
      state: "committed",
      ...(precondition !== undefined ? { precondition } : {}),
      ...(postcondition !== undefined ? { postcondition } : {}),
      operationIds,
      ...(mutation.output !== undefined ? { output: mutation.output } : {}),
    }
  }

  /**
   * Run slices in order, stopping at the first that does not commit.
   *
   * Only the failing slice is rolled back — by `run`, above. This method's job
   * is the other half of the same rule: it does NOT walk backwards undoing the
   * slices that already committed.
   */
  async runSequence(slices: readonly Slice[]): Promise<SliceOutcome[]> {
    const outcomes: SliceOutcome[] = []
    for (const slice of slices) {
      const outcome = await this.run(slice)
      outcomes.push(outcome)
      if (outcome.state !== "committed") break
    }
    return outcomes
  }

  /** Attempt the slice's own rollback, recording whatever happens. */
  private async undo(slice: Slice, sliceId: string): Promise<SliceCheck | undefined> {
    if (slice.rollback === undefined) return undefined
    let result: SliceCheck
    try {
      result = await slice.rollback()
    } catch (e) {
      // A rollback that throws is a rollback that did not happen. Swallowing it
      // would leave the log claiming the world was restored.
      result = { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
    await this.emit(SliceEventTypes.RolledBack, { sliceId, result })
    return result
  }
}
