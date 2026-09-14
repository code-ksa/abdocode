/**
 * CL-16A3 MEGA-1 §5 — the durable RUN lease.
 *
 * WHY THE HOST'S PID IS NOT AN ANSWER, which is the whole reason this file
 * exists. P4c recorded `hostPid` + `hostStartTime` in `run.requested`, and that
 * is necessary but it answers the wrong question. It tells you whether the
 * PROCESS THAT STARTED the run is still running. For a long-lived host that
 * serves many runs — which is what Abdo is — that is true almost all the time,
 * including for runs that died minutes ago inside it. Recovery keyed on host
 * liveness would therefore skip genuinely dead runs indefinitely, leaving their
 * ACEs and AppContainers on the machine forever; and after a host restart the
 * same rule flips to the opposite error, declaring every run of the previous
 * process reclaimable whether or not one is still finishing.
 *
 * A run has to assert its OWN liveness, and it has to do so DURABLY, because the
 * process making the assertion is exactly the thing that might die.
 *
 * So: a lease, written to the journal, renewed by a heartbeat while the run is in
 * flight, and released when the run finishes — whether it finished by completing,
 * by being refused, or by being cancelled. A lease that stops being renewed
 * EXPIRES, and only an expired lease makes a run a candidate for reclamation.
 *
 * FOUR THINGS IDENTIFY A LEASE, and each is load-bearing:
 *
 *   - `runId`        — which run.
 *   - `operationId`  — which ATTEMPT at that run. Fresh per execution, from the
 *                      CSPRNG. Without it a retry inherits the previous attempt's
 *                      lease and two executions share one liveness claim.
 *   - `ownerPid`     — which process holds it.
 *   - `ownerStartTime` — and WHICH process that is. Windows reuses pids; a pid
 *                      alone lets a brand-new, unrelated process be mistaken for
 *                      the dead owner, which is how a reclaim gets skipped
 *                      forever. The creation time is what makes it an identity.
 *
 * TIME IS THE WEAK PART AND IS TREATED AS SUCH. Expiry is wall-clock, compared
 * across processes, and a clock that jumps makes a live lease look expired. That
 * is why an expired lease is NOT on its own permission to delete anything: the
 * recovery pass in `isorun-recovery.ts` additionally requires the owner process
 * to be genuinely gone, and reports a contradiction (expired lease, live owner)
 * as `manual_intervention_required` rather than resolving it by guessing.
 */
import { randomBytes } from "node:crypto"
import { SequenceConflictError } from "@abdo/contracts/error"
import type { EventStore } from "@abdo/event-store"

export const RunLeaseEvents = {
  Acquired: "isorun.lease_acquired",
  Renewed: "isorun.lease_renewed",
  Released: "isorun.lease_released",
} as const

/**
 * A holder that is no longer the current one tried to act.
 *
 * THIS IS THE FENCING FAILURE, and it is thrown rather than returned because
 * every call site is a mutation about to happen. A stale owner asking to renew
 * is harmless; a stale owner asking to REVOKE or DELETE is the distributed-
 * systems classic — a process pauses (GC, a long OS call, a suspended VM), its
 * lease expires, recovery legitimately takes over, and then the original wakes
 * up and completes the operation it was in the middle of, tearing down resources
 * that now belong to somebody else. A return value can be ignored by one
 * forgetful caller; an exception cannot.
 */
export class StaleLeaseHolder extends Error {
  readonly reasonCode = "stale_lease_holder"
  constructor(
    readonly runId: string,
    readonly heldToken: number,
    readonly currentToken: number,
    detail: string,
  ) {
    super(`stale_lease_holder: ${detail} (held fencing token ${heldToken}, current is ${currentToken})`)
  }
}

/**
 * Proof that a run left nothing behind.
 *
 * `releaseRunLease` DEMANDS one, and that is a deliberate structural choice
 * rather than a convention: releasing the lease is the run saying "I am finished
 * and there is nothing here for recovery to find". If that claim can be made
 * without evidence, then the one signal recovery trusts most is the one nothing
 * checks — and a run that failed to remove its profile would mark itself clean
 * on the way out, permanently hiding the residue from the only mechanism that
 * would have reclaimed it.
 *
 * Every field is an OS RE-INSPECTION, never a return code.
 */
export interface ResidueProof {
  readonly clean: boolean
  readonly checkedAt: number
  /** Objects re-read and confirmed to carry no ACE for the container. */
  readonly aclPathsClean: readonly string[]
  /** Objects that still do. Any entry makes the proof dirty. */
  readonly aclPathsDirty: readonly string[]
  readonly profileAbsent: boolean | "never_created"
  readonly runRootAbsent: boolean | "never_created"
  readonly childProcessGone: boolean | "never_started"
  readonly detail?: string
}

