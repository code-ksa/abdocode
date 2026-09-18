/**
 * S132 — the plan as a DAG, and what replanning is not allowed to forget.
 *
 * # Why the cycle check is here and not in the frame
 *
 * `CognitiveFrame` already refused a step that depends on something outside the
 * plan. It accepted `a -> b -> a`, because "every dependency exists" and "the
 * plan can be executed" are different claims and only the first one was being
 * checked. A cyclic plan is not a plan: nothing in it is ever ready, so the run
 * either sits still or picks a step arbitrarily and calls the order a detail.
 * The frame now delegates to this module, so there is one definition of a
 * valid plan rather than two that agree until somebody edits one.
 *
 * # Why the ready set is ordered
 *
 * Two runs given the same plan must pick the same next step. A ready set whose
 * order depends on insertion or on hash iteration makes every downstream
 * comparison — replay, a diff between two runs, a golden trace — meaningless,
 * and the difference shows up as an unreproducible bug months later.
 *
 * # Why replanning is a merge and not a replacement
 *
 * A model asked to replan will happily emit a plan that omits the step it
 * already finished, and executing that plan does the work twice. Worse, it can
 * emit a plan that omits a step whose result was **proved**, and then the proof
 * refers to nothing. Replanning here keeps what happened and refuses to drop a
 * step that carries evidence.
 */

export type StepState = "pending" | "running" | "done" | "failed"

export interface Step {
  readonly id: string
  readonly action: string
  readonly dependsOn: readonly string[]
  readonly state: StepState
}

export interface StepInput {
  readonly id: string
  readonly action: string
  readonly dependsOn: readonly string[]
}

export type Validity = { readonly ok: true } | { readonly ok: false; readonly why: string }

/**
 * Is this a plan that can actually be run?
 *
 * Returns the first problem, naming the offending step — and for a cycle, the
 * path around it. "The plan is invalid" sends somebody reading the whole plan;
 * "a -> b -> c -> a" sends them to the edge they have to cut.
 */
export const validate = (steps: readonly StepInput[]): Validity => {
  if (steps.length === 0) return { ok: false, why: "an empty plan is not a plan" }

  const byId = new Map<string, StepInput>()
  for (const step of steps) {
    if (step.id.length === 0) return { ok: false, why: "a step has an empty id" }
    if (step.action.length === 0) return { ok: false, why: `step ${step.id} has no action` }
    if (byId.has(step.id)) return { ok: false, why: `two steps share the id ${step.id}` }
    byId.set(step.id, step)
  }

  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (dependency === step.id) return { ok: false, why: `step ${step.id} depends on itself` }
      if (!byId.has(dependency)) {
        return { ok: false, why: `step ${step.id} depends on ${dependency}, which is not in the plan` }
      }
    }
  }

  // Depth-first, tracking the current path so the reported cycle is the actual
  // route rather than the set of nodes involved in one.
  const state = new Map<string, "open" | "closed">()
  const path: string[] = []
  const walk = (id: string): Validity => {
    const seen = state.get(id)
    if (seen === "closed") return { ok: true }
    if (seen === "open") {
      const from = path.indexOf(id)
      return { ok: false, why: `the plan has a cycle: ${[...path.slice(from), id].join(" -> ")}` }
    }
    state.set(id, "open")
    path.push(id)
    for (const dependency of byId.get(id)!.dependsOn) {
      const result = walk(dependency)
      if (!result.ok) return result
    }
    path.pop()
    state.set(id, "closed")
    return { ok: true }
  }

  for (const step of steps) {
    const result = walk(step.id)
    if (!result.ok) return result
  }
  return { ok: true }
}

/**
 * Steps that could be started right now, in a fixed order.
 *
 * Sorted by id, not by position: two callers that built the same plan from the
 * same facts in a different order must get the same answer, or the plan is not
 * a plan, it is a preference.
 */
export const ready = (plan: readonly Step[]): readonly Step[] => {
  const done = new Set(plan.filter((step) => step.state === "done").map((step) => step.id))
  return plan
    .filter((step) => step.state === "pending" && step.dependsOn.every((dependency) => done.has(dependency)))
    .toSorted((left, right) => left.id.localeCompare(right.id))
}

/** Steps that can never run because something they need failed. */
export const blocked = (plan: readonly Step[]): readonly Step[] => {
  const failed = new Set(plan.filter((step) => step.state === "failed").map((step) => step.id))
  if (failed.size === 0) return []
  // Transitive: a step behind a blocked step is blocked too, and reporting only
  // the direct dependents understates how much of the plan is already lost.
  let changed = true
  while (changed) {
    changed = false
    for (const step of plan) {
      if (failed.has(step.id) || step.state === "done") continue
      if (step.dependsOn.some((dependency) => failed.has(dependency))) {
        failed.add(step.id)
        changed = true
      }
    }
  }
  return plan
    .filter((step) => step.state === "pending" && failed.has(step.id))
    .toSorted((left, right) => left.id.localeCompare(right.id))
}

export type Replan =
  | { readonly ok: true; readonly plan: readonly Step[] }
  | { readonly ok: false; readonly why: string }

/**
 * Merge a new plan over the old one.
 *
 * `proved` is the set of step ids that evidence points at. Dropping one of
 * those is refused outright: the proof would survive in the record while the
 * thing it proved no longer appears anywhere, which is worse than either losing
 * both or keeping both — it is a run that can show evidence for work it no
 * longer claims to have planned.
 *
 * Steps that survive keep the state they had. A model replanning mid-run
 * routinely re-emits a step it already finished, and taking the new plan
 * literally does the work twice.
 */
export const replan = (
  previous: readonly Step[],
  next: readonly StepInput[],
  proved: Iterable<string> = [],
): Replan => {
  const validity = validate(next)
  if (!validity.ok) return { ok: false, why: validity.why }

  const incoming = new Set(next.map((step) => step.id))
  const dropped = previous.filter((step) => !incoming.has(step.id))
  const provedSet = new Set(proved)
  const droppedProven = dropped.filter((step) => provedSet.has(step.id)).map((step) => step.id)
  if (droppedProven.length > 0) {
    return {
      ok: false,
      why: `the new plan drops ${droppedProven.join(", ")}, which carries evidence — a proof that points at a step nobody planned proves nothing`,
    }
  }

  const before = new Map(previous.map((step) => [step.id, step] as const))
  return {
    ok: true,
    plan: next.map((step) => ({
      id: step.id,
      action: step.action,
      dependsOn: [...step.dependsOn],
      state: before.get(step.id)?.state ?? "pending",
    })),
  }
}

export * as Planner from "./planner"
