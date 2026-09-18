/**
 * CL-16A3 §7 / CL-16A3-B §0.B — the scope planner, and the refusal that decides
 * the outcome.
 *
 * The measured constraint being encoded: an AppContainer needs traverse on EVERY
 * ancestor of a path it must reach. So a workspace, temp directory or
 * interpreter under the user profile can only be reached by granting the user
 * profile — and that is forbidden. The planner therefore REFUSES those, and the
 * refusal is the honest answer rather than a bug to be worked around.
 *
 * Paths are written with `String.raw` throughout: a single backslash in an
 * ordinary TS string is an escape, and an earlier version of this file silently
 * became `C:AbdoExec` because of it.
 */
import { describe, expect, test } from "bun:test"
import { ancestorsOf, forbiddenGrantRoots, planWindowsExecutionScope, type PathAccessibility } from "../src/windows-scope"

const USER = String.raw`C:\Users\someone`
const WINDOWS = String.raw`C:\Windows`
const PROGRAM_FILES = String.raw`C:\Program Files`
const SAFE = String.raw`C:\AbdoExec`
const REDIRECTED = String.raw`D:\OneDriveProfiles\someone`

/**
 * Windows as MEASURED, not as imagined: the drive root and the Users container
 * are already traversable by everyone, and `C:\Windows` / `C:\Program Files`
 * already grant ALL APPLICATION PACKAGES. The user PROFILE is the boundary that
 * actually bites — reaching inside it would mean granting the profile itself.
 */
const realistic = (p: string): PathAccessibility => {
  const l = p.toLowerCase().replace(/\\+$/, "")
  if (l === "c:" || l === String.raw`c:\users`) return "accessible"
  if (l.startsWith(WINDOWS.toLowerCase()) || l.startsWith(PROGRAM_FILES.toLowerCase())) return "accessible"
  return "not_accessible"
}

/** As above, but a host-owned root outside the profile still needs granting. */
const safeAware = (x: string): PathAccessibility => (x.toLowerCase().startsWith(String.raw`c:\abdoexec`) ? "not_accessible" : realistic(x))

const plan = (over: Partial<Parameters<typeof planWindowsExecutionScope>[0]> = {}) =>
  planWindowsExecutionScope({
    executable: PROGRAM_FILES + String.raw`\nodejs\node.exe`,
    cwd: WINDOWS + String.raw`\Temp`,
    userProfile: USER,
    accessibility: realistic,
    ...over,
  })

describe("CL-16A3 section 7 - ancestors and forbidden roots", () => {
  test("ancestorsOf walks root to leaf", () => {
    expect(ancestorsOf(String.raw`C:\a\b\c`)).toEqual(["C:\\", String.raw`C:\a`, String.raw`C:\a\b`, String.raw`C:\a\b\c`])
  })

  test("the drive root, the Users container and the profile itself are all forbidden", () => {
    const f = forbiddenGrantRoots(USER)
    expect(f).toContain("C:\\")
    expect(f).toContain(String.raw`C:\Users`)
    expect(f).toContain(USER)
  })
})

describe("CL-16A3 section 7 - what can be scoped", () => {
  test("an already-reachable executable and cwd need NO mutation at all", () => {
    const p = plan()
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.noMutationRequired).toBe(true)
    expect(p.grants).toEqual([])
    expect(p.ancestorTraverse).toEqual([])
  })

  test("a host-owned root OUTSIDE the profile can be scoped, with least rights", () => {
    const root = SAFE + String.raw`\run-1`
    const p = plan({ tempRoot: root, accessibility: safeAware })
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.grants.find((g) => g.path === root)?.rights).toBe("modify")
    for (const g of p.grants.filter((x) => x.path !== root)) expect(g.rights).toBe("traverse")
    // No grant is ever Full Control, and none lands on a forbidden root.
    for (const g of p.grants) {
      expect(["traverse", "rx", "modify"]).toContain(g.rights)
      expect(forbiddenGrantRoots(USER).map((f) => f.toLowerCase())).not.toContain(g.path.toLowerCase())
    }
  })

  test("a read root is rx and a write root is modify - never more", () => {
    const p = plan({ readRoots: [SAFE + String.raw`\in`], writeRoots: [SAFE + String.raw`\out`], accessibility: safeAware })
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.grants.find((g) => g.path === SAFE + String.raw`\in`)?.rights).toBe("rx")
    expect(p.grants.find((g) => g.path === SAFE + String.raw`\out`)?.rights).toBe("modify")
  })
})

