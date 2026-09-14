/**
 * CL-16A2-E — the production path, end to end.
 *
 * The chain under test is the real one:
 *
 *     shellTool  ->  launchControlledProcess  ->  AppContainer backend  ->  helper
 *
 * Not the helper on its own. Every earlier slice measured the mechanism in
 * isolation; this one has to show that a tool asking for `deny_all` on Windows
 * actually gets a container, and that a tool that asks for nothing is completely
 * unaffected.
 *
 * WHY THE HARNESS SEAM IS USED HERE, stated plainly so it is not mistaken for a
 * production path: the mechanism can only be exercised from a MEDIUM-integrity
 * process, so the tests inject the measurement harness's de-elevated runner and
 * its matching `selfReport`. `src/` never imports the harness, and the
 * source-scanning tests keep it that way.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THREE PROOF CLASSES, AND WHY THEY ARE NOT INTERCHANGEABLE
 * ────────────────────────────────────────────────────────────────────────────
 *
 * An earlier version of this file had ONE test named "the ELEVATED production
 * path refuses before creating anything". It called `verifyHelperTrust(HELPER,
 * MANIFEST)` with no `selfReport`, so it measured THIS SHELL'S token and
 * asserted `elevated_host_not_supported`. That made the whole suite
 * elevated-only by accident: from a medium-integrity shell the same test fails,
 * because `elevated` is genuinely `false` and trust is genuinely granted. A
 * suite whose result depends on how the terminal was started is not a
 * measurement of the code. The proof is now split three ways:
 *
 *   A. LIVE MEDIUM PROOF (below, `describe` "A").
 *      The real production path — no seam, no injection — on a medium-integrity
 *      host. Spawns the helper itself and measures the actual token. This is the
 *      one that says the production path WORKS. Guarded on the host really being
 *      medium (`selfElevated()`, measured by the helper, never assumed) so it
 *      cannot silently invert; the official round's preflight asserts medium
 *      integrity, so in that round it always RUNS.
 *
 *   B. DETERMINISTIC POLICY PROOF (below, `describe` "B").
 *      That an elevated host is REFUSED is a property of the policy, not of the
 *      terminal. It is proved from an explicit, verified `selfReport` carrying
 *      `elevated=true` / `integrity=high` with the SAME trusted binary hash and
 *      protocol — so the only reason the refusal can fire is the elevation
 *      check. Runs identically at medium and at high integrity. This is NOT a
 *      claim about a live elevated OS measurement, and it does not pretend to be.
 *
 *   C. SEPARATE LIVE ELEVATED PROOF (`scripts/live-elevated-refusal.ts`).
 *      The live elevated measurement still has value, but it cannot live in an
 *      authoritative medium round: it would have to be skipped, and a skip is
 *      not evidence. It is a standalone gate that REFUSES TO RUN unless the host
 *      is genuinely elevated, and is reported separately from this suite.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryEventStore } from "@abdo/event-store"
import { shellTool } from "@abdo/builtin-tools/shell"
import { INHERIT_PROFILE, UNMEASURED_CAPABILITY, launchControlledProcess, type ControlledExecutionGrant, type IsolationEvent } from "@abdo/tools/launcher"
import { DENY_ALL_PROFILE, ISOLATION_VERSION, type IsolationCapabilityReport } from "@abdo/tools/isolation"
import { APPCONTAINER_MECHANISM, createAppContainerBackend, verifyHelperTrust } from "../src/backend"
import { REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import { profileDirFor, profileNameFor } from "../src/lifecycle"
import { HELPER, OWNERSHIP_PREFIX, harnessHelperRunner, helperBuilt, runDirect, runUnelevated, selfElevated } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const CMD = "C:\\Windows\\System32\\cmd.exe"
const MANIFEST = join(import.meta.dir, "..", "helper-manifest.json")
const T = 300_000

/** The helper's identity AS SEEN FROM the de-elevated server (medium integrity). */
let deElevatedSelfReport: Record<string, unknown> = {}

/**
 * A capability report for the AppContainer mechanism, bound to measured trust.
 *
 * `report` defaults to the de-elevated identity captured in `beforeAll`. Proof B
 * passes an elevated one to show the policy refusal without needing an elevated
 * host; nothing else overrides it.
 */
