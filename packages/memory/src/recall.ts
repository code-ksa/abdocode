import type { Fact } from "./types"
import { intrinsicallyValid, validFor, type Query, type Scope } from "./validity"

/**
 * S130 — recall, and the rate it declares about itself.
 *
 * # The number the sprint asks for
 *
 * "False-memory use below 0.5%, **and declared**." The second half is the hard
 * part and the reason this module exists. A system can have a low false-memory
 * rate by accident and have no idea; the requirement is that it **knows**, so
 * every recall carries an audit of what it served and why each rejection
 * happened, and `report` turns a batch of those into a rate somebody can read.
 *
 * A memory system that cannot state its own error rate is one whose errors are
 * discovered by the user.
 */

export interface Rejection {
  readonly id: string
  readonly why: string
}

export interface RecallResult {
  readonly facts: readonly Fact[]
  readonly rejected: readonly Rejection[]
  /**
   * Facts served that were **not** intrinsically valid for the scope and time.
   * Structurally always empty; carried anyway, because a guarantee that is
   * never checked is a comment.
   */
  readonly falseMemories: readonly Rejection[]
}

/**
 * Everything the query is entitled to, and an account of everything it was not.
 *
 * The audit is computed from the served set rather than assumed from the filter
 * that produced it. Auditing the filter with the filter proves the filter
 * agrees with itself.
 */
export const recall = (facts: Iterable<Fact>, query: Query): RecallResult => {
  const served: Fact[] = []
  const rejected: Rejection[] = []
  for (const fact of facts) {
    const verdict = validFor(fact, query)
    if (verdict.ok) served.push(fact)
    else rejected.push({ id: fact.id, why: verdict.why })
  }

  const scope: Scope = { projectId: query.projectId, sessionId: query.sessionId }
  const falseMemories: Rejection[] = []
  for (const fact of served) {
    const independent = intrinsicallyValid(fact, scope, query.now)
    if (!independent.ok) falseMemories.push({ id: fact.id, why: independent.why })
  }

  return { facts: served, rejected, falseMemories }
}

export interface Report {
  readonly recalls: number
  readonly served: number
  readonly falseMemories: number
  /** Served facts that should not have been, as a percentage of served facts. */
  readonly rate: number
  /** The commitment this rate is measured against. */
  readonly budget: number
  readonly withinBudget: boolean
  readonly examples: readonly Rejection[]
}

export const FALSE_MEMORY_BUDGET = 0.5

/**
 * Turn a batch of recalls into the declared number.
 *
 * `served === 0` reports a rate of 0 and says so through `served`, rather than
 * dividing by zero into `NaN` or — worse — into a triumphant `0%` computed
 * from nothing. A system that answered no questions has not earned a low error
 * rate.
 */
export const report = (results: readonly RecallResult[], budget = FALSE_MEMORY_BUDGET): Report => {
  const served = results.reduce((sum, result) => sum + result.facts.length, 0)
  const falseMemories = results.reduce((sum, result) => sum + result.falseMemories.length, 0)
  const rate = served === 0 ? 0 : (falseMemories / served) * 100
  return {
    recalls: results.length,
    served,
    falseMemories,
    rate,
    budget,
    withinBudget: served > 0 && rate <= budget,
    examples: results.flatMap((result) => result.falseMemories).slice(0, 5),
  }
}

export * as Recall from "./recall"
