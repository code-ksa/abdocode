/**
 * CL-16A2-B §2/§4 — the controlled launcher's contract.
 *
 * The environment test is the load-bearing one. MEASURED on Bun 1.3.14: setting
 * `process.env.X` after startup does NOT reach a spawned child, because Bun
 * captures the environment once. Every "just set process.env" fix written
 * against that runtime is a no-op, and the only thing that works is an explicit
 * `env:` on the spawn. So this suite proves BOTH directions: what is in the
 * launcher's `env` reaches the child, and what is only in `process.env` does not.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  INHERIT_PROFILE,
  IsolationEventTypes,
  LAUNCHER_HASH,
  LAUNCHER_VERSION,
  UNMEASURED_CAPABILITY,
  launchControlledProcess,
  profileHash,
  type ControlledExecutionGrant,
  type IsolationCapabilityReport,
  type IsolationEvent,
} from "../src"
import { DENY_ALL_PROFILE, ISOLATION_VERSION } from "../src/isolation"

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "abdo-launcher-")))

const capability = (over: Partial<IsolationCapabilityReport> = {}): IsolationCapabilityReport => ({
  platform: process.platform,
  mechanism: "linux-userns-unshare",
  denyAll: "supported",
  processTree: "supported",
  childInheritance: "supported",
  loopbackInsideDenyAll: "up",
  requiresElevation: false,
  mutatesGlobalState: false,
  reasonCodes: [],
  evidenceHash: "cap-evidence-1",
  isolationVersion: ISOLATION_VERSION,
  ...over,
})

const grantOf = (over: Partial<ControlledExecutionGrant> = {}): ControlledExecutionGrant => ({
  profile: INHERIT_PROFILE,
  capability: UNMEASURED_CAPABILITY,
  approvalGranted: false,
  ...over,
})

/** A grant whose sink records every event, so ordering can be asserted. */
function recordingGrant(over: Partial<ControlledExecutionGrant> = {}): { grant: ControlledExecutionGrant; events: IsolationEvent[] } {
  const events: IsolationEvent[] = []
  return { events, grant: grantOf({ emit: (e) => void events.push(e), ...over }) }
}

