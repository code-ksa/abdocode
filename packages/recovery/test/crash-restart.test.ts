import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RecoveryExecutor, RecoveryReconciler, type ToolRecoveryVerifier } from "../src/index"

const CHILD = join(import.meta.dir, "kill-child.ts")

/** Spawn the crash fixture at a given stage; returns the temp paths. */
async function crashAt(stage: string) {
  const dir = mkdtempSync(join(tmpdir(), "abdo-crash-"))
  const dbFile = join(dir, "events.db")
  const marker = join(dir, "test-output.txt")
  const proc = Bun.spawn(["bun", CHILD, dbFile, marker, stage])
  await proc.exited
  return { dir, dbFile, marker }
}

describe("crash recovery over REAL SQLite — every boundary", () => {
  test("before tool.started -> continue (nothing ran, no side effect)", async () => {
    const { dir, dbFile, marker } = await crashAt("before_tool_started")
    try {
      expect(existsSync(marker)).toBe(false)
      const store = new SqliteEventStore(dbFile)
      const [d] = await new RecoveryReconciler(store).decideForSession("ses_kill")
      expect(d!.kind).toBe("continue")
      store.close()
    } finally {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* best-effort: Windows may briefly hold the db handle */ }
    }
  })

  test("after tool.started, before side effect -> verify_tool (verifier finds not_applied)", async () => {
    const { dir, dbFile, marker } = await crashAt("after_started_before_effect")
    try {
      expect(existsSync(marker)).toBe(false)
      const store = new SqliteEventStore(dbFile)
      const [d] = await new RecoveryReconciler(store).decideForSession("ses_kill")
      expect(d!.kind).toBe("verify_tool")
      const verifier: ToolRecoveryVerifier = { verify: async () => ({ state: "not_applied" }) }
      const result = await new RecoveryExecutor(store, "ses_kill", { verifier }).execute(d!)
      expect(result.kind).toBe("retryable_tool") // safe to retry: nothing happened
      store.close()
    } finally {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* best-effort: Windows may briefly hold the db handle */ }
    }
  })

  test("WORST: after side effect, before tool.executed -> verify_tool -> applied, recorded once, no re-run", async () => {
    const { dir, dbFile, marker } = await crashAt("after_effect_before_exec")
    try {
      expect(existsSync(marker)).toBe(true) // side effect DID happen
      const original = readFileSync(marker, "utf8")

      const store = new SqliteEventStore(dbFile)
      const [d] = await new RecoveryReconciler(store).decideForSession("ses_kill")
      expect(d!.kind).toBe("verify_tool")

      // A verifier that inspects the real world and finds the file present.
      const verifier: ToolRecoveryVerifier = {
        verify: async () => (existsSync(marker) ? { state: "applied" } : { state: "not_applied" }),
      }
      const result = await new RecoveryExecutor(store, "ses_kill", { verifier }).execute(d!)
      expect(result.kind).toBe("recovered_tool")

      // The lost success is now recorded (recovered:true) and the tool is no longer pending.
      const events = await store.read("session", "ses_kill")
      const exec = events.find((e) => e.type === "tool.executed")
      expect(exec).toBeDefined()
      expect((exec!.data as { recovered?: boolean }).recovered).toBe(true)
      expect(await new RecoveryReconciler(store).decideForSession("ses_kill")).not.toContainEqual(
        expect.objectContaining({ kind: "verify_tool" }),
      )

      // Crucially: the side effect was NOT repeated.
      expect(readFileSync(marker, "utf8")).toBe(original)
      store.close()
    } finally {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* best-effort: Windows may briefly hold the db handle */ }
    }
  })

  test("after tool.executed, before terminal -> continue (tool done, finish the run)", async () => {
    const { dir, dbFile } = await crashAt("after_exec_before_terminal")
    try {
      const store = new SqliteEventStore(dbFile)
      const [d] = await new RecoveryReconciler(store).decideForSession("ses_kill")
      expect(d!.kind).toBe("continue")
      store.close()
    } finally {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* best-effort: Windows may briefly hold the db handle */ }
    }
  })

  test("killing repeatedly does not corrupt the log or duplicate the side effect", async () => {
    // Run the worst-case crash 3 times against fresh dbs; each stays consistent.
    for (let i = 0; i < 3; i++) {
      const { dir, dbFile, marker } = await crashAt("after_effect_before_exec")
      try {
        const store = new SqliteEventStore(dbFile)
        const events = await store.read("session", "ses_kill")
        expect(events.map((e) => Number(e.sequence))).toEqual(events.map((_, idx) => idx)) // gapless
        expect(readFileSync(marker, "utf8")).toBe("written by the tool") // single write
        store.close()
      } finally {
        try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* best-effort: Windows may briefly hold the db handle */ }
      }
    }
  })
})
