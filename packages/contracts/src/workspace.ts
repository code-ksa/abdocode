/**
 * Workspace isolation (Sprint 28) — one tree per agent, and a merge that has to
 * be earned.
 *
 * Parallel agents in one working tree do not "occasionally conflict"; they
 * corrupt each other's evidence. Agent B's test run measures a file agent A was
 * halfway through writing, and the receipt that comes out is honest about a
 * state neither of them chose. Every guarantee this program has built — the
 * checkpoint, the diff in the evidence packet, the reconciliation against the
 * real repo — assumes the tree belonged to the run that changed it.
 *
 * So each agent gets a real git worktree at the same base commit, and the
 * shared tree is written to by nobody until an INTEGRATION step. Two rules
 * govern that step:
 *
 *   1. Nothing integrates without a verification verdict (Sprint 27). An
 *      unverified branch merged into the trunk is a fake completion that has
 *      spread.
 *   2. Overlapping edits are REPORTED, never resolved. Two agents that changed
 *      the same file did not agree, and picking one automatically is guessing
 *      about intent — the failure mode that produces a merge nobody wrote.
 *
 * A workspace whose agent FAILED is abandoned, not deleted. The tree is the
 * evidence, and deleting the evidence of a failure is how the same failure
 * happens again next week.
 */
import type { DomainEvent } from "./event"

export const WorkspaceEventTypes = {
  Acquired: "workspace.acquired",
  Released: "workspace.released",
  Abandoned: "workspace.abandoned",
  Integrated: "workspace.integrated",
  IntegrationRefused: "workspace.integration_refused",
} as const

export type WorkspaceState = "active" | "released" | "abandoned" | "integrated"

export interface WorkspaceRecord {
  readonly workspaceId: string
  readonly agentId: string
  readonly dir: string
  readonly baseRef: string
  readonly state: WorkspaceState
  readonly acquiredAt: number
  readonly closedAt?: number
  /** Why it was abandoned — the sentence a diagnosis starts from. */
  readonly abandonReason?: string
  /** Paths the workspace changed, as git reported them at close. */
  readonly changed: readonly string[]
}

/** What an agent is asking to bring into the shared tree. */
export interface IntegrationClaim {
  readonly workspaceId: string
  readonly agentId: string
  readonly changed: readonly string[]
  /** The Sprint 27 verdict for this agent's work, if any was recorded. */
  readonly verified: boolean
  readonly verdictReason?: string
}

export type IntegrationDecision = "integrate" | "refuse"

export interface IntegrationPlan {
  readonly decision: IntegrationDecision
  /** Claims cleared to apply, in the order they should be applied. */
  readonly order: readonly string[]
  /** path -> the workspaces that all touched it. */
  readonly conflicts: readonly { readonly path: string; readonly workspaces: readonly string[] }[]
  /** Claims refused, and why — one entry per refused workspace. */
  readonly refused: readonly { readonly workspaceId: string; readonly why: string }[]
  readonly reason: string
}

/**
 * Decide what may be integrated.
 *
 * Deliberately total and deliberately boring: it never merges, never rewrites a
 * path, never picks a winner. It says which claims are entitled to apply and
 * which pairs of agents have to be told they disagreed.
 *
 * Unverified claims are dropped BEFORE conflict detection, because a conflict
 * with work that was never going to be integrated is not a conflict anyone
 * needs to hear about.
 */
