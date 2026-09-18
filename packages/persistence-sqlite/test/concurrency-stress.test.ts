import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { RunStateProjector } from "../src/projector"
import { SqliteEventStore } from "../src/sqlite"

const CHILD = join(import.meta.dir, "stress-child.ts")

function withDir(fn: (dbFile: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-stress-"))
    try {
      await fn(join(dir, "events.db"))
    } finally {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* best-effort: Windows may briefly hold the db handle */ }
    }
  }
}

async function spawnAll(specs: Array<[session: string, count: number, tag: string]>, dbFile: string) {
  const procs = specs.map(([session, count, tag]) => Bun.spawn(["bun", CHILD, dbFile, session, String(count), tag]))
  const codes = await Promise.all(procs.map((p) => p.exited))
  expect(codes.every((c) => c === 0)).toBe(true)
}

describe("cross-process concurrency over REAL SQLite", () => {
  test(
    "4 processes append to the SAME session -> unique, gapless, no duplicates",
    withDir(async (dbFile) => {
      const per = 25
      await spawnAll(
        [
          ["ses_1", per, "A"],
          ["ses_1", per, "B"],
          ["ses_1", per, "C"],
          ["ses_1", per, "D"],
        ],
        dbFile,
      )
      const store = new SqliteEventStore(dbFile)
      const events = await store.read("session", "ses_1")
      const seqs = events.map((e) => Number(e.sequence)).sort((a, b) => a - b)
      expect(seqs).toEqual(Array.from({ length: per * 4 }, (_, i) => i)) // 0..99 gapless
      expect(new Set(seqs).size).toBe(per * 4) // no duplicates
      // every process's events survived
      const tags = new Set(events.map((e) => (e.data as { tag: string }).tag))
      expect([...tags].sort()).toEqual(["A", "B", "C", "D"])
      store.close()
    }),
  )

  test(
    "different sessions run in parallel; each aggregate is internally ordered",
    withDir(async (dbFile) => {
      await spawnAll(
        [
          ["ses_a", 20, "a"],
          ["ses_b", 20, "b"],
          ["ses_c", 20, "c"],
        ],
        dbFile,
      )
      const store = new SqliteEventStore(dbFile)
      for (const s of ["ses_a", "ses_b", "ses_c"]) {
        const seqs = (await store.read("session", s)).map((e) => Number(e.sequence))
        expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i))
      }
      store.close()
    }),
  )

  test(
    "the projection rebuilds cleanly after concurrent writes",
    withDir(async (dbFile) => {
      await spawnAll(
        [
          ["ses_1", 15, "A"],
          ["ses_1", 15, "B"],
        ],
        dbFile,
      )
      const store = new SqliteEventStore(dbFile)
      const proj = new RunStateProjector(dbFile)
      await proj.rebuild(store)
      // "e" events carry no runId/state, so run_states stays empty but verify must
      // still agree that the projection equals a full replay (both empty).
      expect((await proj.verify(store)).ok).toBe(true)
      proj.close()
      store.close()
    }),
  )
})
