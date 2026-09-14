/**
 * The verification engine (Sprint 71).
 *
 * Verification was scattered: a test command here, a typecheck there, a browser
 * check somewhere else, each with its own idea of what failure means. The cost
 * of that is not untidiness — it is that "I could not run the check" and "the
 * check passed" end up looking the same to whatever reads the results, and the
 * run reports PASS.
 *
 * So: one engine, one verdict, and a status vocabulary with UNAVAILABLE in it
 * that is never folded into success. A run with no available check is
 * `unverified`, which is its own outcome and is not a pass.
 *
 * The engine also spends the expensive part of verification — the Sprint 27
 * verifier persona, which is a second model run — IN PROPORTION TO RISK. The
 * mechanical floor costs zero model calls, so a small local edit whose checks
 * all passed is verified by the floor alone. The guarantee survives (nothing
 * passes without an independent verdict) and most of the token cost does not.
 * Every skipped persona run is RECORDED with its reason, because an exception
 * nobody can audit becomes the rule.
 */

export type CheckKind =
  | "build"
  | "lint"
  | "typecheck"
  | "test"
  | "runtime"
  | "browser"
  | "visual"
  | "security"
  /** What the change DID when it ran, as opposed to what its diff looked like. */
  | "side_effect"

export type CheckStatus = "passed" | "failed" | "unavailable" | "skipped"

export interface CheckResult {
  readonly id: string
  readonly kind: CheckKind
  readonly status: CheckStatus
  /** What was actually run. "checked the build" is not evidence. */
  readonly evidence: string
  readonly detail?: string
  readonly durationMs?: number
  /** Model tokens this check cost. 0 for anything mechanical. */
  readonly tokens?: number
}

export type Verdict = "passed" | "failed" | "unverified"

export interface EngineResult {
  readonly verdict: Verdict
  readonly checks: readonly CheckResult[]
  readonly failed: readonly CheckResult[]
  readonly unavailable: readonly CheckResult[]
  readonly why: string
  readonly tokensSpent: number
}

/**
 * Fold checks into one verdict.
 *
 * The order of the rules is the design:
 *
 *   any failure            -> failed. One broken check is not outvoted by nine
 *                             passing ones; verification is not a poll.
 *   nothing ran at all     -> unverified. Not passed, and not failed either:
 *                             "we do not know" is a third thing and pretending
 *                             otherwise in either direction is a lie.
 *   a REQUIRED kind is
 *   unavailable            -> unverified. The check that mattered is the one
 *                             that could not run.
 *   everything else        -> passed.
 */
export function fold(checks: readonly CheckResult[], requiredKinds: readonly CheckKind[] = []): EngineResult {
  const failed = checks.filter((c) => c.status === "failed")
  const unavailable = checks.filter((c) => c.status === "unavailable")
  const passed = checks.filter((c) => c.status === "passed")
  const tokensSpent = checks.reduce((sum, c) => sum + (c.tokens ?? 0), 0)

  if (failed.length > 0)
    return {
      verdict: "failed",
      checks,
      failed,
      unavailable,
      tokensSpent,
      why: `${failed.length} check(s) failed: ${failed.map((f) => `${f.kind}/${f.id}${f.detail !== undefined ? ` (${f.detail})` : ""}`).join("; ")}`,
    }

  if (passed.length === 0)
    return {
      verdict: "unverified",
      checks,
      failed,
      unavailable,
      tokensSpent,
      why:
        checks.length === 0
          ? "no checks were configured at all — there is nothing this run was measured against"
          : `no check produced a result (${unavailable.length} unavailable, ${checks.length - unavailable.length} skipped) — "could not run" is not "passed"`,
    }

  const missingRequired = requiredKinds.filter((kind) => !passed.some((p) => p.kind === kind))
  if (missingRequired.length > 0)
    return {
      verdict: "unverified",
      checks,
      failed,
      unavailable,
      tokensSpent,
      why: `${missingRequired.join(", ")} were required and did not produce a passing result — the check that mattered is the one that could not run`,
    }

  return {
    verdict: "passed",
    checks,
    failed,
    unavailable,
    tokensSpent,
    why: `${passed.length} check(s) passed${unavailable.length > 0 ? `, ${unavailable.length} unavailable and none of them required` : ""}`,
  }
}