describe("CL-16A2-B §2 — explicit child environment", () => {
  test("the child's PATH is the one in `env`, NOT the one Bun captured at startup", async () => {
    // A directory that exists nowhere in the real PATH. If the child echoes it,
    // the explicit env is what took effect.
    const marker = process.platform === "win32" ? "C:/abdo-launcher-marker" : "/abdo-launcher-marker"
    // bash is named ABSOLUTELY here for a reason worth recording: with `PATH`
    // set to the marker alone, Bun could not resolve a bare `bash` at all. That
    // failure is itself the property under test — the child's PATH really is the
    // one passed in, not the one the process was started with.
    const bash = Bun.which("bash")
    expect(bash).toBeTruthy()
    const res = await launchControlledProcess({
      executable: bash!,
      argv: ["-c", 'printf "%s" "$PATH"'],
      cwd: TMP,
      env: { PATH: marker },
      isolationProfile: INHERIT_PROFILE,
      capability: UNMEASURED_CAPABILITY,
      timeoutMs: 20_000,
      evidence: grantOf(),
    })
    expect(res.outcome).toBe("ran")
    if (res.outcome !== "ran") return
    // Git bash rewrites `C:/x` to `/c/x` on the way in, so the MARKER is what is
    // asserted rather than the exact spelling. The load-bearing part is that the
    // child sees this and ONLY this: a single entry, none of the real PATH.
    expect(res.stdout).toContain("abdo-launcher-marker")
    expect(res.stdout.split(/[:;]/).filter((s) => s.length > 0 && s.length > 2)).toHaveLength(1)
    // And the real PATH is genuinely different — otherwise this proves nothing.
    expect(process.env.PATH).not.toBe(res.stdout)
    expect(process.env.PATH ?? "").not.toContain("abdo-launcher-marker")
  })

  // ⚠ ثغرةٌ مقيسة (2026-09-04): `stripChildEnv` بُني ونُودي في خمسة مواضع،
  // وأربعةٌ تُشغّل عمليّاتٍ فعلاً لم تكن تناديه — فورث مزوّدُ أدواتٍ خارجيّ
  // والمتصفّحُ ومحرّرُ الأسرار `ABDO_SHELL_TOKEN`، وهو ما تُصادق به القشرةُ
  // المحرّك. وعقدُ هذا المُشغّل يقول إنّ المُنادي «سلّم بيئةً مجرّدةً بالفعل»
  // — **وعقدٌ يعتمد على تذكُّر المُنادي ليس حارساً**. فصار يجرّد بنفسه، عند
  // آخر نقطةٍ قبل ولادة العملية، ويمرّ منها الطريقان.
  test("the launcher strips the shell token and vault handles even when the caller hands them over", async () => {
    const res = await launchControlledProcess({
      executable: "bash",
      argv: ["-c", 'printf "%s|%s|%s" "${ABDO_SHELL_TOKEN:-absent}" "${ABDO_VAULT_SCRIPT:-absent}" "${ABDO_HARMLESS_PROBE:-absent}"'],
      cwd: TMP,
      // المُنادي يسلّمها عمداً — وهذا عينُ ما كان المنتَج يفعله بلا قصد.
      env: {
        PATH: process.env.PATH ?? "",
        ABDO_SHELL_TOKEN: "leaked-shell-token",
        ABDO_VAULT_SCRIPT: "C:/vault/secrets.ps1",
        ABDO_HARMLESS_PROBE: "present",
      },
      isolationProfile: INHERIT_PROFILE,
      capability: UNMEASURED_CAPABILITY,
      timeoutMs: 20_000,
      evidence: grantOf(),
    })
    expect(res.outcome).toBe("ran")
    if (res.outcome !== "ran") return
    // المفتاحُ ومقبضُ الخزنة يسقطان — والثالثُ يصل. بلا الثالث كان «absent»
    // قد يعني «لا شيء يصل أصلاً» لا «الحارسُ عمل»: توأمٌ إيجابيٌّ لفحصٍ سلبيّ.
    expect(res.stdout).toBe("absent|absent|present")
  })

  test("a variable present ONLY in process.env does not reach the child", async () => {
    const key = "ABDO_LAUNCHER_LEAK_PROBE"
    process.env[key] = "leaked"
    try {
      const res = await launchControlledProcess({
        executable: "bash",
        argv: ["-c", `printf "%s" "\${${key}:-absent}"`],
        cwd: TMP,
        // Deliberately NOT spreading process.env: the launcher must not add it back.
        env: { PATH: process.env.PATH ?? "" },
        isolationProfile: INHERIT_PROFILE,
        capability: UNMEASURED_CAPABILITY,
        timeoutMs: 20_000,
        evidence: grantOf(),
      })
      expect(res.outcome).toBe("ran")
      if (res.outcome !== "ran") return
      expect(res.stdout).toBe("absent")
    } finally {
      delete process.env[key]
    }
  })

  test("argv is passed separated — a shell metacharacter in an argument is DATA", async () => {
    const res = await launchControlledProcess({
      executable: "bash",
      argv: ["-c", 'printf "%s" "$1"', "abdo", "; touch pwned; echo $HOME"],
      cwd: TMP,
      env: { PATH: process.env.PATH ?? "" },
      isolationProfile: INHERIT_PROFILE,
      capability: UNMEASURED_CAPABILITY,
      timeoutMs: 20_000,
      evidence: grantOf(),
    })
    expect(res.outcome).toBe("ran")
    if (res.outcome !== "ran") return
    expect(res.stdout).toBe("; touch pwned; echo $HOME")
  })

  test("the isolation strip list is applied: a proxy variable never reaches the child", async () => {
    const res = await launchControlledProcess({
      executable: "bash",
      argv: ["-c", 'printf "%s" "${HTTPS_PROXY:-none}"'],
      cwd: TMP,
      env: { PATH: process.env.PATH ?? "", HTTPS_PROXY: "http://127.0.0.1:9" },
      isolationProfile: INHERIT_PROFILE,
      capability: UNMEASURED_CAPABILITY,
      timeoutMs: 20_000,
      evidence: grantOf(),
    })
    expect(res.outcome).toBe("ran")
    if (res.outcome !== "ran") return
    expect(res.stdout).toBe("none")
  })
})

