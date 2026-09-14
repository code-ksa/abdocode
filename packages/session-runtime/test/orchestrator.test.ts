/**
 * GATE (owner order) — one agent does everything ten agents do.
 *
 * The same demand as the concurrency dial, one level up: adding agents changes
 * WHO wears a hat, never WHICH hats exist. So the gate assigns the same work to
 * a solo fleet and to a fleet of workers and demands the same tasks come out
 * with the same scopes, and it asserts that no role goes missing when workers
 * take some of them.
 */
import { describe, expect, test } from "bun:test"
import {
  activateWorkers,
  assignTasks,
  describeFleet,
  integrateFleetWork,
  MAX_WORKERS,
  retireWorkers,
  ROLE_MODE,
  ROLE_ORDER,
  soloFleet,
  type TaskSpec,
} from "../src/orchestrator"

const TASKS: TaskSpec[] = [
  { taskId: "t1", objective: "add the config loader", scope: ["src/config.ts"] },
  { taskId: "t2", objective: "add the http client", scope: ["src/http.ts"] },
  { taskId: "t3", objective: "add the logger", scope: ["src/log.ts"] },
]

describe("GATE — solo is the same pipeline, not a lesser one", () => {
  test("one agent holds every role", () => {
    const fleet = soloFleet()
    expect(fleet.slots).toHaveLength(1)
    expect(fleet.slots[0]!.roles).toEqual(ROLE_ORDER)
    expect(fleet.concurrency).toBe(1)
    // and it works in the shared tree: isolating one agent from nobody costs a
    // worktree and buys nothing
    expect(fleet.slots[0]!.workspace).toBe("shared")
  })

  test("solo and a fleet produce the same tasks with the same scopes", () => {
    const solo = assignTasks(soloFleet(), TASKS)
    const activated = activateWorkers(soloFleet(), { source: "chat_command", requestedBy: "agent_1", workers: 3 })
    expect(activated.kind).toBe("activated")
    if (activated.kind !== "activated") return
    const fleet = assignTasks(activated.fleet, TASKS)

    const shape = (p: typeof solo) => p.assignments.map((a) => ({ taskId: a.taskId, scope: a.scope, role: a.role }))
    expect(shape(fleet)).toEqual(shape(solo))
    expect(solo.refused).toEqual([])
    expect(fleet.refused).toEqual([])
    // only the WHO differs
    expect(new Set(solo.assignments.map((a) => a.agentId)).size).toBe(1)
    expect(new Set(fleet.assignments.map((a) => a.agentId)).size).toBe(3)
  })

  test("no role disappears when workers take some of them", () => {
    const activated = activateWorkers(soloFleet(), {
      source: "settings",
      requestedBy: "agent_1",
      workers: 2,
      workerRoles: ["builder"],
    })
    if (activated.kind !== "activated") throw new Error("expected activation")
    const held = new Set(activated.fleet.slots.flatMap((s) => s.roles))
    for (const role of ROLE_ORDER) expect(held.has(role)).toBe(true)
    // the orchestrator kept designer, verifier and integrator
    const orchestrator = activated.fleet.slots.find((s) => s.agentId === "agent_1")!
    expect(orchestrator.roles).toContain("verifier")
    expect(orchestrator.roles).not.toContain("builder")
  })

  test("every role runs under a mode ceiling, and none of them is DEPLOY by default", () => {
    for (const role of ROLE_ORDER) expect(ROLE_MODE[role]).toBeDefined()
    expect(ROLE_MODE.orchestrator).toBe("PLAN")
    expect(ROLE_MODE.verifier).toBe("VERIFY")
    expect(Object.values(ROLE_MODE)).not.toContain("DEPLOY")
  })
})

describe("activation — one door for chat, settings and the API", () => {
  test("a chat command and a settings toggle build the identical fleet", () => {
    const fromChat = activateWorkers(soloFleet(), { source: "chat_command", requestedBy: "agent_1", workers: 4 })
    const fromSettings = activateWorkers(soloFleet(), { source: "settings", requestedBy: "agent_1", workers: 4 })
    if (fromChat.kind !== "activated" || fromSettings.kind !== "activated") throw new Error("expected activation")
    const strip = (f: typeof fromChat.fleet) => ({ ...f, why: "" })
    expect(strip(fromSettings.fleet)).toEqual(strip(fromChat.fleet))
  })

  test("a worker cannot activate workers — one chat command is not a fork bomb", () => {
    const activated = activateWorkers(soloFleet(), { source: "chat_command", requestedBy: "agent_1", workers: 2 })
    if (activated.kind !== "activated") throw new Error("expected activation")
    const nested = activateWorkers(activated.fleet, { source: "chat_command", requestedBy: "worker_1", workers: 8 })
    expect(nested.kind).toBe("refused")
    if (nested.kind === "refused") expect(nested.why).toContain("fork bomb")
  })

  test("there is exactly one orchestrator, always", () => {
    const two = activateWorkers(soloFleet(), {
      source: "api",
      requestedBy: "agent_1",
      workers: 2,
      workerRoles: ["orchestrator", "builder"],
    })
    expect(two.kind).toBe("refused")
    if (two.kind === "refused") expect(two.why).toContain("two plans for one tree")
  })

  test("the fleet is bounded", () => {
    const tooMany = activateWorkers(soloFleet(), { source: "chat_command", requestedBy: "agent_1", workers: MAX_WORKERS + 1 })
    expect(tooMany.kind).toBe("refused")
    expect(activateWorkers(soloFleet(), { source: "chat_command", requestedBy: "agent_1", workers: 0 }).kind).toBe("refused")
  })

  test("retiring returns to one agent wearing everything", () => {
    const activated = activateWorkers(soloFleet(), { source: "settings", requestedBy: "agent_1", workers: 3 })
    if (activated.kind !== "activated") throw new Error("expected activation")
    const retired = retireWorkers(activated.fleet)
    expect(retired.slots).toHaveLength(1)
    expect(retired.slots[0]!.roles).toEqual(ROLE_ORDER)
  })
})

