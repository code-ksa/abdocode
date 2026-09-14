/**
 * CL-16A2-D §7/§9 — resource leases.
 *
 * WHY THESE EXIST AT ALL, stated precisely, because the obvious answer is wrong.
 *
 * Two runs granting access to the SAME directory do NOT normally conflict: each
 * run has its own AppContainer SID, so each adds its own ACE, and removing one
 * leaves the other untouched. That was measured. The lease is not for that case.
 *
 * It is for the case where two runs share a SID — the same container name, a
 * pooled profile, a retry that reuses an identity — because then they share ONE
 * ACE, and whichever finishes first would revoke access out from under the other.
 * The lease makes the last holder the one that releases.
 *
 * The ledger is the event store, keyed per resource+SID+rights so a release is
 * serialised against exactly the other holders of that same grant and nothing
 * else. `expectedSequence` makes acquire/release atomic under concurrency —
 * two hosts racing cannot both believe they are last.
 */
import type { EventStore } from "@abdo/event-store"
import { AC, JOURNAL_VERSION, leaseAggregateId, leaseKey } from "./journal"

export interface LeaseHolders {
  readonly key: string
  readonly holders: readonly string[]
  /** Runs that have ALREADY released — a duplicate release is not a crash. */
  readonly released: readonly string[]
  readonly sequence: number
}

async function readHolders(store: EventStore, key: string): Promise<LeaseHolders> {
  const events = await store.read("project", leaseAggregateId(key))
  const holders = new Set<string>()
  const released = new Set<string>()
  for (const e of events) {
    const d = (e.data ?? {}) as { runId?: string }
    if (!d.runId) continue
    if (e.type === AC.LeaseAcquired) {
      holders.add(d.runId)
      released.delete(d.runId) // re-acquired: it depends on the grant again
    } else if (e.type === AC.LeaseReleased) {
      holders.delete(d.runId)
      released.add(d.runId)
    }
  }
  return { key, holders: [...holders].sort(), released: [...released].sort(), sequence: events.length === 0 ? -1 : (events[events.length - 1]!.sequence as unknown as number) }
}

export interface LeaseRef {
  readonly key: string
  readonly resourceIdentity: string
  readonly sid: string
  readonly rights: string
}

/**
 * What one attempt at the ledger did.
 *
 * CL-16A2-D-L requires every participant to record the sequence it EXPECTED and
 * the sequence it OBSERVED, because that pair is the only direct evidence that
 * optimistic concurrency actually engaged. Without it a run of twenty workers
 * that never collided is indistinguishable from one where the collisions were
 * silently swallowed — and `acquireLease` swallows them by design, in a bare
 * `catch`. This makes the conflict observable without changing the behaviour.
 */
export interface LeaseAttempt {
  readonly op: "acquire" | "release"
  readonly key: string
  readonly runId: string
  readonly attempt: number
  readonly expectedSequence: number
  readonly observedSequence: number
  readonly outcome: "appended" | "conflict" | "already_holder" | "not_holder"
  readonly holders: readonly string[]
}

export type LeaseObserver = (a: LeaseAttempt) => void

export interface LeaseOptions {
  readonly observe?: LeaseObserver
  /**
   * Awaited between READING the ledger and APPENDING to it.
   *
   * This is the only place a test can make contention DETERMINISTIC rather than
   * likely. Without it, three processes released from a barrier may still
   * serialise perfectly — the second reads after the first has appended, so it
   * computes the correct next sequence and never conflicts — and a test that
   * asserts "a conflict happened" would flake. With a barrier here, every
   * participant reads the same sequence before any of them writes, so exactly
   * one append wins and the rest MUST conflict, on every run.
   *
   * Production passes nothing and the hook does not exist at run time.
   */
  readonly beforeAppend?: () => Promise<void> | void
}

/**
 * MEASURED: 8 was not enough. Twenty runs acquiring the same lease at once lose
 * the optimistic-concurrency race often enough that a fixed handful of retries
 * gives up on a contended-but-perfectly-healthy resource — and "could not
 * acquire" would then be reported as a lease failure rather than as the
 * scheduling artefact it is. The budget scales with the concurrency §9 asks for,
 * and the backoff spreads the retries so they stop colliding in lockstep.
 */
const RETRIES = 128
const backoff = (attempt: number) => new Promise((r) => setTimeout(r, Math.min(2 ** Math.min(attempt, 6), 50) + Math.random() * 15))

/**
 * Take a lease. Returns whether THIS run is the first holder — the one that has
 * to perform the OS grant. A second holder gets `mustGrant: false` and relies on
 * the ACE that is already there.
 */
