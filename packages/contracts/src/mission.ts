/**
 * Missions and sprints (Sprint 23) — the layer above the run.
 *
 * A run already records everything about ONE execution: its objective, spend,
 * tools, evidence, checkpoint and next action, all folded from the log without
 * reading a word of conversation. What the log could not say is which larger
 * piece of work that run belonged to, or how far along that work is.
 *
 * So there are three nested things now, and each is durable:
 *
 *   Mission   the whole job — "upgrade abdo to 2.1"
 *     Sprint  one unit of it, with a state machine and acceptance criteria
 *       Task  one piece of a sprint; a run executes a task, and a task may
 *             take several runs (a retry, a continuation, a subagent)
 *
 * The sprint's states are the part that has to be explicit. "Where are we?" was
 * answerable for a run and not for the work; after this it is answerable for
 * both, from the log alone, after any kind of restart.
 */
import type { DomainEvent } from "./event"

export const MissionEventTypes = {
  MissionCreated: "mission.created",
  MissionClosed: "mission.closed",
  SprintPlanned: "sprint.planned",
  SprintTransitioned: "sprint.transitioned",
  SprintBlocked: "sprint.blocked",
  TaskCreated: "task.created",
  TaskAttempted: "task.attempted",
  TaskResolved: "task.resolved",
  /** An illegal move was refused — recorded, never silently dropped. */
  TransitionRefused: "sprint.transition_refused",
} as const

export type SprintState =
  | "PLANNED"
  | "READY"
  | "RUNNING"
  | "VERIFYING"
  | "PASSED"
  | "COMMITTED"
  | "CLOSED"
  | "FAILED"
  | "DIAGNOSING"
  | "RETRYING"
  | "BLOCKED"

/**
 * The legal moves. Everything else is refused and written down.
 *
 * The rule the gate cares about most: nothing reaches COMMITTED except from
 * PASSED. A sprint that "committed" without a verification is the fake
 * completion this whole program exists to make impossible, moved up a level.
 */
export const SPRINT_TRANSITIONS: Readonly<Record<SprintState, readonly SprintState[]>> = {
  PLANNED: ["READY", "BLOCKED"],
  READY: ["RUNNING", "BLOCKED"],
  RUNNING: ["VERIFYING", "FAILED", "BLOCKED"],
  VERIFYING: ["PASSED", "FAILED", "BLOCKED"],
  PASSED: ["COMMITTED", "FAILED", "BLOCKED"],
  COMMITTED: ["CLOSED", "BLOCKED"],
  CLOSED: [],
  FAILED: ["DIAGNOSING", "BLOCKED"],
  DIAGNOSING: ["RETRYING", "BLOCKED"],
  // A retry re-enters the work, it does not skip to the end.
  RETRYING: ["RUNNING", "BLOCKED"],
  BLOCKED: ["READY", "DIAGNOSING", "CLOSED"],
}

export const canTransition = (from: SprintState, to: SprintState): boolean =>
  SPRINT_TRANSITIONS[from].includes(to)

/** States from which a sprint moves no further on its own. */
export const isSprintTerminal = (state: SprintState): boolean => state === "CLOSED"

export interface TaskAttempt {
  readonly attempt: number
  readonly runId?: string
  readonly startedAt: number
  readonly finishedAt?: number
  readonly outcome?: "passed" | "failed"
  /** Why this attempt failed, in the resumer's words. */
  readonly failureReason?: string
}

export interface TaskRecord {
  readonly taskId: string
  readonly sprintId: string
  readonly title: string
  readonly attempts: readonly TaskAttempt[]
  readonly state: "open" | "passed" | "failed"
  readonly runIds: readonly string[]
}

export interface SprintRecord {
  readonly sprintId: string
  readonly missionId: string
  readonly number: number
  readonly title: string
  readonly state: SprintState
  /** Every state it has been in, in order — the history a diagnosis needs. */
  readonly history: readonly { readonly state: SprintState; readonly at: number; readonly reason?: string }[]
  readonly acceptance: readonly string[]
  readonly tasks: readonly TaskRecord[]
  readonly startedAt: number
  readonly finishedAt?: number
  readonly blockedReason?: string
  readonly commit?: string
}

