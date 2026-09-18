import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MemoryEventStore } from "@abdo/event-store"
import { Importer, SqliteV1Source, V1EventTypes } from "../src/index"

/** Import then close the source so Windows can delete the temp file. */
async function importClosing(store: MemoryEventStore, file: string) {
  const source = new SqliteV1Source(file)
  try {
    return await new Importer(store).import(source)
  } finally {
    source.close()
  }
}

function withV1(build: (db: Database) => void, fn: (file: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-v1big-"))
    const file = join(dir, "abdo.db")
    const db = new Database(file, { create: true })
    db.run(`CREATE TABLE session (id TEXT, title TEXT, directory TEXT, created INTEGER, archived INTEGER)`)
    db.run(`CREATE TABLE message (id TEXT, session_id TEXT, role TEXT, created INTEGER)`)
    db.run(`CREATE TABLE part (id TEXT, message_id TEXT, type TEXT, data TEXT)`)
    build(db)
    db.close()
    try {
      await fn(file)
    } finally {
      // Best-effort cleanup: Windows may still hold the db handle briefly. A
      // cleanup failure must not fail a passing test; the OS reclaims temp dirs.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      } catch {
        /* ignore EBUSY on Windows */
      }
    }
  }
}

describe("V1 importer — large real database", () => {
  test(
    "imports a big db: counts reconcile and the source is byte-identical after",
    withV1(
      (db) => {
        const insS = db.prepare(`INSERT INTO session VALUES (?,?,?,?,?)`)
        const insM = db.prepare(`INSERT INTO message VALUES (?,?,?,?)`)
        const insP = db.prepare(`INSERT INTO part VALUES (?,?,?,?)`)
        const tx = db.transaction(() => {
          for (let s = 0; s < 100; s++) {
            insS.run(`s${s}`, `Session ${s}`, "/proj", s, s % 10 === 0 ? 1 : 0)
            for (let m = 0; m < 10; m++) {
              const mid = `m_${s}_${m}`
              insM.run(mid, `s${s}`, m % 2 ? "assistant" : "user", m)
              for (let p = 0; p < 5; p++) {
                insP.run(`p_${s}_${m}_${p}`, mid, "text", JSON.stringify({ text: `hi ${s}-${m}-${p}` }))
              }
            }
          }
        })
        tx()
      },
      async (file) => {
        const source = new SqliteV1Source(file)
        const hashBefore = source.fileHash()
        const store = new MemoryEventStore()
        const t0 = Date.now()
        const report = await new Importer(store).import(source)
        const ms = Date.now() - t0

        expect(report.sourceSessions).toBe(100)
        expect(report.importedSessions).toBe(100)
        expect(report.sourceMessages).toBe(1000)
        expect(report.importedMessages).toBe(1000)
        expect(report.sourceParts).toBe(5000)
        expect(report.importedParts).toBe(5000)
        expect(report.quarantined).toHaveLength(0)
        expect(report.verification).toBe("passed")

        // Source db is untouched (byte-for-byte).
        expect(source.fileHash()).toBe(hashBefore)
        source.close()

        // 6100 events (100 sessions + 1000 msgs + 5000 parts) landed in the log.
        expect((await store.readAll()).length).toBe(6100)
        expect(ms).toBeLessThan(20_000) // sanity perf bound
      },
    ),
  )
})

describe("V1 importer — edge cases", () => {
  test(
    "session without messages, message without parts",
    withV1(
      (db) => {
        db.run(`INSERT INTO session VALUES ('empty','Empty','/p',1,0)`)
        db.run(`INSERT INTO session VALUES ('s1','One','/p',2,0)`)
        db.run(`INSERT INTO message VALUES ('m1','s1','user',1)`) // no parts
      },
      async (file) => {
        const store = new MemoryEventStore()
        const r = await importClosing(store, file)
        expect(r.importedSessions).toBe(2)
        expect(r.importedMessages).toBe(1)
        expect(r.importedParts).toBe(0)
        expect(r.verification).toBe("passed")
      },
    ),
  )

  test(
    "corrupt JSON part is imported as raw data, never crashes",
    withV1(
      (db) => {
        db.run(`INSERT INTO session VALUES ('s1','t','/p',1,0)`)
        db.run(`INSERT INTO message VALUES ('m1','s1','user',1)`)
        db.run(`INSERT INTO part VALUES ('p1','m1','text','{not valid json')`)
      },
      async (file) => {
        const store = new MemoryEventStore()
        const r = await importClosing(store, file)
        expect(r.importedParts).toBe(1)
        const part = (await store.readAll()).find((e) => e.type === V1EventTypes.Part)
        // raw string preserved (not parsed)
        expect((part!.data as { v1: { data: unknown } }).v1.data).toBe("{not valid json")
      },
    ),
  )

  test(
    "arabic / unicode content round-trips intact",
    withV1(
      (db) => {
        db.run(`INSERT INTO session VALUES ('s1','مشروع تجريبي','/مسار',1,0)`)
        db.run(`INSERT INTO message VALUES ('m1','s1','user',1)`)
        db.run(`INSERT INTO part VALUES ('p1','m1','text','${JSON.stringify({ text: "اكتب دالة تجمع رقمين 🚀" }).replace(/'/g, "''")}')`)
      },
      async (file) => {
        const store = new MemoryEventStore()
        await importClosing(store, file)
        const all = await store.readAll()
        const s = all.find((e) => e.type === V1EventTypes.Session)
        const p = all.find((e) => e.type === V1EventTypes.Part)
        expect((s!.data as { v1: { title: string } }).v1.title).toBe("مشروع تجريبي")
        expect((p!.data as { v1: { data: { text: string } } }).v1.data.text).toBe("اكتب دالة تجمع رقمين 🚀")
      },
    ),
  )

  test(
    "orphans quarantined; duplicate part id deduped; archived sessions imported",
    withV1(
      (db) => {
        db.run(`INSERT INTO session VALUES ('s1','t','/p',1,1)`) // archived
        db.run(`INSERT INTO message VALUES ('m1','s1','user',1)`)
        db.run(`INSERT INTO message VALUES ('mX','sGONE','user',1)`) // orphan message
        db.run(`INSERT INTO part VALUES ('p1','m1','text','{}')`)
        db.run(`INSERT INTO part VALUES ('p1','m1','text','{}')`) // duplicate id
        db.run(`INSERT INTO part VALUES ('pX','mGONE','text','{}')`) // orphan part
      },
      async (file) => {
        const store = new MemoryEventStore()
        const r = await importClosing(store, file)
        expect(r.importedSessions).toBe(1)
        const s = (await store.readAll()).find((e) => e.type === V1EventTypes.Session)
        expect((s!.data as { v1: { archived: boolean } }).v1.archived).toBe(true)
        expect(r.importedMessages).toBe(1) // mX orphan quarantined
        expect(r.importedParts).toBe(1) // p1 once (dup deduped), pX orphan quarantined
        expect(r.deduped).toBeGreaterThanOrEqual(1)
        expect(r.quarantined.some((q) => q.id === "mX")).toBe(true)
        expect(r.quarantined.some((q) => q.id === "pX")).toBe(true)
        expect(r.verification).toBe("passed")
      },
    ),
  )
})
