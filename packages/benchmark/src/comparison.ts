/**
 * Blind comparison (Sprint 36) — twenty tasks, unlabelled, every ten sprints.
 *
 * The reason this is blind is not ceremony. Scoring your own agent against a
 * competitor while knowing which is which produces a number that is always
 * slightly generous, and nobody involved has to be dishonest for that to
 * happen. So the transcripts are relabelled A/B/C, the scoring runs against the
 * labels, and the mapping is revealed after the scores are fixed.
 *
 * The rule that makes the sprint worth having is in `publishComparison`: A LOSS
 * IS PUBLISHED THE WAY A WIN IS. A comparison harness that can be run until it
 * produces a good result is a marketing tool. This one records every completed
 * comparison, and the report cannot be rendered with the losing axes removed —
 * `formatComparison` reads them out of the same array as the wins, so hiding a
 * loss means deleting a result rather than styling a report.
 *
 * What this file does NOT do is run the comparison. That needs provider budget
 * and the owner's authorisation, and a benchmark that fabricates its own
 * numbers would be the worst possible version of this program's own thesis.
 */
import type { BenchAxis } from "./suite-v1"

export interface Contestant {
  /** e.g. "abdo", "rival-a" — the real identity, hidden during scoring. */
  readonly id: string
  readonly version?: string
}

export interface BlindLabel {
  readonly label: string
  readonly contestantId: string
}

/**
 * Assign stable labels without a random number generator.
 *
 * Deterministic on purpose: a comparison that cannot be re-derived from its
 * inputs cannot be audited, and "we shuffled it" is not a record. The order is
 * derived from the round number so consecutive cadences do not reuse the same
 * mapping, and the mapping is written down with the result.
 */
export function assignLabels(contestants: readonly Contestant[], round: number): BlindLabel[] {
  const alphabet = "ABCDEFGH"
  const n = contestants.length
  if (n === 0) return []
  const offset = ((round % n) + n) % n
  return contestants.map((c, i) => ({
    label: alphabet[(i + offset) % n] ?? `X${i}`,
    contestantId: c.id,
  }))
}

export interface AxisResult {
  readonly axis: BenchAxis
  /** label -> score 0..1. Scored against LABELS, never against identities. */
  readonly scores: Readonly<Record<string, number>>
}

export interface ComparisonRound {
  readonly round: number
  /** The sprint after which this cadence fired. */
  readonly afterSprint: number
  readonly labels: readonly BlindLabel[]
  readonly axes: readonly AxisResult[]
  readonly tasksPerAxis: number
  readonly at: number
  /** Anything that stopped an axis being compared — never silently dropped. */
  readonly notRun?: readonly { readonly axis: BenchAxis; readonly why: string }[]
}

export interface AxisVerdictLine {
  readonly axis: BenchAxis
  readonly winner: string
  readonly us: number
  readonly best: number
  readonly weLost: boolean
  readonly margin: number
}

export interface PublishedComparison {
  readonly round: number
  readonly afterSprint: number
  readonly ourId: string
  readonly lines: readonly AxisVerdictLine[]
  readonly wins: readonly BenchAxis[]
  readonly losses: readonly BenchAxis[]
  readonly ties: readonly BenchAxis[]
  readonly notRun: readonly { readonly axis: BenchAxis; readonly why: string }[]
  readonly headline: string
}

/**
 * Reveal the mapping and produce the published result.
 *
 * `lines` holds every axis — won, lost or tied — and `losses` is derived from
 * it rather than supplied. There is no parameter through which a loss could be
 * omitted, which is the only version of "we publish our losses" that survives
 * contact with an incentive to do otherwise.
 */
export function publishComparison(round: ComparisonRound, ourId: string): PublishedComparison {
  const labelOf = new Map(round.labels.map((l) => [l.contestantId, l.label]))
  const idOf = new Map(round.labels.map((l) => [l.label, l.contestantId]))
  const ourLabel = labelOf.get(ourId)

  const lines: AxisVerdictLine[] = round.axes.map((axis) => {
    const entries = Object.entries(axis.scores)
    const best = entries.reduce((a, b) => (b[1] > a[1] ? b : a))
    const us = ourLabel !== undefined ? (axis.scores[ourLabel] ?? 0) : 0
    return {
      axis: axis.axis,
      winner: idOf.get(best[0]) ?? best[0],
      us,
      best: best[1],
      weLost: best[1] > us,
      margin: Math.round((best[1] - us) * 1000) / 1000,
    }
  })

  const losses = lines.filter((l) => l.weLost).map((l) => l.axis)
  const wins = lines.filter((l) => !l.weLost && l.margin === 0 && l.winner === ourId).map((l) => l.axis)
  const ties = lines.filter((l) => !l.weLost && l.winner !== ourId).map((l) => l.axis)

  return {
    round: round.round,
    afterSprint: round.afterSprint,
    ourId,
    lines,
    wins,
    losses,
    ties,
    notRun: round.notRun ?? [],
    headline:
      ourLabel === undefined
        ? `${ourId} did not take part in round ${round.round}`
        : `round ${round.round} (after sprint ${round.afterSprint}): ` +
          `${wins.length} axis win(s), ${losses.length} loss(es), ${ties.length} tie(s)` +
          (round.notRun !== undefined && round.notRun.length > 0 ? `, ${round.notRun.length} not run` : ""),
  }
}

/**
 * The published table.
 *
 * Losses are printed FIRST. A report that buries them under the wins is a
 * report written for the author, and the axis where we are behind is the only
 * part of this document that changes what anybody does next.
 */
export function formatComparison(published: PublishedComparison): string {
  const lines: string[] = [published.headline, ""]
  const order = [...published.lines].sort((a, b) => Number(b.weLost) - Number(a.weLost) || b.margin - a.margin)
  for (const line of order) {
    lines.push(
      `${line.weLost ? "LOST" : "held"}  ${line.axis.padEnd(12)} ` +
        `us ${(line.us * 100).toFixed(0)}%  best ${(line.best * 100).toFixed(0)}% (${line.winner})` +
        (line.weLost ? `  behind by ${(line.margin * 100).toFixed(0)} points` : ""),
    )
  }
  for (const missing of published.notRun) lines.push(`n/a   ${missing.axis.padEnd(12)} not run — ${missing.why}`)
  return lines.join("\n")
}

/** Every ten sprints, starting at the sprint the cadence was declared. */
export const CADENCE_INTERVAL = 10

export function cadenceDue(sprintNumber: number, lastRunAtSprint: number | undefined, from = 36): boolean {
  if (sprintNumber < from) return false
  if (lastRunAtSprint === undefined) return true
  return sprintNumber - lastRunAtSprint >= CADENCE_INTERVAL
}

/**
 * A comparison that has not been run yet is stated as such.
 *
 * This exists so the first cadence has something honest to publish before any
 * provider budget is spent: "not measured" as a first-class result, rather than
 * an absence that reads like a pass.
 */
export function unrunComparison(afterSprint: number, why: string): PublishedComparison {
  return {
    round: 1,
    afterSprint,
    ourId: "abdo",
    lines: [],
    wins: [],
    losses: [],
    ties: [],
    notRun: [],
    headline: `no blind comparison has been run yet (${why}) — no claim of superiority is supported by measurement`,
  }
}
