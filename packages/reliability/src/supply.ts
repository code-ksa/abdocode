/**
 * Git safety (Sprint 51) and the package-manager broker (Sprint 52).
 *
 * The git rule is one sentence: a destructive operation is preceded by a backup
 * that has been RESTORED FROM, not merely created. Every backup system that has
 * ever failed failed at restore, and a backup nobody has restored is a belief.
 * Here the proof is cheap — the backup ref is resolved and its tree compared —
 * so there is no excuse for the belief.
 *
 * The package rule is smaller and hits more often: installing with the wrong
 * manager in a repository that has a lockfile for a different one. It does not
 * error. It writes a second lockfile, resolves different versions, and the
 * build that breaks is somebody else's, tomorrow. Lifecycle scripts get the
 * same treatment for a worse reason: `postinstall` is arbitrary code from a
 * package the agent chose, and running it silently is the supply-chain hole
 * everyone knows about and nobody gates.
 */

export type GitOperation =
  // non-destructive, listed so the safe path is a real value and not a cast
  | "commit"
  | "fetch"
  | "status"
  | "stash_push"
  // destructive
  | "reset_hard"
  | "clean"
  | "checkout_force"
  | "branch_delete"
  | "rebase"
  | "push_force"
  | "stash_drop"
  | "filter_branch"

export const DESTRUCTIVE_GIT: readonly GitOperation[] = [
  "reset_hard",
  "clean",
  "checkout_force",
  "branch_delete",
  "rebase",
  "push_force",
  "stash_drop",
  "filter_branch",
]

export interface BackupRef {
  /** Where the state went: a ref, a stash, a bundle path. */
  readonly ref: string
  readonly kind: "ref" | "stash" | "bundle"
  /** The commit the working state corresponds to. */
  readonly commit: string
  /** Tree hash at backup time — what a restore must reproduce. */
  readonly tree: string
  readonly createdAt: number
}

export interface RestoreProof {
  readonly ref: string
  /** The tree hash actually produced by reading the backup back. */
  readonly restoredTree: string
  readonly at: number
}

export interface GitSafetyVerdict {
  readonly allowed: boolean
  readonly why: string
  readonly requiresBackup: boolean
}

/**
 * May this git operation run?
 *
 * The three refusals, in the order they bite:
 *
 *   no backup            the obvious one.
 *   backup not restored  the one that matters. A ref that was created and
 *                        never read back is a ref that might point at nothing;
 *                        this is the failure mode of every backup system.
 *   restore mismatch     the backup exists, was read, and produced a DIFFERENT
 *                        tree. That is worse than no backup, because somebody
 *                        would have trusted it.
 */
export function checkGitSafety(
  operation: GitOperation,
  backup: BackupRef | undefined,
  proof: RestoreProof | undefined,
): GitSafetyVerdict {
  const requiresBackup = DESTRUCTIVE_GIT.includes(operation)
  if (!requiresBackup) return { allowed: true, why: `${operation} destroys nothing`, requiresBackup }

  if (backup === undefined)
    return { allowed: false, requiresBackup, why: `${operation} destroys work and no backup was taken` }

  if (proof === undefined)
    return {
      allowed: false,
      requiresBackup,
      why: `a backup exists at ${backup.ref} but nothing has been restored from it — a backup nobody has read back is a belief, and that is where every backup system fails`,
    }

  // RED TEAM S59 FINDING. A proof from BEFORE the backup was accepted, which
  // is a real attack and an even likelier accident: restore an old backup,
  // keep the proof, take a fresh backup of the already-damaged state, and
  // present the stale proof. The trees can coincide; the order cannot.
  if (proof.at < backup.createdAt)
    return {
      allowed: false,
      requiresBackup,
      why: `the restore proof is dated before the backup it claims to verify (proof ${proof.at} < backup ${backup.createdAt}) — a proof that predates its backup proves the restore of something else`,
    }

  if (proof.ref !== backup.ref)
    return { allowed: false, requiresBackup, why: `the restore proof is for ${proof.ref}, not ${backup.ref}` }

  if (proof.restoredTree !== backup.tree)
    return {
      allowed: false,
      requiresBackup,
      why: `restoring ${backup.ref} produced tree ${proof.restoredTree.slice(0, 12)} but the backup recorded ${backup.tree.slice(0, 12)} — a backup that restores to something else is worse than none, because somebody would have trusted it`,
    }

  return { allowed: true, requiresBackup, why: `${backup.kind} ${backup.ref} restored and verified at tree ${backup.tree.slice(0, 12)}` }
}

