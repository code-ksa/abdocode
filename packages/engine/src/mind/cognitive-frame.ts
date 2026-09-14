/**
 * S127 — the CognitiveFrame reducer.
 *
 * What a run knows about itself: its goal, the constraints it must respect, the
 * unknowns it has raised, the assumptions it is standing on, its plan, the
 * proofs it has collected, and what it has spent. One pure reducer, one event
 * per transition.
 *
 * # Model text is not state
 *
 * This is the sprint's real condition and the reason the frame exists at all.
 * The failure it prevents is the one every agent falls into: the model narrates
 * something plausible, the narration is kept, and three turns later the run is
 * reasoning about its own prose as if it were fact. Nothing here stores what a
 * model said. An event payload is a **decision** — an id, a kind, a bounded
 * subject — and `TEXT_LIMIT` is enforced at the boundary, so a paragraph
 * cannot enter even by accident. The one long string in the frame is the goal
 * statement, which is the caller's request and not the model's output.
 *
 * `cognitive-frame.test.ts` checks this three ways: a source census over the
 * declared fields, a runtime refusal for over-long payloads, and a fingerprint
 * that does not move when the narration around the same decisions changes.
 *
 * # Silence is refusal
 *
 * An event that cannot be applied returns a **refusal carrying a reason**, not
 * an unchanged frame. A reducer that quietly ignores what it cannot handle is
 * indistinguishable from one that handled it, and the run goes on believing a
 * transition happened. This is the same rule the kernel's approval path
 * settled on in S114.
 */

import { Planner } from "./planner"

/** Longest string any event payload may carry. A decision fits; prose does not. */
export const TEXT_LIMIT = 200

/** The goal statement is the caller's request, so it gets more room than a decision. */
export const GOAL_LIMIT = 2_000

export type StepState = "pending" | "running" | "done" | "failed"

export interface Goal {
  readonly statement: string
  readonly acceptance: readonly string[]
}

export interface Constraint {
  readonly id: string
  readonly kind: string
  readonly subject: string
}

export interface Unknown {
  readonly id: string
  readonly question: string
  readonly answer?: string
}

export interface Assumption {
  readonly id: string
  readonly statement: string
  readonly because: string
  readonly invalidatedBy?: string
}

export interface Step {
  readonly id: string
  readonly action: string
  readonly dependsOn: readonly string[]
  readonly state: StepState
}

export interface Proof {
  readonly id: string
  /** The id of the constraint or step this proves. */
  readonly about: string
  readonly evidence: string
}

export interface Budget {
  readonly tokens: number
  readonly seconds: number
}

export interface Frame {
  readonly goal: Goal | undefined
  readonly constraints: readonly Constraint[]
  readonly unknowns: readonly Unknown[]
  readonly assumptions: readonly Assumption[]
  readonly plan: readonly Step[]
  readonly proofs: readonly Proof[]
  readonly spent: Budget
  /** Transitions applied. Part of the fingerprint, so replay divergence shows. */
  readonly transitions: number
}

export const empty: Frame = Object.freeze({
  goal: undefined,
  constraints: [],
  unknowns: [],
  assumptions: [],
  plan: [],
  proofs: [],
  spent: Object.freeze({ tokens: 0, seconds: 0 }),
  transitions: 0,
})

export type Event =
  | { readonly type: "goal-set"; readonly statement: string; readonly acceptance: readonly string[] }
  | { readonly type: "constraint-added"; readonly id: string; readonly kind: string; readonly subject: string }
  | { readonly type: "unknown-raised"; readonly id: string; readonly question: string }
  | { readonly type: "unknown-resolved"; readonly id: string; readonly answer: string }
  | { readonly type: "assumption-made"; readonly id: string; readonly statement: string; readonly because: string }
  | { readonly type: "assumption-invalidated"; readonly id: string; readonly by: string }
  | { readonly type: "plan-set"; readonly steps: readonly { readonly id: string; readonly action: string; readonly dependsOn: readonly string[] }[] }
  | { readonly type: "step-started"; readonly id: string }
  | { readonly type: "step-finished"; readonly id: string; readonly ok: boolean }
  | { readonly type: "proof-recorded"; readonly id: string; readonly about: string; readonly evidence: string }
  | { readonly type: "budget-spent"; readonly tokens: number; readonly seconds: number }

export type EventType = Event["type"]

/** Which frame fields each event kind is permitted to move. Checked by the tests. */
export const WRITE_SETS: Readonly<Record<EventType, readonly (keyof Frame)[]>> = {
  "goal-set": ["goal"],
  "constraint-added": ["constraints"],
  "unknown-raised": ["unknowns"],
  "unknown-resolved": ["unknowns"],
  "assumption-made": ["assumptions"],
  "assumption-invalidated": ["assumptions"],
  "plan-set": ["plan"],
  "step-started": ["plan"],
  "step-finished": ["plan"],
  "proof-recorded": ["proofs"],
  "budget-spent": ["spent"],
}

