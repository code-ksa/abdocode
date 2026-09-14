/**
 * Context sources — the keyed, comparable inputs that make up system context.
 *
 * Each source has a STABLE key (e.g. "core/environment", "project/instructions")
 * and produces a value plus a content hash. Stable keys + hashes are what let
 * the epoch diff decide, cheaply, what changed since the last snapshot — so an
 * unchanged source is never re-sent.
 */

export interface ContextValue {
  /** Rendered text that goes into the prompt (empty if the source is data-only). */
  readonly text: string
  /** Optional structured value for consumers that need more than text. */
  readonly data?: unknown
}

export interface ContextSource {
  readonly key: string
  load(): Promise<ContextValue>
}

/** Keys under this prefix are baseline-critical: a change forces a new epoch. */
export const BASELINE_PREFIX = "core/"

export const isBaselineKey = (key: string): boolean => key.startsWith(BASELINE_PREFIX)

/** FNV-1a — small, dependency-free, stable across runs. Not cryptographic. */
export function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/** A fixed source — handy for tests and for values computed once per turn. */
export function staticSource(key: string, text: string, data?: unknown): ContextSource {
  return { key, load: async () => ({ text, data }) }
}
