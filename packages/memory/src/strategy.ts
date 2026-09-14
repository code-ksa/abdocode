import { chooseStrategy, REPEAT_LIMIT, type FailureRecord, type StrategyDecision } from "./experience"

/**
 * S131 — the strategy repertoire, and the thing that actually breaks a loop.
 *
 * # Changing strategy is not the same as making progress
 *
 * The obvious anti-looping rule is "do not repeat a strategy that failed", and
 * `chooseStrategy` already enforces it. It is not enough, and the way it fails
 * is worth stating because it is what an agent actually does: it cycles.
 * Direct, then inspect, then debug, then decompose, then recover, then direct
 * again — five different labels, five identical outcomes, and nothing learned
 * at any point. Every individual step passes the no-repeat rule. The run is
 * still a loop.
 *
 * So the unit that has to change is not the strategy, it is the **evidence**.
 * An attempt that produced the same evidence as the last one was the same
 * attempt wearing a different name, and this module counts it as such.
 *
 * # Stopping is a decision with a cost on both sides
 *
 * Escalating too late burns the budget; escalating too early abandons a task
 * that was one attempt from done, and that is worse, because it is invisible —
 * the run reports that it stopped responsibly. So there are exactly two ways to
 * stop, and both are named:
 *
 * 1. **Nothing left to try and the evidence has gone still.** Either half alone
 *    is a guess: an untried move means there is genuinely something else to do,
 *    and moving evidence means the last attempt changed something.
 * 2. **The attempt ceiling.** Added because the first rule is unbounded and the
 *    measured sweep proved it — 283 runs in ten thousand learned something new
 *    every single time and never arrived. Evidence that moves forever without
 *    arriving is still a loop.
 */

/**
 * The five moves, declared rather than implied.
 *
 * A repertoire that lives in prompt text is one nobody can count, and "the
 * agent tried everything" is unfalsifiable unless "everything" is a list.
 */
export const REPERTOIRE = {
  direct: "do the thing that was asked, the obvious way",
  inspect: "look at the actual state before deciding anything else",
  debug: "reproduce the failure in the smallest form that still shows it",
  decompose: "split the task where the parts can be checked independently",
  recover: "undo the damage and re-approach from a known state",
} as const

export type Strategy = keyof typeof REPERTOIRE

export const STRATEGIES = Object.keys(REPERTOIRE) as readonly Strategy[]

export interface Attempt {
  readonly taskKind: string
  /** What failed, normalized. Two attempts share a signature when they hit the same wall. */
  readonly signature: string
  readonly strategy: Strategy
  /**
   * What the attempt learned, as a stable key.
   *
   * Callers hash whatever they consider evidence — the error text, the diff,
   * the observed state. What matters is that two attempts that learned nothing
   * new produce the same key, because that is the comparison this module is
   * built on.
   */
  readonly evidence: string
  readonly runId: string
  readonly at: number
}

/** Attempts with no new evidence before the run is declared stuck. */
export const STILLNESS_LIMIT = 3

/**
 * Attempts on one signature before the run stops regardless.
 *
 * "Keep going while the evidence is still moving" is the right rule and it is
 * **unbounded**, which the first measured sweep proved: 283 runs in ten
 * thousand learned something new on every single attempt and never solved
 * anything, so they never went still and never stopped. Evidence that moves
 * forever without arriving is still a loop; it is just a more interesting one.
 *
 * So there are two stop conditions, and both are named. This one is deliberately
 * generous — with five moves and untried ones taken first, a solvable task is
 * reached in about five attempts — so that the cap ends runs that are lost
 * rather than runs that are working. The false-stop rate is measured against
 * exactly that claim.
 */
export const ATTEMPT_LIMIT = 12

export type Decision =
  | { readonly kind: "proceed"; readonly strategy: Strategy; readonly why: string }
  | { readonly kind: "must_change"; readonly forbidden: readonly Strategy[]; readonly why: string }
  | { readonly kind: "escalate"; readonly why: string; readonly tried: readonly Strategy[] }

export interface Request {
  readonly taskKind: string
  readonly signature: string
  readonly preferred: Strategy
  /** Restrict the repertoire, e.g. `recover` is unavailable when nothing is undoable. */
  readonly available?: readonly Strategy[]
}

