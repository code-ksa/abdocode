/**
 * Session isolation (Sprint 70).
 *
 * Two tasks for two different users must not see each other's session. That is
 * obvious as a sentence and easy to violate in practice, because the default
 * everywhere is one browser profile: the second task opens a tab in the same
 * context and is logged in as the first user. Nothing errors. The agent then
 * does the right work on the wrong account, which is the worst available
 * outcome — a mistake that succeeds.
 *
 * So a session key is (user, project) and a context is never shared across one.
 * The rule is enforced by construction rather than by discipline: `keyOf`
 * produces the key, `contextFor` refuses to hand back a context belonging to a
 * different key, and there is no API that returns "the current context".
 */
import type { SessionSnapshot, StorageState } from "./provider"

export interface SessionKey {
  readonly userId: string
  readonly projectId: string
}

export const keyOf = (key: SessionKey): string => `${key.userId}::${key.projectId}`

export interface SessionRecord {
  readonly key: string
  readonly userId: string
  readonly projectId: string
  readonly contextId: string
  readonly createdAt: number
  readonly snapshot?: SessionSnapshot
}

export type ContextResult =
  | { readonly kind: "context"; readonly record: SessionRecord; readonly fresh: boolean }
  | { readonly kind: "refused"; readonly why: string }

/**
 * One browser context per (user, project), and never a shared one.
 *
 * `contextFor` is the only way to obtain a context, and it takes the key. There
 * is deliberately no `currentContext()`: a function that returns "the one we
 * were using" is a function that returns the previous user's session the moment
 * two tasks interleave.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>()

  constructor(private readonly now: () => number = Date.now) {}

  contextFor(key: SessionKey, makeContextId: () => string): ContextResult {
    if (key.userId.trim().length === 0 || key.projectId.trim().length === 0)
      return {
        kind: "refused",
        why: "a session needs both a user and a project — an empty half would collapse two users into one key, which is exactly the failure this exists to stop",
      }

    const id = keyOf(key)
    const existing = this.sessions.get(id)
    if (existing !== undefined) return { kind: "context", record: existing, fresh: false }

    const record: SessionRecord = {
      key: id,
      userId: key.userId,
      projectId: key.projectId,
      contextId: makeContextId(),
      createdAt: this.now(),
    }
    this.sessions.set(id, record)
    return { kind: "context", record, fresh: true }
  }

  /** Attach a restorable snapshot to a session (Sprint 61's capture). */
  remember(key: SessionKey, snapshot: SessionSnapshot): void {
    const record = this.sessions.get(keyOf(key))
    if (record === undefined) return
    this.sessions.set(record.key, { ...record, snapshot })
  }

  /**
   * The storage a crashed session should be restored with.
   *
   * Returns undefined rather than an empty state, because an empty storage
   * state restores successfully and leaves the agent logged out while believing
   * it recovered.
   */
  storageFor(key: SessionKey): StorageState | undefined {
    return this.sessions.get(keyOf(key))?.snapshot?.storage
  }

  /**
   * Prove two sessions are isolated.
   *
   * A function rather than a comment because this is the property the gate
   * checks: different contexts, and no cookie value in common. Comparing cookie
   * VALUES catches the case the context id alone would miss — two contexts that
   * were seeded from the same storage state.
   */
  isolated(a: SessionKey, b: SessionKey): { isolated: boolean; why: string } {
    const first = this.sessions.get(keyOf(a))
    const second = this.sessions.get(keyOf(b))
    if (first === undefined || second === undefined)
      return { isolated: true, why: "one of the sessions does not exist, so nothing is shared" }

    if (first.contextId === second.contextId)
      return { isolated: false, why: `both sessions use context ${first.contextId} — the second user is browsing as the first` }

    const firstCookies = new Set((first.snapshot?.storage.cookies ?? []).map((c) => `${c.name}=${c.value}`))
    const shared = (second.snapshot?.storage.cookies ?? []).filter((c) => firstCookies.has(`${c.name}=${c.value}`))
    if (shared.length > 0)
      return {
        isolated: false,
        why: `${shared.length} cookie value(s) are identical across the two sessions (${shared.map((c) => c.name).join(", ")}) — separate contexts seeded from one storage state are not separate sessions`,
      }

    return { isolated: true, why: "different contexts and no shared cookie values" }
  }

  all(): readonly SessionRecord[] {
    return [...this.sessions.values()]
  }
}
