/**
 * Structured memory model. Unlike a text summary, these are typed, keyed facts
 * with provenance and lifecycle — the durable, trustworthy memory. The summary
 * is a derived view (see summary.ts), never a source of truth.
 */

export type FactKind =
  | "project_fact"
  | "architecture_decision"
  | "active_task"
  | "known_error"
  | "resolved_error"
  | "server_inventory"
  | "service_dependency"
  | "deployment_target"
  | "credential_reference"

/**
 * candidate  — recorded, not yet corroborated by a source
 * verified   — backed by at least one documented source
 * superseded — replaced by a newer fact (kept for history, never deleted)
 * invalid    — retracted
 */
export type FactStatus = "candidate" | "verified" | "superseded" | "invalid"

export interface Fact {
  readonly id: string
  readonly projectId: string
  /**
   * Session scope. A fact without one is project-wide; a fact with one is
   * invisible outside that session (S130).
   *
   * The distinction matters because the most common false memory is not an
   * expired fact — it is a fact that was true in another conversation.
   */
  readonly sessionId?: string
  readonly kind: FactKind
  readonly key: string
  readonly value: unknown
  readonly status: FactStatus
  /** 0..1 subjective confidence. */
  readonly confidence: number
  /** Event ids that evidence this fact — required to reach `verified`. */
  readonly sourceEventIds: readonly string[]
  readonly sourceFilePaths: readonly string[]
  readonly sourceGitCommit?: string
  readonly validFrom: number
  readonly validUntil?: number
  /**
   * TTL (S130). Distinct from `validUntil`, which records that a fact *was*
   * retired; this records that it will stop being true on its own. Merging them
   * would lose the difference between "we replaced this" and "this went stale",
   * and only the first is a decision anybody made.
   */
  readonly expiresAt?: number
  readonly supersedesId?: string
  readonly createdAt: number
  readonly verifiedAt?: number
}

export interface RecordFactInput {
  readonly projectId: string
  readonly sessionId?: string
  readonly kind: FactKind
  readonly key: string
  readonly value: unknown
  readonly confidence?: number
  readonly sourceEventIds?: readonly string[]
  readonly sourceFilePaths?: readonly string[]
  readonly sourceGitCommit?: string
  readonly expiresAt?: number
}

/** A fact is "active" (counts toward current memory) when not retired. */
export const isActive = (fact: Fact): boolean => fact.status === "candidate" || fact.status === "verified"

/** Credential references must point at a secret store, never hold a raw secret. */
export const CREDENTIAL_REFERENCE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/