const toFailureRecord = (attempt: Attempt): FailureRecord => ({
  taskKind: attempt.taskKind,
  signature: attempt.signature,
  strategy: attempt.strategy,
  runId: attempt.runId,
  at: attempt.at,
})

/** Consecutive attempts, most recent first, that learned nothing new. */
export const stillness = (history: readonly Attempt[], request: { taskKind: string; signature: string }): number => {
  const relevant = history.filter(
    (attempt) => attempt.taskKind === request.taskKind && attempt.signature === request.signature,
  )
  if (relevant.length === 0) return 0
  const latest = relevant[relevant.length - 1]!.evidence
  let count = 0
  for (let index = relevant.length - 1; index >= 0; index--) {
    if (relevant[index]!.evidence !== latest) break
    count += 1
  }
  return count
}

/** Strategies not yet tried on this exact failure. */
export const untried = (history: readonly Attempt[], request: Request): readonly Strategy[] => {
  const available = request.available ?? STRATEGIES
  const used = new Set(
    history
      .filter((attempt) => attempt.taskKind === request.taskKind && attempt.signature === request.signature)
      .map((attempt) => attempt.strategy),
  )
  return available.filter((strategy) => !used.has(strategy))
}

/**
 * What to do next.
 *
 * The repeat rule is delegated to `chooseStrategy` rather than reimplemented —
 * two copies of "how many failures forbid a strategy" would disagree the first
 * time either was tuned, and the disagreement would be invisible because each
 * would pass its own tests.
 */
export const next = (history: readonly Attempt[], request: Request): Decision => {
  const available = request.available ?? STRATEGIES
  const stuck = stillness(history, request)
  const remaining = untried(history, request)
  const attempts = history.filter(
    (attempt) => attempt.taskKind === request.taskKind && attempt.signature === request.signature,
  ).length

  if (attempts >= ATTEMPT_LIMIT) {
    return {
      kind: "escalate",
      tried: [...new Set(history.map((attempt) => attempt.strategy))],
      why: `${attempts} attempts on the same failure without solving it — evidence that keeps moving without arriving is still a loop`,
    }
  }

  // Both conditions, never one. Nothing left to try but evidence still moving
  // means the last attempt taught us something and a repeat may now behave
  // differently; still evidence but an untried move left means there is a
  // genuinely different thing to do.
  if (stuck >= STILLNESS_LIMIT && remaining.length === 0) {
    return {
      kind: "escalate",
      tried: [...new Set(history.map((attempt) => attempt.strategy))],
      why: `${stuck} attempts produced identical evidence and every available move has been tried — this is a loop, not persistence`,
    }
  }

  const delegated: StrategyDecision = chooseStrategy(history.map(toFailureRecord), {
    taskKind: request.taskKind,
    signature: request.signature,
    preferred: request.preferred,
    available: [...available],
  })

  if (delegated.kind === "escalate") {
    // The repeat rule wants to stop. Overruled while evidence is still moving:
    // a run that is learning has not run out of ideas, it has run out of
    // *labels*, and stopping there is the expensive kind of wrong.
    if (stuck < STILLNESS_LIMIT) {
      const fallback = remaining[0] ?? available[0]
      if (fallback !== undefined) {
        return {
          kind: "proceed",
          strategy: fallback,
          why: `every strategy has failed ${REPEAT_LIMIT}+ times, but the last ${stuck} attempts each learned something new — the evidence is still moving`,
        }
      }
    }
    return { kind: "escalate", why: delegated.why, tried: delegated.tried as readonly Strategy[] }
  }

  if (delegated.kind === "must_change") {
    const forbidden = delegated.forbidden as readonly Strategy[]
    const alternative = remaining.find((strategy) => !forbidden.includes(strategy))
    if (alternative === undefined) return { kind: "must_change", forbidden, why: delegated.why }
    return { kind: "must_change", forbidden, why: `${delegated.why}; ${alternative} has not been tried` }
  }

  return { kind: "proceed", strategy: delegated.strategy as Strategy, why: delegated.why }
}

export * as StrategyMemoir from "./strategy"
