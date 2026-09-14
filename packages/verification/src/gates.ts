/**
 * The gates (Sprints 72-77).
 *
 * Each one exists because of a specific way a run reports success while being
 * wrong, and most of those ways have been seen in this repository:
 *
 *   S72  a build failure that did not stop the chain, because the failure was
 *        piped and the pipe's exit status was zero
 *   S73  "11/11 passed" with the database stopped — the mocking trap, which is
 *        in this project's own memory as a real incident
 *   S74  a green build for an application that does not boot
 *   S75  a UI sprint where nobody ever loaded the page
 *   S76  a secret in the diff, and a visual change nobody looked at
 *   S77  a sprint whose acceptance criteria could not be checked by anything
 */
import { redact } from "@abdo/reliability"
import type { CheckKind, CheckResult } from "./engine"

// --------------------------------------------------------------------------
// Sprint 72 — build and lint
// --------------------------------------------------------------------------

export type FailureClass = "compile_error" | "type_error" | "lint_error" | "missing_dependency" | "config_error" | "unknown"

const FAILURE_SIGNATURES: readonly { readonly cls: FailureClass; readonly re: RegExp }[] = [
  { cls: "type_error", re: /error TS\d+|Type '.*' is not assignable/i },
  { cls: "missing_dependency", re: /cannot find module|module not found|ERR_MODULE_NOT_FOUND/i },
  { cls: "lint_error", re: /eslint|biome|lint error|\d+ problems? \(/i },
  { cls: "config_error", re: /invalid (config|option)|unknown compiler option|failed to load config/i },
  { cls: "compile_error", re: /syntax error|unexpected token|parse error|compilation failed/i },
]

export interface BuildOutcome {
  readonly command: string
  readonly exitCode: number | null
  readonly output: string
}

/**
 * Judge a build, and CLASSIFY the failure.
 *
 * The classification is what makes stopping useful: "the build failed" sends an
 * agent back to guess, and "missing_dependency" sends it to install something.
 *
 * A null exit code is a FAILURE, not an unknown. It means the process was
 * killed or never reported, and both of those are states in which nothing was
 * proven — the one reading that must not be able to treat it as a pass.
 */
export function judgeBuild(outcome: BuildOutcome, kind: CheckKind = "build"): CheckResult & { failureClass?: FailureClass } {
  const evidence = `${outcome.command} -> exit ${outcome.exitCode ?? "null"}`
  if (outcome.exitCode === 0)
    return { id: outcome.command, kind, status: "passed", evidence, tokens: 0 }

  const signature = FAILURE_SIGNATURES.find((s) => s.re.test(outcome.output))
  const failureClass: FailureClass = outcome.exitCode === null ? "unknown" : (signature?.cls ?? "unknown")
  return {
    id: outcome.command,
    kind,
    status: "failed",
    evidence,
    tokens: 0,
    detail:
      outcome.exitCode === null
        ? "the process never reported an exit code — it was killed or died, and nothing was proven either way"
        : `${failureClass}: ${(outcome.output.match(FAILURE_SIGNATURES.find((s) => s.re.test(outcome.output))?.re ?? /.*/)?.[0] ?? outcome.output).slice(0, 200)}`,
    failureClass,
  }
}

// --------------------------------------------------------------------------
// Sprint 73 — test gates, and the mocking trap
// --------------------------------------------------------------------------

export interface TestRun {
  readonly command: string
  readonly passed: number
  readonly failed: number
  readonly skipped?: number
  readonly output: string
  /** Dependencies the suite claims to exercise. */
  readonly requires?: readonly ("database" | "redis" | "network" | "browser" | "filesystem")[]
  /** Which of those were actually reachable when it ran. */
  readonly available?: readonly ("database" | "redis" | "network" | "browser" | "filesystem")[]
  /**
   * Did the suite execute the lines this change touched?
   *
   * The same question `judgeEffects` asks its sandbox, and it belongs here for
   * the same reason: a green suite that never ran the changed lines passed a
   * test of the code as it was. Unlike "is there a bug I did not think to
   * assert", this is a question the run can answer about itself.
   *
   * Covering the change is NOT the same as catching its defect — an executed
   * line with no assertion about it proves nothing — so this promotes nothing.
   * It only refuses to let an uncovered run read as a passing one.
   *
   * Defaults to `true` for callers with no coverage data; `false` is the case
   * worth writing down.
   */
  readonly coversChange?: boolean
}

const MOCK_SIGNALS = [
  /\bmock(ed|ing)?\b/i,
  /\bstub(bed|bing)?\b/i,
  /jest\.mock|vi\.mock|sinon\.(stub|mock)|mock\.module/i,
  /in-?memory (database|db|store)/i,
]

export interface TestVerdict extends CheckResult {
  readonly suspicious: boolean
}

/**
 * Judge a test run — and refuse "11/11 passed" when the thing under test was
 * not there.
 *
 * This is in this project's own memory as a real incident: a sprint agent
 * reported a full green suite by mocking the database away. The suite was
 * honest about what it ran; nobody asked whether what it ran was the system.
 *
 * So a suite that DECLARES a dependency and ran without it is `unavailable`,
 * not passed. The declaration is the key: this cannot detect a mock nobody
 * mentioned, and pretending otherwise would be its own fake completion. What it
 * can do is make the honest case checkable and the dishonest case require a
 * deliberate lie in the manifest.
 */
export function judgeTests(run: TestRun): TestVerdict {
  const evidence = `${run.command} -> ${run.passed} passed, ${run.failed} failed${run.skipped !== undefined ? `, ${run.skipped} skipped` : ""}`
  const suspicious = MOCK_SIGNALS.some((re) => re.test(run.output))

  const required = run.requires ?? []
  const available = new Set(run.available ?? [])
  const missing = required.filter((r) => !available.has(r))

  if (missing.length > 0)
    return {
      id: run.command,
      kind: "test",
      status: "unavailable",
      evidence,
      tokens: 0,
      suspicious,
      detail: `the suite declares it needs ${required.join(", ")} and ${missing.join(", ")} ${missing.length === 1 ? "was" : "were"} not reachable — ${run.passed} passing tests against a system that was not there is not a result`,
    }

  if (run.failed > 0)
    return { id: run.command, kind: "test", status: "failed", evidence, tokens: 0, suspicious, detail: `${run.failed} failing test(s)` }

  if (run.coversChange === false)
    return {
      id: run.command,
      kind: "test",
      status: "unavailable",
      evidence,
      tokens: 0,
      suspicious,
      detail: `${run.passed} tests passed and none of them executed the lines that changed — this is a green suite for the code as it was`,
    }

  if (run.passed === 0)
    return {
      id: run.command,
      kind: "test",
      status: "unavailable",
      evidence,
      tokens: 0,
      suspicious,
      detail: "zero tests ran — a suite that selected nothing is not a suite that passed",
    }

  return { id: run.command, kind: "test", status: "passed", evidence, tokens: 0, suspicious }
}

// --------------------------------------------------------------------------
// Sprint 74 — runtime health
// --------------------------------------------------------------------------

export interface HealthProbe {
  readonly url: string
  readonly status?: number
  readonly bootMs?: number
  readonly error?: string
}

/**
 * A build is not a boot.
 *
 * The gate exists for the case that reads as success everywhere else: the
 * bundle compiled, the artefact exists, and the process exits three seconds
 * after start because a required environment variable is missing. Every static
 * check passes. Nothing works.
 */
export function judgeHealth(probe: HealthProbe): CheckResult {
  const evidence = `GET ${probe.url}${probe.status !== undefined ? ` -> ${probe.status}` : ""}`
  if (probe.error !== undefined)
    return {
      id: probe.url,
      kind: "runtime",
      status: "failed",
      evidence,
      tokens: 0,
      detail: `the application did not answer: ${probe.error} — a successful build and an application that does not boot is a FAIL, not a PASS`,
    }
  if (probe.status === undefined)
    return { id: probe.url, kind: "runtime", status: "unavailable", evidence, tokens: 0, detail: "no probe was run" }
  if (probe.status >= 400)
    return { id: probe.url, kind: "runtime", status: "failed", evidence, tokens: 0, detail: `the application answered ${probe.status}` }
  return { id: probe.url, kind: "runtime", status: "passed", evidence, tokens: 0 }
}

// --------------------------------------------------------------------------
// Sprint 75 — the browser critical path
// --------------------------------------------------------------------------

export interface CriticalPathStep {
  readonly name: string
  readonly done: boolean
  readonly why?: string
}

export interface CriticalPathRun {
  readonly path: string
  readonly steps: readonly CriticalPathStep[]
  /** Console errors judged by @abdo/browser. */
  readonly consoleClean: boolean
}

/**
 * Did anybody actually load the page?
 *
 * A UI sprint that changed a component and ran unit tests has verified that the
 * component renders in a test harness. The gate asks the different question:
 * did the flow a user performs still work, in a browser, this sprint.
 */
export function judgeCriticalPath(run: CriticalPathRun, touchesUi: boolean): CheckResult {
  if (!touchesUi)
    return { id: run.path, kind: "browser", status: "skipped", evidence: "no UI change in this sprint", tokens: 0 }

  const incomplete = run.steps.filter((s) => !s.done)
  const evidence = `${run.path}: ${run.steps.length - incomplete.length}/${run.steps.length} steps`
  if (run.steps.length === 0)
    return {
      id: run.path,
      kind: "browser",
      status: "unavailable",
      evidence,
      tokens: 0,
      detail: "this sprint touched the interface and no critical path was defined for it",
    }
  if (incomplete.length > 0)
    return {
      id: run.path,
      kind: "browser",
      status: "failed",
      evidence,
      tokens: 0,
      detail: `stopped at ${incomplete[0]!.name}${incomplete[0]!.why !== undefined ? `: ${incomplete[0]!.why}` : ""}`,
    }
  if (!run.consoleClean)
    return { id: run.path, kind: "browser", status: "failed", evidence, tokens: 0, detail: "the path completed but the console carried unclassified errors" }
  return { id: run.path, kind: "browser", status: "passed", evidence, tokens: 0 }
}

// --------------------------------------------------------------------------
// Sprint 76 — visual and security diff
// --------------------------------------------------------------------------

export interface VisualDiff {
  readonly screen: string
  /** Fraction of pixels that changed, 0..1. */
  readonly changed: number
  readonly baselineExists: boolean
  /** Where the evidence was kept. A diff with no artefact cannot be reviewed. */
  readonly artefact?: string
}

export const DEFAULT_VISUAL_LIMIT = 0.02

export function judgeVisual(diff: VisualDiff, limit = DEFAULT_VISUAL_LIMIT): CheckResult {
  const evidence = `${diff.screen}: ${(diff.changed * 100).toFixed(1)}% of pixels changed (limit ${(limit * 100).toFixed(1)}%)`
  if (!diff.baselineExists)
    return {
      id: diff.screen,
      kind: "visual",
      status: "unavailable",
      evidence,
      tokens: 0,
      detail: "no baseline exists, so nothing can be compared — the first run records one rather than passing",
    }
  if (diff.changed > limit)
    return {
      id: diff.screen,
      kind: "visual",
      status: "failed",
      evidence,
      tokens: 0,
      detail:
        diff.artefact === undefined
          ? "over the limit, and NO artefact was kept — a visual failure nobody can look at cannot be judged or dismissed"
          : `over the limit; evidence at ${diff.artefact}`,
    }
  return { id: diff.screen, kind: "visual", status: "passed", evidence, tokens: 0 }
}

export interface DiffReview {
  readonly secrets: readonly { readonly file: string; readonly kind: string }[]
  readonly permissionChanges: readonly string[]
  readonly dangerousPaths: readonly string[]
  readonly outOfScope: readonly string[]
}

const DANGEROUS_PATHS = [/^\.github\/workflows\//, /^Dockerfile/, /^docker-compose/, /\.env($|\.)/, /^infra\//, /^deploy\//, /^\.ssh\//]

/**
 * Review a diff mechanically for the four things a human reviewer looks for
 * and misses when the diff is long.
 *
 * The secret scan runs the Sprint 53 redactor over the ADDED lines and reports
 * what it would have removed. That reuse matters: a second, weaker secret
 * pattern list here would be the one that misses something.
 */
export function reviewDiff(
  added: readonly { readonly file: string; readonly line: string }[],
  declaredScope: readonly string[],
): DiffReview {
  const secrets: { file: string; kind: string }[] = []
  for (const { file, line } of added) {
    const result = redact(line)
    for (const r of result.redactions) secrets.push({ file, kind: r.kind })
  }

  const files = [...new Set(added.map((a) => a.file))]
  const permissionChanges = files.filter((f) =>
    added.some((a) => a.file === f && /(chmod|chown|sudo|setuid|"?role"?\s*[:=]|GRANT |privileged\s*[:=]\s*true)/i.test(a.line)),
  )
  const dangerousPaths = files.filter((f) => DANGEROUS_PATHS.some((re) => re.test(f)))
  const outOfScope =
    declaredScope.length === 0 ? [] : files.filter((f) => !declaredScope.some((s) => f === s || f.startsWith(`${s}/`)))

  return { secrets, permissionChanges, dangerousPaths, outOfScope }
}

export function judgeDiff(review: DiffReview): CheckResult {
  const problems: string[] = []
  if (review.secrets.length > 0)
    problems.push(`${review.secrets.length} possible secret(s) (${[...new Set(review.secrets.map((s) => s.kind))].join(", ")})`)
  if (review.dangerousPaths.length > 0) problems.push(`dangerous paths: ${review.dangerousPaths.join(", ")}`)
  if (review.permissionChanges.length > 0) problems.push(`permission changes in ${review.permissionChanges.join(", ")}`)
  if (review.outOfScope.length > 0) problems.push(`out of scope: ${review.outOfScope.join(", ")}`)

  return problems.length > 0
    ? { id: "diff", kind: "security", status: "failed", evidence: "mechanical diff review", tokens: 0, detail: problems.join("; ") }
    : { id: "diff", kind: "security", status: "passed", evidence: "mechanical diff review", tokens: 0 }
}

// --------------------------------------------------------------------------
// Sprint 77 — acceptance criteria binding
// --------------------------------------------------------------------------

export interface BoundCriterion {
  readonly id: string
  readonly text: string
  /** Check ids expected to demonstrate it. Empty = nothing can check it. */
  readonly checks: readonly string[]
}

export interface BindingVerdict {
  readonly mayStart: boolean
  readonly unbound: readonly string[]
  readonly why: string
}

/**
 * May this sprint enter RUNNING?
 *
 * Not "should it be reviewed" — may it START. A criterion nothing can check is
 * a criterion that will be declared met by whoever is tired at the end, and the
 * cheapest moment to notice is before any work exists to defend.
 *
 * A sprint with no criteria at all is refused for the same reason: it cannot
 * fail, and a sprint that cannot fail is not a sprint.
 */
export function checkBinding(criteria: readonly BoundCriterion[]): BindingVerdict {
  if (criteria.length === 0)
    return {
      mayStart: false,
      unbound: [],
      why: "this sprint declares no acceptance criteria — it cannot fail, and a sprint that cannot fail is not a sprint",
    }

  const unbound = criteria.filter((c) => c.checks.length === 0).map((c) => c.id)
  if (unbound.length > 0)
    return {
      mayStart: false,
      unbound,
      why: `${unbound.join(", ")} ${unbound.length === 1 ? "has" : "have"} no check behind ${unbound.length === 1 ? "it" : "them"} — a criterion nothing can check is one that gets declared met by whoever is tired at the end`,
    }

  return { mayStart: true, unbound: [], why: `${criteria.length} criteria, each bound to at least one check` }
}

// --------------------------------------------------------------------------
// S133 — the side effect gate
// --------------------------------------------------------------------------

/**
 * What a change did while it ran.
 *
 * Every gate above this one reads an ARTEFACT: an exit code, a test count, a
 * diff, a screenshot. `reviewDiff` is the closest, and it reads the text of the
 * change — which is exactly the thing a patch can be innocent of. A diff that
 * adds one call to a helper is three clean lines, and the helper opens a
 * socket. Nothing above would say a word.
 */
export interface EffectObservation {
  readonly sandbox: string
  /** Effects the change said it would have. */
  readonly declared: readonly string[]
  /**
   * Effects that were seen. `undefined` means nothing watched — which is NOT
   * an empty list, and the difference is the whole point of the gate.
   */
  readonly observed: readonly string[] | undefined
  /**
   * Did this run actually execute the changed code?
   *
   * A watcher that ran, saw nothing, and never took the path the change is on
   * reports an empty list — which is indistinguishable from a clean change and
   * is the same lie one level down. Coverage is the thing that separates them,
   * and unlike "is there a defect I do not recognise", coverage is a question
   * the watcher can answer about itself.
   *
   * Defaults to `true` for callers that cannot report it; the `false` case is
   * the one worth writing down.
   */
  readonly exercised?: boolean
}

export interface EffectVerdict extends CheckResult {
  /** Seen and never declared. This is the failure. */
  readonly undeclared: readonly string[]
  /** Declared and never seen. Not a failure — but worth knowing. */
  readonly unexercised: readonly string[]
}

/**
 * Judge what the change did.
 *
 * The comparison is against the DECLARATION, not against a list of forbidden
 * effects, and that choice is what makes the gate sharp. A blocklist catches
 * the effects somebody thought of; a declaration catches every effect nobody
 * mentioned, including the ones that have no name yet.
 *
 * An unobserved run is `unavailable`, never `passed`. "We did not watch" and
 * "we watched and it was clean" are the same sentence to anything downstream
 * unless this refuses to collapse them, and the engine already knows what to do
 * with a check that could not run.
 *
 * Declared-but-unexercised is reported and does not fail: a change that
 * promised to write a file and did not is usually a path the run never took,
 * and failing it would punish honest declarations.
 */
export function judgeEffects(observation: EffectObservation): EffectVerdict {
  const declared = new Set(observation.declared)
  const evidence = `${observation.sandbox}: declared ${observation.declared.length}, observed ${observation.observed?.length ?? "nothing — no watcher"}`

  if (observation.exercised === false)
    return {
      id: observation.sandbox,
      kind: "side_effect",
      status: "unavailable",
      evidence: `${evidence} (the run never reached the change)`,
      tokens: 0,
      undeclared: [],
      unexercised: observation.declared,
      detail:
        "this run never executed the changed code, so its empty list of effects is about some other code — " +
        "a watcher that did not look is not a watcher that found nothing",
    }

  if (observation.observed === undefined)
    return {
      id: observation.sandbox,
      kind: "side_effect",
      status: "unavailable",
      evidence,
      tokens: 0,
      undeclared: [],
      unexercised: observation.declared,
      detail: "nothing watched this run — an unobserved run is not a clean run, and the two must not read the same",
    }

  const seen = new Set(observation.observed)
  const undeclared = observation.observed.filter((e) => !declared.has(e))
  const unexercised = observation.declared.filter((e) => !seen.has(e))

  if (undeclared.length > 0)
    return {
      id: observation.sandbox,
      kind: "side_effect",
      status: "failed",
      evidence,
      tokens: 0,
      undeclared,
      unexercised,
      detail: `did what it never said it would: ${undeclared.join(", ")} — the diff can be innocent and the run guilty`,
    }

  return {
    id: observation.sandbox,
    kind: "side_effect",
    status: "passed",
    evidence,
    tokens: 0,
    undeclared: [],
    unexercised,
    detail: unexercised.length > 0 ? `declared but never exercised: ${unexercised.join(", ")}` : undefined,
  }
}
