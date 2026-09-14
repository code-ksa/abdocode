/**
 * Layered memory (Sprint 80) and retrieval budgeting (Sprint 81).
 *
 * The failure this removes is the one a small local model dies of: a context
 * filled with things that were relevant once. Every long task accumulates
 * facts, and an agent that keeps them all runs out of window; an agent that
 * drops them by age forgets the constraint it was given in the first message.
 *
 * So memory has LAYERS with different rules:
 *
 *   L0  the standing rules and the objective. Always present, never evicted,
 *       kept small enough that "always" is affordable.
 *   L1  project facts — the DNA. Present when working in that project.
 *   L2  retrievable on relevance. The bulk.
 *   L3  archive. Never retrieved automatically; searched when asked.
 *
 * Sprint 81's requirement is the one worth getting right: exceeding the budget
 * must be IMPOSSIBLE BY CONSTRUCTION, not discouraged. So `assemble` returns
 * what fits and reports what it dropped; there is no path through this file
 * that produces a context larger than the budget it was given, and the check is
 * not a warning anybody can ignore.
 */

export type Layer = "L0" | "L1" | "L2" | "L3"

export interface MemoryItem {
  readonly id: string
  readonly layer: Layer
  readonly text: string
  /** Cost in tokens. Measured by the caller; this never estimates. */
  readonly tokens: number
  /** 0..1 relevance to the current objective, for L2. */
  readonly relevance?: number
  readonly at: number
}

export interface AssemblyBudget {
  readonly totalTokens: number
  /** Minimum share L0 may occupy. Below this the budget is unusable. */
  readonly minL0?: number
}

export interface Assembly {
  /**
   * Present and false on purpose: a union whose members share no key is a
   * union TypeScript cannot narrow, and a narrowing that only works because
   * of a helper is one the next caller will get wrong.
   */
  readonly impossible?: false
  readonly included: readonly MemoryItem[]
  readonly droppedForBudget: readonly { readonly id: string; readonly layer: Layer; readonly tokens: number }[]
  readonly usedTokens: number
  readonly budget: number
  readonly byLayer: Readonly<Record<Layer, number>>
  readonly why: string
}

export type AssemblyResult = Assembly | { readonly impossible: true; readonly why: string; readonly shortfall: number }

/**
 * Narrow on the POSITIVE side.
 *
 * A predicate written as `r is TheFailureCase` narrows its false branch through
 * `Exclude`, which only filters a union member the predicate type matches
 * exactly — and "exactly" includes `readonly`. Getting that subtly wrong gives
 * a helper that compiles, reads correctly, and narrows nothing, which is worse
 * than no helper because every call site then looks safe.
 */
export const isAssembly = (r: AssemblyResult): r is Assembly => (r as Assembly).included !== undefined

export const isImpossible = (r: AssemblyResult): boolean => !isAssembly(r)

/**
 * Assemble a context from memory, within a budget that cannot be exceeded.
 *
 * L0 first and whole. If L0 alone does not fit, the result is IMPOSSIBLE rather
 * than a truncated L0 — the standing rules half-present are worse than absent,
 * because the agent behaves as though it has them.
 *
 * L2 is chosen by relevance and never by recency. Recency is a proxy that fails
 * exactly when it matters: the constraint from the first message is the oldest
 * item in memory and usually the most important.
 *
 * L3 is never included automatically. An archive that leaks into every context
 * is not an archive.
 */
export function assemble(items: readonly MemoryItem[], budget: AssemblyBudget): AssemblyResult {
  const l0 = items.filter((i) => i.layer === "L0")
  const l1 = items.filter((i) => i.layer === "L1")
  const l2 = items.filter((i) => i.layer === "L2").sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))

  const l0Tokens = l0.reduce((sum, i) => sum + i.tokens, 0)
  if (l0Tokens > budget.totalTokens)
    return {
      impossible: true,
      why: `the standing rules alone need ${l0Tokens} tokens and the budget is ${budget.totalTokens} — half the rules present is worse than none, because the agent behaves as though it has them`,
      shortfall: l0Tokens - budget.totalTokens,
    }

  const minL0 = budget.minL0 ?? 0
  if (l0Tokens < minL0)
    return {
      impossible: true,
      why: `L0 holds ${l0Tokens} tokens, below the ${minL0} this configuration requires — the standing rules are missing, not merely small`,
      shortfall: minL0 - l0Tokens,
    }

  const included: MemoryItem[] = [...l0]
  const dropped: { id: string; layer: Layer; tokens: number }[] = []
  let used = l0Tokens

  for (const item of [...l1, ...l2]) {
    if (used + item.tokens > budget.totalTokens) {
      dropped.push({ id: item.id, layer: item.layer, tokens: item.tokens })
      continue
    }
    included.push(item)
    used += item.tokens
  }

  for (const item of items.filter((i) => i.layer === "L3")) {
    dropped.push({ id: item.id, layer: "L3", tokens: item.tokens })
  }

  const byLayer = { L0: 0, L1: 0, L2: 0, L3: 0 } as Record<Layer, number>
  for (const item of included) byLayer[item.layer] += item.tokens

  return {
    included,
    droppedForBudget: dropped,
    usedTokens: used,
    budget: budget.totalTokens,
    byLayer,
    why:
      `${included.length} item(s), ${used}/${budget.totalTokens} tokens ` +
      `(L0 ${byLayer.L0}, L1 ${byLayer.L1}, L2 ${byLayer.L2})` +
      (dropped.length > 0 ? `; ${dropped.length} left out` : ""),
  }
}

/**
 * Explicit retrieval from the archive.
 *
 * The only way L3 enters a context: somebody asked for it, by query, with a
 * bound. Automatic archive retrieval is how a memory system quietly becomes a
 * context filler.
 */
export function searchArchive(
  items: readonly MemoryItem[],
  query: string,
  maxTokens: number,
): { found: MemoryItem[]; tokens: number; truncated: boolean } {
  const needle = query.toLowerCase().trim()
  if (needle.length === 0) return { found: [], tokens: 0, truncated: false }

  const matches = items
    .filter((i) => i.layer === "L3" && i.text.toLowerCase().includes(needle))
    .sort((a, b) => b.at - a.at)

  const found: MemoryItem[] = []
  let tokens = 0
  let truncated = false
  for (const item of matches) {
    if (tokens + item.tokens > maxTokens) {
      truncated = true
      continue
    }
    found.push(item)
    tokens += item.tokens
  }
  return { found, tokens, truncated }
}

/**
 * Move an item down a layer.
 *
 * Demotion rather than deletion, because this program has spent forty sprints
 * establishing that evidence of a past state is worth keeping. L0 is never
 * demoted automatically: the standing rules leave by a human's decision.
 */
export function demote(item: MemoryItem): MemoryItem {
  const next: Record<Layer, Layer> = { L0: "L0", L1: "L2", L2: "L3", L3: "L3" }
  return { ...item, layer: next[item.layer] }
}