export async function acquireLease(
  store: EventStore,
  ref: Omit<LeaseRef, "key">,
  runId: string,
  opts: LeaseOptions = {},
): Promise<{ ref: LeaseRef; mustGrant: boolean; holders: readonly string[] }> {
  const { observe, beforeAppend } = opts
  const key = leaseKey(ref.resourceIdentity, ref.sid, ref.rights)
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const cur = await readHolders(store, key)
    if (cur.holders.includes(runId)) {
      // Idempotent: a retry after a crash re-reads its own lease rather than
      // double-counting itself and becoming impossible to release.
      observe?.({ op: "acquire", key, runId, attempt, expectedSequence: cur.sequence + 1, observedSequence: cur.sequence, outcome: "already_holder", holders: cur.holders })
      return { ref: { ...ref, key }, mustGrant: cur.holders.length === 1, holders: cur.holders }
    }
    try {
      if (beforeAppend) await beforeAppend()
      await store.append({
        aggregateKind: "project",
        aggregateId: leaseAggregateId(key),
        type: AC.LeaseAcquired,
        version: JOURNAL_VERSION,
        data: { runId, ...ref, key },
        idempotencyKey: `lease-acquire:${key}:${runId}`,
        expectedSequence: cur.sequence + 1,
      })
      observe?.({ op: "acquire", key, runId, attempt, expectedSequence: cur.sequence + 1, observedSequence: cur.sequence, outcome: "appended", holders: [...cur.holders, runId].sort() })
      return { ref: { ...ref, key }, mustGrant: cur.holders.length === 0, holders: [...cur.holders, runId].sort() }
    } catch {
      // Someone else appended first; re-read and decide again.
      const now = await readHolders(store, key)
      observe?.({ op: "acquire", key, runId, attempt, expectedSequence: cur.sequence + 1, observedSequence: now.sequence, outcome: "conflict", holders: now.holders })
      await backoff(attempt)
    }
  }
  throw new Error(`lease_contention: could not acquire ${key} after ${RETRIES} attempts`)
}

/**
 * Give up a lease. Returns whether this was the LAST holder, i.e. whether the
 * OS grant may now be removed. A run that is not a holder gets `mustRevoke:
 * false` — releasing twice must not revoke a live grant.
 */
export async function releaseLease(store: EventStore, key: string, runId: string, opts: LeaseOptions = {}): Promise<{ mustRevoke: boolean; holders: readonly string[]; wasHolder: boolean }> {
  const { observe, beforeAppend } = opts
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const cur = await readHolders(store, key)
    if (!cur.holders.includes(runId)) {
      observe?.({ op: "release", key, runId, attempt, expectedSequence: cur.sequence + 1, observedSequence: cur.sequence, outcome: "not_holder", holders: cur.holders })
      // NOT A HOLDER — and that is TWO different situations, which the first
      // version collapsed into one and got wrong.
      //
      //   - others hold it  -> leave the grant alone, they need it;
      //   - NOBODY holds it -> this run crashed between granting and recording
      //     its lease. Treating that as "someone else's" left the ACE on disk
      //     forever. MEASURED in the crash matrix.
      //
      // The grant itself is still ownership-checked and only ever removes
      // Abdo's own ACE, so acting here cannot damage a third party.
      // A DUPLICATE release is not the same as a crashed one, even though the
      // ledger state is identical, so the difference has to be recorded rather
      // than inferred: `released` says this run already gave the lease up.
      //
      //   - already released -> idempotent no-op; claiming `mustRevoke` again
      //     would make "release twice" a second revoke decision;
      //   - never a holder, and NOBODY holds it -> this run crashed between
      //     granting and recording its lease, and its ACE must still go.
      //
      // Cleanup does not depend on this flag to remove an orphaned ACE: it skips
      // the restore only when OTHER holders exist, so a released-then-died run is
      // still reclaimed by the normal path.
      const alreadyReleased = cur.released.includes(runId)
      return { mustRevoke: !alreadyReleased && cur.holders.length === 0, holders: cur.holders, wasHolder: false }
    }
    try {
      if (beforeAppend) await beforeAppend()
      await store.append({
        aggregateKind: "project",
        aggregateId: leaseAggregateId(key),
        type: AC.LeaseReleased,
        version: JOURNAL_VERSION,
        data: { runId, key },
        idempotencyKey: `lease-release:${key}:${runId}`,
        expectedSequence: cur.sequence + 1,
      })
      const rest = cur.holders.filter((h) => h !== runId)
      observe?.({ op: "release", key, runId, attempt, expectedSequence: cur.sequence + 1, observedSequence: cur.sequence, outcome: "appended", holders: rest })
      return { mustRevoke: rest.length === 0, holders: rest, wasHolder: true }
    } catch {
      const now = await readHolders(store, key)
      observe?.({ op: "release", key, runId, attempt, expectedSequence: cur.sequence + 1, observedSequence: now.sequence, outcome: "conflict", holders: now.holders })
      await backoff(attempt)
    }
  }
  throw new Error(`lease_contention: could not release ${key} after ${RETRIES} attempts`)
}

export async function leaseHolders(store: EventStore, key: string): Promise<readonly string[]> {
  return (await readHolders(store, key)).holders
}
