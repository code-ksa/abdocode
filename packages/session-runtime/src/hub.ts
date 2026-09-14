/**
 * StreamHub — fan-out of events to DISPLAY subscribers, with a bounded per-
 * subscriber queue so a slow consumer can never block the producer, the
 * persistence path, or the other subscribers, and can never grow memory without
 * limit. The event store is the source of truth; a subscriber is a detachable
 * view that can always re-sync from a cursor.
 *
 * Generic over the event type so it serves both the raw ModelStreamEvent display
 * layer (12F.1) and the host's UiStreamEvent layer (12H) with one implementation.
 *
 * Overflow policy per subscriber:
 *  - `droppable_display` (incremental display) may be dropped — the consumer can
 *    rebuild it from the persisted log,
 *  - `required_state`/`terminal` is NEVER silently dropped; if the queue can't
 *    make room, the slow subscriber is detached and told to re-sync
 *    (`stream.resync_required`) from its last acknowledged sequence.
 *
 * `publish` is synchronous and non-blocking: it offers to each queue and returns.
 */
import type { ModelStreamEvent } from "./ports"

export type DeliveryClass = "droppable_display" | "required_state" | "terminal"

export function classifyEvent(event: ModelStreamEvent): DeliveryClass {
  switch (event.type) {
    case "text.delta":
    case "reasoning.delta":
    case "usage":
    case "tool_call.arguments.delta":
      return "droppable_display"
    case "response.completed":
    case "response.failed":
      return "terminal"
    default:
      return "required_state"
  }
}

export interface QueuedEvent<E = ModelStreamEvent> {
  readonly sequence: number
  readonly cls: DeliveryClass
  readonly bytes: number
  readonly event: E
}

export interface SubscriberOptions {
  readonly capacity: number
  readonly maxBytes?: number
  readonly afterSequence?: number
  readonly onResync?: () => void
}

export type OfferResult = "queued" | "dropped_display" | "resync_required"

export class BoundedSubscriber<E = ModelStreamEvent> {
  private queue: QueuedEvent<E>[] = []
  private bytes = 0
  private resync = false
  private cursor: number

  constructor(
    readonly id: string,
    private readonly opts: SubscriberOptions,
  ) {
    this.cursor = opts.afterSequence ?? 0
  }

  get lastSequence(): number {
    return this.cursor
  }
  get needsResync(): boolean {
    return this.resync
  }
  get depth(): number {
    return this.queue.length
  }
  get queuedBytes(): number {
    return this.bytes
  }

  offer(item: QueuedEvent<E>): OfferResult {
    if (item.sequence <= this.cursor) return "queued" // already seen; ignore (no dup)
    if (this.resync) return "resync_required"

    if (this.hasRoom(item)) {
      this.push(item)
      return "queued"
    }
    if (item.cls === "droppable_display") return "dropped_display"

    if (this.evictOldestDroppable() && this.hasRoom(item)) {
      this.push(item)
      return "queued"
    }
    this.detach()
    return "resync_required"
  }

  drain(): QueuedEvent<E>[] {
    const out = this.queue
    this.queue = []
    this.bytes = 0
    for (const q of out) this.cursor = Math.max(this.cursor, q.sequence)
    return out
  }

  resyncedTo(sequence: number): void {
    this.cursor = Math.max(this.cursor, sequence)
    this.resync = false
  }

  private hasRoom(item: QueuedEvent<E>): boolean {
    if (this.queue.length + 1 > this.opts.capacity) return false
    if (this.opts.maxBytes !== undefined && this.bytes + item.bytes > this.opts.maxBytes) return false
    return true
  }
  private push(item: QueuedEvent<E>): void {
    this.queue.push(item)
    this.bytes += item.bytes
  }
  private evictOldestDroppable(): boolean {
    const i = this.queue.findIndex((q) => q.cls === "droppable_display")
    if (i < 0) return false
    this.bytes -= this.queue[i]!.bytes
    this.queue.splice(i, 1)
    return true
  }
  private detach(): void {
    this.resync = true
    this.queue = []
    this.bytes = 0
    this.opts.onResync?.()
  }
}

const modelSizeOf = (e: ModelStreamEvent): number => {
  if (e.type === "text.delta" || e.type === "reasoning.delta") return e.text.length
  if (e.type === "tool_call.arguments.delta") return e.delta.length
  return 32
}

export interface HubOptions<E> {
  readonly classify: (event: E) => DeliveryClass
  readonly sizeOf?: (event: E) => number
}

export class StreamHub<E = ModelStreamEvent> {
  private readonly subscribers = new Map<string, BoundedSubscriber<E>>()
  private readonly classify: (event: E) => DeliveryClass
  private readonly sizeOf: (event: E) => number

  constructor(opts?: HubOptions<E>) {
    this.classify = opts?.classify ?? (classifyEvent as unknown as (event: E) => DeliveryClass)
    this.sizeOf = opts?.sizeOf ?? (modelSizeOf as unknown as (event: E) => number)
  }

  subscribe(id: string, opts: SubscriberOptions): BoundedSubscriber<E> {
    const sub = new BoundedSubscriber<E>(id, opts)
    this.subscribers.set(id, sub)
    return sub
  }
  unsubscribe(id: string): void {
    this.subscribers.delete(id)
  }
  get(id: string): BoundedSubscriber<E> | undefined {
    return this.subscribers.get(id)
  }

  publish(sequence: number, event: E): Record<string, OfferResult> {
    const cls = this.classify(event)
    const bytes = this.sizeOf(event)
    const results: Record<string, OfferResult> = {}
    for (const [id, sub] of this.subscribers) results[id] = sub.offer({ sequence, cls, bytes, event })
    return results
  }
}
