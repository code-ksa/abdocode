/**
 * Branded identifiers for the Abdo domain.
 *
 * Every id is a prefixed, monotonic, sortable string. Prefixes make ids
 * self-describing in logs and prevent accidentally passing (say) a MessageID
 * where a SessionID is expected — the brand is enforced at the type level.
 *
 * ⚠️ كان هذا مبنيّاً على `Schema.brand` من النواة القديمة. والوسمُ في
 * TypeScript **ليس ميزة مكتبة** — نوعٌ متقاطع مع حقلٍ وهميّ يكفي، ويعطي نفس
 * المنع عند الترجمة بلا تبعيّةٍ وقت التشغيل. أمّا التحقّق من البادئة فيبقى
 * حقيقيّاً في `from`، ويرفض بجملةٍ تسمّي البادئة المتوقّعة.
 */
import { ascending, descending } from "./internal"

declare const BRAND: unique symbol
export type Branded<T extends string> = string & { readonly [BRAND]: T }

interface IdFactory<T extends string> {
  /** معرّفٌ جديد بالبادئة والترتيب الصحيح. */
  create(): Branded<T>
  /** يقبل نصّاً قائماً بعد التحقّق من بادئته. */
  from(id: string): Branded<T>
  readonly prefix: string
}

function makeId<T extends string>(prefix: string, _brand: T, seq: () => string): IdFactory<T> {
  const head = prefix + "_"
  return {
    prefix: head,
    create: () => (head + seq()) as Branded<T>,
    from: (id: string) => {
      if (typeof id !== "string" || !id.startsWith(head)) {
        throw new TypeError(`expected an id starting with "${head}", got ${JSON.stringify(id)}`)
      }
      return id as Branded<T>
    },
  }
}

const descendingId = <T extends string>(prefix: string, brand: T) => makeId(prefix, brand, descending)
const ascendingId = <T extends string>(prefix: string, brand: T) => makeId(prefix, brand, ascending)

export const SessionID = descendingId("ses", "Abdo.SessionID")
export type SessionID = ReturnType<(typeof SessionID)["create"]>

export const MessageID = descendingId("msg", "Abdo.MessageID")
export type MessageID = ReturnType<(typeof MessageID)["create"]>

export const PartID = descendingId("prt", "Abdo.PartID")
export type PartID = ReturnType<(typeof PartID)["create"]>

export const RunID = descendingId("run", "Abdo.RunID")
export type RunID = ReturnType<(typeof RunID)["create"]>

export const ToolExecutionID = descendingId("tex", "Abdo.ToolExecutionID")
export type ToolExecutionID = ReturnType<(typeof ToolExecutionID)["create"]>

export const ProjectID = descendingId("prj", "Abdo.ProjectID")
export type ProjectID = ReturnType<(typeof ProjectID)["create"]>

export const AgentID = descendingId("agt", "Abdo.AgentID")
export type AgentID = ReturnType<(typeof AgentID)["create"]>

export const CheckpointID = descendingId("ckp", "Abdo.CheckpointID")
export type CheckpointID = ReturnType<(typeof CheckpointID)["create"]>

/** Events sort ASCENDING — the log is replayed oldest-first. */
export const EventID = ascendingId("evt", "Abdo.EventID")
export type EventID = ReturnType<(typeof EventID)["create"]>

/**
 * Per-aggregate monotonic sequence. This is the ordering authority for the
 * event store; ids are for identity, sequence is for order. Assigned by the
 * store inside a transaction — never computed in application code (that race
 * is exactly what V2 must avoid).
 */
export const EventSequence = {
  from: (n: number): Branded<"Abdo.EventSequence"> => {
    if (!Number.isInteger(n) || n < 0) throw new TypeError(`sequence must be a non-negative integer, got ${n}`)
    return n as unknown as Branded<"Abdo.EventSequence">
  },
}
export type EventSequence = Branded<"Abdo.EventSequence">

/** Idempotency key — dedupes command/event appends across retries. */
export const IdempotencyKey = {
  from: (v: string): Branded<"Abdo.IdempotencyKey"> => {
    if (typeof v !== "string" || v.length === 0) throw new TypeError("idempotency key must be a non-empty string")
    return v as Branded<"Abdo.IdempotencyKey">
  },
}
export type IdempotencyKey = Branded<"Abdo.IdempotencyKey">
