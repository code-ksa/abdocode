/**
 * The experience store (Sprint 82), the failure knowledge base (Sprint 83) and
 * strategy selection (Sprint 84).
 *
 * The promise of "the agent learns from experience" is usually delivered as a
 * paragraph the model writes about what it thinks worked, retrieved later and
 * believed. That is not experience; it is a model's opinion of its own past,
 * which is the least reliable thing it produces.
 *
 * So an experience record here is a MEASUREMENT of a run that happened:
 * outcome, attempts, tokens, wall-clock, and the strategy used. Numbers come
 * from recorded runs or they do not exist. There is no field for a narrative.
 *
 * Sprint 83's rule is the one with teeth: a failure seen TWICE must be met with
 * a DIFFERENT strategy on the third attempt, and the ledger proves it. Trying
 * the same thing a third time is the single most common way an agent burns a
 * budget, and it always looks like persistence.
 *
 * Sprint 84 refuses the usual ending. Either the numbers show improvement on
 * repeated tasks, or the report SAYS there was none. "The agent is learning" is
 * a claim, and this program does not accept claims.
 */

export interface ExperienceRecord {
  readonly taskKind: string
  readonly strategy: string
  readonly outcome: "succeeded" | "failed"
  /** Attempts inside this run. */
  readonly attempts: number
  readonly tokens: number
  readonly ms: number
  /** The failure signature, when it failed. */
  readonly failure?: string
  readonly runId: string
  readonly at: number
}

export interface StrategyStats {
  readonly strategy: string
  readonly runs: number
  readonly successes: number
  readonly successRate: number
  readonly medianTokens: number
  readonly medianMs: number
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!
}

/** Median rather than mean: one 40-minute outlier should not move the estimate. */
export function statsFor(records: readonly ExperienceRecord[], taskKind: string): StrategyStats[] {
  const mine = records.filter((r) => r.taskKind === taskKind)
  const byStrategy = new Map<string, ExperienceRecord[]>()
  for (const record of mine) {
    const list = byStrategy.get(record.strategy) ?? []
    list.push(record)
    byStrategy.set(record.strategy, list)
  }
  return [...byStrategy.entries()]
    .map(([strategy, list]) => ({
      strategy,
      runs: list.length,
      successes: list.filter((r) => r.outcome === "succeeded").length,
      successRate: list.filter((r) => r.outcome === "succeeded").length / list.length,
      medianTokens: median(list.map((r) => r.tokens)),
      medianMs: median(list.map((r) => r.ms)),
    }))
    .sort((a, b) => b.successRate - a.successRate || a.medianTokens - b.medianTokens)
}

// --------------------------------------------------------------------------
// Sprint 83 — the failure knowledge base
// --------------------------------------------------------------------------

export interface FailureRecord {
  readonly taskKind: string
  readonly signature: string
  readonly strategy: string
  readonly runId: string
  readonly at: number
}

export type StrategyDecision =
  | { readonly kind: "proceed"; readonly strategy: string; readonly why: string }
  | { readonly kind: "must_change"; readonly forbidden: readonly string[]; readonly why: string }
  | { readonly kind: "escalate"; readonly why: string; readonly tried: readonly string[] }

export const REPEAT_LIMIT = 2

/**
 * May the agent use this strategy again?
 *
 * The rule: a signature that has failed `REPEAT_LIMIT` times under a strategy
 * forbids that strategy for that signature. Not "discourages" — forbids, and
 * names what is now off the table so the caller has to pick something else
 * rather than rephrase the same attempt.
 *
 * When every known strategy is exhausted the answer is ESCALATE, listing what
 * was tried. An agent that has run out of ideas and keeps going is the most
 * expensive thing in this system, and the honest move is to say so.
 */
