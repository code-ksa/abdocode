/**
 * Console and network observation (Sprint 65), and the escalation ledger that
 * makes vision a last resort rather than a habit (Sprint 66).
 *
 * Sprint 65's rule: a console error during verification blocks PASS unless it
 * is classified and justified. Not "logged". Blocked. A page that throws while
 * the agent declares success is the browser version of the fake completion this
 * whole programme exists to make impossible — and console errors are the
 * easiest signal in the world to collect and the most commonly ignored.
 *
 * Sprint 66's rule is the ladder's enforcement: vision may be used only after a
 * semantic attempt has FAILED and that failure is on the record. The ledger is
 * what turns the ordering rule from advice into a precondition, and it is why
 * the descent can be audited afterwards: every screenshot in the log has a
 * failed selector standing behind it.
 */
import type { ConsoleMessage, NetworkEvent } from "./provider"

export type ErrorDisposition = "blocking" | "known_benign" | "third_party" | "expected_by_test"

export interface ErrorClassification {
  /** Substring or pattern that identifies the message. */
  readonly match: string
  readonly disposition: ErrorDisposition
  /** Why it is not blocking. Required, and required to be a sentence. */
  readonly why: string
}

export interface ConsoleVerdict {
  readonly allowed: boolean
  readonly blocking: readonly ConsoleMessage[]
  readonly excused: readonly { readonly message: ConsoleMessage; readonly why: string }[]
  readonly why: string
}

/**
 * May verification pass, given what the console said?
 *
 * An excuse must NAME the message and give a reason of real length. A
 * classification list of `{match: "", disposition: "known_benign", why: "ok"}`
 * would excuse everything, which is how this kind of gate dies: not by being
 * removed, but by acquiring one entry that matches all.
 */
export function judgeConsole(
  messages: readonly ConsoleMessage[],
  classifications: readonly ErrorClassification[] = [],
): ConsoleVerdict {
  const errors = messages.filter((m) => m.level === "error")
  const blocking: ConsoleMessage[] = []
  const excused: { message: ConsoleMessage; why: string }[] = []

  for (const error of errors) {
    const rule = classifications.find(
      (c) => c.match.length >= 4 && c.why.trim().length >= 20 && c.disposition !== "blocking" && error.text.includes(c.match),
    )
    if (rule === undefined) blocking.push(error)
    else excused.push({ message: error, why: `${rule.disposition}: ${rule.why}` })
  }

  return {
    allowed: blocking.length === 0,
    blocking,
    excused,
    why:
      blocking.length === 0
        ? `${errors.length} console error(s), ${excused.length} classified and justified`
        : `${blocking.length} unclassified console error(s) — the page threw while the agent was about to call this done: ${blocking
            .slice(0, 2)
            .map((m) => m.text.slice(0, 80))
            .join("; ")}`,
  }
}

export interface NetworkVerdict {
  readonly allowed: boolean
  readonly failures: readonly NetworkEvent[]
  readonly why: string
}

/**
 * Network failures during verification.
 *
 * 4xx is included on purpose. A 404 for an asset is the single most common way
 * a page "works" in a screenshot and is broken for a user, and treating only
 * 5xx as failure is how that gets shipped.
 */
export function judgeNetwork(events: readonly NetworkEvent[], ignoreUrls: readonly string[] = []): NetworkVerdict {
  const failures = events.filter(
    (e) => (e.failed === true || (e.status !== undefined && e.status >= 400)) && !ignoreUrls.some((u) => e.url.includes(u)),
  )
  return {
    allowed: failures.length === 0,
    failures,
    why:
      failures.length === 0
        ? `${events.length} request(s), none failed`
        : `${failures.length} failed request(s): ${failures.slice(0, 3).map((f) => `${f.status ?? "ERR"} ${f.url}`).join(", ")}`,
  }
}

// --------------------------------------------------------------------------
// Sprint 66 — the escalation ledger
// --------------------------------------------------------------------------

export type Rung = "dom" | "accessibility" | "semantic" | "vision" | "coordinates"

export const RUNG_ORDER: readonly Rung[] = ["dom", "accessibility", "semantic", "vision", "coordinates"]

export interface AttemptRecord {
  readonly rung: Rung
  readonly target: string
  readonly failed: boolean
  readonly why: string
  readonly at: number
}

/**
 * The record that permits a descent.
 *
 * Deliberately append-only and deliberately per-target: a semantic failure on
 * "Save" does not licence a coordinate click on "Delete". Without that scoping
 * one failed selector anywhere would unlock pixels everywhere, which is exactly
 * how a last resort becomes the default path.
 */
export class EscalationLedger {
  private readonly attempts: AttemptRecord[] = []

  record(attempt: AttemptRecord): void {
    this.attempts.push(attempt)
  }

  history(target?: string): readonly AttemptRecord[] {
    return target === undefined ? this.attempts : this.attempts.filter((a) => a.target === target)
  }

  /**
   * May the agent use this rung for this target?
   *
   * Every rung above it must have been tried and failed for THIS target. The
   * refusal names the rung that was skipped, because "not allowed" without it
   * is a message an agent cannot act on and a human cannot audit.
   */
  mayUse(rung: Rung, target: string): { allowed: boolean; why: string } {
    const index = RUNG_ORDER.indexOf(rung)
    if (index <= 1) return { allowed: true, why: `${rung} is where every action starts` }

    const mine = this.attempts.filter((a) => a.target === target)
    for (const higher of RUNG_ORDER.slice(0, index)) {
      if (higher === "dom" || higher === "accessibility") continue
      const tried = mine.some((a) => a.rung === higher && a.failed)
      if (!tried)
        return {
          allowed: false,
          why: `${rung} needs a recorded ${higher} failure for "${target}" first — a ladder anybody can skip is a preference, and preferences lose to whatever is shortest to write`,
        }
    }
    return {
      allowed: true,
      why: `${RUNG_ORDER.slice(1, index).join(" and ")} failed for "${target}" and the failure is on the record`,
    }
  }

  /** How often the agent reached each rung — the number that shows a habit. */
  usage(): Record<Rung, number> {
    const counts = Object.fromEntries(RUNG_ORDER.map((r) => [r, 0])) as Record<Rung, number>
    for (const attempt of this.attempts) counts[attempt.rung]++
    return counts
  }

  /**
   * Is the agent leaning on the bottom of the ladder?
   *
   * A report rather than an enforcement, because the threshold is a judgement
   * and the number is not. If a tenth of all actions are pixel clicks, the
   * selectors are wrong and no gate will fix that.
   */
  visionHabit(threshold = 0.1): { suspicious: boolean; why: string } {
    const counts = this.usage()
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    if (total === 0) return { suspicious: false, why: "no actions recorded" }
    const low = counts.vision + counts.coordinates
    const rate = low / total
    return rate >= threshold
      ? {
          suspicious: true,
          why: `${(rate * 100).toFixed(0)}% of actions reached vision or coordinates — the selectors are wrong, and no gate fixes that`,
        }
      : { suspicious: false, why: `${(rate * 100).toFixed(0)}% of actions reached the bottom of the ladder` }
  }
}
