/**
 * S137 — the turn protocol: one framed entry, and reconnection that cannot
 * duplicate a turn.
 *
 * The shells this section builds are THIN — the acceptance says no domain
 * logic in the shell — and thin clients fail in one specific, expensive way:
 * the connection drops after a turn was sent and before its acknowledgement
 * arrived, and the client, knowing nothing, sends it again. The engine now
 * runs the same user turn twice. With a model attached, that is twice the
 * tokens; with tools attached, it is twice the side effects.
 *
 * The estate has already paid for both halves of the answer, in other clothes:
 *
 * THE OUTBOX (client half) is the kernel's crash discipline: intent is made
 * durable BEFORE the send, under a client-minted id, so a crashed or
 * reconnected client re-offers the SAME turn rather than minting a new one.
 * At most one turn is in flight — a shell that pipelines turns cannot say
 * which answer belongs to which question, and "one framed entry" (مدخل
 * مُحزَّم واحد) means there is exactly one way in and it is this one.
 *
 * THE LEDGER (engine half) is UNIQUE(intent_id, phase_tag) wearing session
 * clothes: admission by identity, exactly once. A duplicate offer is answered
 * with the ORIGINAL admission — not an error, because from a reconnecting
 * client's point of view a duplicate offer is the correct, honest move, and
 * punishing it teaches clients to mint fresh ids, which is the disease.
 *
 * THE CURSOR (stream half) makes resumption addressable: every event carries a
 * sequence number, the client acknowledges what it has seen, and a reconnect
 * asks for "everything after N". Replay from a cursor can duplicate delivery
 * of an event the client saw but had not acknowledged — that is inherent — so
 * delivery is at-least-once and the client folds by sequence, which makes the
 * FOLD exactly-once. What the cursor can never do is skip: a gap is a
 * refusal, not a warning, because a shell that renders around a hole is
 * showing the operator a conversation that did not happen.
 */

// ---------------------------------------------------------------------------
// The outbox — the client half
// ---------------------------------------------------------------------------

export interface Turn {
  readonly id: string
  readonly body: string
}

export type OutboxState =
  | { readonly kind: "idle" }
  | { readonly kind: "offering"; readonly turn: Turn }
  | { readonly kind: "acknowledged"; readonly turn: Turn }

export type Submitted =
  | { readonly ok: true; readonly state: OutboxState }
  | { readonly ok: false; readonly why: string }

/**
 * Submit a turn.
 *
 * Refused while one is already in flight. The alternative — queueing — looks
 * friendlier and is how a shell ends up with domain logic: something has to
 * decide what happens to queued turns when the in-flight one fails, and that
 * decision belongs to the operator, not to a buffer.
 */
export const submit = (state: OutboxState, turn: Turn): Submitted => {
  if (state.kind === "offering") {
    return {
      ok: false,
      why: `turn ${state.turn.id} is still in flight — one framed entry means one turn at a time, and what to do about the pending one is the operator's decision, not a queue's`,
    }
  }
  return { ok: true, state: { kind: "offering", turn } }
}

/**
 * What a reconnecting client sends.
 *
 * The SAME turn, same id — never a fresh one. This function existing is the
 * point: there is no API on the outbox that re-wraps a pending body under a
 * new id, so the duplicating client cannot be written against this type.
 */
export const reoffer = (state: OutboxState): Turn | undefined =>
  state.kind === "offering" ? state.turn : undefined

export const acknowledge = (state: OutboxState, turnId: string): OutboxState => {
  if (state.kind !== "offering" || state.turn.id !== turnId) return state
  return { kind: "acknowledged", turn: state.turn }
}

// ---------------------------------------------------------------------------
// The ledger — the engine half
// ---------------------------------------------------------------------------

export interface Admission {
  readonly turnId: string
  readonly seq: number
  /** True exactly when this offer was the first with its id. */
  readonly fresh: boolean
}

export interface TurnLedger {
  readonly admitted: ReadonlyMap<string, number>
  readonly nextSeq: number
}

export const ledger = (): TurnLedger => ({ admitted: new Map(), nextSeq: 1 })

/**
 * Admit a turn, exactly once by identity.
 *
 * A duplicate is answered with the ORIGINAL admission and `fresh: false`. Not
 * an error: a reconnecting client re-offering its unacknowledged turn is doing
 * the correct thing, and an engine that punished it would teach clients to
 * mint fresh ids per retry — which is precisely the double-run this exists to
 * make impossible.
 */
export const admit = (state: TurnLedger, turn: Turn): { readonly ledger: TurnLedger; readonly admission: Admission } => {
  const existing = state.admitted.get(turn.id)
  if (existing !== undefined) {
    return { ledger: state, admission: { turnId: turn.id, seq: existing, fresh: false } }
  }
  const seq = state.nextSeq
  return {
    ledger: { admitted: new Map([...state.admitted, [turn.id, seq]]), nextSeq: seq + 1 },
    admission: { turnId: turn.id, seq, fresh: true },
  }
}

// ---------------------------------------------------------------------------
// The cursor — the stream half
// ---------------------------------------------------------------------------

export interface StreamEvent {
  readonly seq: number
  readonly payload: string
}

export type Folded =
  | { readonly ok: true; readonly seen: number; readonly fresh: readonly StreamEvent[] }
  | { readonly ok: false; readonly why: string }

/**
 * Fold a batch of replayed events into the client's view.
 *
 * Duplicates (seq ≤ seen) are dropped silently — at-least-once delivery makes
 * them ordinary, not suspicious. A GAP is a refusal: an event stream with a
 * hole is a conversation the shell would render around, and an operator
 * looking at a transcript with a silent hole is an operator being lied to by
 * omission.
 */
export const fold = (seen: number, events: readonly StreamEvent[]): Folded => {
  const fresh: StreamEvent[] = []
  let cursor = seen
  for (const event of events) {
    if (event.seq <= cursor) continue
    if (event.seq !== cursor + 1) {
      return {
        ok: false,
        why: `the stream jumped from ${cursor} to ${event.seq} — a gap is a conversation that did not happen, and rendering around it lies by omission`,
      }
    }
    fresh.push(event)
    cursor = event.seq
  }
  return { ok: true, seen: cursor, fresh }
}

/** What a reconnecting client asks the engine for. */
export const resumeFrom = (seen: number): number => seen + 1

export * as Turns from "./turns"
