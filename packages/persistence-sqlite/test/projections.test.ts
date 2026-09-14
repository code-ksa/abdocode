import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { IllegalTransitionError } from "@abdo/contracts/error"
import { SqliteEventStore } from "../src/index"
import { foldSession, SessionProjector } from "../src/projections"

const SID = "ses_proj"

async function seedLifecycle(store: SqliteEventStore) {
  const emit = (type: string) => store.append({ aggregateKind: "session", aggregateId: SID, type, data: {} })
  await emit("run.admitted")
  await emit("run.preparing")
  await emit("run.calling")
  await emit("run.streaming")
  await emit("message.appended")
  await emit("message.appended")
  await emit("run.verifying")
  await emit("run.completed")
}

describe("SessionProjector — rebuild from log", () => {
  test("replays lifecycle into the exact terminal state", async () => {
    const store = new SqliteEventStore()
    await seedLifecycle(store)
    const view = await new SessionProjector(store).rebuild(SID)
    expect(view.state).toBe("completed")
    expect(view.terminal).toBe(true)
    expect(view.messageCount).toBe(2)
    expect(view.lastSequence).toBe(7)
    store.close()
  })

  test("projection is disposable: dropped view recomputes identically", async () => {
    const store = new SqliteEventStore()
    await seedLifecycle(store)
    const projector = new SessionProjector(store)
    const a = await projector.rebuild(SID)
    const b = await projector.rebuild(SID) // no cached state — pure recompute
    expect(b).toEqual(a)
    store.close()
  })

  test("terminal state survives a real restart (no phantom running)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-proj-"))
    const file = join(dir, "events.db")
    try {
      const first = new SqliteEventStore(file)
      await seedLifecycle(first)
      first.close()

      const reopened = new SqliteEventStore(file)
      const view = await new SessionProjector(reopened).rebuild(SID)
      expect(view.state).toBe("completed")
      expect(view.terminal).toBe(true)
      reopened.close()
    } finally {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* best-effort: Windows may briefly hold the db handle */ }
    }
  })

  test("a corrupt/illegal event order fails loudly", () => {
    // completed -> streaming is not a legal transition
    const events = [
      { sequence: 0, type: "run.completed" },
      { sequence: 1, type: "run.streaming" },
    ] as never[]
    expect(() => foldSession(SID, events)).toThrow(IllegalTransitionError)
  })
})
