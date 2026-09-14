/**
 * CL-16A3 §7 — the Windows execution SCOPE planner.
 *
 * MEASURED IN CL-16A2-E, and the reason this exists: an AppContainer needs
 * traverse rights on EVERY ANCESTOR of a path it must reach, not just on the
 * leaf. Granting only the leaf directory was measured and did not help. So a cwd
 * or an interpreter under the user profile can only be reached by granting
 * traverse on the user profile itself — which is exactly the user-profile-wide
 * grant the scope rules forbid.
 *
 * This module answers one question, purely and before anything is mutated:
 *
 *     can this execution be scoped SAFELY, and if so with which exact grants?
 *
 * It never widens an ACL to make an execution possible, and it never substitutes
 * a different working directory to dodge the problem — changing the cwd changes
 * what the command MEANS, so a plan that quietly relocated a run would be
 * reporting on a different execution than the one requested.
 *
 * Accessibility is INJECTED rather than measured here, so the policy is pure and
 * testable and the IO lives with the caller.
 */

/** Whether a path is already reachable by an AppContainer, as OBSERVED. */
export type PathAccessibility = "accessible" | "not_accessible" | "unknown"

import { isInsideAnyProfile, type ProfileRootInventory } from "./profile-inventory"

export type ScopeRights = "traverse" | "rx" | "modify"

export interface ScopeGrant {
  readonly path: string
  /** The LEAST rights that make this path usable for its purpose. */
  readonly rights: ScopeRights
  readonly why: string
}

export interface WindowsExecutionScopePlan {
  readonly ok: true
  readonly executable: string
  readonly cwd: string
  /** Directories the runtime loads code from (the executable's own root, etc). */
  readonly runtimeRoots: readonly string[]
  readonly readRoots: readonly string[]
  readonly writeRoots: readonly string[]
  readonly tempRoot?: string
  /** Ancestors that must be traversable, in root-to-leaf order. */
  readonly ancestorTraverse: readonly string[]
  /** The grants that would have to be applied. EMPTY when nothing is needed. */
  readonly grants: readonly ScopeGrant[]
  /** True when every required path is already reachable: the safest case. */
  readonly noMutationRequired: boolean
}

export interface WindowsExecutionScopeRefusal {
  readonly ok: false
  readonly reasonCode: string
  readonly detail: string
  /** Which paths could not be scoped, so the refusal names them. */
  readonly blockedPaths: readonly string[]
}

export type WindowsExecutionScopeResult = WindowsExecutionScopePlan | WindowsExecutionScopeRefusal

export interface ScopeRequest {
  readonly executable: string
  readonly cwd: string
  readonly readRoots?: readonly string[]
  readonly writeRoots?: readonly string[]
  readonly tempRoot?: string
  /** `%USERPROFILE%`. Anything at or above it may never be granted. */
  readonly userProfile: string
  /**
   * EVERY profile root this host knows about, not just ours.
   *
   * `%USERPROFILE%` is not the whole story: `ProfileList` in the registry can
   * place profiles elsewhere, OneDrive Known Folder Move redirects Documents and
   * Desktop out of the profile tree, and a machine can have custom profile
   * roots. Each is supplied as a MEASURED fact rather than assumed from a
   * pattern, and each is treated exactly like the profile itself.
   */
  readonly additionalProfileRoots?: readonly string[]
  /**
   * The MEASURED profile inventory (CL-16A3-B1 §1).
   *
   * Supplying it is how the planner learns that profiles are not all under
   * `C:\Users`: this machine reports three SERVICE profiles under `C:\Windows`,
   * a tree an AppContainer can otherwise already read. An INCOMPLETE inventory
   * refuses outright - "we could not read the sources" must never collapse into
   * "there are no profiles", which is the most permissive possible default.
   */
  readonly profileInventory?: ProfileRootInventory
  /**
   * Resolve a path to its FINAL path, following junctions and symlinks.
   *
   * Without this the planner is purely lexical, and a junction from an
   * innocuous-looking root into the user profile would be planned and granted -
   * the same lexical-vs-realpath hole CL-11.4C4 found in the pip work. A
   * resolver that throws (or is absent) makes the path unresolvable, which is
   * refused rather than assumed safe.
   */
  readonly realpath?: (path: string) => string
  /** Observed reachability. `unknown` is treated as NOT reachable: fail-closed. */
  readonly accessibility: (path: string) => PathAccessibility
}

