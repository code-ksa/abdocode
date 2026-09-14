/**
 * Repository reconciliation (Sprint 24) — resume against reality, not against
 * our own record of it.
 *
 * Recovery already reconciles the LOG: it finds the runs that never reached a
 * terminal event and decides what to do about them. But the log is our account
 * of the world, and between two sessions the world moves without us — someone
 * edits a file, switches a branch, commits, reverts, or pulls. A resume that
 * trusts the ledger alone will happily continue a sprint on top of a tree that
 * no longer matches what the sprint was working on.
 *
 * So this compares the two and REPORTS the difference. It does not resolve it.
 * A divergence is a fact for a human or a policy to act on; guessing which side
 * is right — silently discarding a manual fix, or silently redoing work that is
 * already committed — is exactly the class of damage this program refuses to
 * risk.
 */

export interface RepoFacts {
  /** Full commit hash of HEAD. */
  readonly head: string
  /** Branch name, or undefined when detached. */
  readonly branch?: string
  readonly detached: boolean
  /** Paths with uncommitted modifications (tracked). */
  readonly modified: readonly string[]
  /** Paths git does not track. */
  readonly untracked: readonly string[]
  /** True when anything at all is uncommitted. */
  readonly dirty: boolean
  /** When the facts could not be read — the repo is a blind spot, not clean. */
  readonly unreadable?: string
}

export interface LedgerClaims {
  /** The commit the ledger believes the work is standing on. */
  readonly lastCommit?: string
  readonly branch?: string
  /** Files the ledger recorded this work as having changed. */
  readonly changedFiles?: readonly string[]
  /** Whether the ledger believes the tree was clean when it stopped. */
  readonly expectedClean?: boolean
}

export type DivergenceKind =
  /** HEAD is not where the ledger left it. */
  | "commit_moved"
  /** A different branch is checked out. */
  | "branch_changed"
  /** Uncommitted changes exist that the ledger did not expect. */
  | "unexpected_dirty"
  /** A file changed on disk that no run claims to have touched. */
  | "unclaimed_change"
  /** The ledger claims a change that the repository does not show. */
  | "claimed_change_absent"
  /** The repository could not be read at all. */
  | "repository_unreadable"

export interface Divergence {
  readonly kind: DivergenceKind
  readonly detail: string
  /** The specific paths or hashes involved, for a human to look at. */
  readonly subjects?: readonly string[]
}

export interface ReconciliationResult {
  readonly status: "aligned" | "divergent" | "unknown"
  readonly divergences: readonly Divergence[]
  readonly facts: RepoFacts
  readonly at: number
}

/**
 * Compare what the ledger claims with what the repository shows.
 *
 * A claim the ledger never made is not a divergence: absent expectations are
 * absent, not violated. That matters because most sprints will not claim a
 * commit or a file list, and a reconciler that invented expectations would
 * report divergence on every ordinary resume and be switched off within a week.
 */
export function reconcile(claims: LedgerClaims, facts: RepoFacts, at = 0): ReconciliationResult {
  if (facts.unreadable !== undefined) {
    return {
      status: "unknown",
      divergences: [{ kind: "repository_unreadable", detail: facts.unreadable }],
      facts,
      at,
    }
  }

  const divergences: Divergence[] = []

  if (claims.lastCommit !== undefined && claims.lastCommit !== facts.head) {
    divergences.push({
      kind: "commit_moved",
      detail: `the ledger stopped at ${claims.lastCommit.slice(0, 12)}, HEAD is ${facts.head.slice(0, 12)}`,
      subjects: [claims.lastCommit, facts.head],
    })
  }

  if (claims.branch !== undefined && claims.branch !== facts.branch) {
    divergences.push({
      kind: "branch_changed",
      detail: `the ledger was on ${claims.branch}, the repository is on ${facts.branch ?? "a detached HEAD"}`,
      ...(facts.branch !== undefined ? { subjects: [claims.branch, facts.branch] } : { subjects: [claims.branch] }),
    })
  }

  const dirtyPaths = [...facts.modified, ...facts.untracked]
  if (claims.expectedClean === true && facts.dirty) {
    divergences.push({
      kind: "unexpected_dirty",
      detail: `the ledger expected a clean tree; ${dirtyPaths.length} path(s) are uncommitted`,
      subjects: dirtyPaths,
    })
  }

  if (claims.changedFiles !== undefined) {
    const claimed = new Set(claims.changedFiles)
    const unclaimed = facts.modified.filter((f) => !claimed.has(f))
    if (unclaimed.length > 0) {
      divergences.push({
        kind: "unclaimed_change",
        detail: `${unclaimed.length} file(s) changed that no run claims to have touched`,
        subjects: unclaimed,
      })
    }
    // A claimed file that is neither modified nor committed away is a claim the
    // repository cannot support. It is reported, not explained away: it may be
    // a committed change, or it may be work that was reverted.
    const present = new Set([...facts.modified, ...facts.untracked])
    const absent = claims.changedFiles.filter((f) => !present.has(f))
    if (absent.length > 0 && claims.lastCommit === facts.head) {
      divergences.push({
        kind: "claimed_change_absent",
        detail: `${absent.length} claimed change(s) are not present, and HEAD has not moved to explain them`,
        subjects: absent,
      })
    }
  }

  return { status: divergences.length === 0 ? "aligned" : "divergent", divergences, facts, at }
}

/**
 * May work resume on this repository?
 *
 * A divergence blocks by default. `acknowledged` is the explicit human or policy
 * decision that lets it through, and it is required to carry a reason — an
 * override with no stated reason is indistinguishable from not having noticed.
 */
export function resumeDecision(
  result: ReconciliationResult,
  acknowledged?: { readonly reason: string },
): { readonly allowed: boolean; readonly why: string } {
  if (result.status === "aligned") return { allowed: true, why: "the repository matches the ledger" }
  const summary = result.divergences.map((d) => d.kind).join(", ")
  if (acknowledged !== undefined && acknowledged.reason.trim().length > 0) {
    return { allowed: true, why: `divergence acknowledged (${summary}): ${acknowledged.reason}` }
  }
  return {
    allowed: false,
    why:
      result.status === "unknown"
        ? `the repository could not be read (${summary}) — resuming would be working blind`
        : `the repository diverges from the ledger (${summary}) and nobody has said which is right`,
  }
}
