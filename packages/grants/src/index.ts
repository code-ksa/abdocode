/**
 * @abdo/grants — CL-03: durable approval grants.
 *
 * A grant is a *durable* answer to "may this specific operation run?", not a
 * flag in a process. Two properties decide whether it is trustworthy:
 *
 *  1. **Reservation is atomic and happens BEFORE the side effect.** Consuming a
 *     grant is an append to the GRANT's own aggregate guarded by
 *     `expectedSequence`. Two processes racing for the same use both target the
 *     same next sequence; the store lets exactly one through and the other gets
 *     `SequenceConflictError` and loses. The grant lives on its own aggregate
 *     precisely so this check is not fighting the session's busy event stream.
 *
 *  2. **State is rebuilt from events.** `granted / consumed / revoked / expired`
 *     are folded on every read, so a restart — or a second process — sees the
 *     same truth. Nothing depends on in-process memory.
 *
 * Everything is fail-closed: expired, revoked, exhausted, unmatched, or a store
 * error all mean NO grant, which means the call goes to a human or is denied.
 *
 * A grant is ALWAYS bound to capability + target + operationHash. There is no
 * wildcard scope — a grant cannot be written that authorises "anything".
 */
import { createHash } from "node:crypto"
import type { EventStore } from "@abdo/event-store"
import type { Capability, ControlRequest } from "@abdo/control-contracts"
import { targetIdentity } from "@abdo/control-contracts"

export const GrantEvents = {
  Requested: "approval.requested",
  Granted: "approval.granted",
  Denied: "approval.denied",
  Consumed: "approval.consumed",
  Revoked: "approval.revoked",
  Expired: "approval.expired",
} as const

/**
 * How far a grant reaches. Every kind ALSO binds capability + target +
 * operationHash — the scope only narrows further, it never widens.
 */
export type GrantScope =
  /** One use, anywhere in this session (still same capability/target/operation). */
  | { readonly kind: "once" }
  /** Only this exact tool execution. */
  | { readonly kind: "tool_execution"; readonly toolExecutionId: string }
  /** Any matching call within this run. */
  | { readonly kind: "run"; readonly runId: string }
  /** Any matching call within this session. */
  | { readonly kind: "session" }

export interface GrantSpec {
  readonly sessionId: string
  readonly capability: Capability
  /** `targetIdentity(...)` — never a pattern. */
  readonly target: string
  /** Identity of the operation this grant authorises. Never "*". */
  readonly operationHash: string
  /** Which `operationHash` function produced it. Defaults to the current one. */
  readonly operationHashVersion?: number
  readonly scope: GrantScope
  /** Hard cap on uses. `once` implies 1. */
  readonly maxUses?: number
  /** Absolute expiry (ms epoch). Absent = no time limit (still use-capped). */
  readonly expiresAt?: number
  /** Free-text justification recorded in the log (never a secret). */
  readonly reason: string
  /** Who authorised it — a human id, or an explicit env-driven CLI act. */
  readonly grantedBy: string
}

export type GrantStatus = "active" | "exhausted" | "revoked" | "expired"

export interface GrantState extends GrantSpec {
  readonly grantId: string
  readonly maxUses: number
  readonly usedCount: number
  readonly status: GrantStatus
  readonly revokedReason?: string
}

/**
 * Version of the operation-identity function itself.
 *
 * CL-04 replaces command normalization, which CHANGES how `operationHash` is
 * computed. A grant issued under the old function must not be silently
 * reinterpreted under the new one — the same bytes could hash differently, or
 * worse, two different operations could collide into one old hash. So the
 * version is stored ON the grant and a mismatch makes it inapplicable (fail
 * closed): the user is asked again rather than being granted something they
 * never approved. BUMP THIS whenever `operationHash` changes.
 */
export const OPERATION_HASH_VERSION = 3 // CL-05: capability meaning changed

/** The identity a grant is bound to. Derived, never supplied by a model. */
export function operationHash(request: ControlRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        capability: request.capability,
        target: targetIdentity(request.target),
        tool: request.tool,
        kind: request.normalizedOperation.kind,
        argsHash: request.argsHash,
      }),
    )
    .digest("hex")
}

/** Bounded retries per grant when a concurrent reserver wins a use. */
const RESERVE_ATTEMPTS = 32

/**
 * The binding a reservation is checked against. Derived from a ControlRequest
 * for tool calls, or built directly by another control-plane caller — either
 * way the same exact triple (capability + target + operationHash) applies.
 */
