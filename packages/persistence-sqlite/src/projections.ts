/**
 * Projections — derived read-models rebuilt from the event log.
 *
 * A projection is never a source of truth; it can be dropped and recomputed by
 * replaying events. Here we fold a session's run-lifecycle events through the
 * SAME state machine used at write time, so replay reconstructs the exact
 * current state. If a terminal event exists, the projection is terminal — this
 * is what guarantees the UI can never show a phantom "running" after a crash.
 */
import type { DomainEvent } from "@abdo/contracts/event"
import { isTerminal, type SessionState } from "@abdo/contracts/state"
import { transition } from "@abdo/contracts/transition"
import type { EventStore } from "@abdo/event-store"

/** Maps a run-lifecycle event type to the state it drives the session into. */
const EVENT_TO_STATE: Record<string, SessionState> = {
  "run.admitted": "input_admitted",
  "run.preparing": "preparing_context",
  "run.calling": "calling_model",
  "run.streaming": "streaming",
  "run.awaiting_permission": "awaiting_permission",
  "run.executing_tool": "executing_tool",
  "run.verifying": "verifying",
  "run.compacting": "compacting",
  "run.paused": "paused",
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
}

export interface SessionView {
  readonly sessionId: string
  readonly state: SessionState
  readonly messageCount: number
  readonly lastSequence: number
  readonly terminal: boolean
}

/** Pure fold: events (in sequence order) -> current session view. */
export function foldSession(sessionId: string, events: readonly DomainEvent[]): SessionView {
  let state: SessionState = "idle"
  let messageCount = 0
  let lastSequence = -1

  for (const event of events) {
    lastSequence = Number(event.sequence)
    if (event.type === "message.appended") {
      messageCount++
      continue
    }
    const target = EVENT_TO_STATE[event.type]
    if (target !== undefined) {
      // transition() throws on an illegal move, so a corrupt log fails loudly.
      state = transition(state, target)
    }
  }

  return { sessionId, state, messageCount, lastSequence, terminal: isTerminal(state) }
}

/** Rebuilds a session view by replaying its log from the store. */
export class SessionProjector {
  constructor(private readonly store: EventStore) {}

  async rebuild(sessionId: string): Promise<SessionView> {
    const events = await this.store.read("session", sessionId)
    return foldSession(sessionId, events)
  }
}
