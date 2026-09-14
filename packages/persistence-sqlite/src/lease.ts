/**
 * SqliteLeaseManager — single-owner leasing for runs.
 *
 * Prevents two processes from resuming the same run. Acquisition is ATOMIC via
 * `BEGIN IMMEDIATE` (the write lock is held while we read-then-write), so two
 * racers can never both win. A crash simply lets the lease expire; a healthy
 * owner renews it with a heartbeat. Every run-mutating append should be gated on
 * a still-valid lease token.
 */
import { Database } from "bun:sqlite"

const DDL = `
CREATE TABLE IF NOT EXISTS run_leases (
  run_id        TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  lease_token   TEXT NOT NULL,
  acquired_at   INTEGER NOT NULL,
  heartbeat_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
`

export interface LeaseRow {
  readonly runId: string
  readonly ownerId: string
  readonly leaseToken: string
  readonly acquiredAt: number
  readonly heartbeatAt: number
  readonly expiresAt: number
}

export type AcquireResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly heldBy: string; readonly expiresAt: number }

export interface LeaseOptions {
  readonly ttlMs?: number
  readonly now?: () => number
}

export class SqliteLeaseManager {
  private readonly db: Database
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(filename: string, options: LeaseOptions = {}) {
    this.db = new Database(filename, { create: true })
    this.db.run("PRAGMA busy_timeout = 5000;")
    this.db.run("PRAGMA journal_mode = WAL;")
    
    this.db.run(DDL)
    this.ttlMs = options.ttlMs ?? 30_000
    this.now = options.now ?? Date.now
  }

  close(): void {
    this.db.close()
  }

  /** Atomically take or renew the lease. Fails if a live lease is held by another owner. */
  acquire(runId: string, ownerId: string, ttlMs = this.ttlMs): AcquireResult {
    const txn = this.db.transaction((): AcquireResult => {
      const now = this.now()
      const row = this.db.query("SELECT * FROM run_leases WHERE run_id = ?").get(runId) as LeaseRowRaw | null
      const takeable = !row || row.expires_at < now || row.owner_id === ownerId
      if (!takeable) return { ok: false, heldBy: row!.owner_id, expiresAt: row!.expires_at }

      const token = crypto.randomUUID()
      const expiresAt = now + ttlMs
      this.db
        .query(
          `INSERT INTO run_leases (run_id, owner_id, lease_token, acquired_at, heartbeat_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             owner_id = excluded.owner_id,
             lease_token = excluded.lease_token,
             acquired_at = excluded.acquired_at,
             heartbeat_at = excluded.heartbeat_at,
             expires_at = excluded.expires_at`,
        )
        .run(runId, ownerId, token, now, now, expiresAt)
      return { ok: true, token }
    })
    return txn.immediate()
  }

  /** Renew the lease. Returns false if the token is stale (someone took over). */
  heartbeat(runId: string, token: string, ttlMs = this.ttlMs): boolean {
    const now = this.now()
    const res = this.db
      .query("UPDATE run_leases SET heartbeat_at = ?, expires_at = ? WHERE run_id = ? AND lease_token = ?")
      .run(now, now + ttlMs, runId, token)
    return res.changes === 1
  }

  release(runId: string, token: string): boolean {
    const res = this.db.query("DELETE FROM run_leases WHERE run_id = ? AND lease_token = ?").run(runId, token)
    return res.changes === 1
  }

  /** True only if this exact token still holds an unexpired lease. */
  isValid(runId: string, token: string): boolean {
    const row = this.db
      .query("SELECT expires_at FROM run_leases WHERE run_id = ? AND lease_token = ?")
      .get(runId, token) as { expires_at: number } | null
    return !!row && row.expires_at >= this.now()
  }

  current(runId: string): LeaseRow | undefined {
    const row = this.db.query("SELECT * FROM run_leases WHERE run_id = ?").get(runId) as LeaseRowRaw | null
    if (!row) return undefined
    return {
      runId: row.run_id,
      ownerId: row.owner_id,
      leaseToken: row.lease_token,
      acquiredAt: row.acquired_at,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
    }
  }
}

interface LeaseRowRaw {
  run_id: string
  owner_id: string
  lease_token: string
  acquired_at: number
  heartbeat_at: number
  expires_at: number
}
