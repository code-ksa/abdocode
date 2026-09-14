/**
 * Local-model orchestration (Sprint 48).
 *
 * This is the layer a small local model lives or dies on. A frontier model with
 * a 200k window forgives almost every context mistake; Qwen with 8k forgives
 * none of them, and the failure is never an error message — it is a model that
 * silently stopped seeing the part of the prompt that mattered.
 *
 * The rule everything here follows: A PROMPT THAT DID NOT FIT IS NOT A SMALLER
 * PROMPT. Truncating to fit produces a request that looks well-formed and is
 * missing the instruction, the file, or the error the answer depended on. So
 * `planForWindow` either fits the work, or splits it into steps that each fit,
 * or refuses — and refusing is a real outcome with a real reason.
 */

export interface WindowBudget {
  /** Total context the model can hold. */
  readonly contextTokens: number
  /** Reserved for the model's own answer. */
  readonly reserveForOutput: number
  /** Reserved for the tool schemas (see Sprint 46). */
  readonly reserveForTools: number
}

export interface Piece {
  readonly id: string
  readonly tokens: number
  /** Pieces without which the request is meaningless. Never dropped, ever. */
  readonly required: boolean
  /** Higher is kept first among optional pieces. */
  readonly priority?: number
}

export type WindowPlan =
  | { readonly kind: "fits"; readonly included: readonly string[]; readonly usedTokens: number; readonly headroom: number }
  | {
      readonly kind: "split"
      readonly steps: readonly { readonly step: number; readonly included: readonly string[]; readonly tokens: number }[]
      readonly why: string
    }
  | { readonly kind: "impossible"; readonly why: string; readonly shortfall: number }

export const usable = (budget: WindowBudget): number =>
  budget.contextTokens - budget.reserveForOutput - budget.reserveForTools

/**
 * Fit the work into the window, or split it, or say it cannot be done.
 *
 * The order of the three answers is the point. Dropping optional context is
 * allowed and reported; dropping REQUIRED context is not, at any window size,
 * because a request missing the file it is about is not a cheaper request —
 * it is a wrong answer that will look like a right one.
 */
export function planForWindow(pieces: readonly Piece[], budget: WindowBudget): WindowPlan {
  const room = usable(budget)
  const required = pieces.filter((p) => p.required)
  const optional = pieces.filter((p) => !p.required).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  const requiredTokens = required.reduce((sum, p) => sum + p.tokens, 0)

  if (room <= 0)
    return { kind: "impossible", why: "the reserves leave no room for any content at all", shortfall: -room }

  if (requiredTokens > room) {
    // required content alone does not fit: split it, if the pieces can stand
    // alone; otherwise say so rather than truncating the one that mattered
    const steps: { step: number; included: string[]; tokens: number }[] = []
    let current: { step: number; included: string[]; tokens: number } = { step: 1, included: [], tokens: 0 }
    for (const piece of required) {
      if (piece.tokens > room)
        return {
          kind: "impossible",
          why: `"${piece.id}" needs ${piece.tokens} tokens and the window has room for ${room} — it cannot be sent, and sending part of it would be a request missing the thing it is about`,
          shortfall: piece.tokens - room,
        }
      if (current.tokens + piece.tokens > room) {
        steps.push(current)
        current = { step: steps.length + 1, included: [], tokens: 0 }
      }
      current.included.push(piece.id)
      current.tokens += piece.tokens
    }
    if (current.included.length > 0) steps.push(current)
    return {
      kind: "split",
      steps,
      why: `${requiredTokens} required tokens do not fit in ${room} — split into ${steps.length} steps rather than truncated, because a truncated prompt looks well-formed and is missing what the answer depended on`,
    }
  }

  const included = required.map((p) => p.id)
  let used = requiredTokens
  for (const piece of optional) {
    if (used + piece.tokens > room) continue
    included.push(piece.id)
    used += piece.tokens
  }

  return { kind: "fits", included, usedTokens: used, headroom: room - used }
}

export interface RetrievalCandidate {
  readonly id: string
  readonly tokens: number
  /** 0..1 relevance from whatever retriever produced it. */
  readonly score: number
}

/**
 * Choose retrieved context for a small window.
 *
 * A relevance floor rather than a fixed top-k. Top-k on a small window fills it
 * with the least relevant of the k when the corpus has only two good matches,
 * and the model then reasons over noise it had no way to discount. Below the
 * floor, sending nothing is better than sending something.
 */
export function selectRetrieval(
  candidates: readonly RetrievalCandidate[],
  roomTokens: number,
  minScore = 0.35,
): { chosen: string[]; tokens: number; droppedForScore: number; droppedForRoom: number } {
  const eligible = candidates.filter((c) => c.score >= minScore).sort((a, b) => b.score - a.score)
  const chosen: string[] = []
  let tokens = 0
  let droppedForRoom = 0

  for (const candidate of eligible) {
    if (tokens + candidate.tokens > roomTokens) {
      droppedForRoom++
      continue
    }
    chosen.push(candidate.id)
    tokens += candidate.tokens
  }

  return {
    chosen,
    tokens,
    droppedForScore: candidates.length - eligible.length,
    droppedForRoom,
  }
}

export interface ModelComparison {
  readonly task: string
  readonly local: { readonly passed: boolean; readonly tokens: number; readonly ms: number; readonly steps: number }
  readonly cloud: { readonly passed: boolean; readonly tokens: number; readonly ms: number; readonly steps: number }
}

/**
 * State the gap between local and cloud, in both directions.
 *
 * The S48 gate asks for the difference to be MEASURED AND STATED, so this
 * refuses to produce a one-word verdict. A local model that passes in four
 * times the steps for a twentieth of the cost is neither "as good" nor "worse"
 * — it is a trade, and whoever reads this should see both halves and choose.
 */
export function stateTheGap(comparison: ModelComparison): string {
  const { local, cloud, task } = comparison
  const lines = [
    `task      ${task}`,
    `local     ${local.passed ? "PASSED" : "failed"}  ${local.steps} steps, ${local.tokens} tokens, ${(local.ms / 1000).toFixed(1)}s`,
    `cloud     ${cloud.passed ? "PASSED" : "failed"}  ${cloud.steps} steps, ${cloud.tokens} tokens, ${(cloud.ms / 1000).toFixed(1)}s`,
  ]
  if (local.passed && cloud.passed) {
    lines.push(
      `gap       both completed it; local took ${(local.steps / Math.max(cloud.steps, 1)).toFixed(1)}x the steps ` +
        `and ${(local.ms / Math.max(cloud.ms, 1)).toFixed(1)}x the time. Whether that is a good trade depends on what the tokens cost you.`,
    )
  } else if (local.passed && !cloud.passed) {
    lines.push("gap       the local model completed a task the cloud model did not — worth investigating before believing it")
  } else if (!local.passed) {
    lines.push(`gap       the local model did NOT complete this task${cloud.passed ? ", the cloud model did" : "; neither did the cloud model"}`)
  }
  return lines.join("\n")
}
