/**
 * The mission ledger (Sprint 23) — the writer for the layer above the run.
 *
 * Everything here goes through the event store, so a mission's state survives
 * the process the same way a run's does: nothing lives in memory that a restart
 * would need and could not rebuild.
 *
 * The ledger refuses illegal moves rather than trusting callers. A refusal is
 * WRITTEN DOWN (`sprint.transition_refused`), because a guard that silently
 * drops a bad move leaves the caller believing it happened — which is the same
 * class of lie as a fake completion, one level up.
 */
import {
  MissionEventTypes,
  canTransition,
  foldMissions,
  resumeBriefing,
  type MissionRecord,
  type SprintState,
} from "@abdo/contracts/mission"
import type { ReconciliationResult } from "@abdo/contracts/reconciliation"
import { resumeDecision } from "@abdo/contracts/reconciliation"
import { currentVerdict, passIsEarned } from "@abdo/contracts/verification"
import type { DomainEvent } from "@abdo/contracts/event"
import type { EventStore } from "@abdo/event-store"

export interface MissionLedgerOptions {
  readonly store: EventStore
  /** Missions are their own aggregate: they outlive any one session. */
  readonly missionId: string
  readonly now?: () => number
}

export interface TransitionResult {
  readonly ok: boolean
  readonly from?: SprintState
  readonly to: SprintState
  readonly reason?: string
}

export class MissionLedger {
  constructor(private readonly options: MissionLedgerOptions) {}

  private append(type: string, data: Record<string, unknown>): Promise<unknown> {
    return this.options.store.append({
      aggregateKind: "mission",
      aggregateId: this.options.missionId,
      type,
      data: { missionId: this.options.missionId, ...data },
    })
  }

  private events(): Promise<readonly DomainEvent[]> {
    return this.options.store.read("mission", this.options.missionId)
  }

  private async read(): Promise<MissionRecord | undefined> {
    const events = await this.events()
    return foldMissions(events).find((m) => m.missionId === this.options.missionId)
  }

  async createMission(title: string): Promise<void> {
    await this.append(MissionEventTypes.MissionCreated, { title })
  }

  async planSprint(sprint: { sprintId: string; number: number; title: string; acceptance?: readonly string[] }): Promise<void> {
    await this.append(MissionEventTypes.SprintPlanned, {
      sprintId: sprint.sprintId,
      number: sprint.number,
      title: sprint.title,
      acceptance: sprint.acceptance ?? [],
    })
  }

  /**
   * Move a sprint. The move is checked against the table BEFORE it is written,
   * and a refusal is recorded with both states so the attempt is visible.
   */
  async transition(sprintId: string, to: SprintState, detail: { reason?: string; commit?: string } = {}): Promise<TransitionResult> {
    const mission = await this.read()
    const sprint = mission?.sprints.find((s) => s.sprintId === sprintId)
    if (sprint === undefined) {
      await this.append(MissionEventTypes.TransitionRefused, { sprintId, to, reason: "no such sprint" })
      return { ok: false, to, reason: "no such sprint" }
    }
    if (!canTransition(sprint.state, to)) {
      const reason = `${sprint.state} -> ${to} is not a legal move`
      await this.append(MissionEventTypes.TransitionRefused, { sprintId, from: sprint.state, to, reason })
      return { ok: false, from: sprint.state, to, reason }
    }

    // Sprint 27. The state machine says PASSED is reachable from VERIFYING;
    // this says WHO is allowed to say so. A sprint arrives at PASSED on a
    // recorded verdict from a run that did not build it, or it does not
    // arrive — the builder's own account of its work is not a verification,
    // however confident, and a caller that skipped the verifier entirely has
    // no verdict to point at at all.
    if (to === "PASSED") {
      const verdict = currentVerdict(await this.events(), sprintId)
      const earned = passIsEarned(verdict)
      if (!earned.ok) {
        await this.append(MissionEventTypes.TransitionRefused, { sprintId, from: sprint.state, to, reason: earned.why })
        return { ok: false, from: sprint.state, to, reason: earned.why }
      }
    }
    await this.append(MissionEventTypes.SprintTransitioned, {
      sprintId,
      from: sprint.state,
      to,
      ...(detail.reason !== undefined ? { reason: detail.reason } : {}),
      ...(detail.commit !== undefined ? { commit: detail.commit } : {}),
    })
    return { ok: true, from: sprint.state, to }
  }

  /**
   * Record what the repository actually says (Sprint 24).
   *
   * Stored on the mission's own timeline because reconciliation is about the
   * WORK, not about one session: the tree a mission resumes onto is the same
   * tree whichever process looks at it.
   */
  async recordReconciliation(result: ReconciliationResult, acknowledged?: { reason: string }): Promise<void> {
    await this.append("reconciliation.checked", {
      status: result.status,
      divergences: result.divergences,
      head: result.facts.head,
      branch: result.facts.branch ?? null,
      dirty: result.facts.dirty,
      ...(acknowledged !== undefined ? { acknowledged } : {}),
    })
    if (result.status !== "aligned") {
      await this.append("reconciliation.divergence", {
        status: result.status,
        divergences: result.divergences,
        ...(acknowledged !== undefined ? { acknowledged } : {}),
      })
    }
  }

  /**
   * Start work only if the repository and the ledger agree — or if somebody
   * has said, in writing, which of them is right.
   *
   * This is the transition that matters: RUNNING is where the agent begins
   * changing things, and beginning to change a tree that is not the tree the
   * plan was made against is how a resume destroys a manual fix.
   */
  async startWork(
    sprintId: string,
    reconciliation: ReconciliationResult,
    acknowledged?: { reason: string },
  ): Promise<TransitionResult> {
    await this.recordReconciliation(reconciliation, acknowledged)
    const decision = resumeDecision(reconciliation, acknowledged)
    if (!decision.allowed) {
      await this.append(MissionEventTypes.TransitionRefused, { sprintId, to: "RUNNING", reason: decision.why })
      return { ok: false, to: "RUNNING", reason: decision.why }
    }
    return this.transition(sprintId, "RUNNING", { reason: decision.why })
  }

  /** BLOCKED is reachable from anywhere, so it has its own door. */
  async block(sprintId: string, reason: string): Promise<void> {
    await this.append(MissionEventTypes.SprintBlocked, { sprintId, reason })
  }

  async createTask(task: { sprintId: string; taskId: string; title: string }): Promise<void> {
    await this.append(MissionEventTypes.TaskCreated, task)
  }

  /** A run is starting on this task — the link that ties the two layers. */
  async attemptTask(attempt: { sprintId: string; taskId: string; runId: string; attempt: number }): Promise<void> {
    await this.append(MissionEventTypes.TaskAttempted, attempt)
  }

  async resolveTask(resolution: {
    sprintId: string
    taskId: string
    outcome: "passed" | "failed"
    failureReason?: string
  }): Promise<void> {
    await this.append(MissionEventTypes.TaskResolved, resolution)
  }

  async closeMission(): Promise<void> {
    await this.append(MissionEventTypes.MissionClosed, {})
  }

  /** The mission as data. */
  mission(): Promise<MissionRecord | undefined> {
    return this.read()
  }

  /** The sentence a restarted process says before it does anything else. */
  async briefing(): Promise<string> {
    const mission = await this.read()
    return mission === undefined ? `mission ${this.options.missionId} does not exist` : resumeBriefing(mission)
  }
}
