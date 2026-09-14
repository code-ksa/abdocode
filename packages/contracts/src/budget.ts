/**
 * Step Budget Planner (Sprint 13) — the budget is divided BEFORE the work
 * starts, and the last steps are never available to spend.
 *
 * The failure this exists to remove is the one the round-2 verdict scored 5/10:
 * a run that spends its whole allowance on the work and then has nothing left
 * to say what it did. Running out of budget is fine and expected. Running out
 * with no checkpoint and no resumable report is how a long task becomes a
 * mystery — the next session has to reconstruct it from prose, or redo it.
 *
 * So the total is split two ways. `spendable` is what the model may consume.
 * `reserved` is withheld: the run keeps enough room to roll back what it half
 * did and to write the report that makes it resumable. The phase allocations
 * are the plan (discovery / plan / implementation / testing / proof); the
 * reserve is the part that is ENFORCED.
 *
 * Phase attribution is mechanical, from what actually ran — never a claim the
 * model makes about itself.
 */

export type BudgetPhase = "discovery" | "plan" | "implementation" | "testing" | "proof"

/** The owner's split. They sum to 1; the test in budget.test.ts keeps them honest. */
export const PHASE_SHARES: Readonly<Record<BudgetPhase, number>> = {
  discovery: 0.15,
  plan: 0.15,
  implementation: 0.45,
  testing: 0.2,
  proof: 0.05,
}

export interface StepBudgetPlan {
  /** The hard ceiling — nothing may push total tool calls past this. */
  readonly totalToolCalls: number
  /** Withheld from the model so the run can always finish safely. */
  readonly reserved: number
  /** What ordinary work may consume. */
  readonly spendable: number
  /** Allocation of `spendable` across the phases, in whole steps. */
  readonly phases: Readonly<Record<BudgetPhase, number>>
}

/**
 * Reserve at least two steps — room to undo and to finish safely — and 5% on
 * larger budgets. A budget of one step gets no reserve, because leaving zero
 * steps for work would be a planner that plans nothing.
 *
 * The report itself costs no tool call, so it is written at ANY budget; the
 * reserve is what keeps compensating work (a rollback of the half-applied
 * change) reachable after the model has spent everything it was allowed.
 */
export function planStepBudget(totalToolCalls: number, options: { reserve?: number } = {}): StepBudgetPlan {
  const total = Math.max(1, Math.floor(totalToolCalls))
  const wanted = options.reserve ?? Math.max(2, Math.ceil(total * 0.05))
  // Never reserve so much that no work is possible; leave at least one step.
  const reserved = Math.min(wanted, Math.max(0, total - 1))
  const spendable = total - reserved
  const phases = {} as Record<BudgetPhase, number>
  for (const [phase, share] of Object.entries(PHASE_SHARES) as [BudgetPhase, number][]) {
    phases[phase] = Math.floor(spendable * share)
  }
  return { totalToolCalls: total, reserved, spendable, phases }
}

/**
 * Which phase a tool call belongs to, decided by what the call DOES.
 *
 * `read` risk is looking around; anything that can change the world is
 * implementation; the runtime's own verification is testing. A model that
 * calls its work "planning" cannot move a step into a cheaper bucket, because
 * nothing here asks the model.
 */
export function phaseOfToolCall(risk: string | undefined, toolName: string): BudgetPhase {
  if (/^(test|typecheck|lint|verify|check)/i.test(toolName)) return "testing"
  if (risk === "read") return "discovery"
  // The runtime dispatches through a runner that exposes no policy lookup, so
  // when risk is unknown the NAME decides. Anything unrecognised counts as
  // implementation: charging an unknown call to the largest, most expensive
  // bucket is the safe direction to be wrong in.
  if (risk === undefined && /^(read|list|ls|cat|grep|search|find|glob|inspect|show|describe)/i.test(toolName)) {
    return "discovery"
  }
  return "implementation"
}

/** Steps actually consumed, per phase. */
export type PhaseSpend = Readonly<Record<BudgetPhase, number>>

export const emptyPhaseSpend = (): PhaseSpend => ({
  discovery: 0,
  plan: 0,
  implementation: 0,
  testing: 0,
  proof: 0,
})

export const addPhaseSpend = (spend: PhaseSpend, phase: BudgetPhase, n = 1): PhaseSpend => ({
  ...spend,
  [phase]: spend[phase] + n,
})

/**
 * The report a run owes when it stops without finishing.
 *
 * It is deliberately self-contained: whoever picks this up gets the objective,
 * what was done, what is in the way and the exact next action WITHOUT reading
 * the conversation or replaying the log. That is the difference between a run
 * that ran out of budget and a run that was abandoned.
 */
export interface RunReport {
  readonly runId: string
  readonly reason: string
  readonly objective?: string
  readonly filesChanged: readonly string[]
  readonly commandsCompleted: readonly string[]
  readonly tests: readonly string[]
  readonly blocker?: string
  /** The exact next action, in the resumer's vocabulary. */
  readonly nextAction: string
  /**
   * The operation that was REFUSED at the boundary, if the run stopped while
   * about to do one.
   *
   * Without this a handover can only say "re-issue the tool" and the next run
   * has to guess which call that was — which loses exactly one step per session
   * boundary, silently. A gap is worse than a duplicate: a duplicate is visible.
   */
  readonly pending?: { readonly tool: string; readonly input?: unknown }
  readonly budget: {
    readonly plan: StepBudgetPlan
    readonly spent: number
    readonly bySpend: PhaseSpend
    readonly turnsUsed: number
    readonly wallClockMs: number
  }
  readonly at: number
}

/** True when a report can actually be acted on — the gate's definition of "valid". */
export function isResumableReport(report: RunReport | undefined): report is RunReport {
  return (
    report !== undefined &&
    typeof report.nextAction === "string" &&
    report.nextAction.length > 0 &&
    typeof report.reason === "string" &&
    report.reason.length > 0 &&
    report.budget !== undefined
  )
}
