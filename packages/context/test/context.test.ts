import { describe, expect, test } from "bun:test"
import { RequestTooLargeError } from "@abdo/contracts/error"
import { MemoryEventStore } from "@abdo/event-store"
import {
  assertFits,
  buildSnapshot,
  ContextEventTypes,
  diffSnapshots,
  EventSourcedReconciler,
  fits,
  requiresNewBaseline,
  selectMode,
  staticSource,
  type ProviderEnvelope,
} from "../src/index"

describe("snapshot + delta", () => {
  test("diff detects added / changed / removed", async () => {
    const a = await buildSnapshot([staticSource("core/env", "linux"), staticSource("project/x", "1")])
    const b = await buildSnapshot([staticSource("core/env", "linux"), staticSource("project/y", "2")])
    const d = diffSnapshots(a, b)
    expect(d.added).toEqual(["project/y"])
    expect(d.removed).toEqual(["project/x"])
    expect(d.changed).toEqual([])
  })

  test("core/* change or any removal forces a new baseline; other change is incremental", () => {
    expect(requiresNewBaseline({ added: [], changed: ["core/env"], removed: [] })).toBe(true)
    expect(requiresNewBaseline({ added: [], changed: [], removed: ["project/x"] })).toBe(true)
    expect(requiresNewBaseline({ added: ["project/y"], changed: ["project/z"], removed: [] })).toBe(false)
  })
})

const ENV: ProviderEnvelope = { maxInputTokens: 1000, maxOutputTokens: 500, maxRequestBytes: 4000, maxMessages: 10, safetyMargin: 0.1 }

describe("budget manager (tokens AND bytes AND messages)", () => {
  test("a small request fits", () => {
    const r = fits({ messages: [{ role: "user", text: "hello" }], tools: [] }, ENV)
    expect(r.ok).toBe(true)
  })

  test("token overflow is caught and typed", () => {
    const big = "x".repeat(5000) // ~1250 tokens > 900 (1000 * 0.9)
    let caught: unknown
    try {
      assertFits({ messages: [{ role: "user", text: big }], tools: [] }, ENV)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(RequestTooLargeError)
    expect((caught as RequestTooLargeError).reason).toBe("tokens")
  })

  test("byte overflow is caught even when tokens fit", () => {
    // multibyte chars: few tokens by our estimate but many bytes
    const multibyte = "€".repeat(1200) // 1200 chars ~300 tokens (fits), but 3600 bytes > 3600? tune
    const r = fits({ messages: [{ role: "user", text: multibyte }], tools: [] }, ENV)
    // €=3 bytes => 3600 bytes; limit 3600 (4000*0.9). Push over with one more.
    const r2 = fits({ messages: [{ role: "user", text: "€".repeat(1201) }], tools: [] }, ENV)
    expect(r.ok).toBe(true)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toBe("bytes")
  })

  test("too many messages is caught", () => {
    const messages = Array.from({ length: 11 }, () => ({ role: "user", text: "hi" }))
    const r = fits({ messages, tools: [] }, ENV)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("messages")
  })
})

describe("execution modes", () => {
  test("selects the cheapest sufficient mode", () => {
    expect(selectMode({})).toBe("fast")
    expect(selectMode({ touchesFiles: true })).toBe("standard")
    expect(selectMode({ promptChars: 5000 })).toBe("standard")
    expect(selectMode({ serverAdmin: true })).toBe("deep")
    expect(selectMode({ priorTurns: 10 })).toBe("deep")
  })
})

describe("EventSourcedReconciler — epochs in the log", () => {
  const SID = "ses_ctx"

  test("first reconcile emits a baseline; unchanged reconcile emits nothing", async () => {
    const store = new MemoryEventStore()
    const sources = () => [staticSource("core/env", "linux"), staticSource("project/instr", "v1")]
    const rec = new EventSourcedReconciler(store, sources)

    await rec.reconcile(SID)
    let events = await store.readAll()
    expect(events.map((e) => e.type)).toEqual([ContextEventTypes.Baseline])

    await rec.reconcile(SID) // nothing changed
    events = await store.readAll()
    expect(events).toHaveLength(1) // still just the one baseline
  })

  test("non-core change appends an incremental update", async () => {
    const store = new MemoryEventStore()
    let instr = "v1"
    const rec = new EventSourcedReconciler(store, () => [staticSource("core/env", "linux"), staticSource("project/instr", instr)])
    await rec.reconcile(SID)
    instr = "v2"
    await rec.reconcile(SID)
    const types = (await store.readAll()).map((e) => e.type)
    expect(types).toEqual([ContextEventTypes.Baseline, ContextEventTypes.Update])
  })

  test("core change starts a fresh baseline epoch", async () => {
    const store = new MemoryEventStore()
    let env = "linux"
    const rec = new EventSourcedReconciler(store, () => [staticSource("core/env", env), staticSource("project/instr", "v1")])
    await rec.reconcile(SID)
    env = "windows"
    await rec.reconcile(SID)
    const types = (await store.readAll()).map((e) => e.type)
    expect(types).toEqual([ContextEventTypes.Baseline, ContextEventTypes.Baseline])
  })

  test("snapshot is reconstructable from the log (survives restart)", async () => {
    const store = new MemoryEventStore()
    let instr = "v1"
    const rec = new EventSourcedReconciler(store, () => [staticSource("core/env", "linux"), staticSource("project/instr", instr)])
    await rec.reconcile(SID)
    instr = "v2"
    await rec.reconcile(SID)

    // A brand-new reconciler over the same log reconstructs the same snapshot.
    const fresh = new EventSourcedReconciler(store, () => [])
    const snap = await fresh.snapshotFor(SID)
    expect(Object.keys(snap).sort()).toEqual(["core/env", "project/instr"])
  })
})