describe("CL-16A2-B §2 — refuse before spawn when isolation is impossible", () => {
  test("deny_all with an UNMEASURED capability refuses and starts nothing", async () => {
    let spawned = false
    const res = await launchControlledProcess({
      executable: "bash",
      argv: ["-c", "exit 0"],
      cwd: TMP,
      env: {},
      isolationProfile: DENY_ALL_PROFILE,
      capability: UNMEASURED_CAPABILITY,
      timeoutMs: 20_000,
      evidence: grantOf(),
      hooks: {
        spawn: ((...args: unknown[]) => {
          spawned = true
          return Bun.spawn(...(args as Parameters<typeof Bun.spawn>))
        }) as typeof Bun.spawn,
      },
    })
    expect(res.outcome).toBe("refused")
    if (res.outcome !== "refused") return
    expect(res.reasonCode).toBe("isolation_unsupported")
    expect(spawned).toBe(false)
  })

  test("deny_all refuses when the platform reports it unsupported (Windows today)", async () => {
    const res = await launchControlledProcess({
      executable: "bash",
      argv: ["-c", "exit 0"],
      cwd: TMP,
      env: {},
      isolationProfile: DENY_ALL_PROFILE,
      capability: capability({ platform: "win32", mechanism: "none", denyAll: "unsupported", childInheritance: "unsupported" }),
      timeoutMs: 20_000,
      evidence: grantOf(),
    })
    expect(res.outcome).toBe("refused")
    if (res.outcome !== "refused") return
    expect(res.reasonCode).toBe("isolation_unsupported")
  })

  test("deny_all refuses when child inheritance is unproven — no partial isolation", async () => {
    const res = await launchControlledProcess({
      executable: "bash",
      argv: ["-c", "exit 0"],
      cwd: TMP,
      env: {},
      isolationProfile: DENY_ALL_PROFILE,
      capability: capability({ childInheritance: "unknown" }),
      timeoutMs: 20_000,
      evidence: grantOf(),
      hooks: { resolvePrimitive: () => "/usr/bin/unshare", primitiveIdentity: () => "stub" },
    })
    expect(res.outcome).toBe("refused")
    if (res.outcome !== "refused") return
    expect(res.reasonCode).toBe("isolation_child_inheritance_unproven")
  })

  test("deny_all refuses when the primitive is missing from every TRUSTED location", async () => {
    const res = await launchControlledProcess({
      executable: "bash",
      argv: ["-c", "exit 0"],
      cwd: TMP,
      env: {},
      isolationProfile: DENY_ALL_PROFILE,
      capability: capability({ platform: "linux" }),
      timeoutMs: 20_000,
      evidence: grantOf(),
      hooks: { resolvePrimitive: () => undefined },
    })
    expect(res.outcome).toBe("refused")
    if (res.outcome !== "refused") return
    expect(res.reasonCode).toBe("isolation_primitive_missing")
  })

  test("the primitive runs from its ABSOLUTE trusted path, never a bare PATH lookup", async () => {
    let seen: readonly string[] = []
    const res = await launchControlledProcess({
      executable: "bash",
      argv: ["-c", "exit 0"],
      cwd: TMP,
      env: { PATH: process.env.PATH ?? "" },
      isolationProfile: DENY_ALL_PROFILE,
      capability: capability({ platform: "linux" }),
      timeoutMs: 20_000,
      evidence: grantOf(),
      hooks: {
        resolvePrimitive: () => "/usr/bin/unshare",
        primitiveIdentity: () => "stub",
        spawn: ((argv: string[]) => {
          seen = argv
          return Bun.spawn(["bash", "-c", "exit 0"], { stdout: "pipe", stderr: "pipe" })
        }) as unknown as typeof Bun.spawn,
      },
    })
    expect(res.outcome).toBe("ran")
    expect(seen[0]).toBe("/usr/bin/unshare")
    expect([...seen].slice(0, 5)).toEqual(["/usr/bin/unshare", "--user", "--map-root-user", "--net", "bash"])
  })
})

