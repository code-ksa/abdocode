import { describe, expect, test } from "bun:test"
import { isTerminalRunEvent } from "@abdo/contracts/event"
import { MemoryEventStore } from "@abdo/event-store"
import { SessionRuntime } from "../src/index"
import type { EnforcedToolRunner, ModelClient, ModelTurn } from "../src/index"
import { unenforcedToolRunner } from "@abdo/control-contracts"

const SID = "ses_rob"

const terminals = async (store: MemoryEventStore) =>
  (await store.readAll()).filter((e) => isTerminalRunEvent(e.type))

describe("SessionRuntime — provider timeout", () => {
  test("a hung model call is failed by modelTimeoutMs (no phantom running)", async () => {
    const hung: ModelClient = { call: () => new Promise<ModelTurn>(() => {}) } // never resolves
    const store = new MemoryEventStore()
    const runtime = new SessionRuntime({ store, model: hung, tools: okTools(), modelTimeoutMs: 25 })
    const r = await runtime.run(SID)
    expect(r.state).toBe("failed")
    expect(r.reason).toBe("provider_error")
    expect(await terminals(store)).toHaveLength(1)
  })
})

describe("SessionRuntime — cancellation during tool execution", () => {
  test("aborting mid-tools lands cancelled, not stuck in executing_tool", async () => {
    const controller = new AbortController()
    const tools: EnforcedToolRunner = unenforcedToolRunner({
      async run() {
        controller.abort() // cancel arrives while tools are running
        return { ok: true as const, output: null }
      },
    }, "test fake")
    const model: ModelClient = {
      async call() {
        return { kind: "tools", calls: [{ name: "a", input: {} }, { name: "b", input: {} }] }
      },
    }
    const store = new MemoryEventStore()
    const runtime = new SessionRuntime({ store, model, tools })
    const r = await runtime.run(SID, { signal: controller.signal })
    expect(r.state).toBe("cancelled")
    expect(await terminals(store)).toHaveLength(1)
  })
})

describe("SessionRuntime — unavailable tool", () => {
  test("an unknown tool reported by the runner ends the run as failed", async () => {
    const tools = unenforcedToolRunner({ async run() { return { ok: false as const, error: "unknown tool: ghost" } } }, "test fake")
    const model: ModelClient = {
      async call() {
        return { kind: "tools", calls: [{ name: "ghost", input: {} }] }
      },
    }
    const store = new MemoryEventStore()
    const r = await new SessionRuntime({ store, model, tools }).run(SID)
    expect(r.state).toBe("failed")
    expect(r.reason).toBe("tool_failed")
    expect(await terminals(store)).toHaveLength(1)
  })
})

describe("SessionRuntime — terminal guarantee under adversity", () => {
  test("timeout AND cancel-mid-tool each produce exactly one terminal", async () => {
    // timeout
    const s1 = new MemoryEventStore()
    await new SessionRuntime({
      store: s1,
      model: { call: () => new Promise<ModelTurn>(() => {}) },
      tools: okTools(),
      modelTimeoutMs: 15,
    }).run("a")
    expect(await terminals(s1)).toHaveLength(1)
  })
})

function okTools(): EnforcedToolRunner {
  return unenforcedToolRunner({ async run() { return { ok: true as const, output: null } } }, "test fake")
}

describe("SessionRuntime — late/superseded response is rejected", () => {
  test("a model response is dropped if a newer request superseded it", async () => {
    const store = new MemoryEventStore()
    // This model, mid-call, simulates a newer attempt starting a fresh request,
    // then returns — so its own response is now stale and must not be applied.
    const supersedingModel: ModelClient = {
      async call() {
        await store.append({
          aggregateKind: "session",
          aggregateId: SID,
          type: "model.request.started",
          data: { runId: "OTHER", requestId: "req_newer" },
        })
        // ...but for the SAME run, a newer request also lands:
        const runEvents = await store.read("session", SID)
        const myRun = (runEvents.find((e) => e.type === "run.admitted")?.data as { runId?: string })?.runId
        await store.append({
          aggregateKind: "session",
          aggregateId: SID,
          type: "model.request.started",
          data: { runId: myRun, requestId: "req_supersedes" },
        })
        return { kind: "final", text: "stale answer" }
      },
    }
    const r = await new SessionRuntime({ store, model: supersedingModel, tools: okTools() }).run(SID)
    expect(r.state).toBe("cancelled") // dropped as superseded, not applied
    const types = (await store.readAll()).map((e) => e.type)
    expect(types).not.toContain("run.completed")
  })
})
