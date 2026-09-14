import { isActive, type Fact, type FactKind } from "./types"

/**
 * S130 — the one definition of "may this fact be used, here, now".
 *
 * # Why this is a module and not a method
 *
 * There are two stores (the in-memory reference and the `bun:sqlite` durable
 * one) and they must not disagree about validity, because the disagreement
 * would be invisible: the same query answered differently depending on which
 * store the run happened to be using is exactly the class of defect this tree
 * keeps paying for. So the rule lives once and both stores call it.
 *
 * # False memory
 *
 * A **false memory** is a fact the run used that it was not entitled to use:
 * expired, out of scope, retired, or below the confidence the caller asked
 * for. It is not a rare pathology — it is the default behaviour of every
 * memory system that filters on "is this row still here" rather than "is this
 * still true, for me, now". The existing `FactStore.current()` filtered on
 * project and status alone and would have served a fact whose `validUntil` had
 * passed; TTL had not been added yet, so the hole had nothing to leak, which
 * is not the same as being closed.
 *
 * Every rejection here carries a reason, and `recall` reports the reasons.
 * A memory system that silently returns fewer rows is one nobody can debug.
 */

export interface Scope {
  readonly projectId: string
  /** Session-scoped facts are invisible outside their session. */
  readonly sessionId?: string
}

export interface Query extends Scope {
  readonly now: number
  readonly kind?: FactKind
  /** Facts below this confidence are refused, and the refusal is reported. */
  readonly minConfidence?: number
}

export type Validity = { readonly ok: true } | { readonly ok: false; readonly why: string }

const VALID: Validity = { ok: true }

/**
 * May this fact answer this query?
 *
 * Ordered so the reported reason is the most fundamental one: a fact that is
 * both retired and out of scope reports the scope, because that is the thing
 * the caller can act on.
 */
export const validFor = (fact: Fact, query: Query): Validity => {
  if (fact.projectId !== query.projectId) {
    return { ok: false, why: `belongs to project ${fact.projectId}, not ${query.projectId}` }
  }
  if (fact.sessionId !== undefined && fact.sessionId !== query.sessionId) {
    return { ok: false, why: `scoped to session ${fact.sessionId}` }
  }
  if (!isActive(fact)) return { ok: false, why: `status is ${fact.status}` }
  if (fact.validUntil !== undefined && query.now >= fact.validUntil) {
    return { ok: false, why: `stopped being valid at ${fact.validUntil}` }
  }
  if (fact.expiresAt !== undefined && query.now >= fact.expiresAt) {
    return { ok: false, why: `expired at ${fact.expiresAt}` }
  }
  if (query.now < fact.validFrom) return { ok: false, why: `not valid until ${fact.validFrom}` }
  if (query.kind !== undefined && fact.kind !== query.kind) {
    return { ok: false, why: `is a ${fact.kind}, not a ${query.kind}` }
  }
  if (query.minConfidence !== undefined && fact.confidence < query.minConfidence) {
    return { ok: false, why: `confidence ${fact.confidence} is below ${query.minConfidence}` }
  }
  return VALID
}

/**
 * The same judgement, ignoring what the caller asked for.
 *
 * Used by the false-memory audit: "the caller wanted architecture decisions and
 * got a project fact" is a filtering mistake, while "the run was handed an
 * expired, out-of-scope, retired fact" is a memory that should not exist. The
 * sprint's <0.5% budget is about the second kind, so the two are separated
 * rather than added together into a number that means neither.
 */
export const intrinsicallyValid = (fact: Fact, scope: Scope, now: number): Validity =>
  validFor(fact, { ...scope, now })

export * as Validity from "./validity"
