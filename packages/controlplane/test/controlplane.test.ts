/**
 * Batch 9 GATES — S85 state in the log, S87 the gateway whose waiting is free,
 * S88 never twice and never lost, S89 inherit-and-narrow, S90 dependency order,
 * S91 the merged result, S92 hooks that cannot take a run down.
 */
import { describe, expect, test } from "bun:test"
import {
  claimTask,
  deriveCapabilities,
  orphanedTasks,
  permits,
  scheduleLevels,
  type Capabilities,
  type Claim,
  type TaskRecord,
} from "../src/registry"
import {
  applyReply,
  ask,
  confirmMerged,
  planMerge,
  runHooks,
  waitCost,
  type Channel,
  type Hook,
} from "../src/gateway"

const task = (taskId: string, over: Partial<TaskRecord> = {}): TaskRecord => ({
  taskId,
  objective: `do ${taskId}`,
  state: "queued",
  dependsOn: [],
  attempts: 0,
  ...over,
})

describe("S88 GATE — a task is not done twice and is not lost between agents", () => {
  const t = task("t1")

  test("a live claim blocks a second agent", () => {
    const claims: Claim[] = [{ taskId: "t1", agentId: "a1", at: 1000, leaseMs: 60_000 }]
    const result = claimTask(t, claims, { agentId: "a2", at: 2000 })
    expect(result.kind).toBe("refused")
    if (result.kind === "refused") {
      expect(result.heldBy).toBe("a1")
      expect(result.why).toContain("doing it twice is as bad as not doing it")
    }
  })

  test("an EXPIRED claim may be taken over — that is the other half of the same rule", () => {
    const claims: Claim[] = [{ taskId: "t1", agentId: "a1", at: 1000, leaseMs: 1000 }]
    expect(claimTask(t, claims, { agentId: "a2", at: 100_000 }).kind).toBe("claimed")
  })

  test("the same agent may renew its own claim", () => {
    const claims: Claim[] = [{ taskId: "t1", agentId: "a1", at: 1000, leaseMs: 60_000 }]
    expect(claimTask(t, claims, { agentId: "a1", at: 2000 }).kind).toBe("claimed")
  })

  test("a done task is not reclaimable, and an abandoned one needs a human", () => {
    expect(claimTask(task("t1", { state: "done" }), [], { agentId: "a", at: 1 }).kind).toBe("refused")
    const abandoned = claimTask(task("t1", { state: "abandoned" }), [], { agentId: "a", at: 1 })
    if (abandoned.kind === "refused") expect(abandoned.why).toContain("needs a human")
  })

  test("work held by nobody alive is FOUND — the lost half made visible", () => {
    const tasks = [task("t1", { state: "running" }), task("t2", { state: "running" }), task("t3", { state: "done" })]
    const claims: Claim[] = [
      { taskId: "t1", agentId: "a1", at: 1000, leaseMs: 60_000 },
      { taskId: "t2", agentId: "a2", at: 1000, leaseMs: 100 },
    ]
    const orphans = orphanedTasks(tasks, claims, 50_000)
    expect(orphans.map((t) => t.taskId)).toEqual(["t2"])
  })
})

describe("S90 GATE — a task that depends on another never starts first", () => {
  const tasks = [
    task("migrate"),
    task("deploy", { dependsOn: ["migrate", "build"] }),
    task("build"),
    task("smoke", { dependsOn: ["deploy"] }),
  ]

  test("levels put every dependency before its dependent", () => {
    const { levels, cycle } = scheduleLevels(tasks)
    expect(cycle).toEqual([])
    expect(levels[0]).toEqual(["build", "migrate"])
    expect(levels[1]).toEqual(["deploy"])
    expect(levels[2]).toEqual(["smoke"])
  })

  test("claiming a task whose dependency is unfinished is refused, with the blocker named", () => {
    const result = claimTask(tasks[1]!, [], { agentId: "a", at: 1 }, tasks)
    expect(result.kind).toBe("refused")
    if (result.kind === "refused") {
      expect(result.why).toContain("migrate")
      expect(result.why).toContain("against a state that does not exist yet")
    }
  })

  test("with the dependencies done, it may start", () => {
    const done = tasks.map((t) => (t.taskId === "migrate" || t.taskId === "build" ? { ...t, state: "done" as const } : t))
    expect(claimTask(done[1]!, [], { agentId: "a", at: 1 }, done).kind).toBe("claimed")
  })

  test("a cycle is REPORTED, never broken by picking a start nobody chose", () => {
    const cyclic = [task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })]
    const { cycle, levels } = scheduleLevels(cyclic)
    expect(cycle).toEqual(["a", "b"])
    expect(levels).toEqual([])
  })

  test("a dependency on something that does not exist is reported rather than ignored", () => {
    const { unknown } = scheduleLevels([task("a", { dependsOn: ["ghost"] })])
    expect(unknown).toEqual([{ taskId: "a", missing: ["ghost"] }])
  })
})

