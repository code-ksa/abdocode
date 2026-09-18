/**
 * Snapshots and deltas — the epoch machinery.
 *
 * A snapshot is `key -> {hash, text}`. Diffing two snapshots yields added /
 * changed / removed keys. A change to a baseline-critical (`core/`) key, or any
 * removal, is "incompatible" and forces a fresh baseline epoch; everything else
 * is an incremental update appended to the current epoch.
 */
import { hash, isBaselineKey, type ContextSource } from "./sources"

export interface SnapshotEntry {
  readonly hash: string
  readonly text: string
}

export type Snapshot = Readonly<Record<string, SnapshotEntry>>

export interface SnapshotDelta {
  readonly added: string[]
  readonly changed: string[]
  readonly removed: string[]
}

export const EMPTY_SNAPSHOT: Snapshot = {}

/** Load all sources into a snapshot (keys stay sorted for determinism). */
export async function buildSnapshot(sources: readonly ContextSource[]): Promise<Snapshot> {
  const entries: Record<string, SnapshotEntry> = {}
  for (const source of [...sources].sort((a, b) => a.key.localeCompare(b.key))) {
    const value = await source.load()
    entries[source.key] = { hash: hash(value.text), text: value.text }
  }
  return entries
}

export function diffSnapshots(previous: Snapshot, next: Snapshot): SnapshotDelta {
  const added: string[] = []
  const changed: string[] = []
  const removed: string[] = []
  for (const key of Object.keys(next)) {
    if (!(key in previous)) added.push(key)
    else if (previous[key]!.hash !== next[key]!.hash) changed.push(key)
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) removed.push(key)
  }
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() }
}

export const isEmptyDelta = (d: SnapshotDelta): boolean =>
  d.added.length === 0 && d.changed.length === 0 && d.removed.length === 0

/** A delta needs a brand-new baseline if it removes anything or touches core/*. */
export function requiresNewBaseline(delta: SnapshotDelta): boolean {
  if (delta.removed.length > 0) return true
  return [...delta.added, ...delta.changed].some(isBaselineKey)
}
