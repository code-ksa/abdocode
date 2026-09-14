/**
 * SqliteEventStore — durable implementation of the @abdo/event-store port.
 *
 * Same contract as MemoryEventStore, but the ordering guarantee comes from the
 * database instead of an in-process mutex:
 *   - each append runs inside a `BEGIN IMMEDIATE` transaction, which takes the
 *     write lock up front, so the next sequence is computed while no other
 *     writer can interleave (safe across processes, not just fibers)
 *   - `UNIQUE(aggregate_kind, aggregate_id, sequence)` is the hard backstop
 *   - `UNIQUE(idempotency_key)` makes a replayed side-effect a no-op
 *
 * bun:sqlite is synchronous; the port is async, so results are wrapped in
 * resolved promises. Listeners fire after the transaction commits.
 */
import { Database } from "bun:sqlite"
import { withBusyRetry, withBusyRetrySync } from "./db-retry"
import { Id } from "@abdo/contracts"
import { SequenceConflictError } from "@abdo/contracts/error"
import type { AggregateKind, DomainEvent } from "@abdo/contracts/event"
import type { AppendRequest, AppendResult, EventStore, Unsubscribe } from "@abdo/event-store"

const DDL = `
CREATE TABLE IF NOT EXISTS events (
  global_seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT    NOT NULL UNIQUE,
  aggregate_kind TEXT    NOT NULL,
  aggregate_id   TEXT    NOT NULL,
  sequence       INTEGER NOT NULL,
  type           TEXT    NOT NULL,
  version        INTEGER NOT NULL,
  data           TEXT    NOT NULL,
  idempotency_key TEXT,
  occurred_at    INTEGER NOT NULL,
  UNIQUE(aggregate_kind, aggregate_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem ON events(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_agg ON events(aggregate_kind, aggregate_id, sequence);
`

interface Row {
  id: string
  aggregate_kind: string
  aggregate_id: string
  sequence: number
  type: string
  version: number
  data: string
  idempotency_key: string | null
  occurred_at: number
}

function rowToEvent(row: Row): DomainEvent {
  return {
    id: Id.EventID.from(row.id),
    aggregateKind: row.aggregate_kind as AggregateKind,
    aggregateId: row.aggregate_id,
    sequence: Id.EventSequence.from(row.sequence),
    type: row.type,
    version: row.version,
    data: JSON.parse(row.data),
    ...(row.idempotency_key !== null ? { idempotencyKey: Id.IdempotencyKey.from(row.idempotency_key) } : {}),
    occurredAt: row.occurred_at,
  }
}

export class SqliteEventStore implements EventStore {
  private readonly db: Database
  private readonly listeners = new Set<(event: DomainEvent) => void>()

  /** @param filename path to the db file, or ":memory:" for an ephemeral store. */
  constructor(filename = ":memory:") {
    this.db = new Database(filename, { create: true })
    // busy_timeout FIRST so even WAL setup/recovery waits instead of failing when
    // several processes open the same db at once. With BEGIN IMMEDIATE this
    // serializes cross-process appends safely.
    this.db.run("PRAGMA busy_timeout = 5000;")
    withBusyRetrySync(() => this.db.run("PRAGMA journal_mode = WAL;"))
    this.db.run("PRAGMA foreign_keys = ON;")
    withBusyRetrySync(() => this.db.run(DDL))
  }

  close(): void {
    this.db.close()
  }

  async append(request: AppendRequest): Promise<AppendResult> {
    // IMMEDIATE takes the write lock at BEGIN, serializing sequence assignment.
    // Under cross-process contention a writer can still get SQLITE_BUSY after the
    // busy_timeout; retry (the txn rolled back, so nothing was committed — safe,
    // DB-only). This is what makes concurrent multi-process appends robust.
    const result = await withBusyRetry(() => this.db.transaction((): AppendResult => this.commit(request)).immediate())
    if (!result.deduped) {
      for (const listener of this.listeners) {
        try {
          listener(result.event)
        } catch {
          // A subscriber must not break the write path.
        }
      }
    }
    return result
  }

  private commit(request: AppendRequest): AppendResult {
    if (request.idempotencyKey !== undefined) {
      const existing = this.db
        .query("SELECT * FROM events WHERE idempotency_key = ?")
        .get(request.idempotencyKey) as Row | null
      if (existing) return { event: rowToEvent(existing), deduped: true }
    }

    const maxRow = this.db
      .query("SELECT MAX(sequence) AS max FROM events WHERE aggregate_kind = ? AND aggregate_id = ?")
      .get(request.aggregateKind, request.aggregateId) as { max: number | null }
    const nextSequence = maxRow.max === null ? 0 : maxRow.max + 1

    if (request.expectedSequence !== undefined && request.expectedSequence !== nextSequence) {
      throw new SequenceConflictError({
        aggregateId: request.aggregateId,
        expected: request.expectedSequence,
        actual: nextSequence,
      })
    }

    const event: DomainEvent = {
      id: Id.EventID.create(),
      aggregateKind: request.aggregateKind,
      aggregateId: request.aggregateId,
      sequence: Id.EventSequence.from(nextSequence),
      type: request.type,
      version: request.version ?? 1,
      data: request.data,
      ...(request.idempotencyKey !== undefined
        ? { idempotencyKey: Id.IdempotencyKey.from(request.idempotencyKey) }
        : {}),
      occurredAt: Date.now(),
    }

    this.db
      .query(
        `INSERT INTO events (id, aggregate_kind, aggregate_id, sequence, type, version, data, idempotency_key, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.aggregateKind,
        event.aggregateId,
        nextSequence,
        event.type,
        event.version,
        JSON.stringify(event.data ?? null),
        request.idempotencyKey ?? null,
        event.occurredAt,
      )

    return { event, deduped: false }
  }

  async read(kind: AggregateKind, id: string, fromSequence = 0): Promise<DomainEvent[]> {
    const rows = this.db
      .query(
        "SELECT * FROM events WHERE aggregate_kind = ? AND aggregate_id = ? AND sequence >= ? ORDER BY sequence",
      )
      .all(kind, id, fromSequence) as Row[]
    return rows.map(rowToEvent)
  }

  async readAll(fromGlobalOffset = 0): Promise<DomainEvent[]> {
    const rows = this.db
      .query("SELECT * FROM events ORDER BY global_seq LIMIT -1 OFFSET ?")
      .all(fromGlobalOffset) as Row[]
    return rows.map(rowToEvent)
  }

  async lastSequence(kind: AggregateKind, id: string): Promise<number> {
    const row = this.db
      .query("SELECT MAX(sequence) AS max FROM events WHERE aggregate_kind = ? AND aggregate_id = ?")
      .get(kind, id) as { max: number | null }
    return row.max === null ? -1 : row.max
  }

  subscribe(listener: (event: DomainEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
