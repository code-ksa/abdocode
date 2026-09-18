/**
 * CL-16A3-B2B — an unknown right never reaches the OS.
 *
 * The rule: anything the matrix does not know is refused HOST-SIDE, before a
 * durable intent is written and before any mutation. Forwarding it would ask the
 * OS to interpret a value no measurement stands behind, and a typo would quietly
 * become a different grant.
 *
 * Every test here asserts the same four negatives: the backend was never called,
 * no container was created, no ACL was touched, and no `isolation.applied` was
 * written.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { launchControlledProcess, type IsolationBackend, type IsolationEvent } from "../src/launcher"
import { DENY_ALL_PROFILE, ISOLATION_VERSION, type IsolationCapabilityReport } from "../src/isolation"
import { validateAclPlan, type AclGrantRequest } from "../src/windows-acl-matrix"

const EXE = process.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/echo"
const ARGV = process.platform === "win32" ? ["/c", "echo", "x"] : ["x"]

const capability = (): IsolationCapabilityReport => ({
  platform: process.platform,
  mechanism: "windows-appcontainer-zero-capabilities",
  denyAll: "supported",
  processTree: "supported",
  childInheritance: "supported",
  loopbackInsideDenyAll: "unknown",
  requiresElevation: false,
  mutatesGlobalState: false,
  reasonCodes: [],
  evidenceHash: "acl-gate-fixed",
  isolationVersion: ISOLATION_VERSION,
})

const GOOD: AclGrantRequest = { path: "C:\\ProgramData\\AbdoExec\\runs\\r1", operation: "ancestor_traverse", target: "object_self", namedRights: ["traverse"] }

/** Records whether the backend was ever consulted. */
function spyBackend(): { backend: IsolationBackend; called: () => boolean } {
  let called = false
  return {
    called: () => called,
    backend: {
      mechanism: "windows-appcontainer-zero-capabilities",
      run: async () => {
        called = true
        throw new Error("the backend must never be reached for an invalid ACL plan")
      },
    },
  }
}

async function launchWith(aclPlan: readonly AclGrantRequest[]) {
  const events: IsolationEvent[] = []
  const spy = spyBackend()
  const cwd = mkdtempSync(join(tmpdir(), "abdo-aclgate-"))
  try {
    const res = await launchControlledProcess({
      executable: EXE,
      argv: ARGV,
      cwd,
      env: { PATH: process.env.PATH ?? "" },
      isolationProfile: DENY_ALL_PROFILE,
      capability: capability(),
      timeoutMs: 30_000,
      evidence: {
        profile: DENY_ALL_PROFILE,
        capability: capability(),
        approvalGranted: false,
        aclPlan,
        emit: (e) => {
          events.push(e)
        },
        backend: spy.backend,
      },
    })
    return { res, events, backendCalled: spy.called() }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe("CL-16A3-B2B - windows_acl_right_unknown is refused host-side", () => {
  const bad: [string, AclGrantRequest][] = [
    ["an unknown RIGHT", { ...GOOD, namedRights: ["traverse", "take_ownership"] }],
    ["a misspelled right", { ...GOOD, namedRights: ["travrese"] }],
    ["an unknown OPERATION", { ...GOOD, operation: "mount_volume" }],
    ["an unknown TARGET", { ...GOOD, target: "everything" as never }],
    ["a known right on the WRONG target", { ...GOOD, operation: "temp_child_files", target: "object_self", namedRights: ["read_file"] }],
  ]

  for (const [label, grant] of bad) {
    test(`${label} is refused, and NOTHING happens`, async () => {
      const { res, events, backendCalled } = await launchWith([grant])
      expect(res.outcome).toBe("refused")
      if (res.outcome === "refused") {
        expect(res.reasonCode).toBe("windows_acl_right_unknown")
        expect(res.detail).toContain("no measurement stands behind")
      }
      // 1. the backend / helper was never consulted
      expect(backendCalled).toBe(false)
      // 2. no isolation.applied was written
      expect(events.some((e) => e.type === "isolation.applied")).toBe(false)
      // 3. NOTHING was written at all - the refusal precedes the durable intent,
      //    so there is no container and no ACL to undo.
      expect(events).toEqual([])
    })
  }

  test("a VALID plan is not blocked by the gate (non-vacuity)", () => {
    // Without this the tests above would pass for a gate that refuses everything.
    const v = validateAclPlan([GOOD])
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.mask & 0x20).toBe(0x20) // FILE_TRAVERSE really is in there
  })

  test("an alias is expanded and accepted, not waved through", () => {
    const v = validateAclPlan([{ path: "C:\\x\\f.txt", operation: "file_read", target: "object_self", namedRights: ["rx"] }])
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.resolved[0]!.namedRights).not.toContain("rx")
      expect(v.resolved[0]!.namedRights).toContain("read_file")
    }
  })

  test("the refusal names EVERY unknown value, not just the first", () => {
    const v = validateAclPlan([{ path: "C:\\x", operation: "nope", target: "bogus" as never, namedRights: ["fake_right"] }])
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.unknown.some((u) => u.startsWith("operation:"))).toBe(true)
      expect(v.unknown.some((u) => u.startsWith("target:"))).toBe(true)
      expect(v.unknown.some((u) => u.startsWith("right:"))).toBe(true)
    }
  })

  test("an empty plan is not an error - it simply grants nothing", () => {
    expect(validateAclPlan([]).ok).toBe(true)
  })
})
