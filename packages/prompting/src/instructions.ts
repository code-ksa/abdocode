/**
 * Instructions as code (Sprint 45).
 *
 * System prompts are the least disciplined part of every agent I have seen,
 * including this one: strings scattered across files, edited by feel, with no
 * record of what changed or whether it helped. The reason is understandable —
 * a prompt edit is one line and takes ten seconds — and the consequence is that
 * the single largest lever on agent quality is the only part of the system with
 * no version control over its EFFECT.
 *
 * So an instruction here is a module: an id, a version, a rationale, and the
 * behaviour it is supposed to produce. Changes are proposals, and a proposal is
 * adopted only with a measurement attached. `adopt()` refuses without one.
 *
 * The refusal is the whole sprint. Everything else is bookkeeping.
 */

export type InstructionScope = "system" | "builder" | "verifier" | "planner" | "recovery"

export interface InstructionModule {
  readonly id: string
  readonly scope: InstructionScope
  /** Bumped on every adopted change. */
  readonly version: number
  readonly text: string
  /** Why this instruction exists — a module nobody can justify gets deleted. */
  readonly rationale: string
  /** The behaviour it should produce, in a form a scenario can be written from. */
  readonly expectedBehaviour: string
  /** Bench scenario ids that exercise it. Empty = nothing measures this. */
  readonly measuredBy: readonly string[]
}

export interface InstructionSet {
  readonly scope: InstructionScope
  readonly modules: readonly InstructionModule[]
  readonly text: string
  readonly bytes: number
  /** Modules no scenario exercises — a prompt nobody measures is folklore. */
  readonly unmeasured: readonly string[]
}

/**
 * Assemble the prompt for a scope.
 *
 * Order is by module id, deliberately: an assembly whose order depends on
 * insertion or on a Set's iteration is an assembly that changes behaviour when
 * an unrelated module is added, and that change would be invisible.
 */
export function assemble(scope: InstructionScope, modules: readonly InstructionModule[]): InstructionSet {
  const mine = modules.filter((m) => m.scope === scope).sort((a, b) => a.id.localeCompare(b.id))
  const text = mine.map((m) => m.text.trim()).join("\n\n")
  return {
    scope,
    modules: mine,
    text,
    bytes: text.length,
    unmeasured: mine.filter((m) => m.measuredBy.length === 0).map((m) => m.id),
  }
}

export interface Measurement {
  /** Bench axis or scenario the change was measured on. */
  readonly on: string
  readonly before: number
  readonly after: number
  /** How many runs each side. One run is an anecdote. */
  readonly samples: number
}

export interface ChangeProposal {
  readonly moduleId: string
  readonly newText: string
  readonly why: string
  readonly measurement?: Measurement
}

export type AdoptionDecision = "adopted" | "needs_measurement" | "rejected"

export interface AdoptionVerdict {
  readonly decision: AdoptionDecision
  readonly why: string
  readonly module?: InstructionModule
}

/** Below this, a difference is noise dressed as an improvement. */
export const MIN_SAMPLES = 5
export const MIN_EFFECT = 0.02

/**
 * Adopt an instruction change — or refuse it.
 *
 * Three refusals, in the order they matter:
 *
 *   no measurement    the change may well be an improvement; nobody knows, and
 *                     "it reads better" is how prompts accumulate contradictory
 *                     rules that each seemed sensible alone.
 *   too few samples   a model's output varies between identical calls, so one
 *                     run either way measures the sampler, not the prompt.
 *   it made it worse  adopted anyway is how a system gets worse one reasonable
 *                     decision at a time.
 *
 * A change that measures as NEUTRAL is adopted, because a simplification that
 * costs nothing is worth having — but it is recorded as neutral, so nobody
 * later cites it as evidence the wording mattered.
 */
export function adopt(module: InstructionModule, proposal: ChangeProposal): AdoptionVerdict {
  if (proposal.moduleId !== module.id)
    return { decision: "rejected", why: `the proposal is for ${proposal.moduleId}, not ${module.id}` }
  if (proposal.newText.trim() === module.text.trim())
    return { decision: "rejected", why: "the proposed text is identical to the current text" }

  const measurement = proposal.measurement
  if (measurement === undefined)
    return {
      decision: "needs_measurement",
      why: `no measurement is attached — this may well be better, but nobody knows, and "it reads better" is how a prompt accumulates contradictory rules`,
    }

  if (measurement.samples < MIN_SAMPLES)
    return {
      decision: "needs_measurement",
      why: `${measurement.samples} sample(s) measures the sampler, not the prompt — a model varies between identical calls; ${MIN_SAMPLES} minimum`,
    }

  const delta = measurement.after - measurement.before
  if (delta <= -MIN_EFFECT)
    return {
      decision: "rejected",
      why: `it measured WORSE on ${measurement.on}: ${(measurement.before * 100).toFixed(0)}% → ${(measurement.after * 100).toFixed(0)}%`,
    }

  return {
    decision: "adopted",
    why:
      delta >= MIN_EFFECT
        ? `measured better on ${measurement.on}: ${(measurement.before * 100).toFixed(0)}% → ${(measurement.after * 100).toFixed(0)}% over ${measurement.samples} samples`
        : `measured NEUTRAL on ${measurement.on} over ${measurement.samples} samples — adopted as a simplification, not as evidence the wording mattered`,
    module: { ...module, version: module.version + 1, text: proposal.newText },
  }
}

/**
 * Contradictions between modules in one scope.
 *
 * The cheapest real failure in a long system prompt: two rules that were each
 * sensible when written and cannot both be followed. Detected by declared
 * opposition rather than by reading the English, because a check that needs a
 * model to run is a check that will not run on every change.
 */
export function findContradictions(
  set: InstructionSet,
  opposites: readonly (readonly [string, string])[],
): { a: string; b: string }[] {
  const present = new Set(set.modules.map((m) => m.id))
  return opposites
    .filter(([a, b]) => present.has(a) && present.has(b))
    .map(([a, b]) => ({ a, b }))
}
