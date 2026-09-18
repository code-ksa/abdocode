/**
 * Slice 2 — state machine enforcement.
 *
 * A single choke point every state change must pass through. Illegal moves
 * raise a typed `IllegalTransitionError` instead of silently corrupting a run.
 * Kept separate from `state.ts` so the pure transition data has no error dep.
 */
import { IllegalTransitionError } from "./error"
import { canTransition, isTerminal, type SessionState } from "./state"

/** Assert `from -> to` is legal, else throw. Returns `to` for fluent use. */
export function assertTransition(from: SessionState, to: SessionState): SessionState {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError({ from, to })
  }
  return to
}

/**
 * Apply a transition, treating a no-op on a terminal state as already-done
 * (idempotent), so a duplicate `complete` after a crash-recovery replay is safe
 * rather than an error.
 */
export function transition(from: SessionState, to: SessionState): SessionState {
  if (from === to && isTerminal(from)) return from
  return assertTransition(from, to)
}
