/**
 * The plan ledger (Sprint 26) — drafting, critique and approval, on the record.
 *
 * The gate in `@abdo/control-contracts/plangate` decides; this is what writes
 * the thing it decides against. Approval is an EVENT, so "was this approved?"
 * is answered from the log rather than from anyone's memory, and an approval
 * that never happened cannot be remembered into existence.
 */
import { PlanEventTypes, approvedPlanFor, foldPlans, type PlanRecord, type PlanStep } from "@abdo/contracts/plan"
import type { EventStore } from "@abdo/event-store"

export interface PlanLedgerOptions {
  readonly store: EventStore
  readonly sessionId: string
}

export class PlanLedger {
  constructor(private readonly options: PlanLedgerOptions) {}

  private append(type: string, data: Record<string, unknown>): Promise<unknown> {
    return this.options.store.append({
      aggregateKind: "session",
      aggregateId: this.options.sessionId,
      type,
      data,
    })
  }

  async draft(plan: { planId: string; scope: string; objective: string; steps: readonly PlanStep[] }): Promise<void> {
    await this.append(PlanEventTypes.Drafted, {
      planId: plan.planId,
      scope: plan.scope,
      objective: plan.objective,
      steps: plan.steps,
    })
  }

  /**
   * A critique is recorded whether or not it found anything. "Reviewed and had
   * no concerns" and "was never reviewed" are different facts, and only one of
   * them should let an approval through.
   */
  async critique(planId: string, by: string, concerns: readonly string[]): Promise<void> {
    await this.append(PlanEventTypes.Critiqued, { planId, by, concerns })
  }

  async approve(planId: string, by: string): Promise<void> {
    await this.append(PlanEventTypes.Approved, { planId, by })
  }

  async reject(planId: string, reason: string): Promise<void> {
    await this.append(PlanEventTypes.Rejected, { planId, reason })
  }

  async supersede(planId: string): Promise<void> {
    await this.append(PlanEventTypes.Superseded, { planId })
  }

  async plans(): Promise<PlanRecord[]> {
    return foldPlans(await this.options.store.read("session", this.options.sessionId))
  }

  /** The approved plan covering a scope, read from the log. */
  async approvedFor(scope: string): Promise<PlanRecord | undefined> {
    return approvedPlanFor(await this.options.store.read("session", this.options.sessionId), scope)
  }
}