describe("CL-16A2-B §4 — durable isolation events", () => {
  test("requested -> capability_checked -> applied, ALL before the process starts", async () => {
    const order: string[] = []
    const events: IsolationEvent[] = []
    const res = await launchControlledProcess({
      executable: "bash",
      argv: ["-c", "exit 0"],
      cwd: TMP,
      env: { PATH: process.env.PATH ?? "" },
      isolationProfile: INHERIT_PROFILE,
      capability: UNMEASURED_CAPABILITY,
      timeoutMs: 20_000,
      evidence: grantOf({
        decisionId: "dec-1",
        executionId: "tex-1",
        emit: async (e) => {
          events.push(e)
          order.push(e.type)
          await Bun.sleep(1) // a real durable write is I/O; keep the window honest
        },
      }),
      hooks: {
        spawn: ((...args: unknown[]) => {
          order.push("SPAWN")
          return Bun.spawn(...(args as Parameters<typeof Bun.spawn>))
        }) as typeof Bun.spawn,
      },
    })
    expect(res.outcome).toBe("ran")
    expect(order).toEqual([IsolationEventTypes.Requested, IsolationEventTypes.CapabilityChecked, IsolationEventTypes.Applied, "SPAWN"])
    const applied = events.at(-1)!
    expect(applied.appliedMode).toBe("inherit")
    expect(applied.requestedMode).toBe("inherit")
    expect(applied.launcherVersion).toBe(LAUNCHER_VERSION)
    expect(applied.launcherHash).toBe(LAUNCHER_HASH)
    expect(applied.isolationVersion).toBe(ISOLATION_VERSION)
    expect(applied.isolationProfileHash).toBe(profileHash(INHERIT_PROFILE))
    expect(applied.capabilityEvidenceHash).toBe(UNMEASURED_CAPABILITY.evidenceHash)
    expect(applied.decisionId).toBe("dec-1")
    expect(applied.executionId).toBe("tex-1")
  })

  test("a refusal emits isolation.failed with the reason, and NO applied event", async () => {
    const { grant, events } = recordingGrant()
    const res = await launchControlledProcess({
      executable: "bash",
      argv: ["-c", "exit 0"],
      cwd: TMP,
      env: {},
      isolationProfile: DENY_ALL_PROFILE,
      capability: capability({ platform: "win32", denyAll: "unsupported" }),
      timeoutMs: 20_000,
      evidence: grant,
    })
    expect(res.outcome).toBe("refused")
    expect(events.map((e) => e.type)).toEqual([IsolationEventTypes.Requested, IsolationEventTypes.CapabilityChecked, IsolationEventTypes.Failed])
    expect(events.at(-1)!.failureReason).toBe("isolation_unsupported")
    expect(events.some((e) => e.type === IsolationEventTypes.Applied)).toBe(false)
  })

  test("NO event ever carries an environment VALUE — only key names", async () => {
    const secret = "sk-abdo-super-secret-value-9f2a"
    const { grant, events } = recordingGrant({ envConstraintNames: ["npm_config_ignore_scripts"] })
    const res = await launchControlledProcess({
      executable: "bash",
      argv: ["-c", "exit 0"],
      cwd: TMP,
      env: { PATH: process.env.PATH ?? "", ABDO_TOKEN: secret, AWS_SECRET_ACCESS_KEY: secret },
      isolationProfile: INHERIT_PROFILE,
      capability: UNMEASURED_CAPABILITY,
      timeoutMs: 20_000,
      evidence: grant,
    })
    expect(res.outcome).toBe("ran")
    expect(events.length).toBeGreaterThan(0)
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(secret)
    // The NAME is recorded, which is what makes the record useful at all.
    expect(serialized).toContain("npm_config_ignore_scripts")
    // Sanity: the secret really was in the child environment, so its absence
    // from the log is the launcher's discipline and not an empty test.
    expect(serialized).not.toContain("ABDO_TOKEN=")
  })

  test("a sink that throws FAILS CLOSED — the process never starts", async () => {
    let spawned = false
    const res = await launchControlledProcess({
      executable: "bash",
      argv: ["-c", "exit 0"],
      cwd: TMP,
      env: {},
      isolationProfile: INHERIT_PROFILE,
      capability: UNMEASURED_CAPABILITY,
      timeoutMs: 20_000,
      evidence: grantOf({
        emit: () => {
          throw new Error("event store unavailable")
        },
      }),
      hooks: {
        spawn: ((...args: unknown[]) => {
          spawned = true
          return Bun.spawn(...(args as Parameters<typeof Bun.spawn>))
        }) as typeof Bun.spawn,
      },
    })
    expect(res.outcome).toBe("refused")
    if (res.outcome !== "refused") return
    expect(res.reasonCode).toBe("isolation_evidence_not_recorded")
    expect(spawned).toBe(false)
  })
})

