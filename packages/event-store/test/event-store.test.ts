import { describe, expect, test } from "bun:test"
import { SequenceConflictError } from "@abdo/contracts/error"
import { MemoryEventStore } from "../src/index"

const SES = { kind: "session" as const, id: "ses_test" }

describe("MemoryEventStore — sequencing", () => {
  test("assigns dense sequences from 0 in order", async () => {
    const store = new MemoryEventStore()
    for (let i = 0; i < 5; i++) {
      const r = await store.append({ aggregateKind: SES.kind, aggregateId: SES.id, type: "x", data: { i } })
      expect(Number(r.event.sequence)).toBe(i)
      expect(r.deduped).toBe(false)
    }
    expect(await store.lastSequence(SES.kind, SES.id)).toBe(4)
  })

  test("hundreds of CONCURRENT appends produce unique, gapless sequences", async () => {
    const store = new MemoryEventStore()
    const N = 500
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.append({ aggregateKind: SES.kind, aggregateId: SES.id, type: "burst", data: { i } }),
      ),
    )
    const seqs = results.map((r) => Number(r.event.sequence)).sort((a, b) => a - b)
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i))
    expect(new Set(seqs).size).toBe(N) // no duplicates
    const log = await store.read(SES.kind, SES.id)
    expect(log.map((e) => Number(e.sequence))).toEqual(Array.from({ length: N }, (_, i) => i))
  })

  test("different aggregates keep independent sequences", async () => {
    const store = new MemoryEventStore()
    await store.append({ aggregateKind: "session", aggregateId: "ses_a", type: "x", data: {} })
    await store.append({ aggregateKind: "session", aggregateId: "ses_a", type: "x", data: {} })
    const b = await store.append({ aggregateKind: "session", aggregateId: "ses_b", type: "x", data: {} })
    expect(Number(b.event.sequence)).toBe(0)
    expect(await store.lastSequence("session", "ses_a")).toBe(1)
    expect(await store.lastSequence("session", "ses_b")).toBe(0)
  })
})

describe("MemoryEventStore — idempotency", () => {
  test("same idempotency key is a safe no-op, not a double write", async () => {
    const store = new MemoryEventStore()
    const first = await store.append({
      aggregateKind: SES.kind,
      aggregateId: SES.id,
      type: "tool.executed",
      data: { cmd: "deploy" },
      idempotencyKey: "deploy-once",
    })
    const retry = await store.append({
      aggregateKind: SES.kind,
      aggregateId: SES.id,
      type: "tool.executed",
      data: { cmd: "deploy" },
      idempotencyKey: "deploy-once",
    })
    expect(retry.deduped).toBe(true)
    expect(retry.event.id).toBe(first.event.id)
    expect(await store.lastSequence(SES.kind, SES.id)).toBe(0) // only one event committed
  })
})

describe("MemoryEventStore — optimistic concurrency", () => {
  test("expectedSequence mismatch raises SequenceConflictError", async () => {
    const store = new MemoryEventStore()
    await store.append({ aggregateKind: SES.kind, aggregateId: SES.id, type: "x", data: {} })
    let caught: unknown
    try {
      await store.append({
        aggregateKind: SES.kind,
        aggregateId: SES.id,
        type: "x",
        data: {},
        expectedSequence: 0, // stale: next is actually 1
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SequenceConflictError)
    expect((caught as SequenceConflictError).expected).toBe(0)
    expect((caught as SequenceConflictError).actual).toBe(1)
  })

  test("correct expectedSequence commits", async () => {
    const store = new MemoryEventStore()
    await store.append({ aggregateKind: SES.kind, aggregateId: SES.id, type: "x", data: {}, expectedSequence: 0 })
    const r = await store.append({
      aggregateKind: SES.kind,
      aggregateId: SES.id,
      type: "x",
      data: {},
      expectedSequence: 1,
    })
    expect(Number(r.event.sequence)).toBe(1)
  })
})

describe("MemoryEventStore — replay & subscribe", () => {
  test("readAll returns global append order for projection rebuild", async () => {
    const store = new MemoryEventStore()
    await store.append({ aggregateKind: "session", aggregateId: "ses_a", type: "a1", data: {} })
    await store.append({ aggregateKind: "project", aggregateId: "prj_x", type: "p1", data: {} })
    await store.append({ aggregateKind: "session", aggregateId: "ses_a", type: "a2", data: {} })
    const all = await store.readAll()
    expect(all.map((e) => e.type)).toEqual(["a1", "p1", "a2"])
  })

  test("subscribe receives committed events and unsubscribes", async () => {
    const store = new MemoryEventStore()
    const seen: string[] = []
    const off = store.subscribe((e) => seen.push(e.type))
    await store.append({ aggregateKind: SES.kind, aggregateId: SES.id, type: "one", data: {} })
    off()
    await store.append({ aggregateKind: SES.kind, aggregateId: SES.id, type: "two", data: {} })
    expect(seen).toEqual(["one"])
  })
})
