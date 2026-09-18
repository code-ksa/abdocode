/**
 * CL-16A3-B1 §1 — the profile inventory, and why an empty one is dangerous.
 *
 * MEASURED ON THIS MACHINE, and the reason the module exists: `ProfileList`
 * reports five profiles, and three of them are NOT under `C:\Users` —
 * `C:\Windows\ServiceProfiles\LocalService`, `...\NetworkService` and
 * `C:\Windows\system32\config\systemprofile`. `C:\Windows` is one of the two
 * trees an AppContainer can already read, so a planner that only knew
 * `C:\Users` would have happily scoped a cwd inside a service profile.
 */
import { describe, expect, test } from "bun:test"
import { buildProfileInventory, isInsideAnyProfile, PROFILE_INVENTORY_VERSION } from "../src/profile-inventory"
import { planWindowsExecutionScope, type PathAccessibility } from "../src/windows-scope"

const USER = String.raw`C:\Users\someone`
const WINDOWS = String.raw`C:\Windows`
const PROGRAM_FILES = String.raw`C:\Program Files`

/** The shape this machine actually reported. */
const REAL_SOURCES = {
  userProfile: USER,
  profileListPaths: [
    String.raw`C:\Windows\system32\config\systemprofile`,
    String.raw`C:\Windows\ServiceProfiles\LocalService`,
    String.raw`C:\Windows\ServiceProfiles\NetworkService`,
    USER,
    String.raw`C:\Users\CodexSandboxOffline`,
  ],
  knownFolders: { Desktop: USER + String.raw`\Desktop`, Personal: USER + String.raw`\Documents` },
  oneDriveRoots: [USER + String.raw`\OneDrive`],
  errors: [],
}

const realistic = (p: string): PathAccessibility => {
  const l = p.toLowerCase().replace(/\\+$/, "")
  if (l === "c:" || l === String.raw`c:\users`) return "accessible"
  if (l.startsWith(WINDOWS.toLowerCase()) || l.startsWith(PROGRAM_FILES.toLowerCase())) return "accessible"
  return "not_accessible"
}

describe("CL-16A3-B1 section 1 - the inventory is built from measured sources", () => {
  test("the real machine's shape yields a COMPLETE inventory with all five roots", () => {
    const inv = buildProfileInventory(REAL_SOURCES)
    expect(inv.version).toBe(PROFILE_INVENTORY_VERSION)
    expect(inv.complete).toBe(true)
    expect(inv.status).toBe("complete")
    expect(inv.roots).toHaveLength(5)
    // THE POINT: profiles that are not under C:\Users.
    const paths = inv.roots.map((r) => r.path.toLowerCase())
    expect(paths).toContain(String.raw`c:\windows\serviceprofiles\localservice`)
    expect(paths).toContain(String.raw`c:\windows\system32\config\systemprofile`)
    expect(paths).toContain(String.raw`c:\users\codexsandboxoffline`)
  })

  test("a known folder INSIDE a profile is not a separate root", () => {
    // Desktop and Documents live in the profile here; adding them would be noise
    // that makes the boundary look larger than it is.
    const inv = buildProfileInventory(REAL_SOURCES)
    expect(inv.roots.some((r) => r.path.toLowerCase().endsWith(String.raw`\desktop`))).toBe(false)
    expect(inv.roots.some((r) => r.source === "oneDrive")).toBe(false)
  })

  test("a REDIRECTED known folder outside every profile IS a root", () => {
    const inv = buildProfileInventory({ ...REAL_SOURCES, knownFolders: { Personal: String.raw`D:\Redirected\Documents` } })
    expect(inv.roots.some((r) => r.source === "knownFolder" && r.path === String.raw`D:\Redirected\Documents`)).toBe(true)
  })

  test("a MISSING required source makes the inventory unknown, NOT empty", () => {
    // The most dangerous possible default would be an empty list, which reads as
    // "nothing is a profile" and permits everything.
    const noList = buildProfileInventory({ userProfile: USER })
    expect(noList.complete).toBe(false)
    expect(noList.status).toBe("profile_inventory_unknown")
    expect(noList.errors).toContain("missing_source:profileList")

    const noUser = buildProfileInventory({ profileListPaths: [USER] })
    expect(noUser.complete).toBe(false)
    expect(noUser.errors).toContain("missing_source:userProfile")
  })

  test("a collector error is carried through and blocks completeness", () => {
    const inv = buildProfileInventory({ ...REAL_SOURCES, errors: ["profileList:UnauthorizedAccessException"] })
    expect(inv.complete).toBe(false)
    expect(inv.status).toBe("profile_inventory_unknown")
  })

  test("the hash changes when the roots change, and is stable when they do not", () => {
    const a = buildProfileInventory(REAL_SOURCES)
    const b = buildProfileInventory(REAL_SOURCES)
    expect(a.hash).toBe(b.hash)
    const c = buildProfileInventory({ ...REAL_SOURCES, profileListPaths: [...REAL_SOURCES.profileListPaths, String.raw`D:\Another\Profile`] })
    expect(c.hash).not.toBe(a.hash)
  })

  test("isInsideAnyProfile follows the RESOLVED path too", () => {
    const inv = buildProfileInventory(REAL_SOURCES, (p) => (p === String.raw`C:\Link` ? { resolved: USER + String.raw`\secret` } : {}))
    expect(isInsideAnyProfile(String.raw`C:\Windows\ServiceProfiles\LocalService\x`, inv)).toBe(true)
    expect(isInsideAnyProfile(String.raw`C:\AbdoExec\run`, inv)).toBe(false)
    // Resolution is what catches a junction pointing into a profile.
    expect(isInsideAnyProfile(String.raw`C:\AbdoExec\run`, inv, USER + String.raw`\secret`)).toBe(true)
  })
})