export type Applied = { readonly ok: true; readonly frame: Frame } | { readonly ok: false; readonly why: string }

const refuse = (why: string): Applied => ({ ok: false, why })

const overLimit = (event: Event): string | undefined => {
  for (const [key, value] of Object.entries(event)) {
    if (key === "type" || typeof value !== "string") continue
    const limit = event.type === "goal-set" && key === "statement" ? GOAL_LIMIT : TEXT_LIMIT
    if (value.length > limit) return `${event.type}.${key} is ${value.length} chars, over the ${limit} limit`
    if (value.length === 0) return `${event.type}.${key} is empty`
  }
  return undefined
}

/**
 * Every collection the reducer produces is frozen, and every unchanged one is
 * passed through by reference.
 *
 * Freezing makes in-place mutation throw in a module under `"use strict"`
 * semantics rather than leaving a purity violation to be discovered by a test
 * that happens to look. Passing unchanged fields through by reference makes the
 * violation cheap to detect too: an untouched field must be the *identical*
 * object afterwards, which is a stronger statement than being equal to it and
 * costs one comparison instead of a serialization.
 */
const frozen = <A>(items: readonly A[]): readonly A[] => Object.freeze(items) as readonly A[]

const replace = <A>(items: readonly A[], index: number, next: A): readonly A[] => {
  const copy = [...items]
  copy[index] = next
  return frozen(copy)
}

/**
 * Apply one event.
 *
 * Total: every input produces either a new frame or a refusal with a reason.
 * Never mutates its argument, and never returns the argument unchanged on a
 * path that was supposed to change something.
 */
export const apply = (frame: Frame, event: Event): Applied => {
  const bad = overLimit(event)
  if (bad !== undefined) return refuse(bad)

  const advance = (patch: Partial<Frame>): Applied => ({
    ok: true,
    frame: Object.freeze({ ...frame, ...patch, transitions: frame.transitions + 1 }),
  })

  switch (event.type) {
    case "goal-set": {
      // A goal is set once. Re-goaling mid-run is a different run, and letting
      // it happen silently is how a frame ends up describing work nobody asked
      // for.
      if (frame.goal !== undefined) return refuse("the goal is already set")
      if (event.acceptance.length === 0) return refuse("a goal with no acceptance criteria cannot be proved")
      if (event.acceptance.some((entry) => entry.length === 0 || entry.length > TEXT_LIMIT)) {
        return refuse("an acceptance criterion is empty or over the limit")
      }
      return advance({ goal: Object.freeze({ statement: event.statement, acceptance: frozen([...event.acceptance]) }) })
    }

    case "constraint-added": {
      if (frame.constraints.some((entry) => entry.id === event.id)) return refuse(`constraint ${event.id} exists`)
      return advance({
        constraints: frozen([...frame.constraints, Object.freeze({ id: event.id, kind: event.kind, subject: event.subject })]),
      })
    }

    case "unknown-raised": {
      if (frame.unknowns.some((entry) => entry.id === event.id)) return refuse(`unknown ${event.id} exists`)
      return advance({ unknowns: frozen([...frame.unknowns, Object.freeze({ id: event.id, question: event.question })]) })
    }

    case "unknown-resolved": {
      const index = frame.unknowns.findIndex((entry) => entry.id === event.id)
      if (index < 0) return refuse(`no unknown ${event.id}`)
      const current = frame.unknowns[index]!
      if (current.answer !== undefined) return refuse(`unknown ${event.id} is already resolved`)
      return advance({ unknowns: replace(frame.unknowns, index, Object.freeze({ ...current, answer: event.answer })) })
    }

    case "assumption-made": {
      if (frame.assumptions.some((entry) => entry.id === event.id)) return refuse(`assumption ${event.id} exists`)
      return advance({
        assumptions: frozen([
          ...frame.assumptions,
          Object.freeze({ id: event.id, statement: event.statement, because: event.because }),
        ]),
      })
    }

    case "assumption-invalidated": {
      const index = frame.assumptions.findIndex((entry) => entry.id === event.id)
      if (index < 0) return refuse(`no assumption ${event.id}`)
      const current = frame.assumptions[index]!
      if (current.invalidatedBy !== undefined) return refuse(`assumption ${event.id} is already invalidated`)
      return advance({ assumptions: replace(frame.assumptions, index, Object.freeze({ ...current, invalidatedBy: event.by })) })
    }

    case "plan-set": {
      for (const step of event.steps) {
        if (step.id.length > TEXT_LIMIT) return refuse("a step id is over the limit")
        if (step.action.length > TEXT_LIMIT) return refuse(`step ${step.id} action is over the limit`)
      }
      // Delegated: the frame used to check that every dependency existed, which
      // is a different claim from "this plan can be executed" — it accepted
      // `a -> b -> a`, a plan in which nothing is ever ready. One definition of
      // a valid plan, in `planner.ts`, rather than two that agree until
      // somebody edits one.
      const validity = Planner.validate(event.steps)
      if (!validity.ok) return refuse(validity.why)
      // Replanning keeps the outcomes already observed. A plan that forgets a
      // finished step invites the run to do it twice.
      const previous = new Map(frame.plan.map((step) => [step.id, step] as const))
      return advance({
        plan: frozen(
          event.steps.map((step) =>
            Object.freeze({
              id: step.id,
              action: step.action,
              dependsOn: frozen([...step.dependsOn]),
              state: previous.get(step.id)?.state ?? "pending",
            }),
          ),
        ),
      })
    }

    case "step-started": {
      const index = frame.plan.findIndex((step) => step.id === event.id)
      if (index < 0) return refuse(`no step ${event.id}`)
      const step = frame.plan[index]!
      if (step.state !== "pending") return refuse(`step ${event.id} is ${step.state}, not pending`)
      const unmet = step.dependsOn.filter((id) => frame.plan.find((entry) => entry.id === id)?.state !== "done")
      if (unmet.length > 0) return refuse(`step ${event.id} depends on unfinished ${unmet.join(", ")}`)
      return advance({ plan: replace(frame.plan, index, Object.freeze({ ...step, state: "running" as const })) })
    }

    case "step-finished": {
      const index = frame.plan.findIndex((step) => step.id === event.id)
      if (index < 0) return refuse(`no step ${event.id}`)
      const step = frame.plan[index]!
      if (step.state !== "running") return refuse(`step ${event.id} is ${step.state}, not running`)
      return advance({ plan: replace(frame.plan, index, Object.freeze({ ...step, state: event.ok ? ("done" as const) : ("failed" as const) })) })
    }

    case "proof-recorded": {
      if (frame.proofs.some((entry) => entry.id === event.id)) return refuse(`proof ${event.id} exists`)
      // A proof about nothing is the shape a self-certifying run takes: it
      // records that something was verified without saying what.
      const known =
        frame.constraints.some((entry) => entry.id === event.about) ||
        frame.plan.some((step) => step.id === event.about) ||
        (frame.goal?.acceptance.includes(event.about) ?? false)
      if (!known) return refuse(`proof ${event.id} is about ${event.about}, which is not a constraint, step, or criterion`)
      return advance({ proofs: frozen([...frame.proofs, Object.freeze({ id: event.id, about: event.about, evidence: event.evidence })]) })
    }

    case "budget-spent": {
      if (!Number.isFinite(event.tokens) || !Number.isFinite(event.seconds)) return refuse("budget must be finite")
      if (event.tokens < 0 || event.seconds < 0) return refuse("budget only ever goes up")
      return advance({
        spent: Object.freeze({
          tokens: frame.spent.tokens + event.tokens,
          seconds: frame.spent.seconds + event.seconds,
        }),
      })
    }
  }
}

