/**
 * S133 — the verification network.
 *
 * `fold` in the engine answers one question well: given these check results,
 * what is the verdict. It has a hole underneath it that nothing in this package
 * closes, and the hole is not in the folding rules — it is in the word "given".
 *
 * A `CheckResult` is data. The actor that wrote the patch can write one:
 *
 *     { kind: "test", status: "passed", evidence: "I ran the tests" }
 *
 * and `fold` returns `passed`, correctly, because the rules it applies are
 * sound and the input is a lie. The engine was built so that "I could not run
 * the check" would never read as "the check passed"; the remaining case is the
 * one where "I say it is fine" reads as "something independent found it fine".
 *
 * So the network is not a second verdict rule. It is an ADMISSION rule that
 * runs before the fold and decides which claims are entitled to be counted as
 * evidence, and then delegates the verdict — because two ideas of what a
 * failure means would disagree the first time either was tuned, and the
 * disagreement would be invisible: each passes its own tests.
 *
 * The distinction it turns on is not who ran the check. It is whether the
 * result is a MEASUREMENT or an ASSERTION. A compiler does not share the
 * author's belief about the patch, so a build the author ran is evidence. A
 * judgement the author formed about their own work is the belief itself,
 * restated. That is why the rule is asymmetric, and the asymmetry is the design:
 *
 *     a self-claim can condemn, and it cannot acquit.
 *
 * Believing an author who says their own change is broken costs nothing and
 * refusing to is perverse. Believing one who says it is fine is the entire
 * failure mode.
 *
 * WHAT THIS CANNOT DO, said plainly: it cannot detect a fabricated measurement.
 * An actor that invents an exit code defeats it, exactly as `judgeTests` cannot
 * detect a mock nobody declared. What it can do is make the honest case
 * checkable and force the dishonest case to be a deliberate lie about a fact,
 * rather than an ordinary optimistic sentence about one's own work.
 */
import { fold, riskyClasses, type CheckKind, type CheckResult, type EngineResult, type Verdict } from "./engine"

export type Actor = string

/**
 * Did the author's reasoning reach this validator?
 *
 * A reviewer handed the patch together with the explanation of why it is
 * correct is not an independent look at the patch — it is a second reading of
 * the explanation, and it inherits whatever the explanation got wrong. Clean
 * context is what makes a second opinion a second opinion.
 */
export type ContextPurity = "clean" | "contaminated"

/**
 * Who produced this result.
 *
 * `mechanical` is a tool: a compiler, a test runner, a scanner, a sandbox. It
 * has no opinion about the patch and no stake in it.
 * `judged` is somebody who read something and formed a view.
 */
export type Witness =
  | { readonly sort: "mechanical"; readonly tool: string }
  | { readonly sort: "judged"; readonly by: Actor; readonly context: ContextPurity; readonly contaminatedBy?: string }

export interface AttributedCheck extends CheckResult {
  readonly witness: Witness
}

/** Two witnesses are the same witness if they are the same tool or the same actor. */
export const witnessId = (witness: Witness): string =>
  witness.sort === "mechanical" ? `tool:${witness.tool}` : `actor:${witness.by}`

// --------------------------------------------------------------------------
// Criticality — derived from surface, never asserted
// --------------------------------------------------------------------------

export type Criticality = "ordinary" | "critical"

export interface PatchProfile {
  readonly id: string
  readonly author: Actor
  readonly filesChanged: number
  /** Risk classes carried by the work, in the vocabulary the engine already uses. */
  readonly classes: readonly string[]
  /** Protected capabilities touched. */
  readonly protectedAspects: readonly string[]
}

/**
 * Is this critical work?
 *
 * From the surface it touches, not from its size and not from anybody saying
 * so. Size is `decidePersona`'s question — a one-line change to a permission
 * check is small and critical, and a thousand-line rename is neither.
 *
 * The classes come from `riskyClasses` rather than a list kept here, so that
 * "which classes are beyond a local edit" has one answer in this package.
 */
export function criticalityOf(profile: PatchProfile): Criticality {
  if (profile.protectedAspects.length > 0) return "critical"
  if (riskyClasses(profile.classes).length > 0) return "critical"
  return "ordinary"
}

// --------------------------------------------------------------------------
// The demand — what evidence has to exist BEFORE anything is judged
// --------------------------------------------------------------------------

