import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MemoryEventStore } from "@abdo/event-store"
import { Importer, SqliteV1Source, V1EventTypes, type V1Source } from "../src/index"

/** Build a synthetic legacy abdo db with clean + malformed + orphan rows. */
function makeV1Db(file: string) {
  const db = new Database(file, { create: true })
  db.run(`CREATE TABLE session (id TEXT, title TEXT, directory TEXT, created INTEGER)`)
  db.run(`CREATE TABLE message (id TEXT, session_id TEXT, role TEXT, created INTEGER)`)
  db.run(`CREATE TABLE part (id TEXT, message_id TEXT, type TEXT, data TEXT)`)
  db.run(`INSERT INTO session VALUES ('s1','Hello','/proj',1),('s2','Two','/p2',2)`)
  db.run(`INSERT INTO message VALUES
    ('m1','s1','user',1),
    ('m2','s1','assistant',2),
    ('m3','s2','user',3),
    ('mX','sNONE','user',4)`) // orphan: unknown session
  db.run(`INSERT INTO part VALUES
    ('p1','m1','text','{"text":"hi"}'),
    ('p2','m2','text','{"text":"yo"}'),
    ('pX','mNONE','text','{}'),
    (NULL,'m1','text','{}')`) // malformed: null id
  db.close()
}

function withV1Db(fn: (file: string, dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-v1-"))
    const file = join(dir, "abdo.db")
    makeV1Db(file)
    try {
      await fn(file, dir)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }
}

describe("Importer — verification report", () => {
  test(
    "imports clean rows, quarantines malformed/orphan, report reconciles",
    withV1Db(async (file) => {
      const source = new SqliteV1Source(file)
      const store = new MemoryEventStore()
      const report = await new Importer(store).import(source)
      source.close()

      expect(report.sourceSessions).toBe(2)
      expect(report.importedSessions).toBe(2)
      expect(report.sourceMessages).toBe(4)
      expect(report.importedMessages).toBe(3) // mX orphan quarantined
      expect(report.sourceParts).toBe(4)
      expect(report.importedParts).toBe(2) // pX orphan + null-id quarantined

      const q = report.quarantined
      expect(q.some((x) => x.table === "message" && x.id === "mX")).toBe(true)
      expect(q.some((x) => x.table === "part" && x.id === "pX")).toBe(true)
      expect(q.length).toBe(3)
      expect(report.verification).toBe("passed") // imported + deduped + quarantined == source
    }),
  )

  test(
    "imported events land under the right session aggregate",
    withV1Db(async (file) => {
      const source = new SqliteV1Source(file)
      const store = new MemoryEventStore()
      await new Importer(store).import(source)
      source.close()

      const s1 = await store.read("session", "s1")
      const types = s1.map((e) => e.type)
      expect(types.filter((t) => t === V1EventTypes.Session)).toHaveLength(1)
      expect(types.filter((t) => t === V1EventTypes.Message)).toHaveLength(2) // m1, m2
      expect(types.filter((t) => t === V1EventTypes.Part)).toHaveLength(2) // p1, p2
    }),
  )
})

describe("Importer — idempotency", () => {
  test(
    "re-running the import dedupes, does not double-write",
    withV1Db(async (file) => {
      const source = new SqliteV1Source(file)
      const store = new MemoryEventStore()
      const first = await new Importer(store).import(source)
      const before = (await store.readAll()).length

      const source2 = new SqliteV1Source(file)
      const second = await new Importer(store).import(source2)
      const after = (await store.readAll()).length
      source.close()
      source2.close()

      expect(first.verification).toBe("passed")
      expect(second.verification).toBe("passed")
      expect(second.importedSessions).toBe(0)
      expect(second.deduped).toBeGreaterThan(0)
      expect(after).toBe(before) // no new events on the second run
    }),
  )
})

describe("Importer — source is never mutated", () => {
  test(
    "the legacy db has identical row counts after import",
    withV1Db(async (file) => {
      const before = countRows(file)
      const source = new SqliteV1Source(file)
      await new Importer(new MemoryEventStore()).import(source)
      source.close()
      const after = countRows(file)
      expect(after).toEqual(before)
    }),
  )
})

function countRows(file: string): Record<string, number> {
  const db = new Database(file, { readonly: true })
  const c = (t: string) => (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
  const out = { session: c("session"), message: c("message"), part: c("part") }
  db.close()
  return out
}

describe("Importer — abstract source (no sqlite required)", () => {
  test("works with an in-memory V1Source", async () => {
    const source: V1Source = {
      sessions: () => [{ id: "a" }],
      messages: () => [{ id: "m", sessionId: "a" }],
      parts: () => [{ id: "p", messageId: "m" }],
    }
    const store = new MemoryEventStore()
    const report = await new Importer(store).import(source)
    expect(report.verification).toBe("passed")
    expect(report.importedSessions + report.importedMessages + report.importedParts).toBe(3)
  })
})
