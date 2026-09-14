import { estimateTokens } from "@abdo/schema/tokens"

/**
 * S129 — the context compiler.
 *
 * Candidates in, a selection that fits the window out, with a reason recorded
 * for everything left behind.
 *
 * # One estimator, and why that is the sprint's first condition
 *
 * A survey on 2026-08-20 found **four** token estimators in one binary — three
 * dividing by 4 and one by 3 — so the context compiler sized a text at N while
 * the window manager sized the same text at 1.33N. Context was packed to a
 * budget computed one way and measured another. This module counts with
 * `@abdo/schema/tokens` and nothing else; the guard in
 * `packages/context/test/single-estimator.test.ts` reddens if a second
 * definition appears anywhere in a package source tree.
 *
 * # A pinned item is not a preference
 *
 * If the pinned set alone does not fit, this **refuses**. It does not drop the
 * lowest-priority pin and carry on. That is the difference between a budget and
 * a suggestion: a run that quietly loses the constraint "never touch the
 * session store" because the window was tight is worse than a run that stops
 * and says the window is too small — the first one proceeds, confidently, to do
 * the forbidden thing.
 *
 * # Dropping is recorded, never silent
 *
 * Every candidate that does not make it carries the reason it did not. A
 * compiler that returns only what it kept is indistinguishable from one that
 * lost half its input to a bug.
 */

export type CandidateKind = "constraint" | "instruction" | "file" | "history" | "tool"

export interface Candidate {
  /** Stable key, so the same input compiles the same way. */
  readonly key: string
  readonly text: string
  readonly kind: CandidateKind
  /**
   * Must survive compilation. Reserved for what the run is not allowed to
   * forget: the goal, the critical commitments, the constraints it is bound by.
   */
  readonly pinned?: boolean
  /** Caller-supplied task relevance in [0,1]. Not inferred here. */
  readonly relevance: number
}

export interface Dropped {
  readonly key: string
  readonly why: string
}

export interface Compiled {
  readonly kept: readonly Candidate[]
  readonly dropped: readonly Dropped[]
  readonly tokensBefore: number
  readonly tokensAfter: number
  /** Fraction of input tokens removed, in [0,1]. */
  readonly saved: number
}

export type Result = { readonly ok: true; readonly compiled: Compiled } | { readonly ok: false; readonly why: string }

export const tokensOf = (candidate: Candidate): number => estimateTokens(candidate.text)

const total = (candidates: readonly Candidate[]) =>
  candidates.reduce((sum, candidate) => sum + tokensOf(candidate), 0)

/**
 * Value per token, which is what a budget actually spends on.
 *
 * Ranking by relevance alone fills the window with one enormous file that
 * happened to score 0.9 and starves ten small items that together carry more of
 * the task. Dividing by cost is the whole reason a compiler beats a filter.
 */
const density = (candidate: Candidate) => candidate.relevance / Math.max(1, tokensOf(candidate))

export interface CompileOptions {
  /** Token ceiling for the compiled context. */
  readonly budgetTokens: number
  /**
   * Relevance at or above which an item is considered relevant to the task.
   * Used by the recall measurement; the compiler itself ranks continuously.
   */
  readonly relevantAt?: number
}

export const RELEVANT_AT = 0.6

/**
 * Compile a candidate set down to the budget.
 *
 * Deterministic: ties break on the key, so the same input always produces the
 * same context. A compiler whose output depends on input ordering makes every
 * downstream comparison — replay, caching, diffing two runs — meaningless.
 */
export const compile = (candidates: readonly Candidate[], options: CompileOptions): Result => {
  if (!Number.isFinite(options.budgetTokens) || options.budgetTokens <= 0) {
    return { ok: false, why: "the budget must be a positive number of tokens" }
  }

  const tokensBefore = total(candidates)
  const pinned = candidates.filter((candidate) => candidate.pinned === true)
  const rest = candidates.filter((candidate) => candidate.pinned !== true)

  const pinnedTokens = total(pinned)
  if (pinnedTokens > options.budgetTokens) {
    // Refusal, not truncation. See the module comment.
    return {
      ok: false,
      why: `pinned context needs ${pinnedTokens} tokens and the budget is ${options.budgetTokens}`,
    }
  }

  const ranked = [...rest].sort((left, right) => density(right) - density(left) || left.key.localeCompare(right.key))

  const kept: Candidate[] = [...pinned]
  const dropped: Dropped[] = []
  let used = pinnedTokens

  for (const candidate of ranked) {
    const cost = tokensOf(candidate)
    if (used + cost <= options.budgetTokens) {
      kept.push(candidate)
      used += cost
      continue
    }
    dropped.push({
      key: candidate.key,
      why: `needs ${cost} tokens, ${options.budgetTokens - used} left`,
    })
  }

  return {
    ok: true,
    compiled: {
      // Input order is preserved in the output so a reader can follow it back
      // to the candidate list; ranking decided membership, not layout.
      kept: candidates.filter((candidate) => kept.includes(candidate)),
      dropped,
      tokensBefore,
      tokensAfter: used,
      saved: tokensBefore === 0 ? 0 : (tokensBefore - used) / tokensBefore,
    },
  }
}

export interface Recall {
  readonly pinnedTotal: number
  readonly pinnedKept: number
  readonly relevantTotal: number
  readonly relevantKept: number
}

/** What the compilation retained, by class. The numbers the sprint is graded on. */
export const recall = (candidates: readonly Candidate[], compiled: Compiled, relevantAt = RELEVANT_AT): Recall => {
  const kept = new Set(compiled.kept.map((candidate) => candidate.key))
  const pinnedAll = candidates.filter((candidate) => candidate.pinned === true)
  const relevantAll = candidates.filter(
    (candidate) => candidate.pinned !== true && candidate.relevance >= relevantAt,
  )
  return {
    pinnedTotal: pinnedAll.length,
    pinnedKept: pinnedAll.filter((candidate) => kept.has(candidate.key)).length,
    relevantTotal: relevantAll.length,
    relevantKept: relevantAll.filter((candidate) => kept.has(candidate.key)).length,
  }
}

export * as ContextCompiler from "./compiler"
