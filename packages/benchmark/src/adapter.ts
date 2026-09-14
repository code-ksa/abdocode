/**
 * RuntimeAdapter — the seam that lets V1 and V2 be driven by the SAME harness on
 * the same task, worktree, db, provider, and budget. The harness never knows
 * which runtime it is driving; it only compares their outputs.
 */
import type { EventLike, EventMetrics } from "./metrics"

export type RuntimeId = "v1" | "v2"

export interface TaskContext {
  readonly taskId: string
  /** Isolated git worktree the runtime may read and modify. */
  readonly workdir: string
  /** Fresh event-log db for this trial. */
  readonly dbFile: string
  readonly messages: readonly string[]
  readonly timeoutMs: number
}

export interface AdapterRunResult {
  readonly finalState: string
  readonly text?: string
  /**
   * The run's own event log (V2: abdo events -> extractEventMetrics). A runtime
   * whose events are shaped differently (V1) supplies `eventMetrics` directly
   * instead, marking anything it cannot measure as `null` (unavailable).
   */
  readonly events?: readonly EventLike[]
  readonly eventMetrics?: EventMetrics
  /** null when the runtime does not expose first-token timing. */
  readonly timeToFirstTokenMs: number | null
  readonly totalMs: number
  readonly humanApprovals: number
  readonly humanInterventions: number
  readonly recoveryAttempted: boolean
  readonly recoverySucceeded: boolean
}

export interface RuntimeAdapter {
  readonly id: RuntimeId
  run(ctx: TaskContext): Promise<AdapterRunResult>
  close?(): void
}

/** Thrown by an adapter that is not yet wired (e.g. legacy V1). Kept explicit so
 *  a head-to-head is GATED, never silently faked with fabricated numbers. */
export class AdapterNotWiredError extends Error {
  constructor(readonly runtime: RuntimeId) {
    super(`the ${runtime} runtime adapter is not wired — a real head-to-head needs it (see RESULTS.md)`)
    this.name = "AdapterNotWiredError"
  }
}