describe("S89 GATE — a sub-agent inherits and cannot widen", () => {
  const parent: Capabilities = {
    classes: ["read", "local_write"],
    tools: ["read_file", "write_file"],
    writeRoots: ["src", "test"],
    maxTokens: 100_000,
  }

  test("asking for a class the parent lacks is refused, and the widening is named", () => {
    const result = deriveCapabilities(parent, { classes: ["read", "local_write", "production_write"] })
    expect(result.kind).toBe("refused")
    if (result.kind === "refused") {
      expect(result.widened[0]).toContain("production_write")
      expect(result.why).toContain("privilege-escalation primitive with a friendly name")
    }
  })

  test("a write root outside the parent's is an escape, including a sneaky prefix", () => {
    expect(deriveCapabilities(parent, { writeRoots: ["src", "/etc"] }).kind).toBe("refused")
    // "srcx" starts with "src" as a STRING but is not inside it as a PATH
    expect(deriveCapabilities(parent, { writeRoots: ["srcx"] }).kind).toBe("refused")
    expect(deriveCapabilities(parent, { writeRoots: ["src/lib"] }).kind).toBe("granted")
  })

  test("a bigger token budget is a widening too", () => {
    expect(deriveCapabilities(parent, { maxTokens: 200_000 }).kind).toBe("refused")
  })

  test("narrowing is granted AND listed — a quiet reduction fails later as a task error", () => {
    const result = deriveCapabilities(parent, { classes: ["read"], maxTokens: 10_000 })
    expect(result.kind).toBe("granted")
    if (result.kind === "granted") {
      expect(result.narrowed).toContain("classes")
      expect(result.narrowed).toContain("maxTokens")
      expect(result.capabilities.tools).toEqual(parent.tools)
    }
  })

  test("the derived grant is actually enforced", () => {
    const child = deriveCapabilities(parent, { classes: ["read"], writeRoots: ["src"] })
    if (child.kind !== "granted") throw new Error("expected a grant")
    expect(permits(child.capabilities, { tool: "write_file", classes: ["local_write"], path: "src/a.ts" }).allowed).toBe(false)
    expect(permits(child.capabilities, { tool: "read_file", classes: ["read"], path: "src/a.ts" }).allowed).toBe(true)
    expect(permits(child.capabilities, { tool: "read_file", classes: ["read"], path: "test/a.ts" }).allowed).toBe(false)
  })
})

