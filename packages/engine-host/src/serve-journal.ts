import { createHash } from "node:crypto"
import type { DomainEvent } from "@abdo/contracts/event"
import { SqliteEventStore } from "@abdo/persistence-sqlite"

const AGGREGATE_ID = "serve-protocol-v1"

export const ServeEventTypes = Object.freeze({
  SessionOpened: "serve.session.opened",
  TurnAdmitted: "serve.turn.admitted",
  OutputEmitted: "serve.output.emitted",
  TurnCompleted: "serve.turn.completed",
  TurnFailed: "serve.turn.failed",
} as const)

export interface ServeAdmission {
  readonly turnId: string
  readonly seq: number
  readonly fresh: boolean
}

export interface ServeOutputEvent {
  readonly seq: number
  readonly turnId: string
  readonly payload: string
}

export interface ServeTurnRecord {
  readonly seq: number
  readonly body: string
  readonly session: string
  readonly attachments?: readonly string[]
}

export interface ServeJournalSnapshot {
  readonly admissions: ReadonlyMap<string, ServeTurnRecord>
  readonly outputs: readonly ServeOutputEvent[]
  readonly completed: ReadonlySet<string>
  readonly failed: ReadonlyMap<string, string>
  readonly sessions: readonly string[]
  readonly sessionModes: ReadonlyMap<string, 'chat' | 'code'>
  readonly outputSequence: number
}

export interface ServeJournalOptions {
  readonly database: string
  /** Parsed rows from the retired append-only JSONL ledger, if it exists. */
  readonly legacyRows?: readonly Readonly<Record<string, unknown>>[]
}

/**
 * Durable projection for the desktop `serve` protocol.
 *
 * It writes into the same SQLite event-store implementation used by
 * SessionRuntime. The legacy JSONL file is import-only: stable idempotency keys
 * make reopening safe and no method can append to that retired format.
 */
export class ServeJournal {
  readonly #store: SqliteEventStore
  readonly #eventIds = new Set<string>()
  readonly #admissions = new Map<string, ServeTurnRecord>()
  readonly #outputs: ServeOutputEvent[] = []
  readonly #completed = new Set<string>()
  readonly #failed = new Map<string, string>()
  readonly #sessions: string[] = []
  readonly #sessionModes = new Map<string, 'chat' | 'code'>()
  #admissionSequence = 0
  #outputSequence = 0
  #closed = false

  private constructor(store: SqliteEventStore) {
    this.#store = store
  }

