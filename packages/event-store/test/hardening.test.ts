import { describe, expect, test } from "bun:test"
import { SequenceConflictError } from "@abdo/contracts/error"
import { MemoryEventStore } from "../src/index"

const kind = "session" as const

describe("EventStore — concurrency hardening", () => {
  test("interleaved concurrent appends across many sessions keep per-aggregate order", async () => {
    const store = new MemoryEventStore()
    const sessions = ["s1", "s2", "s3", "s4"]
    const perSession = 100
    const ops: Promise<unknown>[] = []
    for (const s of sessions) {
      for (let i = 0; i < perSession; i++) {
        ops.push(store.append({ aggregateKind: kind, aggregateId: s, type: "e", data: { i } }))
      }
    }
    await Promise.all(ops)
    for (const s of sessions) {
      const log = await store.read(kind, s)
      expect(log.map((e) => Number(e.sequence))).toEqual(Array.from({ length: perSession }, (_, i) => i))
    }
  })

  test("concurrent appends with the SAME idempotency key commit exactly once", async () => {
    const store = new MemoryEventStore()
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.append({ aggregateKind: kind, aggregateId: "s", type: "once", data: {}, idempotencyKey: "K" }),
      ),
    )
    const committed = results.filter((r) => !r.deduped)
    expect(committed).toHaveLength(1)
    expect(await store.lastSequence(kind, "s")).toBe(0)
    // every result points at the same event
    const ids = new Set(results.map((r) => r.event.id))
    expect(ids.size).toBe(1)
  })

  test("optimistic expectedSequence: exactly one of two racing intents wins", async () => {
    const store = new MemoryEventStore()
    const settle = await Promise.allSettled([
      store.append({ aggregateKind: kind, aggregateId: "s", type: "x", data: {}, expectedSequence: 0 }),
      store.append({ aggregateKind: kind, aggregateId: "s", type: "y", data: {}, expectedSequence: 0 }),
    ])
    const ok = settle.filter((r) => r.status === "fulfilled")
    const bad = settle.filter((r) => r.status === "rejected")
    expect(ok).toHaveLength(1)
    expect(bad).toHaveLength(1)
    expect((bad[0] as PromiseRejectedResult).reason).toBeInstanceOf(SequenceConflictError)
  })

  test("readAll preserves global commit order across interleaved sessions", async () => {
    const store = new MemoryEventStore()
    await store.append({ aggregateKind: kind, aggregateId: "a", type: "1", data: {} })
    await store.append({ aggregateKind: kind, aggregateId: "b", type: "2", data: {} })
    await store.append({ aggregateKind: kind, aggregateId: "a", type: "3", data: {} })
    await store.append({ aggregateKind: kind, aggregateId: "b", type: "4", data: {} })
    expect((await store.readAll()).map((e) => e.type)).toEqual(["1", "2", "3", "4"])
  })

  test("read(fromSequence) returns only the tail — supports incremental projection", async () => {
    const store = new MemoryEventStore()
    for (let i = 0; i < 5; i++) await store.append({ aggregateKind: kind, aggregateId: "s", type: `e${i}`, data: {} })
    const tail = await store.read(kind, "s", 3)
    expect(tail.map((e) => e.type)).toEqual(["e3", "e4"])
  })

  test("a subscriber that throws does not break the write path", async () => {
    const store = new MemoryEventStore()
    store.subscribe(() => {
      throw new Error("bad subscriber")
    })
    const r = await store.append({ aggregateKind: kind, aggregateId: "s", type: "e", data: {} })
    expect(r.deduped).toBe(false)
    expect(await store.lastSequence(kind, "s")).toBe(0)
  })
})
