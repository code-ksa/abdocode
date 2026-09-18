import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { SequenceConflictError } from "@abdo/contracts/error"
import { SqliteEventStore } from "../src/index"

const SES = { kind: "session" as const, id: "ses_test" }

describe("SqliteEventStore — same port invariants (in-memory)", () => {
  test("dense sequences from 0, lastSequence tracks", async () => {
    const store = new SqliteEventStore()
    for (let i = 0; i < 5; i++) {
      const r = await store.append({ aggregateKind: SES.kind, aggregateId: SES.id, type: "x", data: { i } })
      expect(Number(r.event.sequence)).toBe(i)
    }
    expect(await store.lastSequence(SES.kind, SES.id)).toBe(4)
    store.close()
  })

  test("many appends stay unique and gapless", async () => {
    const store = new SqliteEventStore()
    const N = 300
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.append({ aggregateKind: SES.kind, aggregateId: SES.id, type: "burst", data: { i } }),
      ),
    )
    const seqs = results.map((r) => Number(r.event.sequence)).sort((a, b) => a - b)
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i))
    expect(new Set(seqs).size).toBe(N)
    store.close()
  })

  test("idempotency key dedupes without a second row", async () => {
    const store = new SqliteEventStore()
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
    expect(await store.lastSequence(SES.kind, SES.id)).toBe(0)
    store.close()
  })

  test("expectedSequence mismatch raises SequenceConflictError", async () => {
    const store = new SqliteEventStore()
    await store.append({ aggregateKind: SES.kind, aggregateId: SES.id, type: "x", data: {} })
    let caught: unknown
    try {
      await store.append({
        aggregateKind: SES.kind,
        aggregateId: SES.id,
        type: "x",
        data: {},
        expectedSequence: 0,
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SequenceConflictError)
    expect((caught as SequenceConflictError).actual).toBe(1)
    store.close()
  })

  test("readAll returns global order; data round-trips through JSON", async () => {
    const store = new SqliteEventStore()
    await store.append({ aggregateKind: "session", aggregateId: "ses_a", type: "a1", data: { v: 1 } })
    await store.append({ aggregateKind: "project", aggregateId: "prj_x", type: "p1", data: { v: 2 } })
    const all = await store.readAll()
    expect(all.map((e) => e.type)).toEqual(["a1", "p1"])
    expect((all[0]!.data as { v: number }).v).toBe(1)
    store.close()
  })
})

describe("SqliteEventStore — durability across restart", () => {
  test("events survive close + reopen of the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-es-"))
    const file = join(dir, "events.db")
    try {
      const first = new SqliteEventStore(file)
      await first.append({ aggregateKind: SES.kind, aggregateId: SES.id, type: "run.admitted", data: {} })
      await first.append({ aggregateKind: SES.kind, aggregateId: SES.id, type: "run.completed", data: {} })
      first.close()

      // Simulate an app restart: brand new store instance, same file.
      const reopened = new SqliteEventStore(file)
      expect(await reopened.lastSequence(SES.kind, SES.id)).toBe(1)
      const events = await reopened.read(SES.kind, SES.id)
      expect(events.map((e) => e.type)).toEqual(["run.admitted", "run.completed"])
      reopened.close()
    } finally {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* best-effort: Windows may briefly hold the db handle */ }
      expect(existsSync(file)).toBe(false)
    }
  })
})
