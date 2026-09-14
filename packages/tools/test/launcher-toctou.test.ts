/**
 * CL-16A2-B §5 — pre-spawn TOCTOU.
 *
 * A decision is taken against a snapshot of the world. Between that decision and
 * the spawn there are real awaits — three durable event writes, at minimum — and
 * the world can move inside them. Everything the decision rested on is therefore
 * re-derived immediately before the spawn and compared with what was recorded:
 * the command, the cwd, the environment's KEY NAMES, the isolation profile, the
 * platform capability, the primitive on disk, this launcher's own version, and
 * the evidence hash a human approved.
 *
 * THE CONTROL COMES FIRST. Every drift below is proven to actually reach the
 * spawn when the check is disabled — otherwise "the launch was refused" would be
 * indistinguishable from "the drift never happened", which is the exact shape of
 * a security test that passes for the wrong reason.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  INHERIT_PROFILE,
  IsolationEventTypes,
  UNMEASURED_CAPABILITY,
  launchControlledProcess,
  type ControlledExecutionGrant,
  type IsolationEvent,
  type LauncherHooks,
} from "../src"
import { DENY_ALL_PROFILE, ISOLATION_VERSION, type IsolationCapabilityReport } from "../src/isolation"

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "abdo-toctou-")))
const OTHER = realpathSync(mkdtempSync(join(tmpdir(), "abdo-toctou-other-")))

const LINUX_CAP: IsolationCapabilityReport = {
  platform: "linux",
  mechanism: "linux-userns-unshare",
  denyAll: "supported",
  processTree: "supported",
  childInheritance: "supported",
  loopbackInsideDenyAll: "up",
  requiresElevation: false,
  mutatesGlobalState: false,
  reasonCodes: [],
  evidenceHash: "cap-at-decision",
  isolationVersion: ISOLATION_VERSION,
}

interface Run {
  readonly result: Awaited<ReturnType<typeof launchControlledProcess>>
  readonly events: IsolationEvent[]
  readonly spawnedArgv: readonly string[] | undefined
  readonly spawnedCwd: string | undefined
}

/**
 * Run a launch under a drift, capturing what WOULD have been spawned. The stub
 * spawner never runs the drifted command — it records it and runs a harmless
 * `exit 0` — so the control can observe the drift's reach without executing it.
 */
async function runWithDrift(hooks: LauncherHooks, over: Partial<ControlledExecutionGrant> = {}, profile = INHERIT_PROFILE): Promise<Run> {
  const events: IsolationEvent[] = []
  let spawnedArgv: readonly string[] | undefined
  let spawnedCwd: string | undefined
  const grant: ControlledExecutionGrant = {
    profile,
    capability: profile.network === "deny_all" ? LINUX_CAP : UNMEASURED_CAPABILITY,
    approvalGranted: false,
    approvalEvidenceHash: "sc-at-decision",
    decisionId: "dec-toctou",
    emit: async (e) => {
      events.push(e)
      await Bun.sleep(1)
    },
    ...over,
  }
  const result = await launchControlledProcess({
    executable: "bash",
    argv: ["-c", "exit 0"],
    cwd: TMP,
    env: { PATH: process.env.PATH ?? "", ABDO_A: "1" },
    isolationProfile: profile,
    capability: grant.capability,
    timeoutMs: 20_000,
    evidence: grant,
    hooks: {
      ...hooks,
      spawn: ((argv: string[], opts: { cwd?: string }) => {
        spawnedArgv = argv
        spawnedCwd = opts?.cwd
        return Bun.spawn(["bash", "-c", "exit 0"], { stdout: "pipe", stderr: "pipe" })
      }) as unknown as typeof Bun.spawn,
    },
  })
  return { result, events, spawnedArgv, spawnedCwd }
}

const refusedWith = (r: Run, code: string) => {
  expect(r.result.outcome).toBe("refused")
  if (r.result.outcome !== "refused") return
  expect(r.result.reasonCode).toBe(code)
  expect(r.spawnedArgv).toBeUndefined() // nothing started
  const failed = r.events.at(-1)!
  expect(failed.type).toBe(IsolationEventTypes.Failed)
  expect(failed.failureReason).toBe(code)
}

