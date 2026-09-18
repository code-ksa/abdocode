/**
 * Domain errors — typed failures the runtime raises and handles explicitly.
 *
 * These are contracts, not messages: callers match on the tag, never on string
 * text. Grouping them here keeps the failure taxonomy in one auditable place.
 *
 * ⚠️ كانت أصنافاً من `Schema.TaggedErrorClass` في النواة القديمة. والوسمُ
 * الذي يُطابَق عليه حقلٌ نصّيّ — لا يحتاج مكتبة. والأهمّ: هذه الآن **أخطاء
 * حقيقيّة ترث `Error`**، فلها أثرُ مكدّس ورسالةٌ يقرأها الإنسان؛ وما كانت
 * كذلك. أي أنّ إزالة النواة القديمة هنا زادت السلوك ولم تنقصه.
 */

/** أساسٌ واحد: وسمٌ يُطابَق عليه، ورسالةٌ تُقرأ، وأثرُ مكدّس. */
export abstract class TaggedError extends Error {
  abstract readonly _tag: string
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** يطابق بالوسم لا بالنصّ — نفس عقد الاستهلاك السابق. */
export const hasTag = <T extends string>(e: unknown, tag: T): e is { _tag: T } =>
  typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === tag

/**
 * Domain errors — typed failures the V2 runtime raises and handles explicitly.
 *
 * These are contracts, not messages: callers match on the tag, never on string
 * text. Grouping them here keeps the failure taxonomy in one auditable place.
 */

/** Two writers raced on the same aggregate sequence. The store rejects the loser. */
export class SequenceConflictError extends TaggedError {
  readonly _tag = "Abdo.SequenceConflictError" as const
  readonly aggregateId: string
  readonly expected: number
  readonly actual: number
  constructor(fields: { aggregateId: string, expected: number, actual: number }) {
    super(`SequenceConflictError: ${fields.aggregateId} ${fields.expected} ${fields.actual}`)
    this.aggregateId = fields.aggregateId
    this.expected = fields.expected
    this.actual = fields.actual
  }}

/** An append arrived with an idempotency key already committed — safe no-op. */
export class IdempotencyReplayError extends TaggedError {
  readonly _tag = "Abdo.IdempotencyReplayError" as const
  readonly idempotencyKey: string
  constructor(fields: { idempotencyKey: string }) {
    super(`IdempotencyReplayError: ${fields.idempotencyKey}`)
    this.idempotencyKey = fields.idempotencyKey
  }}

/** A state transition not permitted by the machine was attempted. */
export class IllegalTransitionError extends TaggedError {
  readonly _tag = "Abdo.IllegalTransitionError" as const
  readonly from: string
  readonly to: string
  constructor(fields: { from: string, to: string }) {
    super(`IllegalTransitionError: ${fields.from} ${fields.to}`)
    this.from = fields.from
    this.to = fields.to
  }}

export class SessionNotFoundError extends TaggedError {
  readonly _tag = "Abdo.SessionNotFoundError" as const
  readonly sessionId: string
  constructor(fields: { sessionId: string }) {
    super(`SessionNotFoundError: ${fields.sessionId}`)
    this.sessionId = fields.sessionId
  }}

export class RunNotFoundError extends TaggedError {
  readonly _tag = "Abdo.RunNotFoundError" as const
  readonly runId: string
  constructor(fields: { runId: string }) {
    super(`RunNotFoundError: ${fields.runId}`)
    this.runId = fields.runId
  }}

/** Assembled request exceeds the provider envelope (tokens OR bytes). */
export class RequestTooLargeError extends TaggedError {
  readonly _tag = "Abdo.RequestTooLargeError" as const
  readonly reason: unknown
  readonly limit: number
  readonly actual: number
  constructor(fields: { reason: unknown, limit: number, actual: number }) {
    super(`RequestTooLargeError: ${fields.reason} ${fields.limit} ${fields.actual}`)
    this.reason = fields.reason
    this.limit = fields.limit
    this.actual = fields.actual
  }}

/** A tool call was denied by the permission/policy engine. */
export class ToolNotPermittedError extends TaggedError {
  readonly _tag = "Abdo.ToolNotPermittedError" as const
  readonly tool: string
  readonly reason: string
  constructor(fields: { tool: string, reason: string }) {
    super(`ToolNotPermittedError: ${fields.tool} ${fields.reason}`)
    this.tool = fields.tool
    this.reason = fields.reason
  }}

/**
 * The model call exceeded a deadline. `kind` says WHICH watchdog fired:
 * `first_byte`/`idle_chunk` are stream stalls before/between content — safe to
 * retry pre-tool with a fresh request id; `total` is the whole-call budget —
 * terminal, never retried. Absent kind is treated as `total` (conservative).
 */
export class ProviderTimeoutError extends TaggedError {
  readonly _tag = "Abdo.ProviderTimeoutError" as const
  readonly timeoutMs: number
  readonly kind: unknown
  constructor(fields: { timeoutMs: number, kind: unknown }) {
    super(`ProviderTimeoutError: ${fields.timeoutMs} ${fields.kind}`)
    this.timeoutMs = fields.timeoutMs
    this.kind = fields.kind
  }}

/** The model call was aborted because the run was cancelled. */
export class RunCancelledError extends TaggedError {
  readonly _tag = "Abdo.RunCancelledError" as const

  constructor() {
    super(`RunCancelledError: `)

  }
}

/** The provider request was aborted for a reason other than timeout/cancel. */
export class ProviderAbortedError extends TaggedError {
  readonly _tag = "Abdo.ProviderAbortedError" as const
  readonly reason: string
  constructor(fields: { reason: string }) {
    super(`ProviderAbortedError: ${fields.reason}`)
    this.reason = fields.reason
  }}

/**
 * A model response arrived for a request that is no longer active — superseded
 * by a newer attempt, or the run already reached terminal. It MUST be dropped.
 */
export class LateResponseError extends TaggedError {
  readonly _tag = "Abdo.LateResponseError" as const
  readonly requestId: string
  constructor(fields: { requestId: string }) {
    super(`LateResponseError: ${fields.requestId}`)
    this.requestId = fields.requestId
  }}

/** SQLite reported BUSY/LOCKED after the bounded retry budget was exhausted. */
export class DatabaseBusyError extends TaggedError {
  readonly _tag = "Abdo.DatabaseBusyError" as const
  readonly attempts: number
  constructor(fields: { attempts: number }) {
    super(`DatabaseBusyError: ${fields.attempts}`)
    this.attempts = fields.attempts
  }}