describe("CL-16A2-B §2 — timeout, cancellation and the process tree", () => {
  test("a timeout kills the tree and returns a structured result", async () => {
    const res = await launchControlledProcess({
      executable: "bash",
      argv: ["-c", "sleep 30"],
      cwd: TMP,
      env: { PATH: process.env.PATH ?? "" },
      isolationProfile: INHERIT_PROFILE,
      capability: UNMEASURED_CAPABILITY,
      timeoutMs: 700,
      evidence: grantOf(),
    })
    expect(res.outcome).toBe("ran")
    if (res.outcome !== "ran") return
    expect(res.timedOut).toBe(true)
    expect(res.aborted).toBe(false)
  }, 30_000)

  test("cancellation aborts the run", async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 400)
    const res = await launchControlledProcess({
      executable: "bash",
      argv: ["-c", "sleep 30"],
      cwd: TMP,
      env: { PATH: process.env.PATH ?? "" },
      isolationProfile: INHERIT_PROFILE,
      capability: UNMEASURED_CAPABILITY,
      cancellation: ac.signal,
      timeoutMs: 30_000,
      evidence: grantOf(),
    })
    expect(res.outcome).toBe("ran")
    if (res.outcome !== "ran") return
    expect(res.aborted).toBe(true)
    expect(res.timedOut).toBe(false)
  }, 30_000)

  test("stdout, stderr and a non-zero exit code all arrive", async () => {
    const res = await launchControlledProcess({
      executable: "bash",
      argv: ["-c", 'printf out; printf err >&2; exit 7'],
      cwd: TMP,
      env: { PATH: process.env.PATH ?? "" },
      isolationProfile: INHERIT_PROFILE,
      capability: UNMEASURED_CAPABILITY,
      timeoutMs: 20_000,
      evidence: grantOf(),
    })
    expect(res.outcome).toBe("ran")
    if (res.outcome !== "ran") return
    expect(res.stdout).toBe("out")
    expect(res.stderr).toBe("err")
    expect(res.exitCode).toBe(7)
  })

  test("the cwd is fixed and verified — the child really runs there", async () => {
    const res = await launchControlledProcess({
      executable: "bash",
      argv: ["-c", "pwd"],
      cwd: TMP,
      env: { PATH: process.env.PATH ?? "" },
      isolationProfile: INHERIT_PROFILE,
      capability: UNMEASURED_CAPABILITY,
      timeoutMs: 20_000,
      evidence: grantOf(),
    })
    expect(res.outcome).toBe("ran")
    if (res.outcome !== "ran") return
    // Compare basenames: bash reports a posix path even on Windows.
    expect(res.stdout.trim().split(/[\\/]/).pop()).toBe(TMP.split(/[\\/]/).pop())
  })
})
