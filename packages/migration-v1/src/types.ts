/**
 * V1 import contracts.
 *
 * The importer consumes an abstract V1Source so it can be driven by a real
 * abdo sqlite database, a fixture, or any other reader — and so the source
 * is only ever READ. Nothing here can write to V1.
 */

export interface V1Session {
  readonly id: string
  readonly title?: string
  readonly directory?: string
  readonly createdAt?: number
  readonly archived?: boolean
}

export interface V1Message {
  readonly id: string
  readonly sessionId: string
  readonly role?: string
  readonly createdAt?: number
}

export interface V1Part {
  readonly id: string
  readonly messageId: string
  readonly type?: string
  readonly data?: unknown
}

/** Read-only view over a legacy store. All methods are pure reads. */
export interface V1Source {
  sessions(): Iterable<V1Session>
  messages(): Iterable<V1Message>
  parts(): Iterable<V1Part>
  close?(): void
}

export interface QuarantinedRow {
  readonly table: "session" | "message" | "part"
  readonly id: string
  readonly reason: string
}

export interface MigrationReport {
  readonly sourceSessions: number
  readonly importedSessions: number
  readonly sourceMessages: number
  readonly importedMessages: number
  readonly sourceParts: number
  readonly importedParts: number
  readonly deduped: number
  readonly quarantined: readonly QuarantinedRow[]
  readonly warnings: readonly string[]
  readonly verification: "passed" | "failed"
}