describe("assignment — each worker gets a SPECIFIC task in its own tree", () => {
  test("workers get isolated workspaces; the solo agent does not", () => {
    const activated = activateWorkers(soloFleet(), { source: "chat_command", requestedBy: "agent_1", workers: 2 })
    if (activated.kind !== "activated") throw new Error("expected activation")
    const plan = assignTasks(activated.fleet, TASKS)
    expect(plan.assignments.every((a) => a.workspace === "isolated")).toBe(true)
    expect(assignTasks(soloFleet(), TASKS).assignments.every((a) => a.workspace === "shared")).toBe(true)
  })

  test("an overlapping scope is refused AT ASSIGNMENT, with the path named", () => {
    const overlapping: TaskSpec[] = [
      { taskId: "t1", objective: "rename the field", scope: ["src/config.ts"] },
      { taskId: "t2", objective: "add a field", scope: ["src/config.ts", "src/other.ts"] },
    ]
    const activated = activateWorkers(soloFleet(), { source: "chat_command", requestedBy: "agent_1", workers: 2 })
    if (activated.kind !== "activated") throw new Error("expected activation")
    const plan = assignTasks(activated.fleet, overlapping)

    expect(plan.assignments.map((a) => a.taskId)).toEqual(["t1"])
    expect(plan.refused[0]!.taskId).toBe("t2")
    expect(plan.refused[0]!.why).toContain("src/config.ts")
    // the point: this costs one comparison, and catching it at merge costs an
    // hour of two agents' work
    expect(plan.overlaps[0]!.tasks).toEqual(["t1", "t2"])
  })

  test("a fleet with no builder assigns nothing rather than guessing", () => {
    const activated = activateWorkers(soloFleet(), {
      source: "api",
      requestedBy: "agent_1",
      workers: 1,
      workerRoles: ["verifier"],
    })
    if (activated.kind !== "activated") throw new Error("expected activation")
    // the orchestrator kept `builder`, so this fleet CAN build — the honest
    // case is one where nobody holds it
    const plan = assignTasks(
      { ...activated.fleet, slots: activated.fleet.slots.map((s) => ({ ...s, roles: s.roles.filter((r) => r !== "builder") })) },
      TASKS,
    )
    expect(plan.assignments).toEqual([])
    expect(plan.refused).toHaveLength(3)
  })

  test("work is distributed round-robin, so no worker is idle while another queues", () => {
    const activated = activateWorkers(soloFleet(), { source: "chat_command", requestedBy: "agent_1", workers: 3 })
    if (activated.kind !== "activated") throw new Error("expected activation")
    const plan = assignTasks(activated.fleet, TASKS)
    expect(plan.assignments.map((a) => a.agentId)).toEqual(["worker_1", "worker_2", "worker_3"])
  })
})

describe("merging — the orchestrator does not get its own rules", () => {
  test("unverified work does not enter the shared tree, however many agents produced it", () => {
    const plan = integrateFleetWork([
      { workspaceId: "ws_1", agentId: "worker_1", changed: ["src/config.ts"], verified: true },
      { workspaceId: "ws_2", agentId: "worker_2", changed: ["src/http.ts"], verified: false },
    ])
    expect(plan.decision).toBe("integrate")
    expect(plan.order).toEqual(["ws_1"])
    expect(plan.refused.map((r) => r.workspaceId)).toEqual(["ws_2"])
  })

  test("two workers that edited the same file are reported, not merged", () => {
    const plan = integrateFleetWork([
      { workspaceId: "ws_1", agentId: "worker_1", changed: ["src/config.ts"], verified: true },
      { workspaceId: "ws_2", agentId: "worker_2", changed: ["src/config.ts"], verified: true },
    ])
    expect(plan.decision).toBe("refuse")
    expect(plan.conflicts[0]!.path).toBe("src/config.ts")
  })

  test("the fleet describes itself in something a human reads", () => {
    const text = describeFleet(soloFleet())
    expect(text).toContain("orchestrator  agent_1")
    expect(text).toContain("shared")
  })
})
