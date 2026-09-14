import { describe, expect, test } from "bun:test"
import { unenforcedToolRunner } from "@abdo/control-contracts"
import type { EnforcedToolRunner } from "../src/index"
import { isTerminalRunEvent } from "@abdo/contracts/event"
import { MemoryEventStore } from "@abdo/event-store"
import { SessionRuntime, EventTypes } from "../src/index"
import type { ModelClient, ModelTurn, ToolCall, ToolRunner } from "../src/index"

const SID = "ses_run"

/** Model that yields a scripted sequence of turns, then repeats the last. */
function scriptedModel(turns: ModelTurn[]): ModelClient {
  let i = 0
  return {
    async call() {
      const t = turns[Math.min(i, turns.length - 1)]!
      i++
      return t
    },
  }
}

const okTools = unenforcedToolRunner({ async run() { return { ok: true as const, output: null } } }, "test fake")
const failTools = unenforcedToolRunner({ async run() { return { ok: false as const, error: "boom" } } }, "test fake")

async function terminalEvents(store: MemoryEventStore) {
  const all = await store.readAll()
  return all.filter((e) => isTerminalRunEvent(e.type))
}

function harness(model: ModelClient, tools: EnforcedToolRunner, budgets = {}, now?: () => number) {
  const store = new MemoryEventStore()
  const runtime = new SessionRuntime({ store, model, tools, budgets, now })
  return { store, runtime }
}

describe("SessionRuntime — happy paths", () => {
  test("final answer completes and appends the message", async () => {
    const { store, runtime } = harness(scriptedModel([{ kind: "final", text: "done" }]), okTools)
    const r = await runtime.run(SID)
    expect(r.state).toBe("completed")
    expect(r.reason).toBe("completed")
    expect(r.text).toBe("done")
    const types = (await store.readAll()).map((e) => e.type)
    expect(types).toContain(EventTypes.MessageAppended)
    expect(types).toContain(EventTypes.RunCompleted)
  })

  test("tools then final: tool executes, then completes", async () => {
    const { store, runtime } = harness(
      scriptedModel([{ kind: "tools", calls: [{ name: "ls", input: {} }] }, { kind: "final", text: "ok" }]),
      okTools,
    )
    const r = await runtime.run(SID)
    expect(r.state).toBe("completed")
    const types = (await store.readAll()).map((e) => e.type)
    expect(types).toContain(EventTypes.ToolExecuted)
    expect(types).toContain(EventTypes.RunCompleted)
  })
})

describe("SessionRuntime — failure paths always land terminal", () => {
  test("model rejection -> run.failed", async () => {
    const throwingModel: ModelClient = { async call() { throw new Error("provider down") } }
    const { store, runtime } = harness(throwingModel, okTools)
    const r = await runtime.run(SID)
    expect(r.state).toBe("failed")
    expect(r.reason).toBe("provider_error")
    expect((await terminalEvents(store))).toHaveLength(1)
  })

  test("tool failure -> run.failed", async () => {
    const { store, runtime } = harness(
      scriptedModel([{ kind: "tools", calls: [{ name: "rm", input: {} }] }]),
      failTools,
    )
    const r = await runtime.run(SID)
    expect(r.state).toBe("failed")
    expect(r.reason).toBe("tool_failed")
    expect(await terminalEvents(store)).toHaveLength(1)
  })
})

describe("SessionRuntime — cancellation", () => {
  test("aborted signal -> run.cancelled, no phantom running", async () => {
    const controller = new AbortController()
    controller.abort()
    const { store, runtime } = harness(scriptedModel([{ kind: "final", text: "x" }]), okTools)
    const r = await runtime.run(SID, { signal: controller.signal })
    expect(r.state).toBe("cancelled")
    expect(r.reason).toBe("cancelled")
    expect(await terminalEvents(store)).toHaveLength(1)
  })
})

describe("SessionRuntime — budgets pause (never run forever)", () => {
  test("turn budget exhausted -> run.paused(turn_budget)", async () => {
    // model always asks for tools -> loop would never end without a budget
    const { store, runtime } = harness(
      scriptedModel([{ kind: "tools", calls: [{ name: "loop", input: {} }] }]),
      okTools,
      { maxTurns: 3 },
    )
    const r = await runtime.run(SID)
    expect(r.state).toBe("paused")
    expect(r.reason).toBe("turn_budget")
    expect(await terminalEvents(store)).toHaveLength(1)
  })

  test("tool budget exhausted -> run.paused(tool_budget)", async () => {
    const { store, runtime } = harness(
      scriptedModel([{ kind: "tools", calls: [{ name: "a", input: {} }, { name: "b", input: {} }] }]),
      okTools,
      { maxToolCalls: 1 },
    )
    const r = await runtime.run(SID)
    expect(r.state).toBe("paused")
    expect(r.reason).toBe("tool_budget")
  })

  test("wall-clock budget exhausted -> run.paused(wall_clock_budget)", async () => {
    // Clock advances 1s per read: startedAt=1000, the wall-clock check reads 2000
    // => 1000ms elapsed > 50ms budget, so the run pauses before completing.
    let t = 1000
    const clock = () => {
      const v = t
      t += 1000
      return v
    }
    const { runtime } = harness(scriptedModel([{ kind: "final", text: "x" }]), okTools, { wallClockMs: 50 }, clock)
    const r = await runtime.run(SID)
    expect(r.state).toBe("paused")
    expect(r.reason).toBe("wall_clock_budget")
  })
})

describe("SessionRuntime — exactly one terminal event on every path", () => {
  const scenarios: Array<[string, () => ReturnType<typeof harness>, object?]> = [
    ["final", () => harness(scriptedModel([{ kind: "final", text: "x" }]), okTools)],
    ["tool-fail", () => harness(scriptedModel([{ kind: "tools", calls: [{ name: "x", input: {} }] }]), failTools)],
    ["turn-budget", () => harness(scriptedModel([{ kind: "tools", calls: [{ name: "x", input: {} }] }]), okTools, { maxTurns: 2 })],
  ]
  for (const [name, make] of scenarios) {
    test(`${name} => 1 terminal`, async () => {
      const { store, runtime } = make()
      await runtime.run(SID)
      expect(await terminalEvents(store)).toHaveLength(1)
    })
  }
})

describe("SessionRuntime — two-phase input durability", () => {
  test("admit records input; run promotes it exactly once", async () => {
    const { store, runtime } = harness(scriptedModel([{ kind: "final", text: "ok" }]), okTools)
    const inputId = await runtime.admit(SID, "hello")
    // Input is durable before any run happened.
    let types = (await store.readAll()).map((e) => e.type)
    expect(types).toEqual([EventTypes.InputAdmitted])

    await runtime.run(SID)
    const all = await store.readAll()
    const promotions = all.filter((e) => e.type === EventTypes.InputPromoted)
    expect(promotions).toHaveLength(1)
    expect((promotions[0]!.data as { inputId: string }).inputId).toBe(inputId)

    // A second run does not re-promote an already-promoted input.
    await runtime.run(SID)
    const promotions2 = (await store.readAll()).filter((e) => e.type === EventTypes.InputPromoted)
    expect(promotions2).toHaveLength(1)
  })
})
