/**
 * The regression gate (Sprint 34) and the cost budget (Sprint 35).
 *
 * The owner's rule, which the plan used to enforce only at sprint 96: a sprint
 * does not succeed if it fixed one axis and broke seven. Sixty sprints of
 * unprotected building is how a system arrives at the end better on the axis
 * somebody was watching and worse on every other.
 *
 * So there is a score per axis, and a comparison that BLOCKS. Two design
 * decisions carry the weight:
 *
 *   - a regression stops the close until it is explained OR fixed. Not warned
 *     about. A warning in a build log is a thing that gets scrolled past, and
 *     the whole point is that the cost of ignoring it should be higher than the
 *     cost of writing one sentence about it.
 *   - an axis that was NOT MEASURED this time is not "unchanged". It is
 *     unmeasured, and the gate says so, because a suite that quietly stops
 *     running an axis would otherwise read as a permanent pass on it.
 *
 * Sprint 35 lives here too, because a cost regression is a regression. The
 * runtime is deliberately heavy — a verifier persona is a second model run —
 * and the honest way to carry that is a declared budget per task class that
 * announces every doubling instead of letting it accumulate one sprint at a
 * time.
 */
import type { BenchAxis } from "./suite-v1"

export interface AxisScore {
  readonly axis: BenchAxis
  /** 0..1 — the mean objective score across the axis's scenarios. */
  readonly score: number
  readonly scenarios: number
  /** Scenarios that ran but could not be verified at all. */
  readonly unverified: number
}

export interface Scorecard {
  readonly label: string
  readonly axes: readonly AxisScore[]
  /** Mean tokens and milliseconds per SUCCESSFUL scenario. */
  readonly tokensPerTask?: number
  readonly msPerTask?: number
  readonly at: number
}

export type ChangeKind = "improved" | "unchanged" | "regressed" | "unmeasured" | "new"

export interface AxisChange {
  readonly axis: BenchAxis
  readonly kind: ChangeKind
  readonly before?: number
  readonly after?: number
  readonly delta?: number
}

export interface RegressionVerdict {
  readonly changes: readonly AxisChange[]
  readonly regressed: readonly AxisChange[]
  readonly unmeasured: readonly BenchAxis[]
  readonly blocked: boolean
  readonly reason: string
}

/**
 * How much movement counts as movement.
 *
 * A benchmark over thirty scenarios is noisy, and a threshold of zero turns
 * every run into a blocked close for reasons nobody can act on. Two percentage
 * points is small enough to catch a real break and large enough to survive one
 * flaky scenario.
 */
export const REGRESSION_THRESHOLD = 0.02

export function compareScorecards(before: Scorecard, after: Scorecard): RegressionVerdict {
  const beforeByAxis = new Map(before.axes.map((a) => [a.axis, a]))
  const afterByAxis = new Map(after.axes.map((a) => [a.axis, a]))
  const changes: AxisChange[] = []
  const unmeasured: BenchAxis[] = []

  for (const [axis, previous] of beforeByAxis) {
    const current = afterByAxis.get(axis)
    if (current === undefined) {
      // the axis stopped being measured. Silence here would read as a pass
      // for as long as nobody re-added it.
      unmeasured.push(axis)
      changes.push({ axis, kind: "unmeasured", before: previous.score })
      continue
    }
    const delta = current.score - previous.score
    const kind: ChangeKind =
      delta <= -REGRESSION_THRESHOLD ? "regressed" : delta >= REGRESSION_THRESHOLD ? "improved" : "unchanged"
    changes.push({ axis, kind, before: previous.score, after: current.score, delta })
  }

  for (const [axis, current] of afterByAxis) {
    if (!beforeByAxis.has(axis)) changes.push({ axis, kind: "new", after: current.score })
  }

  const regressed = changes.filter((c) => c.kind === "regressed")
  const blocked = regressed.length > 0 || unmeasured.length > 0
  return {
    changes,
    regressed,
    unmeasured,
    blocked,
    reason: blocked
      ? [
          regressed.length > 0
            ? `regressed: ${regressed.map((r) => `${r.axis} ${(r.before! * 100).toFixed(0)}%→${(r.after! * 100).toFixed(0)}%`).join(", ")}`
            : "",
          unmeasured.length > 0 ? `no longer measured: ${unmeasured.join(", ")}` : "",
        ]
          .filter((s) => s.length > 0)
          .join("; ")
      : `no axis regressed by more than ${(REGRESSION_THRESHOLD * 100).toFixed(0)} points`,
  }
}

export interface RegressionAcknowledgement {
  /** Which axes the explanation covers. An explanation must name them. */
  readonly axes: readonly BenchAxis[]
  readonly why: string
  readonly by: string
}

/**
 * May a sprint close given this comparison?
 *
 * An acknowledgement is accepted, and it has to be SPECIFIC: it names the axes
 * it explains, and it does not cover an axis it did not name. A blanket "known
 * issue" is how a gate becomes a formality — the second one costs nothing to
 * write and covers everything forever.
 */
