/**
 * Execution modes — not every request needs the full context pipeline.
 *
 * Running every prompt through the deep path would make V2 needlessly heavy
 * (the exact regression we warned about). The runtime picks a mode and only
 * pays for what the task needs.
 */
export type ExecutionMode = "fast" | "standard" | "deep"

export interface TaskSignals {
  /** Reaches into files / needs code retrieval. */
  readonly touchesFiles?: boolean
  /** Server administration or other high-risk, multi-step work. */
  readonly serverAdmin?: boolean
  /** Approximate prompt size in characters. */
  readonly promptChars?: number
  /** Prior turns in this session (long sessions lean heavier). */
  readonly priorTurns?: number
}

/**
 * fast:    trivial Q&A / single-file edits — recent tail + minimal tools.
 * standard: needs files or some history — targeted retrieval + selected tools.
 * deep:    server admin or long/complex — full planning, memory, verification.
 */
export function selectMode(signals: TaskSignals): ExecutionMode {
  if (signals.serverAdmin) return "deep"
  if ((signals.priorTurns ?? 0) >= 8) return "deep"
  if (signals.touchesFiles) return "standard"
  if ((signals.promptChars ?? 0) > 2000) return "standard"
  return "fast"
}