describe("CL-16A2-B §5 — each element, drifted between the decision and the spawn", () => {
  test("CONTROL: with the check disabled, a drifted cwd genuinely reaches the spawn", async () => {
    // This is what makes every refusal below meaningful. Without it, a passing
    // test could simply mean the drift hook did nothing.
    const r = await runWithDrift({ driftForTest: () => ({ cwd: OTHER }), disableToctouForTest: true })
    expect(r.result.outcome).toBe("ran")
    expect(r.spawnedCwd).toBe(OTHER)
    expect(r.spawnedCwd).not.toBe(TMP)
  })

  test("the CWD changed => stale_isolation_evidence", async () => {
    refusedWith(await runWithDrift({ driftForTest: () => ({ cwd: OTHER }) }), "stale_isolation_evidence")
  })

  test("CONTROL: with the check disabled, a drifted command genuinely reaches the spawn", async () => {
    const r = await runWithDrift({ driftForTest: () => ({ argv: ["-c", "echo pwned"] }), disableToctouForTest: true })
    expect(r.result.outcome).toBe("ran")
    expect(r.spawnedArgv).toEqual(["bash", "-c", "echo pwned"])
  })

  test("the COMMAND/argv changed => stale_isolation_evidence", async () => {
    refusedWith(await runWithDrift({ driftForTest: () => ({ argv: ["-c", "echo pwned"] }) }), "stale_isolation_evidence")
  })

  test("the EXECUTABLE changed => stale_isolation_evidence", async () => {
    refusedWith(await runWithDrift({ driftForTest: () => ({ executable: "sh" }) }), "stale_isolation_evidence")
  })

  test("an environment KEY NAME appeared => stale_isolation_evidence", async () => {
    refusedWith(
      await runWithDrift({ driftForTest: () => ({ env: { PATH: process.env.PATH ?? "", ABDO_A: "1", ABDO_INJECTED: "x" } }) }),
      "stale_isolation_evidence",
    )
  })

  test("an environment key's VALUE changing is NOT a drift (names are what bind)", async () => {
    // Deliberate and documented: the constraint is over names. A value change is
    // invisible here because values are never recorded — recording them to
    // detect this would put secrets in the audit log, which is worse.
    const r = await runWithDrift({ driftForTest: () => ({ env: { PATH: process.env.PATH ?? "", ABDO_A: "changed" } }) })
    expect(r.result.outcome).toBe("ran")
  })

  test("the ISOLATION PROFILE changed => stale_isolation_evidence", async () => {
    refusedWith(
      await runWithDrift({
        driftForTest: () => ({ isolationProfile: { ...INHERIT_PROFILE, stripEnv: ["ABDO_A"] } }),
      }),
      "stale_isolation_evidence",
    )
  })

  /**
   * A clock, not a call counter. An earlier version of these tests keyed the
   * drift off "the Nth call to the hook", which silently stopped firing the
   * moment the launcher's internal call order changed — a test that passes
   * because it tests nothing. `driftForTest` runs EXACTLY once, in the window,
   * so flipping a flag inside it is a real before/after.
   */
  const atWindow = <T>(before: T, after: T) => {
    const state = { moved: false }
    return { state, drift: () => ({}) as Record<string, never>, read: () => (state.moved ? after : before) }
  }

  test("the PLATFORM CAPABILITY changed => stale_isolation_evidence", async () => {
    const cap = atWindow(LINUX_CAP, { ...LINUX_CAP, evidenceHash: "cap-moved" })
    refusedWith(
      await runWithDrift({
        driftForTest: () => {
          cap.state.moved = true
          return {}
        },
        capabilityNow: cap.read,
      }),
      "stale_isolation_evidence",
    )
  })

  test("the PRIMITIVE on disk was replaced => stale_isolation_evidence", async () => {
    const ident = atWindow("dev:1:1:1", "dev:9:9:9")
    refusedWith(
      await runWithDrift(
        {
          driftForTest: () => {
            ident.state.moved = true
            return {}
          },
          resolvePrimitive: () => "/usr/bin/unshare",
          primitiveIdentity: ident.read,
        },
        {},
        DENY_ALL_PROFILE,
      ),
      "stale_isolation_evidence",
    )
  })

  test("the PRIMITIVE moved to a different trusted path => stale_isolation_evidence", async () => {
    const where = atWindow("/usr/bin/unshare", "/bin/unshare")
    refusedWith(
      await runWithDrift(
        {
          driftForTest: () => {
            where.state.moved = true
            return {}
          },
          resolvePrimitive: where.read,
          primitiveIdentity: () => "stub",
        },
        {},
        DENY_ALL_PROFILE,
      ),
      "stale_isolation_evidence",
    )
  })

  test("the LAUNCHER's own version/hash changed => stale_isolation_evidence", async () => {
    const ident = atWindow({ version: 1, hash: "original" }, { version: 2, hash: "rebuilt" })
    refusedWith(
      await runWithDrift({
        driftForTest: () => {
          ident.state.moved = true
          return {}
        },
        launcherIdentityNow: ident.read,
      }),
      "stale_isolation_evidence",
    )
  })

  test("the APPROVED evidence hash moved AFTER a human approval => approval_snapshot_stale", async () => {
    refusedWith(
      await runWithDrift({ approvalEvidenceNow: () => "sc-moved-after-approval" }, { approvalGranted: true }),
      "approval_snapshot_stale",
    )
  })

  test("the same drift on the AUTOMATIC path is stale_isolation_evidence, not an approval failure", async () => {
    refusedWith(await runWithDrift({ approvalEvidenceNow: () => "sc-moved" }, { approvalGranted: false }), "stale_isolation_evidence")
  })

  test("a human-approved call whose COMMAND drifts is also approval_snapshot_stale", async () => {
    refusedWith(await runWithDrift({ driftForTest: () => ({ argv: ["-c", "echo pwned"] }) }, { approvalGranted: true }), "approval_snapshot_stale")
  })

  test("no drift => the launch proceeds (the guard is not simply refusing everything)", async () => {
    const r = await runWithDrift({})
    expect(r.result.outcome).toBe("ran")
    expect(r.spawnedArgv).toEqual(["bash", "-c", "exit 0"])
    expect(r.spawnedCwd).toBe(TMP)
  })

  test("a refusal writes the failure durably and never an applied event", async () => {
    const r = await runWithDrift({ driftForTest: () => ({ cwd: OTHER }) })
    expect(r.events.some((e) => e.type === IsolationEventTypes.Applied)).toBe(false)
    expect(r.events.map((e) => e.type)).toEqual([IsolationEventTypes.Requested, IsolationEventTypes.CapabilityChecked, IsolationEventTypes.Failed])
    // The failure names the fields that moved — and no environment value.
    expect(r.events.at(-1)!.detail).toContain("cwd")
    expect(JSON.stringify(r.events)).not.toContain("ABDO_A=")
  })
})
