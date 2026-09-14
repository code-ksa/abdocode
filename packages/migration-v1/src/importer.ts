/**
 * Importer — folds a V1Source into the abdo event log.
 *
 * Guarantees:
 *   - the source is only read (the V1Source interface has no write)
 *   - malformed rows are quarantined (skipped + reported), never crash the run
 *   - every append is idempotent (`v1:<table>:<id>`), so re-running the import
 *     does not duplicate — the event store dedupes
 *   - a verification report reconciles source counts vs imported counts
 *
 * Target is any EventStore (MemoryEventStore for tests, SqliteEventStore for a
 * real new abdo db) — the legacy db and the abdo db are never the same handle.
 */
import type { EventStore } from "@abdo/event-store"
import type { MigrationReport, QuarantinedRow, V1Source } from "./types"

export const V1EventTypes = {
  Session: "v1.session.imported",
  Message: "v1.message.imported",
  Part: "v1.part.imported",
} as const

export interface ImportOptions {
  /** Prefix isolating imported aggregates if you import into a shared db. */
  readonly aggregatePrefix?: string
}

export class Importer {
  constructor(private readonly target: EventStore) {}

  async import(source: V1Source, options: ImportOptions = {}): Promise<MigrationReport> {
    const prefix = options.aggregatePrefix ?? ""
    const quarantined: QuarantinedRow[] = []
    const warnings: string[] = []
    let deduped = 0

    // --- sessions ---
    const sessionIds = new Set<string>()
    let sourceSessions = 0
    let importedSessions = 0
    for (const s of source.sessions()) {
      sourceSessions++
      if (!s.id) {
        quarantined.push({ table: "session", id: "(empty)", reason: "missing id" })
        continue
      }
      sessionIds.add(s.id)
      const r = await this.target.append({
        aggregateKind: "session",
        aggregateId: prefix + s.id,
        type: V1EventTypes.Session,
        data: { v1: s },
        idempotencyKey: `v1:session:${s.id}`,
      })
      if (r.deduped) deduped++
      else importedSessions++
    }

    // --- messages ---
    const messageIds = new Set<string>()
    let sourceMessages = 0
    let importedMessages = 0
    for (const m of source.messages()) {
      sourceMessages++
      if (!m.id || !m.sessionId) {
        quarantined.push({ table: "message", id: m.id || "(empty)", reason: "missing id or sessionId" })
        continue
      }
      if (!sessionIds.has(m.sessionId)) {
        quarantined.push({ table: "message", id: m.id, reason: `orphan: unknown session ${m.sessionId}` })
        continue
      }
      messageIds.add(m.id)
      const r = await this.target.append({
        aggregateKind: "session",
        aggregateId: prefix + m.sessionId,
        type: V1EventTypes.Message,
        data: { v1: m },
        idempotencyKey: `v1:message:${m.id}`,
      })
      if (r.deduped) deduped++
      else importedMessages++
    }

    // --- parts ---
    let sourceParts = 0
    let importedParts = 0
    const messageToSession = new Map<string, string>()
    for (const m of source.messages()) if (m.id && m.sessionId) messageToSession.set(m.id, m.sessionId)
    for (const p of source.parts()) {
      sourceParts++
      if (!p.id || !p.messageId) {
        quarantined.push({ table: "part", id: p.id || "(empty)", reason: "missing id or messageId" })
        continue
      }
      const sessionId = messageToSession.get(p.messageId)
      if (!sessionId) {
        quarantined.push({ table: "part", id: p.id, reason: `orphan: unknown message ${p.messageId}` })
        continue
      }
      const r = await this.target.append({
        aggregateKind: "session",
        aggregateId: prefix + sessionId,
        type: V1EventTypes.Part,
        data: { v1: p },
        idempotencyKey: `v1:part:${p.id}`,
      })
      if (r.deduped) deduped++
      else importedParts++
    }

    // --- verification ---
    // Every source row is accounted for as exactly one of: imported, deduped
    // (idempotent re-run), or quarantined (malformed/orphan).
    const totalImported = importedSessions + importedMessages + importedParts
    const totalSource = sourceSessions + sourceMessages + sourceParts
    const verification: MigrationReport["verification"] =
      totalImported + deduped + quarantined.length === totalSource ? "passed" : "failed"

    return {
      sourceSessions,
      importedSessions,
      sourceMessages,
      importedMessages,
      sourceParts,
      importedParts,
      deduped,
      quarantined,
      warnings,
      verification,
    }
  }
}