/** How long a lease stays valid without a renewal. */
export const DEFAULT_LEASE_TTL_MS = 30_000

/**
 * How often it is renewed. A THIRD of the TTL, so two consecutive renewals can
 * be lost — to a slow disk, a long OS call, a scheduler hiccup — before a live
 * run is ever mistaken for a dead one. A heartbeat at the TTL itself would make
 * every hesitation an expiry.
 */
export const leaseRenewIntervalMs = (ttlMs: number): number => Math.max(1_000, Math.floor(ttlMs / 3))

export interface RunLeaseIdentity {
  readonly runId: string
  readonly operationId: string
  readonly ownerPid: number
  readonly ownerStartTime: string
}

export interface RunLeaseState extends RunLeaseIdentity {
  /**
   * MONOTONICALLY INCREASING PER RUN. Every acquisition gets a strictly higher
   * one than every acquisition before it, and the increment is made atomic by
   * an `expectedSequence` CAS on the aggregate — so two processes racing to
   * acquire cannot both come away believing they hold the same token.
   *
   * `operationId` says WHICH attempt; the token says WHICH IS NEWER. Only the
   * second question can be answered by a process that was not there for the
   * first, which is why recovery and every mutation guard compare the token.
   */
  readonly fencingToken: number
  readonly ttlMs: number
  /** Epoch millis of the most recent acquire or renew. */
  readonly heldAt: number
  readonly expiresAt: number
  readonly released: boolean
  readonly releaseReason?: string
  /** How many renewals landed. Zero is normal for a very short run. */
  readonly renewals: number
}

/** A per-attempt identifier. Never derived from the runId — see the header. */
export const newOperationId = (): string => `op_${randomBytes(12).toString("hex")}`

export const runLeaseAggregateId = (runId: string): string => `winiso:isorun:${runId}`

async function emit(store: EventStore, runId: string, type: string, data: Record<string, unknown>, idempotencyKey?: string): Promise<void> {
  await store.append({
    aggregateKind: "project",
    aggregateId: runLeaseAggregateId(runId),
    type,
    version: 1,
    data,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  })
}

export interface LeaseDeps {
  readonly store: EventStore
  /** Injectable so expiry can be tested without waiting. */
  readonly now?: () => number
}

/**
 * Take the lease for one ATTEMPT at one run.
 *
 * There is no contention check here, and that is deliberate: a run id comes from
 * the CSPRNG and its directory is published no-replace, so two attempts at the
 * same runId cannot both exist. What this records is "an execution of this run is
 * now in flight, owned by this exact process".
 */
export async function acquireRunLease(deps: LeaseDeps, id: RunLeaseIdentity, ttlMs = DEFAULT_LEASE_TTL_MS): Promise<RunLeaseState> {
  const kind = "project" as const
  const aggId = runLeaseAggregateId(id.runId)

  // READ-MODIFY-WRITE, MADE ATOMIC BY CAS.
  //
  // The new token has to be strictly higher than every token issued before it,
  // which means reading what came before. Two processes doing that concurrently
  // would both read the same maximum and both write the same "next" — two live
  // holders, each believing it is current, which is precisely the state fencing
  // exists to prevent. `expectedSequence` makes the write conditional on the
  // aggregate not having moved since the read, so exactly one of them lands and
  // the loser retries against the new tail.
  for (let attempt = 0; attempt < 32; attempt++) {
    const existing = await deps.store.read(kind, aggId)
    const highest = existing.reduce((max, e) => (e.type === RunLeaseEvents.Acquired ? Math.max(max, Number((e.data as Record<string, unknown>)?.fencingToken ?? 0)) : max), 0)
    const fencingToken = highest + 1
    const heldAt = (deps.now ?? Date.now)()
    const state: RunLeaseState = { ...id, fencingToken, ttlMs, heldAt, expiresAt: heldAt + ttlMs, released: false, renewals: 0 }
    try {
      await deps.store.append({
        aggregateKind: kind,
        aggregateId: aggId,
        type: RunLeaseEvents.Acquired,
        version: 1,
        data: { ...id, fencingToken, ttlMs, heldAt, expiresAt: state.expiresAt },
        expectedSequence: existing.length === 0 ? 0 : (existing[existing.length - 1]!.sequence as unknown as number) + 1,
      })
      return state
    } catch (e) {
      // A conflict means somebody else appended between the read and the write.
      // Re-read and try again with a genuinely higher token. Anything that is
      // NOT a sequence conflict is a real failure and must not be swallowed.
      if (!isSequenceConflict(e)) throw e
    }
  }
  throw new Error(`lease_acquire_contended: ${id.runId} could not be acquired after 32 attempts; another process is appending to this run continuously`)
}

