/**
 * EventStore port — the storage-agnostic contract for the append-only log.
 *
 * The in-memory impl (`MemoryEventStore`) and the future SQLite impl both
 * satisfy this. The runtime depends only on this interface, so persistence can
 * be swapped or tested without touching business logic.
 */
import type { DomainEvent } from "@abdo/contracts/event"
import type { AggregateKind } from "@abdo/contracts/event"

export interface AppendRequest {
  readonly aggregateKind: AggregateKind
  readonly aggregateId: string
  /** Dotted event name, e.g. "run.completed". */
  readonly type: string
  /** Event schema version (defaults to 1). Lets replay upcast old payloads. */
  readonly version?: number
  readonly data: unknown
  /** Present only for side-effecting appends; a repeat is a safe no-op. */
  readonly idempotencyKey?: string
  /**
   * Optimistic concurrency guard. If set, the append succeeds only when the
   * aggregate's next sequence equals this value; otherwise SequenceConflictError.
   * `-1`/omit means "append at whatever the current tail is".
   */
  readonly expectedSequence?: number
}

export interface AppendResult {
  readonly event: DomainEvent
  /** True when an idempotency key matched an existing event (no new write). */
  readonly deduped: boolean
}

export type Unsubscribe = () => void

export interface EventStore {
  /** Append one event to an aggregate's log. Serialized per aggregate. */
  append(request: AppendRequest): Promise<AppendResult>

  /** Events for one aggregate, ordered by sequence, from `fromSequence` (inclusive). */
  read(aggregateKind: AggregateKind, aggregateId: string, fromSequence?: number): Promise<DomainEvent[]>

  /** Whole log in global append order — used to rebuild projections. */
  readAll(fromGlobalOffset?: number): Promise<DomainEvent[]>

  /** Highest committed sequence for an aggregate, or -1 if it has no events. */
  lastSequence(aggregateKind: AggregateKind, aggregateId: string): Promise<number>

  /** Fire-and-forget notification on every committed event. */
  subscribe(listener: (event: DomainEvent) => void): Unsubscribe
}
