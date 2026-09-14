/**
 * Constrained output and bounded repair (Sprint 47).
 *
 * A model asked for JSON produces something JSON-shaped, and the gap between
 * those two is where a large share of agent failures live: a trailing comma, a
 * markdown fence, a helpful sentence before the object, a number written as a
 * word. Each is trivially repairable and each, unrepaired, is a run that died
 * for no reason.
 *
 * Two rules:
 *
 *   1. Repair is BOUNDED and COUNTED. An unbounded repair loop is a way to burn
 *      a budget on a model that cannot produce the shape at all.
 *   2. A repaired result is MARKED. This is the same rule as Sprint 16's
 *      redaction accounting: an output that needed three fixes must not be
 *      indistinguishable from one that arrived clean, because the difference is
 *      the signal that a prompt or a model is wrong.
 *
 * The repairs themselves are mechanical and each one is named. A repair nobody
 * can name is a guess about what the model meant.
 */

export interface RepairStep {
  readonly name: string
  readonly applied: boolean
}

export type ParseOutcome<T> =
  | { readonly kind: "clean"; readonly value: T }
  | { readonly kind: "repaired"; readonly value: T; readonly repairs: readonly string[] }
  | { readonly kind: "failed"; readonly why: string; readonly attempted: readonly string[] }

/** Ordered repairs. Cheapest and least presumptuous first. */
const REPAIRS: readonly { name: string; apply: (s: string) => string }[] = [
  { name: "trim", apply: (s) => s.trim() },
  {
    name: "strip_code_fence",
    apply: (s) => s.replace(/^```(?:json|jsonc|js)?\s*/i, "").replace(/```\s*$/, ""),
  },
  {
    // a model that explains before answering is the most common shape failure
    name: "take_outermost_object",
    apply: (s) => {
      const start = s.search(/[[{]/)
      if (start === -1) return s
      const open = s[start]
      const close = open === "{" ? "}" : "]"
      const end = s.lastIndexOf(close)
      return end > start ? s.slice(start, end + 1) : s
    },
  },
  { name: "remove_trailing_commas", apply: (s) => s.replace(/,(\s*[}\]])/g, "$1") },
  {
    name: "quote_unquoted_keys",
    apply: (s) => s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3'),
  },
  { name: "single_to_double_quotes", apply: (s) => s.replace(/'([^'\\]*)'(\s*[:,}\]])/g, '"$1"$2') },
]

export interface ParseOptions {
  /** How many repairs to attempt. Default: all of them, once each. */
  readonly maxRepairs?: number
  /** Shape check. Return a reason string to reject, or undefined to accept. */
  readonly validate?: (value: unknown) => string | undefined
}

/**
 * Parse a model's output into a value, repairing only what can be named.
 *
 * Each repair is applied cumulatively and re-parsed, so the result reports the
 * shortest sequence that worked rather than every transformation tried. A
 * failure lists what was attempted — "the model did not produce JSON" is not
 * actionable; "these six repairs did not make it parse" is.
 */
export function parseConstrained<T = unknown>(raw: string, options: ParseOptions = {}): ParseOutcome<T> {
  const maxRepairs = options.maxRepairs ?? REPAIRS.length
  const validate = options.validate

  const accept = (text: string): { ok: true; value: T } | { ok: false; why: string } => {
    try {
      const value = JSON.parse(text) as T
      const invalid = validate?.(value)
      return invalid === undefined ? { ok: true, value } : { ok: false, why: invalid }
    } catch (e) {
      return { ok: false, why: e instanceof Error ? e.message : String(e) }
    }
  }

  const direct = accept(raw)
  if (direct.ok) return { kind: "clean", value: direct.value }

  let current = raw
  const applied: string[] = []
  const attempted: string[] = []

  for (const repair of REPAIRS.slice(0, maxRepairs)) {
    attempted.push(repair.name)
    const next = repair.apply(current)
    if (next === current) continue
    current = next
    applied.push(repair.name)
    const result = accept(current)
    if (result.ok) return { kind: "repaired", value: result.value, repairs: applied }
  }

  const final = accept(current)
  if (final.ok) return { kind: "repaired", value: final.value, repairs: applied }

  return {
    kind: "failed",
    why: `${attempted.length} repair(s) did not produce valid output: ${final.why}`,
    attempted,
  }
}

export interface RepairStats {
  readonly total: number
  readonly clean: number
  readonly repaired: number
  readonly failed: number
  readonly byRepair: Readonly<Record<string, number>>
  readonly cleanRate: number
}

/**
 * Repair accounting across a run or a bench pass.
 *
 * The number that matters is `byRepair`: if `strip_code_fence` fires on nine
 * calls out of ten, the prompt is wrong and no amount of repairing fixes the
 * cause. Repair is a shock absorber, and a shock absorber working constantly is
 * a road nobody has looked at.
 */
export function repairStats(outcomes: readonly ParseOutcome<unknown>[]): RepairStats {
  const byRepair: Record<string, number> = {}
  let clean = 0
  let repaired = 0
  let failed = 0

  for (const outcome of outcomes) {
    if (outcome.kind === "clean") clean++
    else if (outcome.kind === "failed") failed++
    else {
      repaired++
      for (const name of outcome.repairs) byRepair[name] = (byRepair[name] ?? 0) + 1
    }
  }

  const total = outcomes.length
  return { total, clean, repaired, failed, byRepair, cleanRate: total === 0 ? 1 : clean / total }
}

/**
 * Is the repair rate telling us something about the prompt?
 *
 * A named threshold rather than a judgement call, so it appears in a report
 * instead of in somebody's memory of last week's numbers.
 */
export function promptSuspicion(stats: RepairStats, threshold = 0.3): { suspicious: boolean; why: string } {
  const dominant = Object.entries(stats.byRepair).sort((a, b) => b[1] - a[1])[0]
  if (dominant === undefined || stats.total === 0)
    return { suspicious: false, why: "nothing needed repairing" }
  const rate = dominant[1] / stats.total
  return rate >= threshold
    ? {
        suspicious: true,
        why: `${dominant[0]} fired on ${(rate * 100).toFixed(0)}% of outputs — that is a prompt problem being absorbed, not a parsing problem being solved`,
      }
    : { suspicious: false, why: `the most common repair (${dominant[0]}) fired on ${(rate * 100).toFixed(0)}% of outputs` }
}