/**
 * `security` is here and not only in the critical list because the scanner is
 * mechanical and costs nothing, and because the shape it catches does not
 * respect the surface: an API key committed in an otherwise local edit is an
 * ordinary patch by every classification and a critical event by every other
 * measure. The sweep priced the omission at 16.4% of ordinary security defects
 * escaping silently — silently being the operative word, since without the
 * demand a scanner that never ran and a scanner that found nothing were the
 * same absence.
 */
export const ORDINARY_REQUIRED: readonly CheckKind[] = ["build", "test", "security"]
export const CRITICAL_REQUIRED: readonly CheckKind[] = ["build", "test", "security", "side_effect"]

/**
 * The kinds where, on critical work, one witness is a sample rather than a
 * quorum.
 *
 * `test` is in this list because the sweep put it there, not because it was
 * designed in: a second reader of critical work moved critical rejection from
 * 97.52% to 98.51% and, unexpectedly, moved false rejection DOWN from 2.58% to
 * 2.48%, for a fifth more reviewer runs. It is the same argument as the other
 * two — one reading of what a change does is a sample — and it took a
 * measurement to notice it applied here as well.
 */
export const QUORUM_KINDS: readonly CheckKind[] = ["security", "side_effect", "test"]

/**
 * How many distinct witnesses a quorum kind needs on critical work.
 *
 * Set by the measurement, and the measurement is a frontier rather than an
 * optimum. Over 40,000 simulated patches:
 *
 *     quorum   critical rejected   false rejection   reviewer runs/patch
 *        2           98.51%             2.48%               1.40
 *        3           99.46%             2.93%               2.47
 *        4           99.91%             3.76%               3.54
 *        5           99.95%             5.01%               4.60
 *
 * The sprint asked for ≥99.9% on critical work AND ≤3% false rejection, and no
 * row satisfies both: the only quorum reaching the first breaks the second.
 *
 * Quorum 3 is the row worth the warning. At 2.93% it appears to fit inside the
 * 3% line, and it does not — on three of five seeds it costs 3.15–3.17%. The
 * seed the frontier was first measured on had won a coin flip against the
 * ceiling, and picking that row would have shipped a tuned configuration as a
 * measured one. Two is the largest quorum that holds the bound on EVERY seed.
 *
 * The reason more witnesses stop paying is worth keeping: each one carries its
 * own rate of raising a concern about nothing, and past a point a panel
 * MANUFACTURES the questions it is being added to answer. Letting the harness
 * answer more persistently does not help either — the sweep ran it to six
 * rounds and nothing moved after four.
 */
export const CRITICAL_QUORUM = 2

export interface Demand {
  readonly criticality: Criticality
  readonly required: readonly CheckKind[]
  readonly quorumKinds: readonly CheckKind[]
  readonly quorum: number
  readonly why: string
}

/**
 * What this patch must produce.
 *
 * The order matters more than it looks. A network that judges whatever evidence
 * it happens to be handed cannot hold a floor, because the cheapest way to
 * avoid a failing check is not to run it — so the demand is computed from the
 * patch BEFORE any evidence exists, and a demanded check that never arrives is
 * a missing answer rather than a question nobody asked.
 */
export function demand(profile: PatchProfile): Demand {
  const criticality = criticalityOf(profile)
  if (criticality === "critical")
    return {
      criticality,
      required: CRITICAL_REQUIRED,
      quorumKinds: QUORUM_KINDS,
      quorum: CRITICAL_QUORUM,
      why:
        `critical: ${[...profile.protectedAspects, ...riskyClasses(profile.classes)].join(", ")} — ` +
        `what it did has to be watched, not only what its diff said`,
    }
  return {
    criticality,
    required: ORDINARY_REQUIRED,
    quorumKinds: [],
    quorum: 1,
    why: "ordinary: local classes, nothing protected — the mechanical floor is the floor",
  }
}

// --------------------------------------------------------------------------
// Admission
// --------------------------------------------------------------------------

export interface Admission {
  readonly check: AttributedCheck
  /** What the fold is allowed to see. Equal to the check unless it was downgraded. */
  readonly admitted: CheckResult
  /** Set exactly when the result was downgraded. A downgrade is never silent. */
  readonly why?: string
}

const strip = ({ witness: _witness, ...rest }: AttributedCheck): CheckResult => rest

/**
 * A claim that was not counted becomes `unavailable`, never `skipped` and never
 * a silent deletion. It is precisely the engine's existing meaning: something
 * that did not produce a usable result. And the reason travels with it, because
 * a verdict that cannot say which claims it declined to believe is one nobody
 * can argue with.
 */
