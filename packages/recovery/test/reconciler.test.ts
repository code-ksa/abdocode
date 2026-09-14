import { describe, expect, test } from "bun:test"
import { MemoryEventStore } from "@abdo/event-store"
import { RecoveryReconciler } from "../src/index"

const SID = "ses_r"

function emitter(store: MemoryEventStore, runId: string) {
  return (type: string, data: Record<string, unknown> = {}) =>
    store.append({ aggregateKind: "session", aggregateId: SID, type, data: { runId, ...data } })
}

describe("RecoveryReconciler — classification", () => {
  test("a finished run is not unfinished", async () => {
    const store = new MemoryEventStore()
    const e = emitter(store, "run_1")
    await e("run.admitted")
    await e("run.calling", { turn: 1 })
    await e("run.streaming", { turn: 1 })
    await e("run.completed", { reason: "completed" })
    expect(await reconcilerRuns(store)).toHaveLength(0)
  })

  test("died mid-tool -> verify_tool with the pending tool details", async () => {
    const store = new MemoryEventStore()
    const e = emitter(store, "run_1")
    await e("run.admitted")
    await e("run.executing_tool", { turn: 1 })
    await e("tool.started", { toolExecutionId: "tex_9", tool: "write_file", idempotencyKey: "k1" })
    // no tool.executed, no terminal
    const decisions = await new RecoveryReconciler(store).decideForSession(SID)
    expect(decisions[0]!.kind).toBe("verify_tool")
    if (decisions[0]!.kind === "verify_tool") {
      expect(decisions[0]!.pendingTool.tool).toBe("write_file")
      expect(decisions[0]!.pendingTool.idempotencyKey).toBe("k1")
    }
  })

  test("a completed tool is not pending (started + executed)", async () => {
    const store = new MemoryEventStore()
    const e = emitter(store, "run_1")
    await e("run.admitted")
    await e("run.executing_tool", { turn: 1 })
    await e("tool.started", { toolExecutionId: "tex_1", tool: "read" })
    await e("tool.executed", { toolExecutionId: "tex_1", tool: "read", ok: true })
    // run still unfinished, but the tool finished -> continue, not verify
    const decisions = await new RecoveryReconciler(store).decideForSession(SID)
    expect(decisions[0]!.kind).toBe("continue")
  })

  test("model in flight -> retry_model (no side effect to worry about)", async () => {
    const store = new MemoryEventStore()
    const e = emitter(store, "run_1")
    await e("run.admitted")
    await e("run.preparing")
    await e("run.calling", { turn: 1 })
    const decisions = await new RecoveryReconciler(store).decideForSession(SID)
    expect(decisions[0]!.kind).toBe("retry_model")
  })

  test("multiple runs in one session are classified independently", async () => {
    const store = new MemoryEventStore()
    const a = emitter(store, "run_a")
    await a("run.admitted")
    await a("run.completed", { reason: "completed" }) // finished
    const b = emitter(store, "run_b")
    await b("run.admitted")
    await b("run.executing_tool", { turn: 1 })
    await b("tool.started", { toolExecutionId: "t", tool: "x" }) // unfinished mid-tool
    const decisions = await new RecoveryReconciler(store).decideForSession(SID)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.kind).toBe("verify_tool")
  })
})

async function reconcilerRuns(store: MemoryEventStore) {
  return new RecoveryReconciler(store).unfinishedRuns(SID)
}