/**
 * Is this the store telling us we lost the CAS race?
 *
 * BY TYPE AND TAG, NOT BY MESSAGE. The first version matched
 * `/sequence/i.test(e.message)` — and `SequenceConflictError` is an Effect
 * `TaggedErrorClass` whose `message` is EMPTY. Measured: with eight processes
 * racing, six acquired tokens 1-6 and two died reporting `error: ""`, because
 * the real conflict was not recognised as one and the retry loop rethrew it
 * instead of re-reading. CAS was working perfectly; the detection around it was
 * not. Matching a library's human-readable text is a guess about a string
 * nobody promised.
 */
const isSequenceConflict = (e: unknown): boolean =>
  e instanceof SequenceConflictError || (typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === "Abdo.SequenceConflictError")

/**
 * Is this holder still the current one? Throws `StaleLeaseHolder` if not.
 *
 * CALLED BEFORE EVERY MUTATION, not just before renewals. The dangerous stale
 * actor is not the one that renews — it is the one that revokes an ACL or
 * deletes a profile after recovery has already handed those resources to a newer
 * attempt.
 *
 * Being released does NOT by itself make a holder stale: a run releases its own
 * lease as its last act, and duplicate releases have to remain a safe no-op. What
 * makes a holder stale is a HIGHER TOKEN existing, or the current acquisition
 * belonging to a different operation.
 */
export async function assertLeaseCurrent(deps: LeaseDeps, state: RunLeaseState): Promise<void> {
  const events = await deps.store.read("project", runLeaseAggregateId(state.runId))
  let currentToken = 0
  let currentOperation = ""
  for (const e of events) {
    if (e.type !== RunLeaseEvents.Acquired) continue
    const d = (e.data ?? {}) as Record<string, unknown>
    const token = Number(d.fencingToken ?? 0)
    if (token >= currentToken) {
      currentToken = token
      currentOperation = String(d.operationId ?? "")
    }
  }
  if (currentToken > state.fencingToken) {
    throw new StaleLeaseHolder(state.runId, state.fencingToken, currentToken, `a newer acquisition (operation ${currentOperation}) has taken this run`)
  }
  if (currentOperation && currentOperation !== state.operationId) {
    throw new StaleLeaseHolder(state.runId, state.fencingToken, currentToken, `the current holder is operation ${currentOperation}, not ${state.operationId}`)
  }
}

/**
 * Renew it. The heartbeat.
 *
 * NOT idempotency-keyed: every renewal is a distinct fact about a distinct
 * moment, and collapsing them would make a heartbeat that stopped ten minutes ago
 * indistinguishable from one still beating.
 */
export async function renewRunLease(deps: LeaseDeps, state: RunLeaseState): Promise<RunLeaseState> {
  await assertLeaseCurrent(deps, state)
  const heldAt = (deps.now ?? Date.now)()
  const next: RunLeaseState = { ...state, heldAt, expiresAt: heldAt + state.ttlMs, renewals: state.renewals + 1 }
  await emit(deps.store, state.runId, RunLeaseEvents.Renewed, {
    runId: state.runId,
    operationId: state.operationId,
    fencingToken: state.fencingToken,
    ownerPid: state.ownerPid,
    heldAt,
    expiresAt: next.expiresAt,
    renewal: next.renewals,
  })
  return next
}

/**
 * The guard every OS mutation goes through.
 *
 * A thin wrapper over `assertLeaseCurrent` that exists so call sites read as
 * what they are — "may I still touch the machine?" — and so the set of guarded
 * mutations can be found by searching for one name.
 */
export const assertMayMutate = async (deps: LeaseDeps, state: RunLeaseState, what: string): Promise<void> => {
  try {
    await assertLeaseCurrent(deps, state)
  } catch (e) {
    if (e instanceof StaleLeaseHolder) throw new StaleLeaseHolder(e.runId, e.heldToken, e.currentToken, `refusing to ${what}: ${e.message}`)
    throw e
  }
}

/**
 * Release it, whatever the outcome.
 *
 * A release is written for a COMPLETED run, a REFUSED one and a CANCELLED one
 * alike, because the question it answers is "is an execution still in flight?"
 * and the answer is no in all three cases. Recording it only on success would
 * leave every refused run looking live until its TTL ran out, and recovery would
 * spend that window unable to tell a refusal from a hang.
 */
export class ResidueNotProven extends Error {
  readonly reasonCode = "release_without_residue_proof"
  constructor(runId: string, detail: string) {
    super(`release_without_residue_proof: ${runId} may not release its lease — ${detail}`)
  }
}