export interface MissionRecord {
  readonly missionId: string
  readonly title: string
  readonly sprints: readonly SprintRecord[]
  readonly createdAt: number
  readonly closedAt?: number
  /** The sprint that is not finished — where the work actually is. */
  readonly currentSprint?: SprintRecord
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const isSprintState = (v: unknown): v is SprintState => typeof v === "string" && v in SPRINT_TRANSITIONS

interface SprintDraft {
  sprintId: string
  missionId: string
  number: number
  title: string
  state: SprintState
  history: { state: SprintState; at: number; reason?: string }[]
  acceptance: string[]
  tasks: Map<string, { taskId: string; sprintId: string; title: string; attempts: TaskAttempt[]; runIds: string[] }>
  startedAt: number
  finishedAt?: number
  blockedReason?: string
  commit?: string
}

/** Fold every mission in a log. */
export function foldMissions(events: readonly DomainEvent[]): MissionRecord[] {
  const missions = new Map<string, { missionId: string; title: string; createdAt: number; closedAt?: number }>()
  const sprints = new Map<string, SprintDraft>()

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>
    const at = event.occurredAt

    switch (event.type) {
      case MissionEventTypes.MissionCreated: {
        const missionId = str(data.missionId)
        if (missionId === undefined) break
        missions.set(missionId, { missionId, title: str(data.title) ?? missionId, createdAt: at })
        break
      }
      case MissionEventTypes.MissionClosed: {
        const missionId = str(data.missionId)
        const mission = missionId !== undefined ? missions.get(missionId) : undefined
        if (mission) missions.set(mission.missionId, { ...mission, closedAt: at })
        break
      }
      case MissionEventTypes.SprintPlanned: {
        const sprintId = str(data.sprintId)
        const missionId = str(data.missionId)
        if (sprintId === undefined || missionId === undefined) break
        sprints.set(sprintId, {
          sprintId,
          missionId,
          number: num(data.number) ?? 0,
          title: str(data.title) ?? sprintId,
          state: "PLANNED",
          history: [{ state: "PLANNED", at }],
          acceptance: Array.isArray(data.acceptance) ? data.acceptance.filter((a): a is string => typeof a === "string") : [],
          tasks: new Map(),
          startedAt: at,
        })
        break
      }
      case MissionEventTypes.SprintTransitioned: {
        const sprint = sprints.get(str(data.sprintId) ?? "")
        const to = data.to
        if (sprint === undefined || !isSprintState(to)) break
        sprint.state = to
        sprint.history.push({ state: to, at, ...(str(data.reason) !== undefined ? { reason: str(data.reason)! } : {}) })
        if (to === "COMMITTED") sprint.commit = str(data.commit) ?? sprint.commit
        if (to === "CLOSED") sprint.finishedAt = at
        break
      }
      case MissionEventTypes.SprintBlocked: {
        const sprint = sprints.get(str(data.sprintId) ?? "")
        if (sprint === undefined) break
        sprint.state = "BLOCKED"
        sprint.blockedReason = str(data.reason)
        sprint.history.push({ state: "BLOCKED", at, ...(str(data.reason) !== undefined ? { reason: str(data.reason)! } : {}) })
        break
      }
      case MissionEventTypes.TaskCreated: {
        const sprint = sprints.get(str(data.sprintId) ?? "")
        const taskId = str(data.taskId)
        if (sprint === undefined || taskId === undefined) break
        if (!sprint.tasks.has(taskId)) {
          sprint.tasks.set(taskId, {
            taskId,
            sprintId: sprint.sprintId,
            title: str(data.title) ?? taskId,
            attempts: [],
            runIds: [],
          })
        }
        break
      }
      case MissionEventTypes.TaskAttempted: {
        const sprint = sprints.get(str(data.sprintId) ?? "")
        const task = sprint?.tasks.get(str(data.taskId) ?? "")
        if (task === undefined) break
        const runId = str(data.runId)
        task.attempts.push({
          attempt: num(data.attempt) ?? task.attempts.length + 1,
          ...(runId !== undefined ? { runId } : {}),
          startedAt: at,
        })
        if (runId !== undefined && !task.runIds.includes(runId)) task.runIds.push(runId)
        break
      }
      case MissionEventTypes.TaskResolved: {
        const sprint = sprints.get(str(data.sprintId) ?? "")
        const task = sprint?.tasks.get(str(data.taskId) ?? "")
        if (task === undefined) break
        const outcome = data.outcome === "passed" ? "passed" : "failed"
        const last = task.attempts[task.attempts.length - 1]
        if (last !== undefined) {
          task.attempts[task.attempts.length - 1] = {
            ...last,
            finishedAt: at,
            outcome,
            ...(str(data.failureReason) !== undefined ? { failureReason: str(data.failureReason)! } : {}),
          }
        }
        break
      }
    }
  }

