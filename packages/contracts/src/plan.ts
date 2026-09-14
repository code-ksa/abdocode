/**
 * Plans (Sprint 26) — the durable artifact a mutation has to stand on.
 *
 * The discipline is EXPLORE → PLAN → CRITIQUE → APPROVED → MUTATE. The value is
 * not the ceremony; it is that the thing an agent is about to do exists in
 * writing, was read by something other than the agent that wrote it, and was
 * approved before anything changed. A plan produced after the fact is a
 * justification, and a justification is what this program keeps refusing to
 * accept in place of evidence.
 *
 * The plan lives in the log like everything else, so "was this approved?" is a
 * question about the record rather than about anybody's memory of the
 * conversation.
 */
import type { DomainEvent } from "./event"

export const PlanEventTypes = {
  Drafted: "plan.drafted",
  Critiqued: "plan.critiqued",
  Approved: "plan.approved",
  Rejected: "plan.rejected",
  Superseded: "plan.superseded",
} as const

export type PlanState = "drafted" | "critiqued" | "approved" | "rejected" | "superseded"

export interface PlanStep {
  readonly summary: string
  /** Files this step expects to touch, when the plan can say. */
  readonly files?: readonly string[]
}

export interface PlanCritique {
  readonly by: string
  readonly concerns: readonly string[]
  readonly at: number
}

export interface PlanRecord {
  readonly planId: string
  readonly sessionId: string
  /** The task or sprint this plan is for. */
  readonly scope: string
  readonly objective: string
  readonly steps: readonly PlanStep[]
  readonly state: PlanState
  readonly critiques: readonly PlanCritique[]
  readonly approvedBy?: string
  readonly approvedAt?: number
  readonly rejectedReason?: string
  readonly draftedAt: number
  /** Every file the plan says it will touch, flattened. */
  readonly declaredFiles: readonly string[]
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])

interface Draft {
  planId: string
  sessionId: string
  scope: string
  objective: string
  steps: PlanStep[]
  state: PlanState
  critiques: PlanCritique[]
  approvedBy?: string
  approvedAt?: number
  rejectedReason?: string
  draftedAt: number
}

/** Fold every plan in a log, newest state winning. */
export function foldPlans(events: readonly DomainEvent[]): PlanRecord[] {
  const drafts = new Map<string, Draft>()

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>
    const planId = str(data.planId)
    if (planId === undefined) continue
    const at = event.occurredAt

    switch (event.type) {
      case PlanEventTypes.Drafted: {
        const rawSteps = Array.isArray(data.steps) ? data.steps : []
        drafts.set(planId, {
          planId,
          sessionId: event.aggregateId,
          scope: str(data.scope) ?? "",
          objective: str(data.objective) ?? "",
          steps: rawSteps.map((s) => {
            const step = (s ?? {}) as Record<string, unknown>
            const files = strings(step.files)
            return { summary: str(step.summary) ?? "", ...(files.length > 0 ? { files } : {}) }
          }),
          state: "drafted",
          critiques: [],
          draftedAt: at,
        })
        break
      }
      case PlanEventTypes.Critiqued: {
        const plan = drafts.get(planId)
        if (plan === undefined) break
        plan.critiques.push({ by: str(data.by) ?? "unknown", concerns: strings(data.concerns), at })
        if (plan.state === "drafted") plan.state = "critiqued"
        break
      }
      case PlanEventTypes.Approved: {
        const plan = drafts.get(planId)
        if (plan === undefined) break
        plan.state = "approved"
        plan.approvedBy = str(data.by) ?? "unknown"
        plan.approvedAt = at
        break
      }
      case PlanEventTypes.Rejected: {
        const plan = drafts.get(planId)
        if (plan === undefined) break
        plan.state = "rejected"
        plan.rejectedReason = str(data.reason)
        break
      }
      case PlanEventTypes.Superseded: {
        const plan = drafts.get(planId)
        if (plan !== undefined) plan.state = "superseded"
        break
      }
    }
  }

  return [...drafts.values()].map((d) => ({
    planId: d.planId,
    sessionId: d.sessionId,
    scope: d.scope,
    objective: d.objective,
    steps: d.steps,
    state: d.state,
    critiques: d.critiques,
    ...(d.approvedBy !== undefined ? { approvedBy: d.approvedBy } : {}),
    ...(d.approvedAt !== undefined ? { approvedAt: d.approvedAt } : {}),
    ...(d.rejectedReason !== undefined ? { rejectedReason: d.rejectedReason } : {}),
    draftedAt: d.draftedAt,
    declaredFiles: [...new Set(d.steps.flatMap((s) => s.files ?? []))],
  }))
}

/**
 * The approved plan covering a scope, if there is one.
 *
 * The LAST approval in log order wins, not the highest timestamp. Two approvals
 * in the same millisecond tie on the clock and sort unpredictably; the log has
 * an order and it is the authority. (Found by a test that approved two plans
 * back to back and got the first one.)
 */
export function approvedPlanFor(events: readonly DomainEvent[], scope: string): PlanRecord | undefined {
  const plans = new Map(foldPlans(events).map((p) => [p.planId, p]))
  let winner: PlanRecord | undefined
  for (const event of events) {
    if (event.type !== PlanEventTypes.Approved) continue
    const planId = str(((event.data ?? {}) as Record<string, unknown>).planId)
    if (planId === undefined) continue
    const plan = plans.get(planId)
    // its CURRENT state must still be approved — a later rejection or
    // supersession undoes this approval however recent it was
    if (plan !== undefined && plan.scope === scope && plan.state === "approved") winner = plan
  }
  return winner
}

/**
 * A plan approved by the same agent that drafted it is not a review.
 *
 * Recorded as a distinct question rather than folded into `state`, because the
 * honest answer is sometimes "yes, it was self-approved, and that was allowed
 * here" — and that should be visible rather than indistinguishable from an
 * independent approval.
 */
export const isSelfApproved = (plan: PlanRecord, drafter: string): boolean =>
  plan.state === "approved" && plan.approvedBy === drafter