export function chooseStrategy(
  failures: readonly FailureRecord[],
  request: { taskKind: string; signature: string; preferred: string; available: readonly string[] },
): StrategyDecision {
  const relevant = failures.filter((f) => f.taskKind === request.taskKind && f.signature === request.signature)
  const countByStrategy = new Map<string, number>()
  for (const failure of relevant) countByStrategy.set(failure.strategy, (countByStrategy.get(failure.strategy) ?? 0) + 1)

  const forbidden = [...countByStrategy.entries()].filter(([, n]) => n >= REPEAT_LIMIT).map(([s]) => s)
  const remaining = request.available.filter((s) => !forbidden.includes(s))

  if (remaining.length === 0)
    return {
      kind: "escalate",
      tried: [...countByStrategy.keys()],
      why: `every available strategy has failed on "${request.signature}" at least ${REPEAT_LIMIT} times — an agent that has run out of ideas and keeps going is the most expensive thing here`,
    }

  if (forbidden.includes(request.preferred))
    return {
      kind: "must_change",
      forbidden,
      why: `"${request.preferred}" has already failed ${countByStrategy.get(request.preferred)} times on this exact failure — a third attempt is not persistence, it is the same attempt`,
    }

  return {
    kind: "proceed",
    strategy: request.preferred,
    why:
      forbidden.length > 0
        ? `${request.preferred} is still available; ${forbidden.join(", ")} ruled out by repeated failure`
        : `no repeated failure recorded for "${request.signature}"`,
  }
}

// --------------------------------------------------------------------------
// Sprint 84 — did any of this help?
// --------------------------------------------------------------------------

export interface LearningReport {
  readonly taskKind: string
  readonly earlyRuns: number
  readonly lateRuns: number
  readonly earlySuccessRate: number
  readonly lateSuccessRate: number
  readonly earlyMedianTokens: number
  readonly lateMedianTokens: number
  readonly improved: boolean
  /** The sentence the sprint is required to be able to print either way. */
  readonly statement: string
}

/**
 * Did repetition make this task cheaper or more reliable?
 *
 * Split by ORDER rather than by date, so a burst of runs in one afternoon is
 * compared fairly against a burst a month later.
 *
 * The important branch is the negative one. If the numbers do not improve, this
 * says so in plain words, and that sentence is the deliverable of the sprint
 * exactly as much as a positive one would be. "The agent learns from
 * experience" is a claim; either the medians moved or they did not.
 */
export function reportLearning(records: readonly ExperienceRecord[], taskKind: string, minRuns = 6): LearningReport {
  const mine = records.filter((r) => r.taskKind === taskKind).sort((a, b) => a.at - b.at)

  if (mine.length < minRuns) {
    return {
      taskKind,
      earlyRuns: mine.length,
      lateRuns: 0,
      earlySuccessRate: 0,
      lateSuccessRate: 0,
      earlyMedianTokens: 0,
      lateMedianTokens: 0,
      improved: false,
      statement: `only ${mine.length} run(s) of "${taskKind}" are recorded, and ${minRuns} is the minimum for a comparison worth making — no claim either way`,
    }
  }

  const half = Math.floor(mine.length / 2)
  const early = mine.slice(0, half)
  const late = mine.slice(mine.length - half)

  const rate = (rs: readonly ExperienceRecord[]) => rs.filter((r) => r.outcome === "succeeded").length / rs.length
  const earlySuccessRate = rate(early)
  const lateSuccessRate = rate(late)
  const earlyMedianTokens = median(early.map((r) => r.tokens))
  const lateMedianTokens = median(late.map((r) => r.tokens))

  const moreReliable = lateSuccessRate - earlySuccessRate >= 0.05
  const cheaper = earlyMedianTokens > 0 && lateMedianTokens <= earlyMedianTokens * 0.9
  const improved = moreReliable || cheaper

  const parts = [
    `success ${(earlySuccessRate * 100).toFixed(0)}% -> ${(lateSuccessRate * 100).toFixed(0)}%`,
    `median tokens ${earlyMedianTokens} -> ${lateMedianTokens}`,
  ]

  return {
    taskKind,
    earlyRuns: early.length,
    lateRuns: late.length,
    earlySuccessRate,
    lateSuccessRate,
    earlyMedianTokens,
    lateMedianTokens,
    improved,
    statement: improved
      ? `"${taskKind}" improved over ${mine.length} runs: ${parts.join(", ")}`
      : `"${taskKind}" did NOT improve over ${mine.length} runs: ${parts.join(", ")} — repetition bought nothing measurable here, and saying so is the result`,
  }
}