const downgrade = (check: AttributedCheck, why: string): Admission => ({
  check,
  admitted: {
    ...strip(check),
    status: "unavailable",
    detail: check.detail === undefined ? why : `${why} (it said: ${check.detail})`,
  },
  why,
})

const accept = (check: AttributedCheck): Admission => ({ check, admitted: strip(check) })

/**
 * Which claims are entitled to be counted.
 *
 * Passing results:
 *   mechanical                 -> counted. The tool has no stake in the patch.
 *   judged, by the author      -> NOT counted. This is the claim, not a check
 *                                 of the claim.
 *   judged, contaminated       -> NOT counted. It read the author's reasoning,
 *                                 so its agreement was inherited rather than
 *                                 found, and a self-claim is just contamination
 *                                 at correlation one.
 *   judged, independent, clean -> counted.
 *
 * Failing results:
 *   mechanical                 -> final. A measurement said no.
 *   judged, by the author      -> final. An admission against interest.
 *   judged, corroborated       -> final.
 *   judged, alone              -> NOT final, and NOT dismissed either. One
 *                                 model's unsupported "this looks wrong" is a
 *                                 finding, and a finding is not a verdict. It
 *                                 becomes a QUESTION instead: the kind it was
 *                                 raised in becomes required AND needs one more
 *                                 witness than it did before.
 *
 *                                 That last clause is not decoration; the sweep
 *                                 put it there. Without it the question is
 *                                 answered by evidence that already existed
 *                                 when the question was asked — the scanner
 *                                 that had already passed — and a real defect
 *                                 caught by one reviewer walks. An answer has
 *                                 to be NEW, or it is not an answer.
 *
 * `unavailable` and `skipped` pass through untouched — the engine already knows
 * what those mean and has since the day it was written.
 */
export function admit(profile: PatchProfile, checks: readonly AttributedCheck[]): readonly Admission[] {
  return adjudicate(profile, checks).admissions
}

export interface Adjudication {
  readonly admissions: readonly Admission[]
  /** Kinds where an uncorroborated concern was raised, and how many were raised. */
  readonly questions: ReadonlyMap<CheckKind, number>
  /**
   * Distinct witnesses per kind that passed the independence rules.
   *
   * Counted BEFORE quorum, and that is the whole point: a witness downgraded
   * for being alone is not absent, it is waiting. Counting it as absent makes a
   * harness commission two replacements where one completes the quorum, and
   * over-commissioning is how a verification budget disappears.
   */
  readonly eligible: ReadonlyMap<CheckKind, number>
}

/** `admit` plus the questions it raised, which `review` needs and callers rarely do. */
export function adjudicate(profile: PatchProfile, checks: readonly AttributedCheck[]): Adjudication {
  const failures = checks.filter((c) => c.status === "failed")
  const questions = new Map<CheckKind, number>()

  const perCheck = checks.map((check): Admission => {
    const { witness } = check

    if (check.status === "failed") {
      if (witness.sort === "mechanical") return accept(check)
      if (witness.by === profile.author) return accept(check)
      const corroborated = failures.some((other) => witnessId(other.witness) !== witnessId(witness))
      if (corroborated) return accept(check)
      questions.set(check.kind, (questions.get(check.kind) ?? 0) + 1)
      return downgrade(
        check,
        `${witness.by} is the only witness to this failure and formed it by judgement — ` +
          `a lone judged failure is a finding, not a verdict, so it becomes a question this patch must answer`,
      )
    }

    if (check.status !== "passed") return accept(check)
    if (witness.sort === "mechanical") return accept(check)

    if (witness.by === profile.author)
      return downgrade(
        check,
        `self-attested by ${witness.by}, who wrote the patch — a claim is not a measurement, and this is the claim`,
      )

    if (witness.context === "contaminated")
      return downgrade(
        check,
        `${witness.by} judged this with the author's reasoning in context` +
          `${witness.contaminatedBy === undefined ? "" : ` (${witness.contaminatedBy})`} — ` +
          `its agreement was inherited, not found`,
      )

    return accept(check)
  })

  const eligible = new Map<CheckKind, number>()
  for (const kind of new Set(perCheck.map((a) => a.admitted.kind))) {
    const witnesses = new Set(
      perCheck
        .filter((a) => a.why === undefined && a.admitted.kind === kind && a.admitted.status === "passed")
        .map((a) => witnessId(a.check.witness)),
    )
    eligible.set(kind, witnesses.size)
  }

  return { admissions: applyQuorum(profile, perCheck, questions, eligible), questions, eligible }
}

