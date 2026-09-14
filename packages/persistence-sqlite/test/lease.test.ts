import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { SqliteLeaseManager } from "../src/index"

function withDb(fn: (file: string) => void) {
  return () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-lease-"))
    try {
      fn(join(dir, "l.db"))
    } finally {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* best-effort: Windows may briefly hold the db handle */ }
    }
  }
}

describe("SqliteLeaseManager — single owner", () => {
  test(
    "two owners race; only one acquires",
    withDb((file) => {
      let t = 1000
      const clock = () => t
      // Two managers on the SAME file model two processes.
      const a = new SqliteLeaseManager(file, { ttlMs: 100, now: clock })
      const b = new SqliteLeaseManager(file, { ttlMs: 100, now: clock })
      const ra = a.acquire("run_1", "owner_a")
      const rb = b.acquire("run_1", "owner_b")
      expect(ra.ok).toBe(true)
      expect(rb.ok).toBe(false)
      if (!rb.ok) expect(rb.heldBy).toBe("owner_a")
      a.close()
      b.close()
    }),
  )

  test(
    "takeover only after the lease expires",
    withDb((file) => {
      let t = 1000
      const m = new SqliteLeaseManager(file, { ttlMs: 100, now: () => t })
      const a = m.acquire("run_1", "owner_a")
      expect(a.ok).toBe(true)
      t = 1050 // still within ttl
      expect(m.acquire("run_1", "owner_b").ok).toBe(false)
      t = 1200 // past expiry
      const b = m.acquire("run_1", "owner_b")
      expect(b.ok).toBe(true)
      m.close()
    }),
  )

  test(
    "a stale heartbeat token is rejected after takeover",
    withDb((file) => {
      let t = 1000
      const m = new SqliteLeaseManager(file, { ttlMs: 100, now: () => t })
      const a = m.acquire("run_1", "owner_a")
      expect(a.ok).toBe(true)
      const oldToken = a.ok ? a.token : ""
      t = 1200
      const b = m.acquire("run_1", "owner_b") // takeover
      expect(b.ok).toBe(true)
      // old owner tries to heartbeat with its now-stale token
      expect(m.heartbeat("run_1", oldToken)).toBe(false)
      // new owner heartbeats fine
      expect(m.heartbeat("run_1", b.ok ? b.token : "")).toBe(true)
      m.close()
    }),
  )

  test(
    "heartbeat renews expiry; release frees the lease",
    withDb((file) => {
      let t = 1000
      const m = new SqliteLeaseManager(file, { ttlMs: 100, now: () => t })
      const a = m.acquire("run_1", "owner_a")
      const token = a.ok ? a.token : ""
      t = 1080
      expect(m.heartbeat("run_1", token)).toBe(true) // expiry now 1180
      t = 1150
      expect(m.acquire("run_1", "owner_b").ok).toBe(false) // still held
      expect(m.release("run_1", token)).toBe(true)
      expect(m.acquire("run_1", "owner_b").ok).toBe(true) // freed
      m.close()
    }),
  )

  test(
    "same owner re-acquires (idempotent renewal)",
    withDb((file) => {
      const m = new SqliteLeaseManager(file, { ttlMs: 100, now: () => 1000 })
      expect(m.acquire("run_1", "owner_a").ok).toBe(true)
      expect(m.acquire("run_1", "owner_a").ok).toBe(true)
      m.close()
    }),
  )
})