  const byMission = new Map<string, SprintRecord[]>()
  for (const draft of [...sprints.values()].sort((a, b) => a.number - b.number || a.startedAt - b.startedAt)) {
    const tasks: TaskRecord[] = [...draft.tasks.values()].map((t) => {
      const last = t.attempts[t.attempts.length - 1]
      return {
        taskId: t.taskId,
        sprintId: t.sprintId,
        title: t.title,
        attempts: t.attempts,
        state: last?.outcome === "passed" ? "passed" : last?.outcome === "failed" ? "failed" : "open",
        runIds: t.runIds,
      }
    })
    const record: SprintRecord = {
      sprintId: draft.sprintId,
      missionId: draft.missionId,
      number: draft.number,
      title: draft.title,
      state: draft.state,
      history: draft.history,
      acceptance: draft.acceptance,
      tasks,
      startedAt: draft.startedAt,
      ...(draft.finishedAt !== undefined ? { finishedAt: draft.finishedAt } : {}),
      ...(draft.blockedReason !== undefined ? { blockedReason: draft.blockedReason } : {}),
      ...(draft.commit !== undefined ? { commit: draft.commit } : {}),
    }
    const list = byMission.get(draft.missionId) ?? []
    list.push(record)
    byMission.set(draft.missionId, list)
  }

  return [...missions.values()].map((m) => {
    const list = byMission.get(m.missionId) ?? []
    const current = list.find((s) => !isSprintTerminal(s.state))
    return {
      missionId: m.missionId,
      title: m.title,
      sprints: list,
      createdAt: m.createdAt,
      ...(m.closedAt !== undefined ? { closedAt: m.closedAt } : {}),
      ...(current !== undefined ? { currentSprint: current } : {}),
    }
  })
}

/**
 * The sentence a restarted process should be able to say.
 *
 * Deliberately a whole sentence rather than a struct: the point of this sprint
 * is that a human or an agent picking the work up mid-flight gets an answer,
 * not a data structure it has to interpret first.
 */
export function resumeBriefing(mission: MissionRecord): string {
  const sprint = mission.currentSprint
  if (sprint === undefined) {
    return mission.closedAt !== undefined
      ? `mission ${mission.title} is closed (${mission.sprints.length} sprints)`
      : `mission ${mission.title} has no open sprint`
  }
  const openTask = sprint.tasks.find((t) => t.state !== "passed")
  const parts = [`Sprint ${sprint.number} (${sprint.title}) is ${sprint.state}`]
  if (openTask !== undefined) {
    const attempt = openTask.attempts.length
    parts.push(`Task ${openTask.taskId} (${openTask.title}), attempt ${attempt || 1}`)
    const failed = [...openTask.attempts].reverse().find((a) => a.outcome === "failed" && a.failureReason)
    if (failed !== undefined) parts.push(`the previous attempt failed: ${failed.failureReason}`)
  }
  if (sprint.state === "BLOCKED" && sprint.blockedReason !== undefined) parts.push(`blocked: ${sprint.blockedReason}`)
  return parts.join("; ")
}
