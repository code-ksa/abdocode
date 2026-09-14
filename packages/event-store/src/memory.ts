/**
 * MemoryEventStore — reference implementation of the EventStore port.
 *
 * It embodies the V2 invariants without a database so they can be tested in
 * isolation and fast:
 *   - single writer per aggregate (KeyedMutex) => sequence never races
 *   - sequence assigned inside the serialized section, never guessed by callers
 *   - idempotency key dedupe => retries don't double-write
 *   - optimistic expectedSequence guard => concurrent intents fail loudly
 *   - global order preserved for projection rebuilds
 *
 * The SQLite impl will keep the same contract, replacing the mutex+array with
 * `BEGIN IMMEDIATE` + an atomic sequence row + UNIQUE(aggregate, sequence).
 */
import { EventID, EventSequence, IdempotencyKey } from "@abdo/contracts/id"
import { SequenceConflictError } from "@abdo/contracts/error"
import type { AggregateKind, DomainEvent } from "@abdo/contracts/event"
import { KeyedMutex } from "./mutex"
import type { AppendRequest, AppendResult, EventStore, Unsubscribe } from "./store"

const keyOf = (kind: AggregateKind, id: string) => `${kind}:${id}`

export class MemoryEventStore implements EventStore {
  private readonly mutex = new KeyedMutex()
  private readonly byAggregate = new Map<string, DomainEvent[]>()
  private readonly global: DomainEvent[] = []
  private readonly byIdempotency = new Map<string, DomainEvent>()
  private readonly listeners = new Set<(event: DomainEvent) => void>()

  append(request: AppendRequest): Promise<AppendResult> {
    const key = keyOf(request.aggregateKind, request.aggregateId)
    return this.mutex.run(key, async () => this.commit(key, request))
  }

  /** Runs only inside the per-aggregate serialized section. */
  private commit(key: string, request: AppendRequest): AppendResult {
    if (request.idempotencyKey !== undefined) {
      const existing = this.byIdempotency.get(request.idempotencyKey)
      if (existing) return { event: existing, deduped: true }
    }

    const log = this.byAggregate.get(key) ?? []
    const nextSequence = log.length // sequences are dense from 0

    if (request.expectedSequence !== undefined && request.expectedSequence !== nextSequence) {
      throw new SequenceConflictError({
        aggregateId: request.aggregateId,
        expected: request.expectedSequence,
        actual: nextSequence,
      })
    }

    const event: DomainEvent = {
      id: EventID.create(),
      aggregateKind: request.aggregateKind,
      aggregateId: request.aggregateId,
      sequence: EventSequence.from(nextSequence),
      type: request.type,
      version: request.version ?? 1,
      data: request.data,
      ...(request.idempotencyKey !== undefined
        ? { idempotencyKey: IdempotencyKey.from(request.idempotencyKey) }
        : {}),
      occurredAt: Date.now(),
    }

    log.push(event)
    this.byAggregate.set(key, log)
    this.global.push(event)
    if (request.idempotencyKey !== undefined) this.byIdempotency.set(request.idempotencyKey, event)

    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A misbehaving subscriber must not break the write path.
      }
    }
    return { event, deduped: false }
  }

  async read(kind: AggregateKind, id: string, fromSequence = 0): Promise<DomainEvent[]> {
    const log = this.byAggregate.get(keyOf(kind, id)) ?? []
    // EventSequence is a branded opaque in the new kernel (was a plain number
    // in the Effect core); it carries a number at runtime, so order-compare via
    // an explicit cast rather than reaching for a store-only helper.
    return log.filter((e) => (e.sequence as unknown as number) >= fromSequence)
  }

  async readAll(fromGlobalOffset = 0): Promise<DomainEvent[]> {
    return this.global.slice(fromGlobalOffset)
  }

  async lastSequence(kind: AggregateKind, id: string): Promise<number> {
    const log = this.byAggregate.get(keyOf(kind, id))
    return log && log.length > 0 ? log.length - 1 : -1
  }

  subscribe(listener: (event: DomainEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