/**
 * On critical work, one witness is a sample.
 *
 * Expressed here rather than as a second verdict rule, deliberately: "were
 * there enough independent witnesses to have asked the question" is an
 * admission question, and routing it through admission keeps ONE place where a
 * verdict is decided. A kind that falls short of quorum has its passing results
 * downgraded to `unavailable`, and the fold — which already refuses to call a
 * required-but-unavailable kind a pass — reaches `unverified` on its own.
 *
 * Failures are never touched by quorum. A single sandbox that saw the patch
 * open a socket it never declared does not need a second sandbox to agree.
 */
function applyQuorum(
  profile: PatchProfile,
  admissions: readonly Admission[],
  questions: ReadonlyMap<CheckKind, number>,
  eligible: ReadonlyMap<CheckKind, number>,
): readonly Admission[] {
  const { criticality, quorumKinds, quorum } = demand(profile)

  /** How many distinct witnesses this kind needs before a pass counts. */
  const needed = (kind: CheckKind): number =>
    (criticality === "critical" && quorumKinds.includes(kind) ? quorum : 1) + (questions.get(kind) ?? 0)

  const short = new Map<CheckKind, number>()
  for (const [kind, have] of eligible) {
    const need = needed(kind)
    if (need <= 1) continue
    if (have > 0 && have < need) short.set(kind, need)
  }
  if (short.size === 0) return admissions

  return admissions.map((admission) => {
    if (admission.why !== undefined) return admission
    if (admission.admitted.status !== "passed") return admission
    const need = short.get(admission.admitted.kind)
    if (need === undefined) return admission
    return downgrade(
      admission.check,
      (questions.has(admission.admitted.kind)
        ? `a concern was raised in ${admission.admitted.kind} and this witness had already reported before it was raised — `
        : `critical work, and ${admission.admitted.kind} rests on too few witnesses — `) +
        `${need} independent witnesses are required here, so what is present is a sample rather than a quorum`,
    )
  })
}

// --------------------------------------------------------------------------
// The verdict
// --------------------------------------------------------------------------

export interface NetworkVerdict {
  readonly verdict: Verdict
  readonly demand: Demand
  readonly required: readonly CheckKind[]
  readonly admissions: readonly Admission[]
  /** Every claim that was not counted, with the reason it was not. */
  readonly downgrades: readonly Admission[]
  readonly result: EngineResult
  /**
   * What would resolve an `unverified` verdict: per kind, how many more
   * distinct admissible witnesses are missing.
   *
   * A verdict that says "not verified" and cannot say what would verify it
   * leaves the caller to guess, and the guess is usually "run everything
   * again". It is also what makes the demand a loop rather than a wall: a
   * harness fulfils the shortfall and asks again, and only a shortfall that
   * CANNOT be filled is a rejection.
   */
  readonly shortfall: ReadonlyMap<CheckKind, number>
  readonly why: string
}

/**
 * Review a patch.
 *
 * Admission, then the fold that already exists. `required` is the demand plus
 * any kind an uncorroborated judged failure raised a question in — a concern
 * nobody could corroborate does not condemn the patch and does not evaporate
 * either; it turns into evidence that now has to exist.
 */
export function review(profile: PatchProfile, checks: readonly AttributedCheck[]): NetworkVerdict {
  const base = demand(profile)
  const { admissions, questions, eligible } = adjudicate(profile, checks)
  const downgrades = admissions.filter((a) => a.why !== undefined)

  const raised = new Set(questions.keys())
  const required = [...new Set([...base.required, ...raised])]
  const result = fold(
    admissions.map((a) => a.admitted),
    required,
  )

  const shortfall = new Map<CheckKind, number>()
  for (const kind of required) {
    const need =
      (base.criticality === "critical" && base.quorumKinds.includes(kind) ? base.quorum : 1) + (questions.get(kind) ?? 0)
    const missing = need - (eligible.get(kind) ?? 0)
    if (missing > 0) shortfall.set(kind, missing)
  }

  const raisedNote =
    raised.size === 0 ? "" : `; ${[...raised].join(", ")} became required because an uncorroborated concern was raised there`
  const downgradeNote = downgrades.length === 0 ? "" : `; ${downgrades.length} claim(s) not counted as evidence`

  return {
    verdict: result.verdict,
    demand: base,
    required,
    admissions,
    downgrades,
    result,
    shortfall,
    why: `${base.criticality}: ${result.why}${downgradeNote}${raisedNote}`,
  }
}