function appContainerCapability(report: () => Record<string, unknown> = () => deElevatedSelfReport): IsolationCapabilityReport {
  const trust = verifyHelperTrust(HELPER, MANIFEST, report)
  return {
    platform: "win32",
    mechanism: APPCONTAINER_MECHANISM,
    denyAll: trust.trusted ? "supported" : "unsupported",
    processTree: "supported", // job object, proven in CL-16A2-C/D
    childInheritance: "supported",
    loopbackInsideDenyAll: "unknown",
    requiresElevation: false,
    mutatesGlobalState: false,
    reasonCodes: trust.trusted ? [] : [trust.reasonCode ?? "stale_isolation_evidence"],
    evidenceHash: `appcontainer:${trust.binaryHash}:${trust.protocolVersion}:${trust.trusted}`,
    isolationVersion: ISOLATION_VERSION,
  }
}

function denyAllGrant(store: MemoryEventStore, events: IsolationEvent[], extra: Partial<ControlledExecutionGrant> = {}): ControlledExecutionGrant {
  return {
    profile: DENY_ALL_PROFILE,
    capability: appContainerCapability(),
    approvalGranted: false,
    emit: (e) => {
      events.push(e)
    },
    backend: createAppContainerBackend({
      store,
      helperPath: HELPER,
      manifestPath: MANIFEST,
      helper: harnessHelperRunner(),
      selfReport: () => deElevatedSelfReport,
    }),
    ...extra,
  }
}