describe("CL-16A3-B1 section 1 - the planner honours the inventory", () => {
  const base = {
    executable: PROGRAM_FILES + String.raw`\nodejs\node.exe`,
    userProfile: USER,
    accessibility: realistic,
    realpath: (x: string) => x,
  }

  test("a cwd inside a SERVICE profile is refused, even though C:\\Windows is readable", () => {
    // Without the inventory this path looks perfectly fine: it is inside the one
    // tree an AppContainer can already read. It is a profile.
    const inv = buildProfileInventory(REAL_SOURCES)
    const p = planWindowsExecutionScope({ ...base, cwd: String.raw`C:\Windows\ServiceProfiles\LocalService\work`, profileInventory: inv })
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.reasonCode).toBe("windows_appcontainer_filesystem_scope_unsupported")
  })

  test("NON-VACUITY: the same shape WITHOUT the inventory is planned", () => {
    // Proves the refusal above comes from the inventory, not from the path.
    const p = planWindowsExecutionScope({ ...base, cwd: String.raw`C:\Windows\ServiceProfiles\LocalService\work` })
    expect(p.ok).toBe(true)
  })

  test("an INCOMPLETE inventory refuses everything, including an easy path", () => {
    const inv = buildProfileInventory({ userProfile: USER })
    const p = planWindowsExecutionScope({ ...base, cwd: WINDOWS + String.raw`\Temp`, profileInventory: inv })
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.detail).toContain("profile_inventory_unknown")
    expect(p.detail).toContain("not an empty one")
  })

  test("a complete inventory still allows a genuinely safe path", () => {
    // The control for the row above: fail-closed must not mean fail-always.
    const inv = buildProfileInventory(REAL_SOURCES)
    const p = planWindowsExecutionScope({ ...base, cwd: WINDOWS + String.raw`\Temp`, profileInventory: inv })
    expect(p.ok).toBe(true)
  })

  test("the OTHER account's profile is refused via the inventory", () => {
    const inv = buildProfileInventory(REAL_SOURCES)
    const p = planWindowsExecutionScope({ ...base, cwd: String.raw`C:\Users\CodexSandboxOffline\work`, profileInventory: inv })
    expect(p.ok).toBe(false)
  })
})
