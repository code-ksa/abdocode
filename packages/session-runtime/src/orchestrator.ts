/**
 * The orchestrator (owner order, 2026-08-19) — roles are a HAT, not a headcount.
 *
 * The requirement, in the owner's words: with one agent, that agent is the
 * orchestrator and the designer and the builder and everything else. If more
 * agents are added — by a command in the chat, or from settings — they are
 * activated, each given a SPECIFIC task in a SEPARATE tree, and the
 * orchestrator merges their work.
 *
 * That is the concurrency dial (one lane does what four lanes do, slower)
 * extended from work to roles, and it has the same failure mode if it is built
 * carelessly. The moment "solo" takes a different code path from "a fleet", the
 * single-agent user is quietly running a lesser product: fewer verifications, a
 * skipped integration step, a design phase nobody performed. So there is ONE
 * pipeline. A role is an assignment of a phase to an agent, and with one agent
 * every assignment names the same one.
 *
 * Four rules the design turns on:
 *
 *   1. There is exactly ONE orchestrator, always. Adding workers never adds
 *      orchestrators — two orchestrators is two plans for one tree.
 *   2. A worker cannot activate workers. One level, or a chat command becomes
 *      a fork bomb with a budget.
 *   3. Chat activation and settings activation are the SAME function. Two entry
 *      points that build the same thing drift, and the one nobody tests is the
 *      one that ships wrong.
 *   4. Overlapping scopes are refused at ASSIGNMENT, not discovered at merge.
 *      Sprint 28 detects a conflict when two agents already did the work; the
 *      orchestrator's job is to not commission it twice.
 */
import type { IntegrationClaim, IntegrationPlan } from "@abdo/contracts/workspace"
import { planIntegration } from "@abdo/contracts/workspace"
import type { AgentMode } from "@abdo/control-contracts/modes"

export const OrchestratorEventTypes = {
  WorkersActivated: "orchestrator.workers_activated",
  WorkerAssigned: "orchestrator.worker_assigned",
  AssignmentRefused: "orchestrator.assignment_refused",
  WorkersRetired: "orchestrator.workers_retired",
} as const

/** The hats. With one agent, one agent wears all of them, in this order. */
export type AgentRole = "orchestrator" | "designer" | "builder" | "verifier" | "integrator"

export const ROLE_ORDER: readonly AgentRole[] = ["orchestrator", "designer", "builder", "verifier", "integrator"]

/** The mode ceiling each role runs under (Sprint 25). */
export const ROLE_MODE: Readonly<Record<AgentRole, AgentMode>> = {
  orchestrator: "PLAN",
  designer: "PLAN",
  builder: "BUILD",
  verifier: "VERIFY",
  integrator: "BUILD",
}

export interface AgentSlot {
  readonly agentId: string
  readonly roles: readonly AgentRole[]
  /** Where this agent works. Solo uses the shared tree; workers get worktrees. */
  readonly workspace: "shared" | "isolated"
}

export interface Fleet {
  readonly orchestratorId: string
  readonly slots: readonly AgentSlot[]
  readonly concurrency: number
  readonly why: string
}

/**
 * One agent, every hat.
 *
 * The default, and deliberately not a degraded mode. It runs the identical
 * pipeline; the only thing it lacks is parallelism, which costs wall-clock and
 * nothing else. Note the workspace: solo works in the SHARED tree, because
 * isolating one agent from nobody buys a worktree's cost for no benefit.
 */
export const soloFleet = (agentId = "agent_1"): Fleet => ({
  orchestratorId: agentId,
  slots: [{ agentId, roles: ROLE_ORDER, workspace: "shared" }],
  concurrency: 1,
  why: "one agent wearing every hat in sequence — the same pipeline, the same gates, more wall-clock",
})

export type ActivationSource = "chat_command" | "settings" | "api"

export interface ActivationRequest {
  readonly source: ActivationSource
  /** Who asked. A worker asking is refused. */
  readonly requestedBy: string
  readonly workers: number
  /** Roles to hand to the workers. The orchestrator keeps its own. */
  readonly workerRoles?: readonly AgentRole[]
}

export type ActivationResult =
  | { readonly kind: "activated"; readonly fleet: Fleet }
  | { readonly kind: "refused"; readonly why: string }

/** Bounded because a chat message should not be able to start forty agents. */
export const MAX_WORKERS = 8

/**
 * Activate workers — from chat, from settings, from the API, through here.
 *
 * The same function for all three sources on purpose. A settings toggle and a
 * chat command that built fleets separately would drift, and the drift would
 * live in whichever one has no test.
 */