describe("CL-16A3 section 7 - what must be REFUSED", () => {
  test("a cwd under the user profile is refused, and the cwd is NOT substituted", () => {
    // THE DECISIVE CASE. This is where a real workspace lives, and it is exactly
    // what CL-16A2-E measured failing: PowerShell could not start with such a
    // cwd. Reaching it needs traverse on the profile, which is forbidden.
    const p = plan({ cwd: USER + String.raw`\projects\app` })
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.reasonCode).toBe("windows_appcontainer_filesystem_scope_unsupported")
    expect(p.blockedPaths).toContain(USER + String.raw`\projects\app`)
    // The refusal SAYS it did not relocate the run: relocating changes meaning.
    expect(p.detail).toContain("was NOT substituted")
    expect(p.detail).toContain("EVERY ancestor")
  })

  test("an interpreter under the user profile is refused", () => {
    const p = plan({ executable: USER + String.raw`\AppData\Local\Python\bin\python.exe` })
    expect(p.ok).toBe(false)
  })

  test("a temp root under the user profile is refused", () => {
    // %TEMP% is inside the profile, which is why a per-run temp cannot simply
    // use the ordinary one.
    const p = plan({ tempRoot: USER + String.raw`\AppData\Local\Temp\abdo-run-1` })
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.blockedPaths.some((b) => b.includes("Temp"))).toBe(true)
  })

  test("another account's profile is never granted", () => {
    const p = plan({ cwd: String.raw`C:\Users\someone-else\work` })
    expect(p.ok).toBe(false)
  })

  test("UNKNOWN accessibility is treated as NOT accessible, and refuses", () => {
    // FAIL-CLOSED. With nothing measured, even the drive root is not known to be
    // traversable - and a drive root may never be granted.
    const p = plan({ accessibility: () => "unknown" })
    expect(p.ok).toBe(false)
  })
})

describe("CL-16A3-B section 0.B - profile boundaries are measured, not pattern-matched", () => {
  test("A JUNCTION from a safe root into the profile is REFUSED", () => {
    // THE HOLE THIS CLOSES. Lexically the cwd is outside every profile, so a
    // purely textual planner grants it; following it lands in the user's home.
    // The same lexical-vs-realpath mistake CL-11.4C4 found in the pip work.
    const link = SAFE + String.raw`\link`
    const p = plan({
      cwd: link,
      accessibility: safeAware,
      realpath: (x) => (x.toLowerCase().startsWith(link.toLowerCase()) ? USER + String.raw`\secrets` : x),
    })
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.reasonCode).toBe("windows_appcontainer_filesystem_scope_unsupported")
    expect(p.blockedPaths).toContain(link)
  })

  test("the same path WITHOUT the junction is planned normally", () => {
    // Non-vacuity: the refusal above comes from the RESOLUTION, not the path.
    const p = plan({ cwd: SAFE + String.raw`\link`, accessibility: safeAware, realpath: (x) => x })
    expect(p.ok).toBe(true)
  })

  test("an UNRESOLVABLE path is refused, not assumed safe", () => {
    const p = plan({
      cwd: SAFE + String.raw`\gone`,
      accessibility: safeAware,
      realpath: () => {
        throw new Error("ENOENT")
      },
    })
    expect(p.ok).toBe(false)
  })

  test("a REDIRECTED profile root (OneDrive / ProfileList) is honoured", () => {
    // %USERPROFILE% is not the whole story: Known Folder Move and a registry
    // ProfileList entry can place a profile where no Users container appears.
    const p = plan({ cwd: REDIRECTED + String.raw`\projects\app`, additionalProfileRoots: [REDIRECTED], accessibility: realistic })
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.blockedPaths).toContain(REDIRECTED + String.raw`\projects\app`)
  })

  test("ANY drive root is forbidden, not only the profile's drive", () => {
    // Found by a probe: a cwd on D: was planned with `traverse` on the D: root
    // itself, because the forbidden list was derived from %USERPROFILE% alone.
    // Granting a drive root hands the container a whole volume for one directory.
    const p = plan({ cwd: String.raw`D:\work\app`, accessibility: realistic, realpath: (x) => x })
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.reasonCode).toBe("windows_appcontainer_filesystem_scope_unsupported")
  })
})