export function regressionBlocksClose(
  verdict: RegressionVerdict,
  acknowledgement?: RegressionAcknowledgement,
): { allowed: boolean; why: string } {
  if (!verdict.blocked) return { allowed: true, why: verdict.reason }
  if (acknowledgement === undefined)
    return { allowed: false, why: `${verdict.reason} — explain it or fix it; a measured regression does not close` }

  const outstanding = [
    ...verdict.regressed.map((r) => r.axis),
    ...verdict.unmeasured,
  ].filter((axis) => !acknowledgement.axes.includes(axis))

  if (outstanding.length > 0)
    return {
      allowed: false,
      why: `the explanation covers ${acknowledgement.axes.join(", ") || "nothing"} but says nothing about ${outstanding.join(", ")}`,
    }

  if (acknowledgement.why.trim().length < 20)
    return { allowed: false, why: "the explanation is too short to be one" }

  return { allowed: true, why: `regression accepted by ${acknowledgement.by}: ${acknowledgement.why}` }
}

// --------------------------------------------------------------------------
// Sprint 35 — cost and latency budgets
// --------------------------------------------------------------------------

export type TaskClass = "trivial" | "small" | "medium" | "large"

export interface Budget {
  readonly tokens: number
  readonly ms: number
}

/**
 * Declared budgets per task class.
 *
 * These are targets to be MEASURED AGAINST, not limits enforced at runtime.
 * Their job is to make a doubling visible in the sprint that caused it, while
 * the reason is still known — rather than as a mysterious 4x eighty sprints
 * later, when nobody can say which change bought it.
 */
export const TASK_CLASS_BUDGETS: Readonly<Record<TaskClass, Budget>> = {
  trivial: { tokens: 8_000, ms: 30_000 },
  small: { tokens: 25_000, ms: 120_000 },
  medium: { tokens: 80_000, ms: 300_000 },
  large: { tokens: 250_000, ms: 900_000 },
}

export type BudgetStatus = "within" | "over" | "doubled" | "unmeasured"

export interface BudgetVerdict {
  readonly taskClass: TaskClass
  readonly tokens: BudgetStatus
  readonly latency: BudgetStatus
  readonly tokenRatio?: number
  readonly latencyRatio?: number
  readonly mustJustify: boolean
  readonly reason: string
}

/**
 * Compare a measurement against its class budget.
 *
 * `unmeasured` never passes quietly. A runtime that cannot report tokens is a
 * runtime whose cost is unknown, and "unknown" appearing as "within budget" is
 * exactly the substitution this program keeps refusing.
 */
export function evaluateBudget(
  taskClass: TaskClass,
  measured: { tokens: number | null; ms: number | null },
): BudgetVerdict {
  const budget = TASK_CLASS_BUDGETS[taskClass]
  const classify = (value: number | null, limit: number): { status: BudgetStatus; ratio?: number } => {
    if (value === null) return { status: "unmeasured" }
    const ratio = value / limit
    if (ratio >= 2) return { status: "doubled", ratio }
    if (ratio > 1) return { status: "over", ratio }
    return { status: "within", ratio }
  }

  const tokens = classify(measured.tokens, budget.tokens)
  const latency = classify(measured.ms, budget.ms)
  const mustJustify =
    tokens.status === "doubled" ||
    latency.status === "doubled" ||
    tokens.status === "unmeasured" ||
    latency.status === "unmeasured"

  const parts: string[] = []
  if (tokens.status === "unmeasured") parts.push("token cost was not measured")
  else parts.push(`tokens ${(tokens.ratio! * 100).toFixed(0)}% of budget`)
  if (latency.status === "unmeasured") parts.push("latency was not measured")
  else parts.push(`latency ${(latency.ratio! * 100).toFixed(0)}% of budget`)

  return {
    taskClass,
    tokens: tokens.status,
    latency: latency.status,
    ...(tokens.ratio !== undefined ? { tokenRatio: Math.round(tokens.ratio * 100) / 100 } : {}),
    ...(latency.ratio !== undefined ? { latencyRatio: Math.round(latency.ratio * 100) / 100 } : {}),
    mustJustify,
    reason: parts.join("; ") + (mustJustify ? " — this must be justified or refused, not passed over" : ""),
  }
}

/** The scorecard as a human reads it, regressions first. */
export function formatScorecard(verdict: RegressionVerdict): string {
  const order: Record<ChangeKind, number> = { regressed: 0, unmeasured: 1, new: 2, improved: 3, unchanged: 4 }
  const sorted = [...verdict.changes].sort((a, b) => order[a.kind] - order[b.kind])
  const lines = sorted.map((c) => {
    const before = c.before === undefined ? "  -  " : `${(c.before * 100).toFixed(0)}%`.padStart(5)
    const after = c.after === undefined ? "  -  " : `${(c.after * 100).toFixed(0)}%`.padStart(5)
    return `${c.kind.padEnd(11)} ${c.axis.padEnd(12)} ${before} -> ${after}`
  })
  lines.push(verdict.blocked ? `BLOCKED: ${verdict.reason}` : `ok: ${verdict.reason}`)
  return lines.join("\n")
}