export function activateWorkers(current: Fleet, request: ActivationRequest): ActivationResult {
  if (request.requestedBy !== current.orchestratorId)
    return {
      kind: "refused",
      why: `${request.requestedBy} is not the orchestrator — a worker cannot activate workers, or one chat command becomes a fork bomb with a budget`,
    }

  if (request.workers < 1)
    return { kind: "refused", why: "activating zero workers is not an activation; retire the fleet instead" }

  if (request.workers > MAX_WORKERS)
    return {
      kind: "refused",
      why: `${request.workers} workers exceeds the ${MAX_WORKERS} this fleet allows — a chat message should not be able to start forty agents`,
    }

  const workerRoles = request.workerRoles ?? ["builder"]
  if (workerRoles.includes("orchestrator"))
    return { kind: "refused", why: "there is exactly one orchestrator — two orchestrators is two plans for one tree" }

  const workers: AgentSlot[] = Array.from({ length: request.workers }, (_, i) => ({
    agentId: `worker_${i + 1}`,
    roles: workerRoles,
    workspace: "isolated" as const,
  }))

  return {
    kind: "activated",
    fleet: {
      orchestratorId: current.orchestratorId,
      slots: [
        // the orchestrator keeps every role the workers did NOT take, so
        // nothing falls between the two: with builders activated it still
        // designs, verifies and integrates
        { agentId: current.orchestratorId, roles: ROLE_ORDER.filter((r) => !workerRoles.includes(r)), workspace: "shared" },
        ...workers,
      ],
      concurrency: request.workers,
      why: `${request.workers} worker(s) activated from ${request.source} by ${request.requestedBy}; the orchestrator keeps ${ROLE_ORDER.filter((r) => !workerRoles.includes(r)).join(", ")}`,
    },
  }
}

/** Back to one agent wearing everything. */
export const retireWorkers = (fleet: Fleet): Fleet => soloFleet(fleet.orchestratorId)

export interface TaskSpec {
  readonly taskId: string
  readonly objective: string
  /** Files this task is expected to touch. Used to keep assignments disjoint. */
  readonly scope: readonly string[]
}

export interface Assignment {
  readonly taskId: string
  readonly agentId: string
  readonly role: AgentRole
  readonly mode: AgentMode
  readonly workspace: "shared" | "isolated"
  readonly scope: readonly string[]
}

export interface AssignmentPlan {
  readonly assignments: readonly Assignment[]
  readonly refused: readonly { readonly taskId: string; readonly why: string }[]
  readonly overlaps: readonly { readonly path: string; readonly tasks: readonly string[] }[]
  readonly why: string
}

/**
 * Give each worker a SPECIFIC task, and refuse tasks that would collide.
 *
 * The overlap check is the part worth having. Sprint 28 catches two agents that
 * edited the same file — after both have spent an hour on it. Catching it here
 * costs one comparison and means the second hour is never spent.
 *
 * Tasks are assigned in declaration order and a task that overlaps an
 * already-assigned one is REFUSED with the path named, rather than silently
 * queued behind it: "later" is a scheduling decision the orchestrator should
 * make explicitly, and a queue that forms itself is one nobody can see.
 */
export function assignTasks(fleet: Fleet, tasks: readonly TaskSpec[]): AssignmentPlan {
  // The ROLE decides who executes, not the workspace. The first version of
  // this took every isolated slot as an executor and never checked whether it
  // held the builder role, so a fleet of verifiers was handed building work —
  // caught by the test that removes `builder` from everybody.
  const executors = fleet.slots.filter((s) => s.roles.includes("builder"))
  const solo = executors.every((s) => s.workspace === "shared")

  if (executors.length === 0)
    return {
      assignments: [],
      refused: tasks.map((t) => ({ taskId: t.taskId, why: "no agent in this fleet holds the builder role" })),
      overlaps: [],
      why: "nothing could be assigned",
    }

  const assignments: Assignment[] = []
  const refused: { taskId: string; why: string }[] = []
  const overlaps: { path: string; tasks: string[] }[] = []
  const claimed = new Map<string, string>()

  for (const task of tasks) {
    const collisions = task.scope.filter((path) => claimed.has(path))
    if (collisions.length > 0) {
      for (const path of collisions) overlaps.push({ path, tasks: [claimed.get(path)!, task.taskId] })
      refused.push({
        taskId: task.taskId,
        why: `its scope overlaps ${collisions.map((p) => `${p} (${claimed.get(p)})`).join(", ")} — commissioning both is how two agents spend an hour each on the same file and disagree at the end`,
      })
      continue
    }
    for (const path of task.scope) claimed.set(path, task.taskId)

    // round-robin: with one executor every task lands on it, in order, which
    // is exactly the solo pipeline
    const executor = executors[assignments.length % executors.length]!
    assignments.push({
      taskId: task.taskId,
      agentId: executor.agentId,
      role: "builder",
      mode: ROLE_MODE.builder,
      workspace: executor.workspace,
      scope: task.scope,
    })
  }

  return {
    assignments,
    refused,
    overlaps,
    why: solo
      ? `${assignments.length} task(s) queued on the single agent, in order`
      : `${assignments.length} task(s) across ${executors.length} worker(s), scopes disjoint`,
  }
}

/**
 * Merge the workers' results.
 *
 * A thin wrapper over Sprint 28's `planIntegration` on purpose: the
 * orchestrator does not get its own merge rules. Unverified work does not enter
 * the shared tree and overlapping edits are reported rather than resolved,
 * whether one agent produced them or eight.
 */
export function integrateFleetWork(claims: readonly IntegrationClaim[]): IntegrationPlan {
  return planIntegration(claims)
}

/** What the orchestrator says about its own shape, for a human reading it. */
export function describeFleet(fleet: Fleet): string {
  const lines = [`orchestrator  ${fleet.orchestratorId}`, `concurrency   ${fleet.concurrency}`]
  for (const slot of fleet.slots) {
    lines.push(`  ${slot.agentId.padEnd(12)} ${slot.workspace.padEnd(9)} ${slot.roles.join(", ") || "(no roles)"}`)
  }
  lines.push(`why           ${fleet.why}`)
  return lines.join("\n")
}
