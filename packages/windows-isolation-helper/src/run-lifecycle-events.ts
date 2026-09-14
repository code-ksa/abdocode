/**
 * CL-16A3 MEGA-1 §4 — the run lifecycle as a CONTRACT, before the driver exists.
 *
 * The law every OS mutation in this system obeys is
 *
 *     durable intent -> mutation -> OS re-inspection -> durable completion
 *
 * and the way that law gets broken is never dramatic: someone adds a stage and
 * emits only its completion, or emits the completion first and the intent after,
 * or ships a run whose journal simply stops mid-sequence. Each leaves a log that
 * READS fine and describes a world that never happened — and recovery believes
 * the log.
 *
 * So the ordering is written down as data and checked as data. This module is
 * pure: it defines the seventeen events, pairs each intent with its completion,
 * and validates a recorded sequence. `run-lifecycle.ts` (the driver) must satisfy
 * it, and a test can hold the driver to it without a machine.
 */

export const RunLifecycle = {
  Requested: "run.requested",
  RootReady: "run.root_ready",
  ScopePlanned: "run.scope_planned",
  GrantsRequested: "run.grants_requested",
  GrantsMutating: "run.grants_mutating",
  GrantsApplied: "run.grants_applied",
  GrantsVerified: "run.grants_verified",
  LaunchRequested: "run.launch_requested",
  ProcessStarted: "run.process_started",
  ProcessObserved: "run.process_observed",
  ProcessExited: "run.process_exited",
  RevocationRequested: "run.revocation_requested",
  RevocationApplied: "run.revocation_applied",
  RevocationVerified: "run.revocation_verified",
  CleanupRequested: "run.cleanup_requested",
  Cleaned: "run.cleaned",
  Completed: "run.completed",
} as const

export type RunLifecycleEvent = (typeof RunLifecycle)[keyof typeof RunLifecycle]

/** The canonical order. A recorded sequence must be a PREFIX of this. */
export const LIFECYCLE_ORDER: readonly RunLifecycleEvent[] = [
  RunLifecycle.Requested,
  RunLifecycle.RootReady,
  RunLifecycle.ScopePlanned,
  RunLifecycle.GrantsRequested,
  RunLifecycle.GrantsMutating,
  RunLifecycle.GrantsApplied,
  RunLifecycle.GrantsVerified,
  RunLifecycle.LaunchRequested,
  RunLifecycle.ProcessStarted,
  RunLifecycle.ProcessObserved,
  RunLifecycle.ProcessExited,
  RunLifecycle.RevocationRequested,
  RunLifecycle.RevocationApplied,
  RunLifecycle.RevocationVerified,
  RunLifecycle.CleanupRequested,
  RunLifecycle.Cleaned,
  RunLifecycle.Completed,
]

/**
 * intent -> completion. A completion without its intent means a side effect was
 * performed that nothing durably asked for, which is the single failure this
 * whole architecture exists to make impossible.
 */
export const INTENT_OF: Readonly<Record<string, RunLifecycleEvent>> = {
  [RunLifecycle.GrantsApplied]: RunLifecycle.GrantsRequested,
  [RunLifecycle.GrantsVerified]: RunLifecycle.GrantsRequested,
  [RunLifecycle.ProcessStarted]: RunLifecycle.LaunchRequested,
  [RunLifecycle.RevocationApplied]: RunLifecycle.RevocationRequested,
  [RunLifecycle.RevocationVerified]: RunLifecycle.RevocationRequested,
  [RunLifecycle.Cleaned]: RunLifecycle.CleanupRequested,
}

/**
 * Stages after which a crash leaves REAL OS STATE that recovery must reclaim.
 * Recorded here so the crash matrix cannot silently stop covering one.
 */
export const MUTATING_STAGES: readonly RunLifecycleEvent[] = [
  RunLifecycle.RootReady,
  RunLifecycle.GrantsMutating,
  RunLifecycle.GrantsApplied,
  RunLifecycle.ProcessStarted,
  RunLifecycle.RevocationApplied,
  RunLifecycle.Cleaned,
]

export type SequenceVerdict = { readonly ok: true; readonly complete: boolean } | { readonly ok: false; readonly problems: readonly string[] }

/**
 * Is this recorded sequence a legal run?
 *
 * A legal sequence is an in-order PREFIX of `LIFECYCLE_ORDER` with no repeats and
 * no completion whose intent is absent. A prefix is legal because a crash is
 * legal — a run that died after `grants_applied` recorded the truth. What is
 * never legal is a gap, a reorder, or a completion nobody asked for.
 */
export function validateLifecycleSequence(events: readonly string[]): SequenceVerdict {
  const problems: string[] = []
  const seen = new Set<string>()
  let cursor = 0

  for (const [i, e] of events.entries()) {
    if (!LIFECYCLE_ORDER.includes(e as RunLifecycleEvent)) {
      problems.push(`unknown event at ${i}: ${e}`)
      continue
    }
    if (seen.has(e)) {
      problems.push(`duplicate ${e} at ${i}`)
      continue
    }
    const expectedAt = LIFECYCLE_ORDER.indexOf(e as RunLifecycleEvent)
    if (expectedAt < cursor) {
      problems.push(`out of order: ${e} at ${i} follows a later stage`)
    } else if (expectedAt > cursor) {
      // A GAP is not "not yet reached" — the sequence jumped a stage, so a
      // mutation happened whose bracket is missing from the log.
      for (let k = cursor; k < expectedAt; k++) problems.push(`skipped ${LIFECYCLE_ORDER[k]} before ${e}`)
    }
    cursor = expectedAt + 1
    seen.add(e)
  }

  for (const e of events) {
    const intent = INTENT_OF[e]
    if (intent && !events.includes(intent)) problems.push(`${e} recorded without its intent ${intent}`)
  }

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, complete: events.length === LIFECYCLE_ORDER.length && events[events.length - 1] === RunLifecycle.Completed }
}

/** Where a sequence stopped, and whether OS state is expected to survive it. */
export function crashResidueExpected(events: readonly string[]): { stoppedAfter: string | undefined; osStateExpected: boolean } {
  const last = events.length > 0 ? events[events.length - 1] : undefined
  if (last === RunLifecycle.Completed) return { stoppedAfter: last, osStateExpected: false }
  const reachedMutating = MUTATING_STAGES.some((m) => events.includes(m))
  return { stoppedAfter: last, osStateExpected: reachedMutating }
}
