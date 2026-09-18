/**
 * CL-16A3-B1 §1 — the profile-root inventory, fail-closed.
 *
 * WHY A BARE `%USERPROFILE%` IS NOT ENOUGH, measured on this machine rather than
 * assumed. `ProfileList` reports FIVE profiles here, and only two of them look
 * like the shape everyone pictures:
 *
 *     C:\Users\someone
 *     C:\Users\CodexSandboxOffline              <- a second real account
 *     C:\Windows\system32\config\systemprofile  <- NOT under C:\Users
 *     C:\Windows\ServiceProfiles\LocalService   <- NOT under C:\Users
 *     C:\Windows\ServiceProfiles\NetworkService <- NOT under C:\Users
 *
 * The last three are the reason this module exists. `C:\Windows` is otherwise
 * one of the two trees an AppContainer can already read, so a scope planner that
 * only knew `C:\Users` would happily plan a cwd inside a SERVICE PROFILE and
 * consider it safe. A profile is whatever the system says is a profile.
 *
 * FAIL-CLOSED, and the distinction matters: an inventory that could not read a
 * required source is `unknown` — not "empty". An empty list would silently mean
 * "nothing is a profile", which is the most dangerous possible default.
 */

export const PROFILE_INVENTORY_VERSION = 1

/** What a collector managed to read. Every field may fail independently. */
export interface RawProfileSources {
  /** `%USERPROFILE%`. Required. */
  readonly userProfile?: string
  /** `ProfileImagePath` for every profile the SYSTEM knows. Required. */
  readonly profileListPaths?: readonly string[]
  /** Known Folder / User Shell Folder redirections. Optional but recorded. */
  readonly knownFolders?: Readonly<Record<string, string>>
  /** OneDrive roots from the environment. Optional but recorded. */
  readonly oneDriveRoots?: readonly string[]
  /** One entry per source that could not be read, naming the source. */
  readonly errors?: readonly string[]
}

export interface ProfileRoot {
  readonly path: string
  /** The final path after following reparse points, when resolvable. */
  readonly resolved?: string
  /** `volumeSerial:fileIndex`, when the collector could obtain it. */
  readonly identity?: string
  readonly reparse?: boolean
  /** Which source produced it — so a surprising root can be traced. */
  readonly source: "userProfile" | "profileList" | "knownFolder" | "oneDrive"
}

export interface ProfileRootInventory {
  readonly version: number
  readonly roots: readonly ProfileRoot[]
  readonly errors: readonly string[]
  /** True only when every REQUIRED source was read and nothing conflicted. */
  readonly complete: boolean
  readonly status: "complete" | "profile_inventory_unknown"
  /** Binds the inventory into evidence; changes whenever the roots change. */
  readonly hash: string
}

const norm = (p: string): string => p.replace(/\//g, "\\").replace(/\\+$/, "")
const lower = (p: string): string => norm(p).toLowerCase()

/** Small, dependency-free hash. The value only has to be stable and comparable. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

export interface ResolveInfo {
  readonly resolved?: string
  readonly identity?: string
  readonly reparse?: boolean
}

/**
 * Build the inventory. PURE: all IO has already happened in the collector.
 *
 * A missing REQUIRED source produces `profile_inventory_unknown`, and callers
 * must treat that as "the scope cannot be established" rather than as an empty
 * set of profiles.
 */
export function buildProfileInventory(raw: RawProfileSources, resolve?: (p: string) => ResolveInfo): ProfileRootInventory {
  const errors = [...(raw.errors ?? [])]
  const seen = new Map<string, ProfileRoot>()

  const add = (p: string | undefined, source: ProfileRoot["source"]): void => {
    if (!p || !p.trim()) return
    const path = norm(p)
    const key = lower(path)
    if (seen.has(key)) return
    let info: ResolveInfo = {}
    if (resolve) {
      try {
        info = resolve(path)
      } catch (e) {
        // A root we cannot resolve is still a root; the failure is recorded so
        // completeness can reflect it rather than being quietly optimistic.
        errors.push(`resolve_failed:${path}:${e instanceof Error ? e.name : "error"}`)
      }
    }
    seen.set(key, {
      path,
      ...(info.resolved ? { resolved: norm(info.resolved) } : {}),
      ...(info.identity ? { identity: info.identity } : {}),
      ...(info.reparse !== undefined ? { reparse: info.reparse } : {}),
      source,
    })
  }

  if (!raw.userProfile) errors.push("missing_source:userProfile")
  if (!raw.profileListPaths) errors.push("missing_source:profileList")

  add(raw.userProfile, "userProfile")
  for (const p of raw.profileListPaths ?? []) add(p, "profileList")
  // A known folder is only a PROFILE ROOT when it has been redirected OUT of
  // every profile already collected; otherwise it is just a folder inside one.
  for (const [, target] of Object.entries(raw.knownFolders ?? {})) {
    const t = norm(target)
    const insideKnownProfile = [...seen.values()].some((r) => lower(t) === lower(r.path) || lower(t).startsWith(`${lower(r.path)}\\`))
    if (!insideKnownProfile) add(t, "knownFolder")
  }
  for (const o of raw.oneDriveRoots ?? []) {
    const t = norm(o)
    const insideKnownProfile = [...seen.values()].some((r) => lower(t) === lower(r.path) || lower(t).startsWith(`${lower(r.path)}\\`))
    if (!insideKnownProfile) add(t, "oneDrive")
  }

  const roots = [...seen.values()].sort((a, b) => lower(a.path).localeCompare(lower(b.path)))
  const complete = errors.length === 0 && roots.length > 0
  return {
    version: PROFILE_INVENTORY_VERSION,
    roots,
    errors,
    complete,
    status: complete ? "complete" : "profile_inventory_unknown",
    hash: fnv1a(JSON.stringify({ v: PROFILE_INVENTORY_VERSION, roots: roots.map((r) => [lower(r.path), r.resolved ? lower(r.resolved) : "", r.identity ?? ""]) })),
  }
}

/** Is this path inside ANY known profile — lexically or after resolution? */
export function isInsideAnyProfile(path: string, inventory: ProfileRootInventory, resolved?: string): boolean {
  const candidates = [lower(path), ...(resolved ? [lower(resolved)] : [])]
  for (const root of inventory.roots) {
    for (const rootPath of [lower(root.path), ...(root.resolved ? [lower(root.resolved)] : [])]) {
      for (const c of candidates) {
        if (c === rootPath || c.startsWith(`${rootPath}\\`)) return true
      }
    }
  }
  return false
}