// --------------------------------------------------------------------------
// Sprint 52 — package manager broker
// --------------------------------------------------------------------------

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm"

/** Lockfile -> manager. Order matters when a repo carries more than one. */
export const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
]

export type ManagerDetection =
  | { readonly kind: "detected"; readonly manager: PackageManager; readonly from: string }
  | { readonly kind: "ambiguous"; readonly found: readonly PackageManager[]; readonly why: string }
  | { readonly kind: "none"; readonly why: string }

/**
 * Which manager owns this project?
 *
 * Two lockfiles is AMBIGUOUS, not "pick the first". A repository with both
 * `bun.lock` and `package-lock.json` has already been installed twice by two
 * tools, and guessing which one is authoritative is how the third install
 * makes it worse.
 */
export function detectManager(files: readonly string[]): ManagerDetection {
  const present = LOCKFILES.filter(([file]) => files.includes(file))
  if (present.length === 0)
    return { kind: "none", why: "no lockfile — the project has never been installed, or the lockfile is not committed" }
  const managers = [...new Set(present.map(([, m]) => m))]
  if (managers.length > 1)
    return {
      kind: "ambiguous",
      found: managers,
      why: `${managers.join(" and ")} lockfiles both exist — this project has been installed by two tools already, and a third guess makes it worse`,
    }
  return { kind: "detected", manager: managers[0]!, from: present[0]![0] }
}

export interface InstallRequest {
  readonly manager: PackageManager
  readonly packages?: readonly string[]
  /** Has a human or a policy decided about lifecycle scripts? */
  readonly lifecycleScripts?: "allow" | "deny"
}

export interface InstallVerdict {
  readonly allowed: boolean
  readonly why: string
  /** The command that should have been used, when the request had it wrong. */
  readonly suggested?: string
}

/**
 * May this install run?
 *
 * The lifecycle-script rule has no default on purpose. `postinstall` is
 * arbitrary code from a package the agent picked, and both possible defaults
 * are wrong: allowing it silently is the supply-chain hole, and denying it
 * silently breaks packages that legitimately need to compile something. So the
 * caller has to have decided, and the decision is on the record.
 */
export function checkInstall(detection: ManagerDetection, request: InstallRequest): InstallVerdict {
  if (detection.kind === "ambiguous")
    return { allowed: false, why: detection.why }

  if (detection.kind === "detected" && detection.manager !== request.manager)
    return {
      allowed: false,
      why: `this project is a ${detection.manager} project (${detection.from}) and the request uses ${request.manager} — the install would not fail, it would write a second lockfile and resolve different versions, and the build that breaks would be somebody else's tomorrow`,
      suggested: `${detection.manager} install${request.packages !== undefined && request.packages.length > 0 ? ` ${request.packages.join(" ")}` : ""}`,
    }

  if (request.lifecycleScripts === undefined)
    return {
      allowed: false,
      why: "no decision was made about lifecycle scripts — postinstall is arbitrary code from a package the agent chose, and both defaults are wrong, so somebody has to choose",
    }

  return {
    allowed: true,
    why:
      `${request.manager} install with lifecycle scripts ${request.lifecycleScripts === "allow" ? "ALLOWED" : "denied"}` +
      (detection.kind === "none" ? " (no lockfile — this will create one)" : ` (${detection.from})`),
  }
}
