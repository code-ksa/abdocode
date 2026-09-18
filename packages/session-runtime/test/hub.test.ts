import { describe, expect, test } from "bun:test"
import { StreamHub, classifyEvent } from "../src/index"
import type { ModelStreamEvent } from "../src/index"

const text = (t: string): ModelStreamEvent => ({ type: "text.delta", text: t })
const toolStart = (id: string): ModelStreamEvent => ({ type: "tool_call.started", providerToolCallId: id })
const completed: ModelStreamEvent = { type: "response.completed", finishReason: "stop" }

describe("classifyEvent", () => {
  test("display deltas are droppable; tool starts are required; completion is terminal", () => {
    expect(classifyEvent(text("x"))).toBe("droppable_display")
    expect(classifyEvent({ type: "reasoning.delta", text: "r" })).toBe("droppable_display")
    expect(classifyEvent({ type: "tool_call.arguments.delta", providerToolCallId: "c", delta: "{" })).toBe("droppable_display")
    expect(classifyEvent(toolStart("c"))).toBe("required_state")
    expect(classifyEvent(completed)).toBe("terminal")
    expect(classifyEvent({ type: "response.failed", error: { message: "x" } })).toBe("terminal")
  })
})

describe("StreamHub — bounded per-subscriber queues", () => {
  test("a slow subscriber never blocks publish and its memory stays bounded", () => {
    const hub = new StreamHub()
    const slow = hub.subscribe("slow", { capacity: 3 })
    // publish far more than capacity; the consumer never drains
    for (let i = 1; i <= 100; i++) hub.publish(i, text(`t${i}`))
    expect(slow.depth).toBeLessThanOrEqual(3) // bounded
    expect(slow.queuedBytes).toBeGreaterThan(0)
  })

  test("display deltas are dropped when full (safe — recoverable from the log)", () => {
    const hub = new StreamHub()
    const sub = hub.subscribe("s", { capacity: 2 })
    expect(hub.publish(1, text("a")).s).toBe("queued")
    expect(hub.publish(2, text("b")).s).toBe("queued")
    expect(hub.publish(3, text("c")).s).toBe("dropped_display") // full -> dropped
    expect(sub.depth).toBe(2)
  })

  test("a required/terminal event evicts an old display event to fit", () => {
    const hub = new StreamHub()
    const sub = hub.subscribe("s", { capacity: 2 })
    hub.publish(1, text("a"))
    hub.publish(2, text("b")) // queue: [a, b], both droppable
    expect(hub.publish(3, completed).s).toBe("queued") // evicts "a" to fit terminal
    const drained = sub.drain()
    expect(drained.map((q) => q.event.type)).toEqual(["text.delta", "response.completed"])
  })

  test("a slow consumer full of required events is detached and told to re-sync (never drops state)", () => {
    let resynced = false
    const hub = new StreamHub()
    const sub = hub.subscribe("s", { capacity: 2, onResync: () => (resynced = true) })
    expect(hub.publish(1, toolStart("c1")).s).toBe("queued")
    expect(hub.publish(2, toolStart("c2")).s).toBe("queued")
    // no droppable to evict, required event can't fit -> detach + resync signal
    expect(hub.publish(3, completed).s).toBe("resync_required")
    expect(sub.needsResync).toBe(true)
    expect(resynced).toBe(true)
  })

  test("after re-sync the subscriber resumes from its cursor with no duplicates", () => {
    const hub = new StreamHub()
    const sub = hub.subscribe("s", { capacity: 2 })
    hub.publish(1, text("a"))
    sub.drain() // cursor now 1
    hub.publish(1, text("a-dup")) // stale seq -> ignored (no dup)
    expect(sub.depth).toBe(0)
    hub.publish(2, text("b"))
    expect(sub.drain().map((q) => q.sequence)).toEqual([2])
  })

  test("re-sync clears after the consumer replays to a sequence", () => {
    const hub = new StreamHub()
    const sub = hub.subscribe("s", { capacity: 1 })
    hub.publish(1, toolStart("c1"))
    hub.publish(2, completed) // detaches
    expect(sub.needsResync).toBe(true)
    sub.resyncedTo(2)
    expect(sub.needsResync).toBe(false)
    expect(sub.lastSequence).toBe(2)
  })

  test("subscribers are independent — one detaching does not affect another", () => {
    const hub = new StreamHub()
    const slow = hub.subscribe("slow", { capacity: 1 })
    const fast = hub.subscribe("fast", { capacity: 100 })
    hub.publish(1, toolStart("c1"))
    hub.publish(2, toolStart("c2")) // slow detaches, fast is fine
    expect(slow.needsResync).toBe(true)
    expect(fast.needsResync).toBe(false)
    expect(fast.depth).toBe(2)
  })
})