describe("S87 GATE — the request reaches a channel, the reply resumes, and waiting is FREE", () => {
  const working = (name: string): Channel => ({ name, async send() { return { delivered: true } } })
  const broken = (name: string): Channel => ({ name, async send() { throw new Error("network down") } })

  test("no channel is hardcoded — any of them satisfies the request", async () => {
    for (const name of ["telegram", "slack", "discord", "email"]) {
      const { pending } = await ask([working(name)], { requestId: "r1", runId: "run1", question: "deploy?", options: ["yes", "no"], at: 1 })
      expect(pending.state).toBe("pending")
      expect(pending.channel).toBe(name)
    }
  })

  test("undeliverable is NOT the same as unanswered", async () => {
    const { pending, deliveries } = await ask([broken("telegram")], {
      requestId: "r1",
      runId: "run1",
      question: "deploy?",
      options: ["yes", "no"],
      at: 1,
    })
    // nobody was asked, which an agent must not confuse with nobody has answered
    expect(pending.state).toBe("undeliverable")
    expect(deliveries[0]!.why).toContain("network down")
  })

  test("a failing channel does not stop a working one", async () => {
    const { pending, deliveries } = await ask([broken("telegram"), working("slack")], {
      requestId: "r1",
      runId: "run1",
      question: "deploy?",
      options: ["yes", "no"],
      at: 1,
    })
    expect(pending.state).toBe("pending")
    expect(pending.channel).toBe("slack")
    expect(deliveries).toHaveLength(2)
  })

  test("free text is not an approval", async () => {
    const { pending } = await ask([working("slack")], { requestId: "r1", runId: "run1", question: "deploy?", options: ["yes", "no"], at: 1 })
    const loose = applyReply(pending, { requestId: "r1", answer: "ok but be careful", by: "owner", at: 2 }, 2)
    expect(loose.request.state).toBe("pending")
    expect(loose.why).toContain("reads \"ok but be careful\" as a yes")

    const strict = applyReply(pending, { requestId: "r1", answer: "yes", by: "owner", at: 2 }, 2)
    expect(strict.request.state).toBe("approved")
  })

  test("a reply after expiry does not approve a decision already made", async () => {
    const { pending } = await ask([working("slack")], {
      requestId: "r1",
      runId: "run1",
      question: "deploy?",
      options: ["yes", "no"],
      at: 1,
      expiresAt: 100,
    })
    const late = applyReply(pending, { requestId: "r1", answer: "yes", by: "owner", at: 500 }, 500)
    expect(late.request.state).toBe("expired")
  })

  test("waiting four hours costs ZERO tokens and ZERO model calls", async () => {
    const { pending } = await ask([working("telegram")], { requestId: "r1", runId: "run1", question: "deploy?", options: ["yes", "no"], at: 0 })
    // the run is a row in the log with nothing attached; this fails the first
    // time somebody adds "just poll every 30 seconds until they answer"
    const cost = waitCost(pending, 4 * 60 * 60 * 1000, 0, 0)
    expect(cost.waitedMs).toBe(14_400_000)
    expect(cost.tokensSpent).toBe(0)
    expect(cost.modelCalls).toBe(0)
  })
})

describe("S91 GATE — nothing merges until the gates are green on the MERGED result", () => {
  const green = [
    { workspaceId: "ws1", changed: ["src/a.ts"], gatesGreenAlone: true },
    { workspaceId: "ws2", changed: ["src/b.ts"], gatesGreenAlone: true },
  ]

  test("green alone is only permission to try", () => {
    const decision = planMerge(green)
    expect(decision.kind).toBe("merge")
    expect(confirmMerged(decision, false).committed).toBe(false)
    expect(confirmMerged(decision, false).why).toContain("a migration that runs twice")
    expect(confirmMerged(decision, true).committed).toBe(true)
  })

  test("a branch that failed its own gates does not reach the merge", () => {
    expect(planMerge([...green, { workspaceId: "ws3", changed: ["src/c.ts"], gatesGreenAlone: false }]).kind).toBe("refuse")
  })

  test("two branches on one file are refused before anything is combined", () => {
    const decision = planMerge([
      { workspaceId: "ws1", changed: ["src/a.ts"], gatesGreenAlone: true },
      { workspaceId: "ws2", changed: ["src/a.ts"], gatesGreenAlone: true },
    ])
    expect(decision.kind).toBe("refuse")
    if (decision.kind === "refuse") expect(decision.why).toContain("src/a.ts")
  })
})

describe("S92 GATE — a failing hook does not take the run down and cannot hide an event", () => {
  const ok = (name: string, log: string[]): Hook => ({
    name,
    phase: "after_tool",
    async run() {
      log.push(name)
    },
  })
  const bad = (name: string): Hook => ({
    name,
    phase: "after_tool",
    async run() {
      throw new Error("the webhook is down")
    },
  })

  test("one hook throwing does not stop the others or the run", async () => {
    const log: string[] = []
    const result = await runHooks([ok("first", log), bad("middle"), ok("last", log)], { phase: "after_tool", runId: "r" }, () => 0)
    expect(log).toEqual(["first", "last"])
    expect(result.outcomes.map((o) => o.ok)).toEqual([true, false, true])
    expect(result.outcomes[1]!.error).toContain("the webhook is down")
  })

  test("the event is emitted whatever the hooks do — a hook cannot suppress its own record", async () => {
    const result = await runHooks([bad("a"), bad("b")], { phase: "after_tool", runId: "r" }, () => 0)
    expect(result.eventEmitted).toBe(true)
    expect(result.outcomes.every((o) => !o.ok)).toBe(true)
  })

  test("hooks for other phases are not run", async () => {
    const log: string[] = []
    const other: Hook = { name: "plan", phase: "before_plan", async run() { log.push("plan") } }
    await runHooks([other, ok("tool", log)], { phase: "after_tool", runId: "r" }, () => 0)
    expect(log).toEqual(["tool"])
  })
})
