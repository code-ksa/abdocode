/**
 * Transactional slices (Sprint 18) — a change carries the four things that make
 * it reversible, and a failure undoes ONE of them.
 *
 * Compensation already existed, but only for a tool that FAILED after it had
 * begun writing. A tool that succeeded and left the wrong state behind was
 * never undone: the mutation reported ok, the run carried on, and the only
 * signal was a verification failure much later with nothing left to point at.
 *
 * A slice makes the unit explicit:
 *
 *   precondition   may this run at all, given the state right now
 *   mutation       the change itself
 *   postcondition  is the state now what the change was supposed to produce
 *   rollback       how to put it back if it is not
 *
 * The rule the gate enforces is the narrow one: a failing postcondition rolls
 * back THAT slice and nothing else. Earlier slices are committed work — undoing
 * them because a later step went wrong turns one bad change into a cascade, and
 * a cascade is far harder to reason about than a single stuck slice.
 */
import type { DomainEvent } from "./event"

export const SliceEventTypes = {
  Started: "slice.started",
  PreconditionChecked: "slice.precondition_checked",
  Mutated: "slice.mutated",
  PostconditionChecked: "slice.postcondition_checked",
  RolledBack: "slice.rolled_back",
  Completed: "slice.completed",
  Failed: "slice.failed",
} as const

export type SliceState =
  /** The precondition said no; nothing was changed. */
  | "refused"
  /** Mutation applied, postcondition passed. */
  | "committed"
  /** Postcondition failed and the change was put back. */
  | "rolled_back"
  /**
   * Postcondition failed and the change could NOT be put back — no rollback was
   * supplied, or the rollback itself failed. Recorded as its own state because
   * calling it "rolled_back" would be the most dangerous lie in this file.
   */
  | "stuck"
  /** The mutation itself failed. */
  | "failed"
  /** Started and never finished — the crash shape. */
  | "in_flight"

export interface SliceCheck {
  readonly ok: boolean
  readonly detail?: string
}

export interface SliceRecord {
  readonly sliceId: string
  readonly runId: string
  readonly description?: string
  readonly state: SliceState
  readonly precondition?: SliceCheck
  readonly postcondition?: SliceCheck
  readonly rollback?: SliceCheck
  /** Tool executions this slice performed, in order. */
  readonly operationIds: readonly string[]
  readonly startedAt: number
  readonly finishedAt?: number
  readonly error?: string
  readonly sequences: readonly number[]
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
const check = (v: unknown): SliceCheck | undefined => {
  const c = v as { ok?: unknown; detail?: unknown } | undefined
  if (c === undefined || typeof c.ok !== "boolean") return undefined
  return { ok: c.ok, ...(typeof c.detail === "string" ? { detail: c.detail } : {}) }
}

interface Draft {
  sliceId: string
  runId: string
  description?: string
  state: SliceState
  precondition?: SliceCheck
  postcondition?: SliceCheck
  rollback?: SliceCheck
  operationIds: string[]
  startedAt: number
  finishedAt?: number
  error?: string
  sequences: number[]
}

/** What the log says about every slice, in the order they started. */
export function foldSlices(events: readonly DomainEvent[], runId?: string): SliceRecord[] {
  const drafts = new Map<string, Draft>()

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>
    const sliceId = str(data.sliceId)
    if (sliceId === undefined) continue
    const eventRunId = str(data.runId)
    if (runId !== undefined && eventRunId !== runId) continue
    const seq = Number(event.sequence)

    let d = drafts.get(sliceId)
    if (d === undefined) {
      d = {
        sliceId,
        runId: eventRunId ?? "",
        state: "in_flight",
        operationIds: [],
        startedAt: event.occurredAt,
        sequences: [],
      }
      drafts.set(sliceId, d)
    }
    d.sequences.push(seq)

    switch (event.type) {
      case SliceEventTypes.Started:
        d.startedAt = event.occurredAt
        d.description = str(data.description) ?? d.description
        break
      case SliceEventTypes.PreconditionChecked: {
        d.precondition = check(data.result)
        if (d.precondition?.ok === false) {
          d.state = "refused"
          d.finishedAt = event.occurredAt
        }
        break
      }
      case SliceEventTypes.Mutated: {
        const ops = Array.isArray(data.operationIds) ? data.operationIds.filter((o): o is string => typeof o === "string") : []
        d.operationIds.push(...ops)
        break
      }
      case SliceEventTypes.PostconditionChecked:
        d.postcondition = check(data.result)
        break
      case SliceEventTypes.RolledBack: {
        d.rollback = check(data.result)
        d.state = d.rollback?.ok === true ? "rolled_back" : "stuck"
        d.finishedAt = event.occurredAt
        break
      }
      case SliceEventTypes.Completed:
        d.state = "committed"
        d.finishedAt = event.occurredAt
        break
      case SliceEventTypes.Failed: {
        // A failure AFTER a mutation with no rollback is stuck, not merely
        // failed: something changed and nothing put it back.
        d.error = str(data.error) ?? d.error
        d.state = str(data.state) === "stuck" ? "stuck" : "failed"
        d.finishedAt = event.occurredAt
        break
      }
    }
  }

  return [...drafts.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((d) => ({
      sliceId: d.sliceId,
      runId: d.runId,
      ...(d.description !== undefined ? { description: d.description } : {}),
      state: d.state,
      ...(d.precondition !== undefined ? { precondition: d.precondition } : {}),
      ...(d.postcondition !== undefined ? { postcondition: d.postcondition } : {}),
      ...(d.rollback !== undefined ? { rollback: d.rollback } : {}),
      operationIds: d.operationIds,
      startedAt: d.startedAt,
      ...(d.finishedAt !== undefined ? { finishedAt: d.finishedAt } : {}),
      ...(d.error !== undefined ? { error: d.error } : {}),
      sequences: d.sequences,
    }))
}

/**
 * Slices that changed something and could not put it back.
 *
 * This is the list a human has to see. Everything else in the taxonomy can be
 * retried or ignored; a stuck slice means the world is in a state nobody chose.
 */
export const stuckSlices = (events: readonly DomainEvent[], runId?: string): SliceRecord[] =>
  foldSlices(events, runId).filter((s) => s.state === "stuck")