/**
 * Release the lease. THE LAST ACT OF A RUN, and it requires a proof.
 *
 * RELEASING IS A CLAIM, NOT A FORMALITY. It tells recovery "this run finished
 * and left nothing", and recovery's cheapest path believes it. So it may only be
 * written once the world has been RE-INSPECTED and found clean:
 *
 *   - the child process is confirmed gone (or never started);
 *   - every ACE this run added has been restored and re-read;
 *   - the AppContainer profile is verified ABSENT (or was never created);
 *   - the run root is verified ABSENT (or was never created).
 *
 * The proof is a required ARGUMENT rather than a convention precisely because
 * the failure mode is silent: a run that could not delete its profile would,
 * under a convention, still mark itself clean on the way out — permanently
 * hiding real residue from the only mechanism that would have reclaimed it. A
 * run that cannot prove itself clean must NOT release; letting the lease expire
 * is what hands it to recovery, which is the correct outcome.
 *
 * A duplicate release is a safe no-op (the idempotency key sees to that), which
 * matters because a retry after a partial failure must not be a hard error.
 */
export async function releaseRunLease(
  deps: LeaseDeps,
  state: RunLeaseState,
  reason: "completed" | "refused" | "cancelled" | "failed",
  proof: ResidueProof,
): Promise<RunLeaseState> {
  if (!proof.clean) {
    throw new ResidueNotProven(
      state.runId,
      proof.detail ??
        `residue remains (dirty ACLs: ${proof.aclPathsDirty.join(", ") || "none"}; profileAbsent=${String(proof.profileAbsent)}; runRootAbsent=${String(proof.runRootAbsent)}; childProcessGone=${String(proof.childProcessGone)})`,
    )
  }
  // FENCING APPLIES TO RELEASE TOO. A stale holder releasing is not harmless: it
  // would mark a run clean that a NEWER attempt is currently working inside.
  await assertMayMutate(deps, state, "release the lease")
  const at = (deps.now ?? Date.now)()
  await emit(
    deps.store,
    state.runId,
    RunLeaseEvents.Released,
    {
      runId: state.runId,
      operationId: state.operationId,
      fencingToken: state.fencingToken,
      ownerPid: state.ownerPid,
      reason,
      at,
      residueProof: {
        checkedAt: proof.checkedAt,
        aclPathsClean: proof.aclPathsClean.length,
        profileAbsent: proof.profileAbsent,
        runRootAbsent: proof.runRootAbsent,
        childProcessGone: proof.childProcessGone,
      },
    },
    `${state.operationId}:lease-released`,
  )
  return { ...state, released: true, releaseReason: reason }
}

/**
 * A heartbeat that renews until it is stopped.
 *
 * `unref`ed so it can never keep the process alive: a timer that outlives the
 * work it was reporting on would turn a finished run into an eternally live one.
 * Renewal failures are swallowed on purpose — a journal write that fails mid-run
 * must not take down a run that is otherwise fine, and the consequence of a
 * missed renewal is already handled by the TTL being three times the interval.
 */
export interface Heartbeat {
  readonly stop: () => void
  /** The latest state, so the caller can release the lease it actually holds. */
  readonly current: () => RunLeaseState
}

export function startLeaseHeartbeat(deps: LeaseDeps, initial: RunLeaseState): Heartbeat {
  let state = initial
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    void renewRunLease(deps, state)
      .then((s) => {
        state = s
      })
      .catch(() => {
        /* see the note above: a missed renewal is what the TTL is for */
      })
  }, leaseRenewIntervalMs(initial.ttlMs))
  timer.unref?.()
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
    current: () => state,
  }
}

/** Fold the lease events of one run into its current state. */
export function foldRunLease(events: readonly { type: string; data: unknown }[]): RunLeaseState | undefined {
  let state: RunLeaseState | undefined
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>
    if (e.type === RunLeaseEvents.Acquired) {
      state = {
        runId: String(d.runId ?? ""),
        operationId: String(d.operationId ?? ""),
        fencingToken: Number(d.fencingToken ?? 0),
        ownerPid: Number(d.ownerPid ?? 0),
        ownerStartTime: String(d.ownerStartTime ?? ""),
        ttlMs: Number(d.ttlMs ?? DEFAULT_LEASE_TTL_MS),
        heldAt: Number(d.heldAt ?? 0),
        expiresAt: Number(d.expiresAt ?? 0),
        released: false,
        renewals: 0,
      }
    } else if (e.type === RunLeaseEvents.Renewed && state) {
      state = { ...state, heldAt: Number(d.heldAt ?? state.heldAt), expiresAt: Number(d.expiresAt ?? state.expiresAt), renewals: Number(d.renewal ?? state.renewals + 1) }
    } else if (e.type === RunLeaseEvents.Released && state) {
      state = { ...state, released: true, releaseReason: String(d.reason ?? "") }
    }
  }
  return state
}

export const leaseIsExpired = (state: RunLeaseState, now: number): boolean => !state.released && now > state.expiresAt