export function planIntegration(claims: readonly IntegrationClaim[]): IntegrationPlan {
  const refused: { workspaceId: string; why: string }[] = []
  const eligible: IntegrationClaim[] = []

  for (const claim of claims) {
    if (!claim.verified) {
      refused.push({
        workspaceId: claim.workspaceId,
        why: claim.verdictReason ?? "no verification verdict — unverified work does not enter the shared tree",
      })
      continue
    }
    if (claim.changed.length === 0) {
      // Not a failure: an agent that changed nothing has nothing to integrate,
      // and saying so is more useful than an empty success.
      refused.push({ workspaceId: claim.workspaceId, why: "the workspace changed no files" })
      continue
    }
    eligible.push(claim)
  }

  const owners = new Map<string, string[]>()
  for (const claim of eligible) {
    for (const path of claim.changed) {
      const list = owners.get(path) ?? []
      list.push(claim.workspaceId)
      owners.set(path, list)
    }
  }

  const conflicts = [...owners.entries()]
    .filter(([, workspaces]) => workspaces.length > 1)
    .map(([path, workspaces]) => ({ path, workspaces: [...new Set(workspaces)].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path))

  if (conflicts.length > 0) {
    return {
      decision: "refuse",
      order: [],
      conflicts,
      refused,
      reason:
        `${conflicts.length} path(s) were changed by more than one agent — ` +
        `${conflicts.map((c) => `${c.path} (${c.workspaces.join(", ")})`).join("; ")}. ` +
        `Two agents that edited the same file did not agree, and choosing between them is not integration.`,
    }
  }

  if (eligible.length === 0) {
    return { decision: "refuse", order: [], conflicts, refused, reason: "nothing was eligible to integrate" }
  }

  return {
    decision: "integrate",
    // stable order, so the same set of claims always applies the same way
    order: eligible.map((c) => c.workspaceId).sort(),
    conflicts,
    refused,
    reason: `${eligible.length} verified workspace(s), no overlapping paths`,
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])

interface Draft {
  workspaceId: string
  agentId: string
  dir: string
  baseRef: string
  state: WorkspaceState
  acquiredAt: number
  closedAt?: number
  abandonReason?: string
  changed: string[]
}

/** Fold every workspace in a log. */
export function foldWorkspaces(events: readonly DomainEvent[]): WorkspaceRecord[] {
  const drafts = new Map<string, Draft>()

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>
    const workspaceId = str(data.workspaceId)
    if (workspaceId === undefined) continue
    const at = event.occurredAt

    switch (event.type) {
      case WorkspaceEventTypes.Acquired:
        drafts.set(workspaceId, {
          workspaceId,
          agentId: str(data.agentId) ?? "",
          dir: str(data.dir) ?? "",
          baseRef: str(data.baseRef) ?? "",
          state: "active",
          acquiredAt: at,
          changed: [],
        })
        break
      case WorkspaceEventTypes.Released: {
        const draft = drafts.get(workspaceId)
        if (draft === undefined) break
        draft.state = "released"
        draft.closedAt = at
        draft.changed = strings(data.changed)
        break
      }
      case WorkspaceEventTypes.Abandoned: {
        const draft = drafts.get(workspaceId)
        if (draft === undefined) break
        draft.state = "abandoned"
        draft.closedAt = at
        draft.abandonReason = str(data.reason)
        draft.changed = strings(data.changed)
        break
      }
      case WorkspaceEventTypes.Integrated: {
        const draft = drafts.get(workspaceId)
        if (draft === undefined) break
        draft.state = "integrated"
        draft.closedAt = at
        break
      }
    }
  }

  return [...drafts.values()].map((d) => ({
    workspaceId: d.workspaceId,
    agentId: d.agentId,
    dir: d.dir,
    baseRef: d.baseRef,
    state: d.state,
    acquiredAt: d.acquiredAt,
    ...(d.closedAt !== undefined ? { closedAt: d.closedAt } : {}),
    ...(d.abandonReason !== undefined ? { abandonReason: d.abandonReason } : {}),
    changed: d.changed,
  }))
}

/**
 * Workspaces still on disk that nobody is using.
 *
 * Abandoned trees are kept ON PURPOSE, so they accumulate, and a list nobody
 * can produce is a disk that fills up silently. This is the list.
 */
export const abandonedWorkspaces = (events: readonly DomainEvent[]): WorkspaceRecord[] =>
  foldWorkspaces(events).filter((w) => w.state === "abandoned")
