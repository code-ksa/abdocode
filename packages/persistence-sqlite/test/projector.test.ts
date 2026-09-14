import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { SqliteEventStore } from "../src/sqlite"
import { RunStateProjector } from "../src/projector"

async function seed(store: SqliteEventStore, runId: string, types: string[]) {
  for (const type of types) await store.append({ aggregateKind: "session", aggregateId: "ses_1", type, data: { runId } })
}

function harness(fn: (ctx: { dir: string; dbFile: string; store: SqliteEventStore }) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-proj-"))
    const dbFile = join(dir, "events.db")
    const store = new SqliteEventStore(dbFile)
    try {
      await fn({ dir, dbFile, store })
    } finally {
      store.close()
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* best-effort: Windows may briefly hold the db handle */ }
    }
  }
}

describe("RunStateProjector — idempotency & rebuild", () => {
  test(
    "catchUp is idempotent: running it twice changes nothing the second time",
    harness(async ({ dbFile, store }) => {
      await seed(store, "run_1", ["run.admitted", "run.calling", "run.streaming", "run.completed"])
      const proj = new RunStateProjector(dbFile)
      const first = proj.catchUp(await store.readAll())
      const second = proj.catchUp(await store.readAll()) // nothing new
      expect(first).toBeGreaterThan(0)
      expect(second).toBe(0)
      expect(proj.get("run_1")!.state).toBe("completed")
      proj.close()
    }),
  )

  test(
    "rebuild-from-zero equals incremental projection (same hash)",
    harness(async ({ dbFile, store }) => {
      await seed(store, "run_1", ["run.admitted", "run.calling", "run.completed"])
      await seed(store, "run_2", ["run.admitted", "run.failed"])
      const proj = new RunStateProjector(dbFile)
      proj.catchUp(await store.readAll())
      const incremental = proj.hash()
      await proj.rebuild(store)
      expect(proj.hash()).toBe(incremental)
      proj.close()
    }),
  )

  test(
    "verify() matches a full replay; drift is detected",
    harness(async ({ dbFile, store }) => {
      await seed(store, "run_1", ["run.admitted", "run.completed"])
      const proj = new RunStateProjector(dbFile)
      proj.catchUp(await store.readAll())
      expect((await proj.verify(store)).ok).toBe(true)
      proj.close()
    }),
  )

  test(
    "CRASH after event commit, before projection: a fresh projector catches up",
    harness(async ({ dbFile, store }) => {
      // Events are committed to the log, but the projector never ran (crash).
      await seed(store, "run_1", ["run.admitted", "run.calling", "run.executing_tool"])
      // "Restart": a brand-new projector connection over the same db.
      const proj = new RunStateProjector(dbFile)
      expect(proj.get("run_1")).toBeUndefined() // projection empty (behind the log)
      proj.catchUp(await store.readAll()) // recover the un-projected tail
      expect(proj.get("run_1")!.state).toBe("executing_tool")
      expect((await proj.verify(store)).ok).toBe(true)
      proj.close()
    }),
  )
})

describe("RunStateProjector — real process kill", () => {
  const CHILD = join(import.meta.dir, "projector-child.ts")
  test(
    "child appends events then is killed; parent projects and verifies",
    harness(async ({ dir, dbFile }) => {
      const marker = join(dir, "done")
      const proc = Bun.spawn(["bun", CHILD, dbFile])
      const code = await proc.exited
      expect(code).toBe(137)
      expect(existsSync(marker)).toBe(false)

      const reopened = new SqliteEventStore(dbFile)
      const proj = new RunStateProjector(dbFile)
      const applied = proj.catchUp(await reopened.readAll())
      expect(applied).toBeGreaterThan(0)
      expect((await proj.verify(reopened)).ok).toBe(true) // projection == replay
      proj.close()
      reopened.close()
    }),
  )
})