/** Apply a sequence, collecting refusals rather than throwing on the first. */
export const applyAll = (
  frame: Frame,
  events: readonly Event[],
): { readonly frame: Frame; readonly refusals: readonly { readonly at: number; readonly why: string }[] } => {
  let current = frame
  const refusals: { readonly at: number; readonly why: string }[] = []
  events.forEach((event, index) => {
    const result = apply(current, event)
    if (result.ok) current = result.frame
    else refusals.push({ at: index, why: result.why })
  })
  return { frame: current, refusals }
}

// --- the fingerprint -----------------------------------------------------------

/**
 * A canonical string for the frame's content.
 *
 * Key order is fixed here rather than taken from object iteration order, so a
 * frame rebuilt by a different code path fingerprints the same. Collections are
 * left in their own order on purpose: the order the run raised its unknowns in
 * is part of what happened, not an incidental detail.
 */
const canonical = (frame: Frame): string =>
  JSON.stringify([
    frame.goal === undefined ? null : [frame.goal.statement, [...frame.goal.acceptance]],
    frame.constraints.map((entry) => [entry.id, entry.kind, entry.subject]),
    frame.unknowns.map((entry) => [entry.id, entry.question, entry.answer ?? null]),
    frame.assumptions.map((entry) => [entry.id, entry.statement, entry.because, entry.invalidatedBy ?? null]),
    frame.plan.map((step) => [step.id, step.action, [...step.dependsOn], step.state]),
    frame.proofs.map((entry) => [entry.id, entry.about, entry.evidence]),
    [frame.spent.tokens, frame.spent.seconds],
    frame.transitions,
  ])

/**
 * FNV-1a over the canonical form.
 *
 * Deterministic across processes and platforms, which a `Math.random`-seeded or
 * `Date`-touched fingerprint would not be — and a fingerprint that changes on
 * replay cannot detect the divergence it exists to detect.
 */
export const fingerprint = (frame: Frame): string => {
  const text = canonical(frame)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

export * as CognitiveFrame from "./cognitive-frame"
