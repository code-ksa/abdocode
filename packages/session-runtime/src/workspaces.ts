/**
 * The workspace manager (Sprint 28) — real git worktrees, one per agent.
 *
 * The executor is INJECTED, as it has been since Sprint 24: nothing in this
 * file spawns anything, which keeps process execution behind the enforcement
 * point and — the reason the rule exists — lets the gate run this against a
 * real repository with three real agents rather than a simulation of one.
 *
 * The two decisions worth arguing about are both here:
 *
 *   - a FAILED workspace is abandoned, not removed. The tree is the evidence,
 *     and a failure whose evidence was cleaned up is a failure that will happen
 *     again. `abandonedWorkspaces()` exists so that the cost of keeping them is
 *     a list somebody can act on rather than a disk that quietly fills.
 *   - integration is a separate step with its own refusal. An agent finishing
 *     is not an agent's work being wanted.
 */
import {
  WorkspaceEventTypes,
  abandonedWorkspaces,
  foldWorkspaces,
  planIntegration,
  type IntegrationClaim,
  type IntegrationPlan,
  type WorkspaceRecord,
} from "@abdo/contracts/workspace"
import type { EventStore } from "@abdo/event-store"

export interface WorkspaceExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs argv in a directory. Supplied by the caller; nothing here spawns. */
export type WorkspaceExec = (argv: readonly string[], cwd: string) => Promise<WorkspaceExecResult>

export interface WorkspaceManagerOptions {
  readonly store: EventStore
  /** Workspaces belong to the mission whose work they hold. */
  readonly missionId: string
  readonly repoRoot: string
  readonly exec: WorkspaceExec
  /** Where the worktrees go. Outside the repo, so the parent never sees them. */
  readonly root: string
  readonly now?: () => number
}

export interface AcquiredWorkspace {
  readonly workspaceId: string
  readonly agentId: string
  readonly dir: string
  readonly baseRef: string
}

/**
 * Paths a worktree has changed, tracked and untracked.
 *
 * `-uall` lists untracked FILES rather than collapsing them into their
 * directory, so a new file inside a new folder is visible; renames record the
 * destination. Both details have bitten this repo before.
 */
export function parseChanged(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .map((l) => l.slice(3).trim())
    .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1]!.trim() : p))
    .map((p) => p.replace(/^"(.*)"$/, "$1"))
}

export class WorkspaceManager {
  private readonly dirs = new Map<string, string>()
  /**
   * Workspace ids used to be agent + timestamp. Two acquisitions by the same
   * agent inside one millisecond produced the SAME id and the same directory,
   * and the second `git worktree add` failed on a path that already existed —
   * the identical tie S26 hit with plan approvals, in a place where the
   * consequence is two agents pointed at one tree. A counter cannot tie.
   */
  private sequence = 0

  constructor(private readonly options: WorkspaceManagerOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private append(type: string, data: Record<string, unknown>): Promise<unknown> {
    return this.options.store.append({
      aggregateKind: "mission",
      aggregateId: this.options.missionId,
      type,
      data: { missionId: this.options.missionId, ...data },
    })
  }

  /**
   * Give an agent its own tree at `baseRef`.
   *
   * Detached on purpose: a branch is shared state, and two agents that both
   * check out the same branch have re-created the problem this sprint exists
   * to remove.
   */
  async acquire(agentId: string, baseRef = "HEAD"): Promise<AcquiredWorkspace> {
    const workspaceId = `ws_${agentId}_${this.now().toString(36)}_${++this.sequence}`
    const dir = `${this.options.root}/${workspaceId}`
    const result = await this.options.exec(["git", "worktree", "add", "--detach", dir, baseRef], this.options.repoRoot)
    if (result.code !== 0) {
      throw new Error(`could not create a workspace for ${agentId}: ${result.stderr.trim().slice(0, 300)}`)
    }
    this.dirs.set(workspaceId, dir)
    await this.append(WorkspaceEventTypes.Acquired, { workspaceId, agentId, dir, baseRef })
    return { workspaceId, agentId, dir, baseRef }
  }

  /** What this workspace changed, straight from git. */
  async changed(workspaceId: string): Promise<string[]> {
    const dir = this.dirs.get(workspaceId)
    if (dir === undefined) return []
    const result = await this.options.exec(["git", "status", "--porcelain", "-uall"], dir)
    return result.code === 0 ? parseChanged(result.stdout) : []
  }

  /** Work finished. The tree is recorded, then removed. */
  async release(workspaceId: string): Promise<string[]> {
    const dir = this.dirs.get(workspaceId)
    const changed = await this.changed(workspaceId)
    await this.append(WorkspaceEventTypes.Released, { workspaceId, changed })
    if (dir !== undefined) {
      await this.options.exec(["git", "worktree", "remove", "--force", dir], this.options.repoRoot)
      this.dirs.delete(workspaceId)
    }
    return changed
  }

  /**
   * Work failed. The tree STAYS.
   *
   * Removing it would make the next run of the same failure start from nothing
   * — no half-written file to look at, no partial diff, only a log line saying
   * something went wrong. The disk cost is real and is paid deliberately.
   */
  async abandon(workspaceId: string, reason: string): Promise<void> {
    const changed = await this.changed(workspaceId)
    await this.append(WorkspaceEventTypes.Abandoned, { workspaceId, reason, changed })
    this.dirs.delete(workspaceId)
  }

  /**
   * Bring finished work into the shared tree — or say why not.
   *
   * The decision is made by `planIntegration` over claims; this only records it
   * and reports. Nothing merges, and a refusal is written down with the paths
   * that caused it, because "integration failed" without the overlapping file
   * is a message nobody can act on.
   */
  async integrate(claims: readonly IntegrationClaim[]): Promise<IntegrationPlan> {
    const plan = planIntegration(claims)
    if (plan.decision === "refuse") {
      await this.append(WorkspaceEventTypes.IntegrationRefused, {
        workspaceId: claims[0]?.workspaceId ?? "none",
        reason: plan.reason,
        conflicts: plan.conflicts,
        refused: plan.refused,
      })
      return plan
    }
    for (const workspaceId of plan.order) {
      await this.append(WorkspaceEventTypes.Integrated, { workspaceId, reason: plan.reason })
    }
    return plan
  }

  async workspaces(): Promise<WorkspaceRecord[]> {
    return foldWorkspaces(await this.options.store.read("mission", this.options.missionId))
  }

  /** The trees still on disk that nobody is using — kept on purpose, listed on purpose. */
  async abandoned(): Promise<WorkspaceRecord[]> {
    return abandonedWorkspaces(await this.options.store.read("mission", this.options.missionId))
  }
}

export { planIntegration }