export interface GrantMatch {
  readonly sessionId: string
  /** The version the CALLER computed its hash with. Defaults to current. */
  readonly operationHashVersion?: number
  readonly runId: string
  readonly toolExecutionId?: string
  readonly capability: Capability
  readonly target: string
  readonly operationHash: string
}

export function matchOf(request: ControlRequest): GrantMatch {
  return {
    sessionId: request.sessionId,
    runId: request.runId,
    toolExecutionId: request.toolExecutionId,
    capability: request.capability,
    target: targetIdentity(request.target),
    operationHash: operationHash(request),
    operationHashVersion: OPERATION_HASH_VERSION,
  }
}

export interface ReserveOutcome {
  readonly reserved: boolean
  readonly grantId?: string
  /** Why nothing was reserved — always populated on failure, for the audit. */
  readonly reason?: string
}

/**
 * INVARIANT behind "use index == sequence": nothing may append a NON-TERMINAL
 * event to a grant aggregate while consumption is still possible. Today only
 * `consumed`, `revoked` and `expired` are ever appended after `granted`, and the
 * latter two are terminal for consumption — once either is folded the grant is
 * no longer `active`, so `applies()` refuses and no further use is attempted.
 * If a future event type is added mid-consumption, it will occupy a sequence a
 * use needs and reservations will (safely) stop reserving: bounded retries end
 * in "not reserved", which is fail-closed, but the grant becomes unusable. Any
 * such event MUST therefore be terminal, or the use index must stop being the
 * sequence.
 *
 * Event-sourced grant ledger. Every method folds the log; none caches decisions
 * in memory. `now` is injectable so expiry is testable without sleeping.
 */
