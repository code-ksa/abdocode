/**
 * The concurrency dial (owner order, 2026-08-19) — how many agents, not how
 * much agent.
 *
 * Some people want four agents and the wall-clock back. Some people want one
 * agent, a steady pace, and no interest in the clock. Both must get the SAME
 * WORK DONE. That is the whole design constraint and it is easy to state and
 * easy to violate: the moment "run four in parallel" takes a different code
 * path from "run one at a time", the single-agent user is quietly running a
 * lesser product — fewer verifications, a skipped integration step, a cheaper
 * plan gate — and nobody told them.
 *
 * So concurrency is a LANE COUNT over one queue, and nothing else changes.
 * Same personas, same plan gate, same verifier, same evidence, same
 * integration refusal. One lane does everything four lanes do; it takes four
 * times as long, and that is the only difference the user should ever be able
 * to observe.
 *
 * The honest note, since the owner asked about cost: concurrency does not save
 * tokens. Four lanes and one lane issue the same model calls for the same work.
 * What the dial buys is wall-clock, and what it costs is peak memory, peak
 * spend rate, and the disk for N worktrees. A user who does not care about time
 * should run one lane and pay none of that.
 */

export interface WorkItem<T> {
  /** Stable identity. Results are ordered by it, so lanes cannot reorder them. */
  readonly id: string
  readonly run: (lane: number) => Promise<T>
}

export interface WorkOutcome<T> {
  readonly id: string
  readonly ok: boolean
  readonly value?: T
  readonly error?: string
  /** Which lane executed it — for a human reading a parallel run afterwards. */
  readonly lane: number
  readonly startedAt: number
  readonly finishedAt: number
}

export interface ScheduleOptions {
  /** Lanes. 1 = strictly sequential. Values below 1 are treated as 1. */
  readonly concurrency?: number
  /**
   * Stop starting new work after the first failure.
   *
   * Off by default, and deliberately: an agent failing is information about
   * that agent's task, and cancelling three unrelated tasks because a fourth
   * broke turns one failure into four unknowns.
   */
  readonly stopOnFailure?: boolean
  readonly onStart?: (item: { id: string; lane: number }) => void
  readonly onFinish?: (outcome: WorkOutcome<unknown>) => void
  readonly now?: () => number
}

export interface ScheduleReport<T> {
  /** Outcomes in the order the items were DECLARED, whatever order they ran. */
  readonly outcomes: readonly WorkOutcome<T>[]
  readonly lanes: number
  readonly completed: number
  readonly failed: number
  /** Items never started because `stopOnFailure` fired. */
  readonly skipped: readonly string[]
}

/**
 * Run a queue across `concurrency` lanes.
 *
 * Two properties the gate leans on:
 *
 *   - the outcome list is in DECLARATION order, never completion order. A
 *     report whose shape depends on which lane happened to finish first is a
 *     report that cannot be compared across settings, and comparing across
 *     settings is the only way to prove one lane does the work of four.
 *   - a lane that throws records the failure and keeps the other lanes going.
 *     The exception never escapes to the caller, because a scheduler that
 *     rejects on the first bad item destroys the outcomes of every item that
 *     had already succeeded.
 */
export async function runWorkQueue<T>(
  items: readonly WorkItem<T>[],
  options: ScheduleOptions = {},
): Promise<ScheduleReport<T>> {
  const lanes = Math.max(1, Math.floor(options.concurrency ?? 1))
  const now = options.now ?? Date.now
  const outcomes = new Array<WorkOutcome<T> | undefined>(items.length)
  const skipped: string[] = []
  let cursor = 0
  let failed = 0
  let halted = false

  const worker = async (lane: number): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      const item = items[index]!
      if (halted) {
        skipped.push(item.id)
        continue
      }
      options.onStart?.({ id: item.id, lane })
      const startedAt = now()
      let outcome: WorkOutcome<T>
      try {
        const value = await item.run(lane)
        outcome = { id: item.id, ok: true, value, lane, startedAt, finishedAt: now() }
      } catch (e) {
        failed++
        outcome = {
          id: item.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          lane,
          startedAt,
          finishedAt: now(),
        }
        if (options.stopOnFailure === true) halted = true
      }
      outcomes[index] = outcome
      options.onFinish?.(outcome as WorkOutcome<unknown>)
    }
  }

  await Promise.all(Array.from({ length: Math.min(lanes, Math.max(items.length, 1)) }, (_, i) => worker(i + 1)))

  const done = outcomes.filter((o): o is WorkOutcome<T> => o !== undefined)
  return {
    outcomes: done,
    lanes,
    completed: done.filter((o) => o.ok).length,
    failed,
    skipped,
  }
}

/**
 * The part of a report that MUST NOT change when the dial moves.
 *
 * Everything about timing and lane assignment is stripped, leaving what was
 * actually accomplished. Two runs of the same work at different concurrency
 * must produce equal values here — that equality IS the promise that one agent
 * does the work of four.
 */
export function workSignature<T>(report: ScheduleReport<T>): string {
  return JSON.stringify(
    report.outcomes.map((o) => ({
      id: o.id,
      ok: o.ok,
      value: o.value ?? null,
      ...(o.error !== undefined ? { error: o.error } : {}),
    })),
  )
}

/**
 * How much of the wall clock the dial actually bought.
 *
 * Reported rather than assumed: parallel speedup is bounded by the slowest
 * single item, and a work list of one long task and three short ones gets
 * almost nothing from four lanes. Telling the user the real number is more
 * useful than implying the dial is a multiplier.
 */
export function laneUtilisation<T>(report: ScheduleReport<T>): {
  wallClockMs: number
  workMs: number
  speedup: number
} {
  if (report.outcomes.length === 0) return { wallClockMs: 0, workMs: 0, speedup: 1 }
  const start = Math.min(...report.outcomes.map((o) => o.startedAt))
  const end = Math.max(...report.outcomes.map((o) => o.finishedAt))
  const workMs = report.outcomes.reduce((sum, o) => sum + (o.finishedAt - o.startedAt), 0)
  const wallClockMs = end - start
  return { wallClockMs, workMs, speedup: wallClockMs === 0 ? 1 : workMs / wallClockMs }
}