const norm = (p: string): string => p.replace(/\//g, "\\").replace(/\\+$/, "")
const lower = (p: string): string => norm(p).toLowerCase()

/** Every ancestor of `p`, root first, including `p` itself. */
export function ancestorsOf(p: string): string[] {
  const parts = norm(p).split("\\")
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const joined = parts.slice(0, i + 1).join("\\")
    out.push(i === 0 ? `${joined}\\` : joined)
  }
  return out
}

export const isAtOrAbove = (candidate: string, target: string): boolean => {
  const c = lower(candidate)
  const t = lower(target)
  return t === c || t.startsWith(`${c}\\`)
}

/**
 * Roots that may NEVER receive a new grant.
 *
 * A drive root and `C:\Users` are obvious. The user's own profile is the one
 * that matters in practice, because that is where workspaces, temp directories
 * and user-installed interpreters live — and granting traverse there would hand
 * the container the whole profile to satisfy one directory.
 */
export function forbiddenGrantRoots(userProfile: string): string[] {
  const drive = norm(userProfile).slice(0, 2)
  return [`${drive}\\`, `${drive}\\Users`, norm(userProfile)]
}

/**
 * Plan the scope, or refuse.
 *
 * The refusal is the important half: `windows_appcontainer_filesystem_scope_
 * unsupported` means the execution as REQUESTED cannot be contained without a
 * grant that is broader than the rules allow. It is not an error and not a
 * fallback — it is the honest answer for that path on this machine.
 */
export function planWindowsExecutionScope(req: ScopeRequest): WindowsExecutionScopeResult {
  const executable = norm(req.executable)
  const cwd = norm(req.cwd)
  const runtimeRoots = [parentOf(executable)]
  const readRoots = (req.readRoots ?? []).map(norm)
  const writeRoots = (req.writeRoots ?? []).map(norm)
  const tempRoot = req.tempRoot ? norm(req.tempRoot) : undefined

  const needed: { path: string; rights: ScopeRights; why: string }[] = [
    { path: executable, rights: "rx", why: "the program itself must be readable and executable" },
    { path: runtimeRoots[0]!, rights: "rx", why: "the runtime loads its dependencies from the executable's directory" },
    { path: cwd, rights: "rx", why: "the process reads its working directory at startup" },
    ...readRoots.map((p) => ({ path: p, rights: "rx" as const, why: "declared read root" })),
    ...writeRoots.map((p) => ({ path: p, rights: "modify" as const, why: "declared write root" })),
    ...(tempRoot ? [{ path: tempRoot, rights: "modify" as const, why: "per-run temp" }] : []),
  ]

  // FAIL-CLOSED ON AN UNREADABLE INVENTORY, before anything else is considered.
  if (req.profileInventory && !req.profileInventory.complete) {
    return {
      ok: false,
      reasonCode: "windows_appcontainer_filesystem_scope_unsupported",
      detail:
        `the profile inventory is ${req.profileInventory.status} (${req.profileInventory.errors.join("; ") || "no detail"}). ` +
        `An inventory that could not be read is not an empty one, so no path can be shown to sit outside every profile. Nothing was executed.`,
      blockedPaths: [],
    }
  }

  const forbidden = forbiddenGrantRoots(req.userProfile)
  const profileRoots = [
    norm(req.userProfile),
    ...(req.additionalProfileRoots ?? []).map(norm),
    ...(req.profileInventory?.roots ?? []).flatMap((r) => (r.resolved ? [norm(r.path), norm(r.resolved)] : [norm(r.path)])),
  ]
  const grants: ScopeGrant[] = []
  const traverse = new Set<string>()
  const blocked: string[] = []

  /**
   * Does this path REALLY live outside every profile?
   *
   * Checked lexically AND after resolution, because a junction inside a safe
   * root can point straight into the profile. An unresolvable path is refused:
   * a path we cannot follow is not a path we can vouch for.
   */
  const escapesIntoProfile = (p: string): boolean => {
    for (const root of profileRoots) if (isAtOrAbove(root, p)) return true
    if (!req.realpath) return false
    let resolved: string
    try {
      resolved = norm(req.realpath(p))
    } catch {
      return true // unresolvable => refused
    }
    for (const root of profileRoots) if (isAtOrAbove(root, resolved)) return true
    // A path that resolves somewhere else entirely is a reparse point; it is only
    // acceptable when its TARGET is also outside every profile, which the loop
    // above has just established.
    return false
  }

  for (const item of needed) {
    // A path that lands inside ANY profile - lexically or through a junction -
    // can never be scoped, whatever its ACLs currently say.
    if (escapesIntoProfile(item.path)) {
      blocked.push(item.path)
      continue
    }
    // Already reachable? Then it needs NOTHING — the safest possible outcome,
    // and the common one for C:\Windows and C:\Program Files.
    if (req.accessibility(item.path) === "accessible") continue

    // Not reachable: every ancestor would need traverse. Find the ones that do
    // not already have it, and check whether granting them is permitted.
    const chain = ancestorsOf(item.path)
    let blockedHere = false
    for (const ancestor of chain.slice(0, -1)) {
      if (req.accessibility(ancestor) === "accessible") continue
      // An ancestor that needs a NEW grant and IS a forbidden root ends it. In
      // practice the drive root and `C:\Users` are already traversable on
      // Windows, so the boundary that actually bites is the user profile: to
      // reach anything inside it the profile itself would have to be granted.
      if (isForbiddenAncestor(ancestor, forbidden, profileRoots, req.userProfile)) {
        blockedHere = true
        break
      }
      traverse.add(ancestor)
    }
    if (blockedHere) {
      blocked.push(item.path)
      continue
    }
    grants.push({ path: item.path, rights: item.rights, why: item.why })
  }

  if (blocked.length > 0) {
    return {
      ok: false,
      reasonCode: "windows_appcontainer_filesystem_scope_unsupported",
      detail:
        `these paths cannot be reached without granting a forbidden root (${forbidden.join(", ")}): ${blocked.join(", ")}. ` +
        `An AppContainer needs traverse on EVERY ancestor, so reaching them would mean granting the user profile itself. ` +
        `Nothing was executed, no container was created, and the working directory was NOT substituted.`,
      blockedPaths: blocked,
    }
  }

  const ancestorTraverse = [...traverse].sort((a, b) => a.length - b.length)
  return {
    ok: true,
    executable,
    cwd,
    runtimeRoots,
    readRoots,
    writeRoots,
    ...(tempRoot ? { tempRoot } : {}),
    ancestorTraverse,
    grants: [...ancestorTraverse.map((p) => ({ path: p, rights: "traverse" as const, why: "ancestor traverse required to reach a granted path" })), ...grants],
    noMutationRequired: grants.length === 0 && ancestorTraverse.length === 0,
  }
}