export class GrantLedger {
  constructor(
    private readonly store: EventStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record that approval was asked for. Purely informational; grants nothing. */
  async requested(sessionId: string, spec: Pick<GrantSpec, "capability" | "target" | "operationHash">, approvalRequestId: string): Promise<void> {
    await this.store.append({
      aggregateKind: "session",
      aggregateId: sessionId,
      type: GrantEvents.Requested,
      data: { ...spec, approvalRequestId },
      idempotencyKey: `approval-requested:${approvalRequestId}`,
    })
  }

  /** Record a refusal. Never creates a grant — a denial is not a weak grant. */
  async denied(sessionId: string, approvalRequestId: string, reason: string): Promise<void> {
    await this.store.append({
      aggregateKind: "session",
      aggregateId: sessionId,
      type: GrantEvents.Denied,
      data: { approvalRequestId, reason },
      idempotencyKey: `approval-denied:${approvalRequestId}`,
    })
  }

  /** Issue a grant. The id is returned; the state lives only in the log. */
  async issue(spec: GrantSpec): Promise<string> {
    const grantId = "grant_" + createHash("sha256").update(`${spec.sessionId}|${spec.operationHash}|${spec.reason}|${this.now()}|${Math.random()}`).digest("hex").slice(0, 24)
    const maxUses = spec.maxUses ?? (spec.scope.kind === "once" ? 1 : Number.MAX_SAFE_INTEGER)
    const operationHashVersion = spec.operationHashVersion ?? OPERATION_HASH_VERSION
    await this.store.append({
      aggregateKind: "grant",
      aggregateId: grantId,
      type: GrantEvents.Granted,
      data: { ...spec, grantId, maxUses, operationHashVersion },
      expectedSequence: 0, // a grant is created exactly once
    })
    return grantId
  }

  async revoke(grantId: string, reason: string): Promise<void> {
    await this.store.append({
      aggregateKind: "grant",
      aggregateId: grantId,
      type: GrantEvents.Revoked,
      data: { grantId, reason },
      idempotencyKey: `revoked:${grantId}`,
    })
  }

  /** Fold this grant's log. The ONLY source of truth — no process memory. */
  async state(grantId: string): Promise<GrantState | undefined> {
    const events = await this.store.read("grant", grantId)
    let spec: (GrantSpec & { grantId: string; maxUses: number }) | undefined
    let usedCount = 0
    let revokedReason: string | undefined
    for (const e of events) {
      const d = e.data as Record<string, unknown>
      if (e.type === GrantEvents.Granted) spec = d as unknown as GrantSpec & { grantId: string; maxUses: number }
      else if (e.type === GrantEvents.Consumed) usedCount++
      else if (e.type === GrantEvents.Revoked) revokedReason = String(d.reason ?? "revoked")
    }
    if (!spec) return undefined
    const status: GrantStatus = revokedReason
      ? "revoked"
      : spec.expiresAt !== undefined && this.now() > spec.expiresAt
        ? "expired"
        : usedCount >= spec.maxUses
          ? "exhausted"
          : "active"
    return { ...spec, usedCount, status, ...(revokedReason ? { revokedReason } : {}) }
  }

  /** Does this grant authorise this exact request, right now? */
  private applies(grant: GrantState, match: GrantMatch): boolean {
    if (grant.status !== "active") return false
    if (grant.sessionId !== match.sessionId) return false
    // A grant hashed by a DIFFERENT normalizer generation means something we can
    // no longer vouch for. Fail closed: ask again rather than assume.
    if ((grant.operationHashVersion ?? OPERATION_HASH_VERSION) !== (match.operationHashVersion ?? OPERATION_HASH_VERSION)) return false
    // The three bindings are mandatory and exact — there is no wildcard form.
    if (grant.capability !== match.capability) return false
    if (grant.target !== match.target) return false
    if (grant.operationHash !== match.operationHash) return false
    switch (grant.scope.kind) {
      case "tool_execution":
        return grant.scope.toolExecutionId === match.toolExecutionId
      case "run":
        return grant.scope.runId === match.runId
      case "once":
      case "session":
        return true
    }
  }

  /**
   * ATOMICALLY reserve one use of a matching grant, BEFORE any side effect.
   *
   * The consume append is guarded by `expectedSequence`, so if another process
   * (or another concurrent call in this one) takes the same use first, this one
   * gets a sequence conflict and does NOT reserve. There is no window in which
   * two callers both believe they hold the same use.
   *
   * Anything unexpected — a store error, a conflict, a missing grant — resolves
   * to "not reserved", which sends the call to a human or to a denial.
   */
  async reserve(input: ControlRequest | GrantMatch, candidateGrantIds: readonly string[]): Promise<ReserveOutcome> {
    const match: GrantMatch = "normalizedOperation" in input ? matchOf(input) : input
    for (const grantId of candidateGrantIds) {
      // A lost race means "someone took THAT use", not "the grant is spent", so
      // a grant with capacity left is retried — bounded, to rule out livelock.
      for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
      let grant: GrantState | undefined
      try {
        grant = await this.state(grantId)
      } catch {
        break // unreadable grant is no grant
      }
      if (!grant) break
      if (grant.status === "expired") {
        // Record the expiry once so the log explains why it stopped working.
        await this.store
          .append({
            aggregateKind: "grant",
            aggregateId: grantId,
            type: GrantEvents.Expired,
            data: { grantId, expiresAt: grant.expiresAt },
            idempotencyKey: `expired:${grantId}`,
          })
          .catch(() => {})
        break
      }
      if (!this.applies(grant, match)) break

      // The USE INDEX IS THE SEQUENCE. Use N may only be written at sequence N
      // (the grant event holds sequence 0), so the capacity check and the
      // concurrency token are the SAME atomic fact. Deriving the sequence from
      // the tail instead would let two racers that both saw usedCount=2 take a
      // third AND a fourth use — a cap violation the store cannot see.
      const expectedSequence = grant.usedCount + 1
      try {
        const r = await this.store.append({
          aggregateKind: "grant",
          aggregateId: grantId,
          type: GrantEvents.Consumed,
          data: {
            grantId,
            sessionId: match.sessionId,
            runId: match.runId,
            ...(match.toolExecutionId ? { toolExecutionId: match.toolExecutionId } : {}),
            capability: match.capability,
            target: match.target,
            operationHash: match.operationHash,
            useIndex: grant.usedCount + 1,
          },
          expectedSequence,
        })
        if (r.deduped) continue // someone else already wrote this exact use
        return { reserved: true, grantId }
      } catch {
        // Lost the race: re-read and try the NEXT use if capacity remains.
        continue
      }
      }
    }
    return { reserved: false, reason: "no_matching_active_grant" }
  }

  /** Grants issued in a session, newest first — for `abdo2 control grants`. */
  async listForSession(sessionId: string): Promise<GrantState[]> {
    const all = await this.store.readAll()
    const ids = all
      .filter((e) => e.type === GrantEvents.Granted && (e.data as { sessionId?: string }).sessionId === sessionId)
      .map((e) => String((e.data as { grantId: string }).grantId))
    const states = await Promise.all(ids.map((id) => this.state(id)))
    return states.filter((s): s is GrantState => s !== undefined).reverse()
  }
}