// --------------------------------------------------------------------------
// The added requirement: spend the verifier persona in proportion to risk
// --------------------------------------------------------------------------

export interface ChangeProfile {
  readonly filesChanged: number
  /** Sprint 20 risk classes carried by the work. */
  readonly classes: readonly string[]
  /** Sprint 26 protected capabilities touched. */
  readonly protectedAspects: readonly string[]
  /** Did the mechanical floor come out clean? */
  readonly mechanicalFloor: Verdict
}

export interface PersonaDecision {
  readonly runPersona: boolean
  readonly why: string
  /** Recorded whenever the persona is skipped. Never silent. */
  readonly skipRecord?: { readonly reason: string; readonly profile: ChangeProfile }
}

/** Classes a change can carry without leaving the machine it was made on. */
export const LOCAL_CLASSES: readonly string[] = ["read", "local_write"]

/**
 * The classes that put a change beyond a local edit.
 *
 * Exported because two callers need it, and a second copy of "which classes are
 * risky" would drift the first time either was tuned — and drift between two
 * lists that each pass their own tests is invisible until it matters.
 */
export const riskyClasses = (classes: readonly string[]): readonly string[] =>
  classes.filter((c) => !LOCAL_CLASSES.includes(c))

/** Above this many files, a change is not small whatever it touched. */
export const TRIVIAL_FILE_LIMIT = 3

/**
 * Should the second model run happen?
 *
 * The rule reads in one direction only: the persona is SKIPPED for changes that
 * are simultaneously small, unprotected, low-class and mechanically clean.
 * Anything else runs it. That asymmetry is deliberate — the cost of an
 * unnecessary verification is tokens, and the cost of a skipped one is a wrong
 * change that nobody independent looked at.
 *
 * A skip is not silence. `skipRecord` carries the profile that justified it, so
 * a later audit can ask "how often did this fire, and on what?" — the question
 * that catches a threshold quietly drifting until the persona never runs.
 */
export function decidePersona(profile: ChangeProfile): PersonaDecision {
  if (profile.mechanicalFloor !== "passed")
    return { runPersona: true, why: `the mechanical floor came out ${profile.mechanicalFloor}, so judgement has something to judge` }

  if (profile.protectedAspects.length > 0)
    return { runPersona: true, why: `this touches ${profile.protectedAspects.join(", ")} — protected work is reviewed whatever its size` }

  const risky = riskyClasses(profile.classes)
  if (risky.length > 0) return { runPersona: true, why: `risk classes ${risky.join(", ")} are beyond a local edit` }

  if (profile.filesChanged > TRIVIAL_FILE_LIMIT)
    return {
      runPersona: true,
      why: `${profile.filesChanged} files changed, past the ${TRIVIAL_FILE_LIMIT} that counts as small`,
    }

  const reason =
    `mechanically clean, ${profile.filesChanged} file(s), nothing protected, classes ${profile.classes.join(", ") || "read"} — ` +
    `the floor IS the verdict here, and a second model run would buy nothing`
  return { runPersona: false, why: reason, skipRecord: { reason, profile } }
}

export interface VerificationCost {
  readonly runs: number
  readonly personaRuns: number
  readonly personaSkips: number
  readonly tokens: number
  readonly tokensPerRun: number
  readonly skipRate: number
}

/**
 * What verification actually cost.
 *
 * `skipRate` is the number to watch in both directions: near zero means the
 * proportionality rule is doing nothing, and near one means it has eaten the
 * guarantee. Reporting it is the only way either of those gets noticed.
 */
export function summariseCost(
  decisions: readonly PersonaDecision[],
  tokensPerPersonaRun: number,
): VerificationCost {
  const personaRuns = decisions.filter((d) => d.runPersona).length
  const personaSkips = decisions.length - personaRuns
  const tokens = personaRuns * tokensPerPersonaRun
  return {
    runs: decisions.length,
    personaRuns,
    personaSkips,
    tokens,
    tokensPerRun: decisions.length === 0 ? 0 : Math.round(tokens / decisions.length),
    skipRate: decisions.length === 0 ? 0 : personaSkips / decisions.length,
  }
}