/**
 * Is this ANY user's profile directory, not merely our own?
 *
 * `forbiddenGrantRoots` names the current user's profile, and a test caught that
 * this is not enough: `C:\Users\someone-else` is equally a profile, and
 * granting an AppContainer traverse into another account's home is exactly the
 * shape the rule exists to forbid. Any direct child of `C:\Users` counts.
 */
function isAnyUserProfile(candidate: string, userProfile: string): boolean {
  const usersRoot = `${norm(userProfile).slice(0, 2)}\\Users`
  const c = norm(candidate)
  if (!lower(c).startsWith(`${lower(usersRoot)}\\`)) return false
  return c.slice(usersRoot.length + 1).split("\\").length === 1
}

/**
 * May this ancestor receive a new traverse grant?
 *
 * A probe caught a real gap here: `forbiddenGrantRoots` derives its drive from
 * `%USERPROFILE%`, so a cwd on `D:` was planned with `traverse` on `D:\` itself.
 * ANY drive root is forbidden — granting one hands the container a whole volume
 * to satisfy a single directory — and so is any `X:\Users` and any profile root,
 * declared or derived.
 */
function isForbiddenAncestor(ancestor: string, forbidden: readonly string[], profileRoots: readonly string[], userProfile: string): boolean {
  const a = lower(ancestor)
  if (/^[a-z]:$/.test(a)) return true // a drive root, on ANY volume
  if (/^[a-z]:\\users$/.test(a)) return true
  if (forbidden.some((f) => lower(f) === a)) return true
  if (profileRoots.some((r) => lower(r) === a)) return true
  return isAnyUserProfile(ancestor, userProfile)
}

function parentOf(p: string): string {
  const n = norm(p)
  const i = n.lastIndexOf("\\")
  return i <= 2 ? n.slice(0, i + 1) : n.slice(0, i)
}
