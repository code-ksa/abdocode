/**
 * Domain event envelope — the unit of the append-only log.
 *
 * The event log is the source of truth in V2. Messages, runs and projections
 * are all derived from replaying these. `sequence` (per aggregate) is the
 * ordering authority and is assigned by the store transactionally.
 */
import type { EventID, EventSequence, IdempotencyKey } from "./id"

/** Aggregate the event belongs to — its serialized, single-writer boundary. */
/**
 * `grant` (CL-03) is its own aggregate ON PURPOSE: a grant's consumption must be
 * serialised against OTHER consumers of that grant, not against the session's
 * busy event stream. Optimistic concurrency on a session aggregate would collide
 * with every unrelated run event and make atomic reservation impossible.
 */
/**
 * `mission` (Sprint 23) is its own aggregate because a mission OUTLIVES any
 * one session: the work continues across restarts, machines and days, and
 * filing it under a session would tie the whole job to whichever session
 * happened to start it.
 */
/**
 * ⚠️ كان `Schema.Literals` و`Schema.Struct` من النواة القديمة.
 *
 * وتسعةُ ملفّاتٍ في هذه الحزمة تستورد `DomainEvent` بـ`import type` — **النوع
 * وحده، لا القيمة**. أي أنّ تسعة ملفّاتٍ بدت نظيفةً في الفحص النصّيّ كانت
 * مربوطةً بالنواة القديمة عبر استيرادٍ واحد لا يظهر فيها. **التلوّث لم يكن في
 * الملفّ بل خلف استيراده** — ولم يكشفه إلّا التصريف.
 *
 * البديل: النوع كما هو، وتحقّقٌ حقيقيّ عند الحدّ بدل مخطّطٍ لم يكن يُستعمل
 * لفكّ ترميز.
 */
export const AGGREGATE_KINDS = ["session", "project", "memory", "grant", "mission"] as const
export type AggregateKind = (typeof AGGREGATE_KINDS)[number]

export const isAggregateKind = (v: unknown): v is AggregateKind =>
  typeof v === "string" && (AGGREGATE_KINDS as readonly string[]).includes(v)

export interface DomainEvent {
  readonly id: EventID
  readonly aggregateKind: AggregateKind
  readonly aggregateId: string
  readonly sequence: EventSequence
  /** Dotted event name, e.g. "run.completed", "tool.executed", "input.admitted". */
  readonly type: string
  /** Schema version of this event type — lets replay upcast old payloads. */
  readonly version: number
  readonly data: unknown
  readonly idempotencyKey?: IdempotencyKey
  readonly occurredAt: number
}

/** عند الحدّ: حدثٌ لا يستوفي شكله يُرفض بجملةٍ تسمّي سببه. */
export function assertDomainEvent(v: unknown): DomainEvent {
  const e = v as Partial<DomainEvent> | null
  if (!e || typeof e !== "object") throw new TypeError("event: not an object")
  if (!isAggregateKind(e.aggregateKind)) throw new TypeError(`event: bad aggregateKind ${String(e.aggregateKind)}`)
  if (typeof e.aggregateId !== "string") throw new TypeError("event: aggregateId must be a string")
  if (typeof e.type !== "string" || e.type.length === 0) throw new TypeError("event: type must be a non-empty string")
  if (!Number.isInteger(e.version)) throw new TypeError("event: version must be an integer")
  if (typeof e.occurredAt !== "number") throw new TypeError("event: occurredAt must be a number")
  return e as DomainEvent
}

/**
 * Terminal run events. Every run MUST end by emitting exactly one of these —
 * that guarantee is what keeps the UI out of a phantom "running" state.
 */
export const TERMINAL_RUN_EVENTS = ["run.completed", "run.failed", "run.cancelled", "run.paused"] as const
export type TerminalRunEvent = (typeof TERMINAL_RUN_EVENTS)[number]

export const isTerminalRunEvent = (type: string): type is TerminalRunEvent =>
  (TERMINAL_RUN_EVENTS as readonly string[]).includes(type)
