/**
 * Priority policy + budget planner.
 *
 * The planner is deliberately SEPARATE from the compactor: it only decides what
 * fits a provider envelope, in a fixed priority order, and which low-value items
 * to evict. The compactor (compactor.ts) then turns evicted history into a
 * summary. Nothing here calls a model.
 *
 * Two hard rules:
 *  - Protected kinds are NEVER evicted (current user message, a pending tool call
 *    or a tool result the next turn needs, a security decision, the active step,
 *    currently-modified file names). If those alone overflow, the plan is `ok:
 *    false` with the offending limit — the caller must fail loudly, not silently
 *    drop them.
 *  - Budget is tokens AND bytes AND message count, each with the provider's
 *    safety margin, and output tokens are reserved up front.
 */
import { estimateTokens, byteLength, type ProviderEnvelope } from "@abdo/context"

/**
 * Canonical inclusion priority under context pressure (1 = keep first). Also the
 * documented answer to "where does the current user request sit": above project
 * instructions, below only safety and tool policy. Project instructions shape
 * HOW to do the task; they never outrank the user's actual current request.
 */
export type EntryKind =
  | "system_safety" // 1
  | "tool_policy" // 2
  | "current_user_message" // 3
  | "active_objective" // 4
  | "pending_tool_result" // 5
  | "nearest_instructions" // 6
  | "verified_decision" // 7
  | "recent_tail" // 8
  | "root_instructions" // 9
  | "historical_tool_output" // 10
  | "old_detail" // 11
  // structural protected items (rank alongside their meaning)
  | "pending_tool_call"
  | "active_step"
  | "modified_file"

const RANK: Record<EntryKind, number> = {
  system_safety: 1,
  tool_policy: 2,
  current_user_message: 3,
  active_objective: 4,
  active_step: 4,
  pending_tool_call: 5,
  pending_tool_result: 5,
  nearest_instructions: 6,
  verified_decision: 7,
  recent_tail: 8,
  root_instructions: 9,
  modified_file: 9,
  historical_tool_output: 10,
  old_detail: 11,
}

export const rankOf = (kind: EntryKind): number => RANK[kind]

/** Kinds that must never be compacted or evicted. */
const PROTECTED = new Set<EntryKind>([
  "system_safety",
  "tool_policy",
  "current_user_message",
  "active_objective",
  "active_step",
  "pending_tool_call",
  "pending_tool_result",
  "modified_file",
])

export const isProtected = (kind: EntryKind): boolean => PROTECTED.has(kind)

export interface BudgetCandidate {
  readonly id: string
  readonly kind: EntryKind
  /** Estimated input tokens for this entry (use estimateTokens on its text). */
  readonly tokens: number
  /** Serialized bytes for this entry. */
  readonly bytes: number
}

export interface PlanEntry extends BudgetCandidate {
  readonly rank: number
  readonly reason: string
}

export interface BudgetPlan {
  readonly included: readonly PlanEntry[]
  readonly excluded: readonly PlanEntry[]
  readonly usedTokens: number
  readonly usedBytes: number
  readonly messageCount: number
  readonly usableTokens: number
  readonly usableBytes: number
  /** false when protected entries alone exceed a limit (caller must fail loudly). */
  readonly ok: boolean
  readonly overflow?: { readonly reason: "tokens" | "bytes" | "messages"; readonly limit: number; readonly actual: number }
}

export interface PlanOptions {
  readonly reservedOutputTokens: number
}

/** Build a candidate from text (tokens+bytes estimated consistently with @abdo/context). */
export function candidate(id: string, kind: EntryKind, text: string): BudgetCandidate {
  return { id, kind, tokens: estimateTokens(text), bytes: byteLength(text) }
}

export function planBudget(
  candidates: readonly BudgetCandidate[],
  envelope: ProviderEnvelope,
  options: PlanOptions,
): BudgetPlan {
  const usableTokens = Math.max(0, Math.floor(envelope.maxInputTokens * (1 - envelope.safetyMargin)) - options.reservedOutputTokens)
  const usableBytes =
    envelope.maxRequestBytes !== undefined ? Math.floor(envelope.maxRequestBytes * (1 - envelope.safetyMargin)) : Number.POSITIVE_INFINITY
  const maxMessages = envelope.maxMessages ?? Number.POSITIVE_INFINITY

  // Stable priority sort: rank asc, then original order (so ties keep insertion order).
  const ordered = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rankOf(a.c.kind) - rankOf(b.c.kind) || a.i - b.i)
    .map(({ c }) => c)

  const included: PlanEntry[] = []
  const excluded: PlanEntry[] = []
  let usedTokens = 0
  let usedBytes = 0
  let count = 0
  let ok = true
  let overflow: BudgetPlan["overflow"]

  for (const c of ordered) {
    const protectedEntry = isProtected(c.kind)
    const nextTokens = usedTokens + c.tokens
    const nextBytes = usedBytes + c.bytes
    const nextCount = count + 1
    const fitsTokens = nextTokens <= usableTokens
    const fitsBytes = nextBytes <= usableBytes
    const fitsCount = nextCount <= maxMessages

    if (fitsTokens && fitsBytes && fitsCount) {
      included.push({ ...c, rank: rankOf(c.kind), reason: protectedEntry ? "protected" : "fits-budget" })
      usedTokens = nextTokens
      usedBytes = nextBytes
      count = nextCount
      continue
    }

    if (protectedEntry) {
      // Cannot drop it — include and record the overflow so the caller fails loudly.
      included.push({ ...c, rank: rankOf(c.kind), reason: "protected-over-budget" })
      usedTokens = nextTokens
      usedBytes = nextBytes
      count = nextCount
      if (ok) {
        ok = false
        overflow = !fitsTokens
          ? { reason: "tokens", limit: usableTokens, actual: nextTokens }
          : !fitsBytes
            ? { reason: "bytes", limit: usableBytes, actual: nextBytes }
            : { reason: "messages", limit: maxMessages, actual: nextCount }
      }
      continue
    }

    excluded.push({
      ...c,
      rank: rankOf(c.kind),
      reason: !fitsTokens ? "evicted-tokens" : !fitsBytes ? "evicted-bytes" : "evicted-messages",
    })
  }

  return { included, excluded, usedTokens, usedBytes, messageCount: count, usableTokens, usableBytes, ok, overflow }
}