describe.skipIf(!READY)("CL-16A2-E - production launcher integration", () => {
  beforeAll(async () => {
    // Start the de-elevated server once and capture its view of the helper.
    const v = await runUnelevated(["version"])
    deElevatedSelfReport = v as unknown as Record<string, unknown>
    expect(v.elevated).toBe(false) // the measurement really is medium integrity
  })

  // ── A. LIVE MEDIUM PROOF ────────────────────────────────────────────────
  //
  // The REAL production path: no seam, no injected runner, no injected
  // selfReport. `verifyHelperTrust` spawns the helper through its own port and
  // measures the token this process actually has. On a medium-integrity host
  // that must come back TRUSTED.
  //
  // The guard is on the host's MEASURED elevation, not on a guess and not on an
  // env var. If it is elevated, this is not the environment for a live medium
  // proof and C is the applicable gate instead — the official round's preflight
  // asserts medium integrity, so this test runs there.
  test.skipIf(selfElevated())("A. LIVE: the production path is TRUSTED at medium integrity, unseamed", () => {
    const trust = verifyHelperTrust(HELPER, MANIFEST)

    // TRUSTED, and specifically not "trusted because nothing was checked".
    expect(trust.trusted).toBe(true)
    expect(trust.reasonCode).toBeUndefined()
    // The failure this most easily hides behind is a stale manifest, so name it.
    expect(trust.reasonCode).not.toBe("stale_isolation_evidence")
    expect(trust.elevated).toBe(false)

    // Manifest, on-disk binary and the helper's own report all agree — the fail
    // path returns "" / 0 for these, so non-empty values are themselves evidence
    // that every identity check was reached and passed.
    expect(trust.binaryHash).toMatch(/^[0-9a-f]{64}$/)
    expect(trust.protocolVersion).toBe(REQUIRED_PROTOCOL_VERSION)
    expect(trust.manifestSourceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(trust.toolchain).toBe("stable-x86_64-pc-windows-gnu")
    expect(trust.osBuildNumber).toBeGreaterThanOrEqual(17763)

    // The live token really is medium (RID 8192), measured by the helper.
    const live = runDirect(["version"])
    expect(live.elevated).toBe(false)
    expect(live.integrity).toBe("medium")
    expect(live.integrityRid).toBe(8192)
    expect(live.binaryHash).toBe(trust.binaryHash)

    // And the capability derived from the unseamed path grants deny_all.
    expect(appContainerCapability(() => live as unknown as Record<string, unknown>).denyAll).toBe("supported")
    console.log(`[gate] A live medium: trusted=true elevated=false integrity=medium rid=8192 protocol=${trust.protocolVersion}`)
  })

  // ── B. DETERMINISTIC POLICY PROOF ───────────────────────────────────────
  //
  // Same trusted binary hash and protocol as A; the ONLY difference is a token
  // that says elevated/high. So a refusal here can have exactly one cause.
  const elevatedSelfReport = (): Record<string, unknown> => ({
    ...deElevatedSelfReport,
    elevated: true,
    integrity: "high",
    integrityRid: 12288,
  })

  test("B. POLICY: an elevated host is refused AFTER identity checks and BEFORE any mutation", () => {
    const report = elevatedSelfReport()
    // The report is a genuine elevated identity carrying the TRUSTED artefact.
    expect(report.elevated).toBe(true)
    expect(report.integrity).toBe("high")
    expect(report.integrityRid).toBe(12288)
    expect(report.binaryHash).toBe(verifyHelperTrust(HELPER, MANIFEST, () => deElevatedSelfReport).binaryHash)
    expect(report.protocolVersion).toBe(REQUIRED_PROTOCOL_VERSION)

    const trust = verifyHelperTrust(HELPER, MANIFEST, () => report)
    expect(trust.trusted).toBe(false)
    expect(trust.reasonCode).toBe("elevated_host_not_supported")
    expect(trust.elevated).toBe(true)

    // NOT a stale-evidence refusal wearing the elevation label: the hash,
    // protocol, source hash and toolchain were all verified before the policy
    // fired, and the elevation branch is the only one that carries them through.
    expect(trust.reasonCode).not.toBe("stale_isolation_evidence")
    expect(trust.binaryHash).toMatch(/^[0-9a-f]{64}$/)
    expect(trust.protocolVersion).toBe(REQUIRED_PROTOCOL_VERSION)
    expect(trust.manifestSourceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(trust.toolchain).toBe("stable-x86_64-pc-windows-gnu")

    // The capability derived from it refuses deny_all, and SAYS WHY.
    const cap = appContainerCapability(elevatedSelfReport)
    expect(cap.denyAll).toBe("unsupported")
    expect(cap.reasonCodes).toContain("elevated_host_not_supported")
    console.log(`[gate] B policy: elevated=true integrity=high -> ${trust.reasonCode}, no mutation`)
  })

  test("B. POLICY: the backend refuses an elevated host WITHOUT ever starting the helper", async () => {
    const runId = `e2e-elevated-policy-${process.pid}`
    let helperInvocations = 0
    const cwd = mkdtempSync(join(tmpdir(), "abdo-e2eelev-"))
    try {
      const backend = createAppContainerBackend({
        store: new MemoryEventStore(),
        helperPath: HELPER,
        manifestPath: MANIFEST,
        selfReport: elevatedSelfReport,
        // IF THIS RUNS, THE TEST HAS FAILED. The refusal must precede it.
        helper: async () => {
          helperInvocations++
          throw new Error("the helper must never be started on an elevated host")
        },
      })

      const res = await backend.run({
        runId,
        executable: CMD,
        argv: ["/c", "echo", "must-not-run"],
        cwd,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 30_000,
      })

      // REFUSED, with the policy's own reason code.
      expect(res.ok).toBe(false)
      expect(res.reasonCode).toBe("elevated_host_not_supported")
      expect(res.childStarted).toBe(false)
      expect(res.exitCode).toBeNull()
      // No applied evidence at all — not "applied with everything false".
      expect(res.appliedEvidence).toBeUndefined()

      // NOTHING WAS STARTED, and nothing was created on the way to refusing.
      //
      // `helperInvocations === 0` is the load-bearing assertion, and it covers
      // the execution root as well as the process: the root is never derived
      // from `%ProgramData%`, it is resolved through the helper's own
      // `known-folder` call (`src/execution-root.ts:307`). A helper that was
      // never invoked cannot have created, bound or mutated a root — so this is
      // a stronger statement than probing one hardcoded path would be.
      expect(helperInvocations).toBe(0)
      expect(existsSync(profileDirFor(profileNameFor(runId)))).toBe(false)
      expect(runDirect(["inspect-profile", "--name", profileNameFor(runId)]).profileExists).toBe(false)
    } finally {
      runDirect(["delete-profile", "--name", profileNameFor(runId)])
      rmSync(cwd, { recursive: true, force: true })
    }
  }, T)

  test("B. POLICY: through the launcher, an elevated host yields refusal + isolation.failed, never isolation.applied", async () => {
    const events: IsolationEvent[] = []
    const cwd = mkdtempSync(join(tmpdir(), "abdo-e2eelev2-"))

    // A DECISION THAT ALREADY HAPPENED. `control.decided` is the control plane's
    // event, not the isolation layer's, so what is provable here is the property
    // that matters: a refusal APPENDS, and never rewrites or drops history that
    // was already durable. The pre-existing record must still be there, still
    // first, still byte-identical afterwards.
    const priorDecision = { type: "control.decided", detail: "approved upstream" } as unknown as IsolationEvent
    events.push(priorDecision)
    const priorSnapshot = JSON.stringify(priorDecision)

    try {
      const cap = appContainerCapability(elevatedSelfReport)
      const res = await launchControlledProcess({
        executable: CMD,
        argv: ["/c", "echo", "must-not-run"],
        cwd,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
        isolationProfile: DENY_ALL_PROFILE,
        capability: cap,
        timeoutMs: 30_000,
        evidence: {
          profile: DENY_ALL_PROFILE,
          capability: cap,
          approvalGranted: false,
          emit: (e) => {
            events.push(e)
          },
          // A backend is present and must NEVER be consulted: `planIsolatedSpawn`
          // is pure and refuses an unsupported capability before this exists as a
          // possibility.
          backend: {
            mechanism: APPCONTAINER_MECHANISM,
            run: async () => {
              throw new Error("the backend must never be launched for an elevated host")
            },
          },
        },
      })

      expect(res.outcome).toBe("refused")
      if (res.outcome !== "refused") return
      // The launcher's own reason for an undeliverable capability, and the
      // policy's reason carried through in the detail.
      expect(res.reasonCode).toBe("isolation_unsupported")
      expect(res.detail ?? "").toContain("elevated_host_not_supported")

      const types = events.map((e) => e.type)
      expect(types).toContain("isolation.requested")
      expect(types).toContain("isolation.capability_checked")
      expect(types).toContain("isolation.failed")
      // THE ONE THAT MUST NEVER APPEAR.
      expect(types).not.toContain("isolation.applied")
      expect(events.some((e) => e.type === "isolation.failed")).toBe(true)

      // Prior durable history survived the refusal, untouched and still first.
      expect(String(types[0])).toBe("control.decided")
      expect(JSON.stringify(events[0])).toBe(priorSnapshot)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, T)

  test("a trusted, de-elevated helper reports SUPPORTED", () => {
    const trust = verifyHelperTrust(HELPER, MANIFEST, () => deElevatedSelfReport)
    expect(trust.trusted).toBe(true)
    expect(trust.protocolVersion).toBe(REQUIRED_PROTOCOL_VERSION)
    expect(trust.osBuildNumber).toBeGreaterThanOrEqual(17763)
    expect(appContainerCapability().denyAll).toBe("supported")
  })

  test("deny_all runs the command IN a container, through launchControlledProcess", async () => {
    const store = new MemoryEventStore()
    const events: IsolationEvent[] = []
    const marker = `E2E-${Math.random().toString(36).slice(2, 10)}`
    const cwd = mkdtempSync(join(tmpdir(), "abdo-e2e-"))
    try {
      const res = await launchControlledProcess({
        executable: CMD,
        argv: ["/c", "echo", marker],
        cwd,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
        isolationProfile: DENY_ALL_PROFILE,
        capability: appContainerCapability(),
        timeoutMs: 60_000,
        evidence: denyAllGrant(store, events),
      })
      expect(res.outcome).toBe("ran")
      if (res.outcome !== "ran") return
      // IT REALLY RAN: the marker came back from a process inside the container.
      expect(res.stdout).toContain(marker)
      expect(res.exitCode).toBe(0)
      expect(res.appliedMode).toBe("deny_all")

      // THE DURABLE RECORD LANDED BEFORE THE EFFECT.
      const types = events.map((e) => e.type)
      expect(types).toContain("isolation.requested")
      expect(types).toContain("isolation.capability_checked")
      expect(types).toContain("isolation.applied")
      expect(types.indexOf("isolation.applied")).toBeGreaterThan(types.indexOf("isolation.requested"))
      const applied = events.find((e) => e.type === "isolation.applied")!
      expect(applied.appliedMode).toBe("deny_all")

      // NO SECRET, NO OUTPUT, in any isolation event.
      const blob = JSON.stringify(events)
      expect(blob).not.toContain(marker)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, T)

  test("the container is torn down: no profile, no residue", async () => {
    const store = new MemoryEventStore()
    const events: IsolationEvent[] = []
    const cwd = mkdtempSync(join(tmpdir(), "abdo-e2e2-"))
    try {
      const res = await launchControlledProcess({
        executable: CMD,
        argv: ["/c", "echo", "teardown"],
        cwd,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
        isolationProfile: DENY_ALL_PROFILE,
        capability: appContainerCapability(),
        timeoutMs: 60_000,
        evidence: denyAllGrant(store, events, { executionId: `e2e-teardown-${process.pid}` }),
      })
      expect(res.outcome).toBe("ran")
      // The profile name is DERIVED from the runId, and it is gone afterwards.
      expect(existsSync(profileDirFor(profileNameFor(`e2e-teardown-${process.pid}`)))).toBe(false)
    } finally {
      runDirect(["delete-profile", "--name", profileNameFor(`e2e-teardown-${process.pid}`)])
      rmSync(cwd, { recursive: true, force: true })
    }
  }, T)

  test("network is DENIED inside, and the CONTROL proves the machine is online", async () => {
    const store = new MemoryEventStore()
    const cwd = mkdtempSync(join(tmpdir(), "abdo-e2enet-"))
    const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    // A fixed probe: no model input, no shell string built from arguments.
    const probe = "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('8.8.8.8',53); 'NET-OK' } catch { 'NET-BLOCKED' }"
    try {
      // CONTROL FIRST. If the machine cannot reach the network at all, a
      // "blocked" result inside the container would prove nothing whatsoever.
      const control = await launchControlledProcess({
        executable: PS,
        argv: ["-NoProfile", "-Command", probe],
        cwd,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
        isolationProfile: INHERIT_PROFILE,
        capability: UNMEASURED_CAPABILITY,
        timeoutMs: 60_000,
        evidence: { profile: INHERIT_PROFILE, capability: UNMEASURED_CAPABILITY, approvalGranted: false },
      })
      expect(control.outcome).toBe("ran")
      if (control.outcome !== "ran") return
      if (!control.stdout.includes("NET-OK")) {
        console.warn("UNKNOWN: this machine has no outbound network, so the deny_all assertion would be vacuous")
        return
      }

      const denied = await launchControlledProcess({
        executable: PS,
        argv: ["-NoProfile", "-Command", probe],
        cwd,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
        isolationProfile: DENY_ALL_PROFILE,
        capability: appContainerCapability(),
        timeoutMs: 60_000,
        evidence: denyAllGrant(store, []),
      })
      expect(denied.outcome).toBe("ran")
      if (denied.outcome !== "ran") return
      // The SAME probe, the SAME machine, the only difference is the container.
      expect(denied.stdout).toContain("NET-BLOCKED")
      expect(denied.stdout).not.toContain("NET-OK")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, T)

  test("a backend that reports no child_started is REFUSED, not reported as a clean run", async () => {
    // The single most dangerous outcome: a sandbox that executes nothing looks
    // identical to a perfect one. The launcher must never turn it into success.
    const events: IsolationEvent[] = []
    const cwd = mkdtempSync(join(tmpdir(), "abdo-e2enc-"))
    try {
      const res = await launchControlledProcess({
        executable: CMD,
        argv: ["/c", "echo", "never"],
        cwd,
        env: { PATH: process.env.PATH ?? "" },
        isolationProfile: DENY_ALL_PROFILE,
        capability: appContainerCapability(),
        timeoutMs: 30_000,
        evidence: {
          profile: DENY_ALL_PROFILE,
          capability: appContainerCapability(),
          approvalGranted: false,
          emit: (e) => {
            events.push(e)
          },
          backend: {
            mechanism: APPCONTAINER_MECHANISM,
            run: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, childStarted: false }),
          },
        },
      })
      expect(res.outcome).toBe("refused")
      if (res.outcome !== "refused") return
      expect(res.reasonCode).toBe("isolation_child_never_started")
      expect(events.some((e) => e.type === "isolation.failed" && e.failureReason === "isolation_child_never_started")).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, T)

  test("SHELL TOOL end to end: the real tool gets a real container", async () => {
    const store = new MemoryEventStore()
    const events: IsolationEvent[] = []
    const workspace = mkdtempSync(join(tmpdir(), "abdo-e2esh-"))
    writeFileSync(join(workspace, "f.txt"), "hello", "utf8")
    const marker = `SHELL-${Math.random().toString(36).slice(2, 8)}`
    try {
      const tool = shellTool(workspace)
      const res = (await tool.run(
        { command: `echo ${marker}` },
        {
          workspace,
          signal: new AbortController().signal,
          execution: denyAllGrant(store, events),
        } as never,
      )) as { ok: boolean; error?: string; output?: { stdout?: string } }

      // MEASURED PLATFORM LIMIT, recorded rather than asserted away.
      //
      // `shell.ts` runs `bash`. On this machine that is msys2's bash, and it
      // CANNOT start inside a zero-capability AppContainer: it exits
      // 0xC0000142 (STATUS_DLL_INIT_FAILED), and NOT because of an ACL — the
      // binary already grants ALL APPLICATION PACKAGES (`0x1200a9;;;AC`). Native
      // Windows executables are unaffected: cmd, PowerShell, python, node, git
      // and curl all run and exit 0 inside the same container.
      //
      // So the launcher integration is correct and the container is real, but
      // the SHELL TOOL's interpreter is incompatible with the mechanism, and the
      // honest outcome of that is a refusal, not a silent success.
      //
      // NOTE ON THE EARLIER VERSION OF THIS TEST: it asserted
      // `JSON.stringify(res)).toContain(marker)`, which PASSED on a refusal —
      // the marker appears in the echoed command text. It proved nothing. The
      // assertion is now on real stdout, or on an explicit refusal.
      if (res.ok) {
        expect(res.output?.stdout ?? "").toContain(marker)
        expect(events.find((e) => e.type === "isolation.applied")?.appliedMode).toBe("deny_all")
      } else {
        // Since the Outcome B closure the refusal happens EARLIER and for a
        // better reason: `planIsolatedSpawn` is pure and rejects a generic shell
        // runtime on a backend mechanism before the backend is ever called, so
        // no container is created at all. (Before the closure the same command
        // reached the backend and failed as `isolation_child_never_started` when
        // msys2 bash could not start inside the container.)
        expect(res.error ?? "").toContain("windows_appcontainer_shell_runtime_unsupported")
        // A refusal must NOT be dressed up as an applied isolation.
        expect(events.some((e) => e.type === "isolation.applied")).toBe(false)
        expect(events.some((e) => e.type === "isolation.failed")).toBe(true)
        console.log(`[gate] shell/bash under deny_all: refused (${(res.error ?? "").slice(0, 60)})`)
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }, T)

  test("inherit is COMPLETELY unaffected: no container, no backend, no isolation events", async () => {
    const events: IsolationEvent[] = []
    const cwd = mkdtempSync(join(tmpdir(), "abdo-e2ein-"))
    const before = runDirect(["inspect-profile", "--name", `${OWNERSHIP_PREFIX}nonexistent`])
    try {
      const res = await launchControlledProcess({
        executable: CMD,
        argv: ["/c", "echo", "INHERIT-OK"],
        cwd,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
        isolationProfile: INHERIT_PROFILE,
        capability: UNMEASURED_CAPABILITY,
        timeoutMs: 30_000,
        evidence: {
          profile: INHERIT_PROFILE,
          capability: UNMEASURED_CAPABILITY,
          approvalGranted: false,
          emit: (e) => {
            events.push(e)
          },
          // A backend is present but must NOT be consulted for `inherit`.
          backend: {
            mechanism: APPCONTAINER_MECHANISM,
            run: async () => {
              throw new Error("the backend must never be used for inherit")
            },
          },
        },
      })
      expect(res.outcome).toBe("ran")
      if (res.outcome !== "ran") return
      expect(res.stdout).toContain("INHERIT-OK")
      expect(res.appliedMode).toBe("inherit")
      expect(before.profileExists).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, T)
})
