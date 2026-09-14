import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MemoryEventStore } from "@abdo/event-store"
import { CHECKPOINT_EVENT, CheckpointStore, type RunCheckpoint } from "../src/index"

function cp(over: Partial<RunCheckpoint>): RunCheckpoint {
  return {
    runId: "run_1",
    sessionId: "ses_1",
    attempt: 1,
    sequence: 5,
    phase: "tool_completed",
    turn: 1,
    nextAction: "continue_after_tool_result",
    createdAt: 1,
    ...over,
  }
}

function withStore(fn: (store: CheckpointStore) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-cp-"))
    const s = new CheckpointStore(join(dir, "c.db"))
    try {
      await fn(s)
    } finally {
      s.close()
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* best-effort: Windows may briefly hold the db handle */ }
    }
  }
}

describe("CheckpointStore", () => {
  test(
    "record keeps only the latest per run (higher sequence wins)",
    withStore((s) => {
      s.record(cp({ sequence: 3, phase: "model_completed" }))
      s.record(cp({ sequence: 7, phase: "turn_completed" }))
      s.record(cp({ sequence: 5, phase: "tool_completed" })) // older -> ignored by guard
      expect(s.get("run_1")!.sequence).toBe(7)
      expect(s.get("run_1")!.phase).toBe("turn_completed")
    }),
  )

  test(
    "rebuildFrom reconstructs from the event log and derives sessionId from the event",
    withStore((s) => {
      const events = new MemoryEventStore()
      const seq = async (data: Partial<RunCheckpoint>) =>
        events.append({ aggregateKind: "session", aggregateId: "ses_1", type: CHECKPOINT_EVENT, data })
      return (async () => {
        // payload.sequence references the last stable event and is <= the log's latest
        await seq({ runId: "run_1", attempt: 1, sequence: 0, phase: "input_promoted", turn: 0, nextAction: "call_model", createdAt: 1 })
        await seq({ runId: "run_1", attempt: 1, sequence: 1, phase: "turn_completed", turn: 2, nextAction: "call_model", createdAt: 2 })
        const n = s.rebuildFrom(await events.readAll())
        expect(n).toBe(1)
        const got = s.get("run_1")!
        expect(got.sessionId).toBe("ses_1") // taken from event.aggregateId
        expect(got.phase).toBe("turn_completed") // latest checkpoint wins
      })()
    }),
  )

  test(
    "a checkpoint ahead of the log is ignored on rebuild",
    withStore((s) => {
      const events = new MemoryEventStore()
      return (async () => {
        // one real event at seq 0, but its payload claims sequence 999 (corrupt/ahead)
        await events.append({
          aggregateKind: "session",
          aggregateId: "ses_1",
          type: CHECKPOINT_EVENT,
          data: { runId: "run_1", attempt: 1, sequence: 999, phase: "turn_completed", turn: 1, nextAction: "call_model" },
        })
        const n = s.rebuildFrom(await events.readAll())
        expect(n).toBe(0) // ignored
        expect(s.get("run_1")).toBeUndefined()
      })()
    }),
  )
})
