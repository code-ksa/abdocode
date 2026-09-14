/**
 * EventSourcedReconciler — maintains the context epoch in the event log.
 *
 * On each reconcile it loads current sources, reconstructs the last snapshot
 * from context events, and diffs:
 *   - no change            -> emit nothing (no context churn)
 *   - compatible change    -> append `context.update` with the delta
 *   - core/* change or any
 *     removal              -> append a fresh `context.baseline` (new epoch)
 *
 * Structurally satisfies @abdo/session-runtime's ContextReconciler port
 * (`reconcile(sessionId): Promise<void>`), so the runtime can use it directly.
 */
import { Id } from "@abdo/contracts"
import type { EventStore } from "@abdo/event-store"
import { buildSnapshot, diffSnapshots, isEmptyDelta, requiresNewBaseline, type Snapshot, type SnapshotEntry } from "./snapshot"
import type { ContextSource } from "./sources"

export const ContextEventTypes = {
  Baseline: "context.baseline",
  Update: "context.update",
} as const

type SourcesFor = (sessionId: string) => readonly ContextSource[] | Promise<readonly ContextSource[]>

interface KeyHash {
  readonly key: string
  readonly hash: string
}

export class EventSourcedReconciler {
  constructor(
    private readonly store: EventStore,
    private readonly sourcesFor: SourcesFor,
  ) {}

  async reconcile(sessionId: string): Promise<void> {
    const sources = await this.sourcesFor(sessionId)
    const next = await buildSnapshot(sources)
    const current = await this.snapshotFor(sessionId)
    const delta = diffSnapshots(current, next)

    if (isEmptyDelta(delta)) return // unchanged — send nothing new

    const isFirst = Object.keys(current).length === 0
    if (isFirst || requiresNewBaseline(delta)) {
      await this.store.append({
        aggregateKind: "session",
        aggregateId: sessionId,
        type: ContextEventTypes.Baseline,
        data: {
          checkpointId: Id.CheckpointID.create(),
          sources: toKeyHash(next),
        },
      })
      return
    }

    await this.store.append({
      aggregateKind: "session",
      aggregateId: sessionId,
      type: ContextEventTypes.Update,
      data: {
        added: delta.added.map((key) => ({ key, hash: next[key]!.hash })),
        changed: delta.changed.map((key) => ({ key, hash: next[key]!.hash })),
        removed: delta.removed,
      },
    })
  }

  /** Reconstruct the current snapshot by folding context events. */
  async snapshotFor(sessionId: string): Promise<Snapshot> {
    const events = await this.store.read("session", sessionId)
    const snap: Record<string, SnapshotEntry> = {}
    for (const event of events) {
      if (event.type === ContextEventTypes.Baseline) {
        for (const key of Object.keys(snap)) delete snap[key]
        const data = event.data as { sources: KeyHash[] }
        for (const s of data.sources) snap[s.key] = { hash: s.hash, text: "" }
      } else if (event.type === ContextEventTypes.Update) {
        const data = event.data as { added: KeyHash[]; changed: KeyHash[]; removed: string[] }
        for (const s of [...data.added, ...data.changed]) snap[s.key] = { hash: s.hash, text: "" }
        for (const key of data.removed) delete snap[key]
      }
    }
    return snap
  }
}

function toKeyHash(snapshot: Snapshot): KeyHash[] {
  return Object.entries(snapshot).map(([key, entry]) => ({ key, hash: entry.hash }))
}