  static async open(options: ServeJournalOptions): Promise<ServeJournal> {
    const journal = new ServeJournal(new SqliteEventStore(options.database))
    try {
      for (const event of await journal.#store.read("session", AGGREGATE_ID)) journal.#apply(event)
      await journal.#importLegacy(options.legacyRows ?? [])
      return journal
    } catch (error) {
      journal.close()
      throw error
    }
  }

  snapshot(): ServeJournalSnapshot {
    this.#assertOpen()
    return Object.freeze({
      admissions: new Map(this.#admissions),
      outputs: Object.freeze(this.#outputs.map((event) => Object.freeze({ ...event }))),
      completed: new Set(this.#completed),
      failed: new Map(this.#failed),
      sessions: Object.freeze([...this.#sessions]),
      sessionModes: new Map(this.#sessionModes),
      outputSequence: this.#outputSequence,
    })
  }

  admission(turnId: string): ServeAdmission | undefined {
    this.#assertOpen()
    const existing = this.#admissions.get(turnId)
    return existing === undefined ? undefined : { turnId, seq: existing.seq, fresh: false }
  }

  async openSession(sessionId: string, conversationMode: 'chat' | 'code' = 'code'): Promise<void> {
    this.#assertOpen()
    nonEmpty(sessionId, "sessionId")
    if (this.#sessionModes.has(sessionId) && this.#sessionModes.get(sessionId) !== conversationMode) throw new Error('serve_session_mode_conflict')
    const result = await this.#store.append({
      aggregateKind: "session",
      aggregateId: AGGREGATE_ID,
      type: ServeEventTypes.SessionOpened,
      data: { sessionId, conversationMode },
      idempotencyKey: `serve:session:${sessionId}`,
    })
    this.#apply(result.event)
  }

  async admit(input: { readonly turnId: string; readonly body: string; readonly sessionId: string; readonly attachments?: readonly string[] }): Promise<ServeAdmission> {
    this.#assertOpen()
    nonEmpty(input.turnId, "turnId")
    nonEmpty(input.sessionId, "sessionId")
    if (typeof input.body !== "string") throw new TypeError("body must be a string")

    const existing = this.#admissions.get(input.turnId)
    if (existing !== undefined) {
      if (existing.body !== input.body || existing.session !== input.sessionId || JSON.stringify(existing.attachments??[])!==JSON.stringify(input.attachments??[])) {
        throw new Error(`serve_turn_identity_conflict:${input.turnId}`)
      }
      return { turnId: input.turnId, seq: existing.seq, fresh: false }
    }

    const seq = this.#admissionSequence + 1
    const result = await this.#store.append({
      aggregateKind: "session",
      aggregateId: AGGREGATE_ID,
      type: ServeEventTypes.TurnAdmitted,
      data: { turnId: input.turnId, body: input.body, sessionId: input.sessionId, seq, ...(input.attachments?.length ? {attachments:input.attachments} : {}) },
      idempotencyKey: `serve:turn:${input.turnId}`,
    })
    this.#apply(result.event)
    const admitted = this.#admissions.get(input.turnId)
    if (admitted === undefined) throw new Error("serve_admission_projection_missing")
    if (admitted.body !== input.body || admitted.session !== input.sessionId || JSON.stringify(admitted.attachments??[])!==JSON.stringify(input.attachments??[])) {
      throw new Error(`serve_turn_identity_conflict:${input.turnId}`)
    }
    return { turnId: input.turnId, seq: admitted.seq, fresh: !result.deduped }
  }

  async emitOutput(turnId: string, payload: string): Promise<ServeOutputEvent> {
    this.#assertOpen()
    nonEmpty(turnId, "turnId")
    if (typeof payload !== "string") throw new TypeError("payload must be a string")
    if (!this.#admissions.has(turnId)) throw new Error(`serve_output_without_admission:${turnId}`)
    const output = { seq: this.#outputSequence + 1, turnId, payload }
    const result = await this.#store.append({
      aggregateKind: "session",
      aggregateId: AGGREGATE_ID,
      type: ServeEventTypes.OutputEmitted,
      data: output,
    })
    this.#apply(result.event)
    return Object.freeze(output)
  }

  async fail(turnId: string, why: string): Promise<void> {
    this.#assertOpen()
    nonEmpty(turnId, "turnId")
    nonEmpty(why, "why")
    if (!this.#admissions.has(turnId)) throw new Error(`serve_failure_without_admission:${turnId}`)
    if (this.#completed.has(turnId)) throw new Error(`serve_failure_after_completion:${turnId}`)
    const result = await this.#store.append({
      aggregateKind: "session", aggregateId: AGGREGATE_ID,
      type: ServeEventTypes.TurnFailed, data: { turnId, why: why.slice(0, 1000) },
      idempotencyKey: `serve:failed:${turnId}`,
    })
    this.#apply(result.event)
  }

  async complete(turnId: string): Promise<void> {
    this.#assertOpen()
    nonEmpty(turnId, "turnId")
    if (!this.#admissions.has(turnId)) throw new Error(`serve_completion_without_admission:${turnId}`)
    if (this.#failed.has(turnId)) throw new Error(`serve_completion_after_failure:${turnId}`)
    const result = await this.#store.append({
      aggregateKind: "session",
      aggregateId: AGGREGATE_ID,
      type: ServeEventTypes.TurnCompleted,
      data: { turnId },
      idempotencyKey: `serve:done:${turnId}`,
    })
    this.#apply(result.event)
  }

  close(): void {
    if (this.#closed) return
    this.#store.close()
    this.#closed = true
  }

  async #importLegacy(rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
    for (const [index, row] of rows.entries()) {
      const key = legacyKey(index, row)
      if (row.k === "session") {
        const sessionId = stringField(row, "id")
        const result = await this.#store.append({
          aggregateKind: "session",
          aggregateId: AGGREGATE_ID,
          type: ServeEventTypes.SessionOpened,
          data: { sessionId },
          idempotencyKey: key,
        })
        this.#apply(result.event)
      } else if (row.k === "admit") {
        const turnId = stringField(row, "id")
        const seq = positiveInteger(row.seq, "seq")
        const result = await this.#store.append({
          aggregateKind: "session",
          aggregateId: AGGREGATE_ID,
          type: ServeEventTypes.TurnAdmitted,
          data: {
            turnId,
            seq,
            body: typeof row.body === "string" ? row.body : "دورٌ قديم",
            sessionId: typeof row.session === "string" ? row.session : "قديم",
          },
          idempotencyKey: key,
        })
        this.#apply(result.event)
      } else if (row.k === "event") {
        const output = {
          seq: positiveInteger(row.seq, "seq"),
          turnId: stringField(row, "turnId"),
          payload: stringField(row, "payload", true),
        }
        const known = this.#outputs.find((event) => event.seq === output.seq)
        if (known !== undefined) {
          if (known.turnId !== output.turnId || known.payload !== output.payload) {
            throw new Error(`serve_legacy_output_conflict:${output.seq}`)
          }
          continue
        }
        const result = await this.#store.append({
          aggregateKind: "session",
          aggregateId: AGGREGATE_ID,
          type: ServeEventTypes.OutputEmitted,
          data: output,
          idempotencyKey: key,
        })
        this.#apply(result.event)
      } else if (row.k === "done") {
        const turnId = stringField(row, "turnId")
        const result = await this.#store.append({
          aggregateKind: "session",
          aggregateId: AGGREGATE_ID,
          type: ServeEventTypes.TurnCompleted,
          data: { turnId },
          idempotencyKey: key,
        })
        this.#apply(result.event)
      }
    }
  }

  #apply(event: DomainEvent): void {
    if (this.#eventIds.has(event.id)) return
    const data = record(event.data)
    if (event.type === ServeEventTypes.SessionOpened) {
      const sessionId = stringField(data, "sessionId")
      if (!this.#sessions.includes(sessionId)) this.#sessions.push(sessionId)
      this.#sessionModes.set(sessionId,data.conversationMode==='chat'?'chat':'code')
    } else if (event.type === ServeEventTypes.TurnAdmitted) {
      const turnId = stringField(data, "turnId")
      const next: ServeTurnRecord = {
        seq: positiveInteger(data.seq, "seq"),
        body: stringField(data, "body", true),
        session: stringField(data, "sessionId"),
        ...(Array.isArray(data.attachments)&&data.attachments.length ? {attachments:data.attachments.map(id=>stringField({id},'id'))} : {}),
      }
      const existing = this.#admissions.get(turnId)
      if (existing !== undefined && (existing.seq !== next.seq || existing.body !== next.body || existing.session !== next.session || JSON.stringify(existing.attachments??[])!==JSON.stringify(next.attachments??[]))) {
        throw new Error(`serve_turn_identity_conflict:${turnId}`)
      }
      this.#admissions.set(turnId, next)
      this.#admissionSequence = Math.max(this.#admissionSequence, next.seq)
      if (!this.#sessions.includes(next.session)) this.#sessions.push(next.session)
    } else if (event.type === ServeEventTypes.OutputEmitted) {
      const output: ServeOutputEvent = {
        seq: positiveInteger(data.seq, "seq"),
        turnId: stringField(data, "turnId"),
        payload: stringField(data, "payload", true),
      }
      if (output.seq !== this.#outputSequence + 1) {
        throw new Error(`serve_output_sequence_gap:${this.#outputSequence}->${output.seq}`)
      }
      this.#outputs.push(output)
      this.#outputSequence = output.seq
    } else if (event.type === ServeEventTypes.TurnFailed) {
      this.#failed.set(stringField(data, "turnId"), stringField(data, "why"))
    } else if (event.type === ServeEventTypes.TurnCompleted) {
      this.#completed.add(stringField(data, "turnId"))
    }
    this.#eventIds.add(event.id)
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("serve_journal_closed")
  }
}

export const openServeJournal = (options: ServeJournalOptions): Promise<ServeJournal> => ServeJournal.open(options)

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("serve event data must be an object")
  return value as Readonly<Record<string, unknown>>
}

function nonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`)
}

function stringField(row: Readonly<Record<string, unknown>>, name: string, empty = false): string {
  const value = row[name]
  if (typeof value !== "string" || (!empty && value.length === 0)) throw new TypeError(`${name} must be a string`)
  return value
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${name} must be a positive safe integer`)
  return value as number
}

function legacyKey(index: number, row: Readonly<Record<string, unknown>>): string {
  const digest = createHash("sha256").update(JSON.stringify(row)).digest("hex")
  return `serve:legacy:${index}:${digest}`
}
