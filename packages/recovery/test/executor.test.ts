import { describe, expect, test } from "bun:test"
import { MemoryEventStore } from "@abdo/event-store"
import {
  RecoveryExecutor,
  RecoveryReconciler,
  UnknownToolOutcomeError,
  type ToolRecoveryVerifier,
} from "../src/index"

const SID = "ses_x"

function seed(store: MemoryEventStore, runId: string) {
  return (type: string, data: Record<string, unknown> = {}) =>
    store.append({ aggregateKind: "session", aggregateId: SID, type, data: { runId, ...data } })
}

const verifier = (state: "applied" | "not_applied" | "partially_applied" | "unknown"): ToolRecoveryVerifier => ({
  verify: async () => (state === "unknown" ? { state, reason: "cannot tell" } : { state }),
})

describe("RecoveryExecutor — verify_tool outcomes", () => {
  async function pendingToolDecision(store: MemoryEventStore) {
    const e = seed(store, "run_1")
    await e("run.executing_tool", { turn: 1 })
    await e("tool.started", { toolExecutionId: "tex_1", tool: "write_file", idempotencyKey: "k1" })
    const [d] = await new RecoveryReconciler(store).decideForSession(SID)
    return d!
  }

  test("applied -> records recovered success once, tool no longer pending", async () => {
    const store = new MemoryEventStore()
    const d = await pendingToolDecision(store)
    const r = await new RecoveryExecutor(store, SID, { verifier: verifier("applied") }).execute(d)
    expect(r.kind).toBe("recovered_tool")
    const decisions = await new RecoveryReconciler(store).decideForSession(SID)
    expect(decisions.every((x) => x.kind !== "verify_tool")).toBe(true)
  })

  test("not_applied -> retryable", async () => {
    const store = new MemoryEventStore()
    const d = await pendingToolDecision(store)
    const r = await new RecoveryExecutor(store, SID, { verifier: verifier("not_applied") }).execute(d)
    expect(r.kind).toBe("retryable_tool")
  })

  test("partially_applied -> needs_approval", async () => {
    const store = new MemoryEventStore()
    const d = await pendingToolDecision(store)
    const r = await new RecoveryExecutor(store, SID, { verifier: verifier("partially_applied") }).execute(d)
    expect(r.kind).toBe("needs_approval")
  })

  test("unknown -> throws UnknownToolOutcomeError (stop, do not risk)", async () => {
    const store = new MemoryEventStore()
    const d = await pendingToolDecision(store)
    const exec = new RecoveryExecutor(store, SID, { verifier: verifier("unknown") })
    await expect(exec.execute(d)).rejects.toBeInstanceOf(UnknownToolOutcomeError)
  })

  test("no verifier -> needs_approval (cannot verify blindly)", async () => {
    const store = new MemoryEventStore()
    const d = await pendingToolDecision(store)
    const r = await new RecoveryExecutor(store, SID, {}).execute(d)
    expect(r.kind).toBe("needs_approval")
  })
})

describe("RecoveryExecutor — retry_model opens a new attempt", () => {
  test("crashed attempt is abandoned and a new attempt is opened (not mutated)", async () => {
    const store = new MemoryEventStore()
    const e = seed(store, "run_1")
    await e("run.preparing")
    await e("run.calling", { turn: 1 }) // model in flight
    const [d] = await new RecoveryReconciler(store).decideForSession(SID)
    expect(d!.kind).toBe("retry_model")

    const r = await new RecoveryExecutor(store, SID, {}).execute(d!)
    expect(r.kind).toBe("model_retry_scheduled")
    if (r.kind === "model_retry_scheduled") expect(r.attempt).toBe(2)

    // executor abandons the crashed attempt; continueRun (host) emits run.resumed.
    const types = (await store.readAll()).map((x) => x.type)
    expect(types).toContain("run.abandoned")
  })
})
