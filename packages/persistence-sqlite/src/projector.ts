/**
 * RunStateProjector — a DURABLE, idempotent, rebuildable projection.
 *
 * Demonstrates the 10.7 contract:
 *   - the event log is the source of truth; this table is disposable
 *   - a projector checkpoint (last_sequence) makes catch-up idempotent, so a
 *     crash "after event commit, before projection update" is recovered by
 *     replaying only the un-projected tail
 *   - rebuild() drops everything and replays from zero
 *   - verify() proves the live projection equals a full replay (by hash)
 */
import { Database } from "bun:sqlite"
import type { DomainEvent } from "@abdo/contracts/event"
import type { EventStore } from "@abdo/event-store"

const PROJECTOR = "run_states"

const DDL = `
CREATE TABLE IF NOT EXISTS projector_state (
  projector_name TEXT PRIMARY KEY,
  last_sequence  INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS run_states (
  run_id     TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  state      TEXT NOT NULL,
  sequence   INTEGER NOT NULL
);
`

/** run.<x> lifecycle event -> the state it puts the run in. */
const STATE_OF: Record<string, string> = {
  "run.admitted": "input_admitted",
  "run.preparing": "preparing_context",
  "run.calling": "calling_model",
  "run.streaming": "streaming",
  "run.executing_tool": "executing_tool",
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "run.paused": "paused",
  "run.resumed": "preparing_context",
}

export class RunStateProjector {
  private readonly db: Database

  constructor(filename: string) {
    this.db = new Database(filename, { create: true })
    this.db.run("PRAGMA busy_timeout = 5000;")
    this.db.run("PRAGMA journal_mode = WAL;")
    
    this.db.run(DDL)
    if (!this.db.query("SELECT 1 FROM projector_state WHERE projector_name = ?").get(PROJECTOR)) {
      this.db.query("INSERT INTO projector_state VALUES (?, -1, ?, 1)").run(PROJECTOR, Date.now())
    }
  }

  close(): void {
    this.db.close()
  }

  lastSequence(): number {
    const r = this.db.query("SELECT last_sequence FROM projector_state WHERE projector_name = ?").get(PROJECTOR) as {
      last_sequence: number
    }
    return r.last_sequence
  }

  /**
   * Apply un-projected events (sequence > checkpoint) idempotently. Applying the
   * same event twice yields the same table (INSERT OR REPLACE keyed by run_id),
   * and events at/below the checkpoint are skipped.
   */
  catchUp(events: readonly DomainEvent[]): number {
    const from = this.lastSequence()
    let applied = 0
    const tx = this.db.transaction(() => {
      let last = from
      for (const e of events) {
        const seq = Number(e.sequence)
        if (seq <= from) continue // idempotent: already projected
        const runId = (e.data as { runId?: string } | null)?.runId
        const state = STATE_OF[e.type]
        if (runId && state) {
          this.db
            .query("INSERT INTO run_states (run_id, session_id, state, sequence) VALUES (?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET state=excluded.state, sequence=excluded.sequence")
            .run(runId, e.aggregateId, state, seq)
          applied++
        }
        last = Math.max(last, seq)
      }
      this.db.query("UPDATE projector_state SET last_sequence = ?, updated_at = ? WHERE projector_name = ?").run(last, Date.now(), PROJECTOR)
    })
    tx.immediate()
    return applied
  }

  /** Drop the projection and replay from zero. */
  async rebuild(store: EventStore): Promise<void> {
    this.db.run("DELETE FROM run_states")
    this.db.query("UPDATE projector_state SET last_sequence = -1 WHERE projector_name = ?").run(PROJECTOR)
    this.catchUp(await store.readAll())
  }

  /** Canonical hash of the current projection (order-independent). */
  hash(): string {
    return hashRows(this.db.query("SELECT run_id, state FROM run_states ORDER BY run_id").all() as StateRow[])
  }

  /** True if the live projection equals a full replay of the log. */
  async verify(store: EventStore): Promise<{ ok: boolean; live: string; replay: string }> {
    const live = this.hash()
    const replay = hashRows(replayRunStates(await store.readAll()))
    return { ok: live === replay, live, replay }
  }

  get(runId: string): { state: string; sequence: number } | undefined {
    const r = this.db.query("SELECT state, sequence FROM run_states WHERE run_id = ?").get(runId) as
      | { state: string; sequence: number }
      | null
    return r ?? undefined
  }
}

interface StateRow {
  run_id: string
  state: string
}

function hashRows(rows: StateRow[]): string {
  const canonical = [...rows]
    .sort((a, b) => a.run_id.localeCompare(b.run_id))
    .map((r) => `${r.run_id}=${r.state}`)
    .join(";")
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/** Pure replay used by verify() — the authority the projection must match. */
function replayRunStates(events: readonly DomainEvent[]): StateRow[] {
  const map = new Map<string, string>()
  for (const e of events) {
    const runId = (e.data as { runId?: string } | null)?.runId
    const state = STATE_OF[e.type]
    if (runId && state) map.set(runId, state)
  }
  return [...map.entries()].map(([run_id, state]) => ({ run_id, state }))
}
