/**
 * CL-16A2-E — Outcome B closure.
 *
 * THE MEASURED FACT THIS ENCODES: the Windows AppContainer mechanism isolates
 * the network correctly, and the obstacle is RUNTIME COMPATIBILITY, not network
 * isolation. Inside a zero-capability container, measured on this machine:
 *
 *     cmd.exe  powershell.exe  python.exe  node.exe  git.exe  curl.exe   exit 0
 *     bash.exe (msys2)                                        0xC0000142
 *
 * and the bash failure is NOT an ACL problem — the binary already grants
 * ALL APPLICATION PACKAGES (`0x1200a9;;;AC`). msys2's runtime cannot initialise
 * without capabilities the container deliberately does not grant.
 *
 * So the capability report distinguishes the two shapes, and a `deny_all`
 * request for a generic shell runtime is REFUSED — before any profile or ACL
 * exists, without calling the backend, and never by falling back to an
 * unisolated run.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryEventStore } from "@abdo/event-store"
import { INHERIT_PROFILE, UNMEASURED_CAPABILITY, launchControlledProcess, type IsolationBackend, type IsolationEvent } from "@abdo/tools/launcher"
import { DENY_ALL_PROFILE, ISOLATION_VERSION, isShellRuntimeExecutable, planIsolatedSpawn, type IsolationCapabilityReport } from "@abdo/tools/isolation"
import { APPCONTAINER_MECHANISM, createAppContainerBackend } from "../src/backend"
import { profileDirFor, profileNameFor } from "../src/lifecycle"
import { HELPER, helperBuilt, harnessHelperRunner, runDirect, runUnelevated } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const MANIFEST = join(import.meta.dir, "..", "helper-manifest.json")
const CMD = "C:\\Windows\\System32\\cmd.exe"
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const WHERE = "C:\\Windows\\System32\\where.exe"
const T = 300_000

let selfReport: Record<string, unknown> = {}

/** The AppContainer capability AS MEASURED: native yes, generic shell no. */
const appContainerCapability = (): IsolationCapabilityReport => ({
  platform: "win32",
  mechanism: APPCONTAINER_MECHANISM,
  denyAll: "supported",
  processTree: "supported",
  childInheritance: "supported",
  loopbackInsideDenyAll: "unknown",
  nativeProcessIsolation: "supported",
  shellRuntimeIsolation: "unsupported",
  requiresElevation: false,
  mutatesGlobalState: false,
  reasonCodes: ["windows_appcontainer_shell_runtime_unsupported"],
  evidenceHash: "outcome-b-capability",
  isolationVersion: ISOLATION_VERSION,
})

/**
 * Resolve a REAL interpreter, skipping Windows Store App Execution Aliases.
 *
 * `where python` returns the `\Microsoft\WindowsApps\python.exe` stub first on
 * this machine. That is a reparse point for a Store app, not an interpreter:
 * run inside the container it emits "EXTRACTING: ...." instead of executing the
 * script. Measuring it would say nothing about whether a native process runs in
 * an AppContainer, so the alias is skipped and an absent real interpreter is
 * reported as UNKNOWN rather than failing or passing vacuously.
 */
const which = (n: string): string => {
  const lines = Bun.spawnSync([WHERE, n], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim().split(/\r?\n/)
  return lines.map((l) => l.trim()).find((l) => l.length > 0 && !l.toLowerCase().includes("\\windowsapps\\")) ?? ""
}

function backendFor(store: MemoryEventStore) {
  return createAppContainerBackend({ store, helperPath: HELPER, manifestPath: MANIFEST, helper: harnessHelperRunner(), selfReport: () => selfReport })
}

/**
 * A working directory the CONTAINER CAN TRAVERSE.
 *
 * MEASURED, and it is a real constraint rather than a test convenience: a cwd
 * under the user profile fails at process startup with
 * "Access to the path ... is denied", because an AppContainer needs traverse
 * rights on EVERY ancestor of its cwd, not just on the leaf. Granting only the
 * leaf was measured and did not help. Granting the ancestors would be exactly
 * the user-profile-wide grant the filesystem-scope rules forbid, so it is left
 * unsolved here and recorded for the filesystem-scope slice.
 *
 * `cmd /c echo` never notices, because it does not touch its cwd; PowerShell,
 * python and node do. That is why this had to be measured rather than assumed.
 */
const CONTAINER_CWD = join(process.env.SystemRoot ?? "C:\\Windows", "Temp")

async function runNative(executable: string, argv: readonly string[], events: IsolationEvent[], runId: string, cwdOverride?: string) {
  const store = new MemoryEventStore()
  const cwd = cwdOverride ?? CONTAINER_CWD
  try {
    return await launchControlledProcess({
      executable,
      argv,
      cwd,
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
      isolationProfile: DENY_ALL_PROFILE,
      capability: appContainerCapability(),
      timeoutMs: 60_000,
      evidence: {
        profile: DENY_ALL_PROFILE,
        capability: appContainerCapability(),
        approvalGranted: false,
        executionId: runId,
        emit: (e) => {
          events.push(e)
        },
        backend: backendFor(store),
      },
    })
  } finally {
    runDirect(["delete-profile", "--name", profileNameFor(runId)])
  }
}

// ─────────────────────────── the refusal is pure, and happens before anything

describe("CL-16A2-E Outcome B - a generic shell runtime is refused, not attempted", () => {
  test("the PURE planner refuses bash on a backend mechanism", () => {
    const plan = planIsolatedSpawn({
      argv: ["bash", "-c", "echo hi"],
      cwd: process.cwd(),
      env: {},
      profile: DENY_ALL_PROFILE,
      capability: appContainerCapability(),
      backendMechanism: APPCONTAINER_MECHANISM,
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.reasonCode).toBe("windows_appcontainer_shell_runtime_unsupported")
      // The message says which shape, and that nothing ran.
      expect(plan.detail).toContain("bash")
      expect(plan.detail).toContain("Native executables are unaffected")
    }
  })

  test("the same planner ALLOWS a native executable under the same capability", () => {
    const plan = planIsolatedSpawn({
      argv: [CMD, "/c", "echo", "hi"],
      cwd: process.cwd(),
      env: {},
      profile: DENY_ALL_PROFILE,
      capability: appContainerCapability(),
      backendMechanism: APPCONTAINER_MECHANISM,
    })
    // Non-vacuity: the refusal above is about the RUNTIME, not about deny_all.
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.applied).toBe("deny_all")
  })

  test("LINUX IS UNCHANGED: bash + deny_all still plans, because it has no backend", () => {
    // The gate is scoped to a backend mechanism. Linux's `unshare` is a wrapper,
    // so a bash command under deny_all plans exactly as it did before this
    // slice — asserted here as a pure regression, runnable on any platform.
    const plan = planIsolatedSpawn({
      argv: ["bash", "-c", "echo hi"],
      cwd: "/tmp",
      env: {},
      profile: DENY_ALL_PROFILE,
      capability: {
        platform: "linux",
        mechanism: "linux-userns-unshare",
        denyAll: "supported",
        processTree: "supported",
        childInheritance: "supported",
        loopbackInsideDenyAll: "down",
        requiresElevation: false,
        mutatesGlobalState: false,
        reasonCodes: [],
        evidenceHash: "linux-fixed",
        isolationVersion: ISOLATION_VERSION,
      },
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.applied).toBe("deny_all")
      expect(plan.argv[0]).toBe("unshare") // the wrapper is still applied
    }
  })

  test("shell runtimes are recognised exactly, and native binaries are not", () => {
    for (const yes of ["bash", "bash.exe", "/bin/bash", "C:\\Program Files\\Git\\usr\\bin\\bash.exe", "sh", "zsh"]) {
      expect(isShellRuntimeExecutable(yes)).toBe(true)
    }
    for (const no of ["cmd.exe", CMD, "powershell.exe", "python.exe", "node", "git.exe", "curl.exe"]) {
      expect(isShellRuntimeExecutable(no)).toBe(false)
    }
  })
})

describe.skipIf(!READY)("CL-16A2-E Outcome B - through the launcher, against the real machine", () => {
  beforeAll(async () => {
    const v = await runUnelevated(["version"])
    selfReport = v as unknown as Record<string, unknown>
    expect(v.elevated).toBe(false)
  })

  test("bash under deny_all: refused BEFORE any profile or ACL, backend never called", async () => {
    const events: IsolationEvent[] = []
    const runId = `ob-bash-${process.pid}`
    let backendCalled = false
    const spyBackend: IsolationBackend = {
      mechanism: APPCONTAINER_MECHANISM,
      run: async () => {
        backendCalled = true
        throw new Error("the backend must not be reached for an unsupported runtime")
      },
    }
    const cwd = mkdtempSync(join(tmpdir(), "abdo-obb-"))
    try {
      const res = await launchControlledProcess({
        executable: "bash",
        argv: ["-c", "echo nope"],
        cwd,
        env: { PATH: process.env.PATH ?? "" },
        isolationProfile: DENY_ALL_PROFILE,
        capability: appContainerCapability(),
        timeoutMs: 30_000,
        evidence: {
          profile: DENY_ALL_PROFILE,
          capability: appContainerCapability(),
          approvalGranted: false,
          executionId: runId,
          emit: (e) => {
            events.push(e)
          },
          backend: spyBackend,
        },
      })
      expect(res.outcome).toBe("refused")
      if (res.outcome === "refused") expect(res.reasonCode).toBe("windows_appcontainer_shell_runtime_unsupported")
      // 1. the backend was never consulted
      expect(backendCalled).toBe(false)
      // 2. NO profile was created — the refusal precedes every OS mutation
      expect(runDirect(["inspect-profile", "--name", profileNameFor(runId)]).profileExists).toBe(false)
      // 3. no applied record, and an explicit failure record
      expect(events.some((e) => e.type === "isolation.applied")).toBe(false)
      const failed = events.find((e) => e.type === "isolation.failed")
      expect(failed?.failureReason).toBe("windows_appcontainer_shell_runtime_unsupported")
      // 4. NO FALLBACK: the result is a refusal, never an inherit run
      expect(res.outcome).not.toBe("ran")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, T)

  test("cmd.exe through the backend: runs, isolated, and reports applied", async () => {
    const events: IsolationEvent[] = []
    const runId = `ob-cmd-${process.pid}`
    const res = await runNative(CMD, ["/c", "echo", "CMD-NATIVE-OK"], events, runId)
    expect(res.outcome).toBe("ran")
    if (res.outcome !== "ran") return
    expect(res.stdout).toContain("CMD-NATIVE-OK")
    expect(res.exitCode).toBe(0)
    expect(res.appliedMode).toBe("deny_all")
    expect(events.find((e) => e.type === "isolation.applied")?.appliedMode).toBe("deny_all")
    expect(existsProfile(runId)).toBe(false)
  }, T)

  test("powershell.exe through the backend: runs, isolated", async () => {
    const events: IsolationEvent[] = []
    const runId = `ob-ps-${process.pid}`
    const res = await runNative(PS, ["-NoProfile", "-Command", "Write-Output PS-NATIVE-OK"], events, runId)
    expect(res.outcome).toBe("ran")
    if (res.outcome !== "ran") return
    expect(res.stdout).toContain("PS-NATIVE-OK")
    expect(events.some((e) => e.type === "isolation.applied")).toBe(true)
  }, T)

  test("native python and node run inside the container", async () => {
    let ran = 0
    for (const [name, args] of [
      ["python", ["-c", "print('PY-NATIVE-OK')"]],
      ["node", ["-e", "console.log('NODE-NATIVE-OK')"]],
    ] as const) {
      const exe = which(name)
      if (!exe) {
        console.warn(`UNKNOWN: ${name} is not on PATH, so this case is not measured here`)
        continue
      }
      const events: IsolationEvent[] = []
      const runId = `ob-${name}-${process.pid}`
      const res = await runNative(exe, args, events, runId)
      expect(res.outcome).toBe("ran")
      if (res.outcome !== "ran") continue

      if (res.stdout.toUpperCase().includes("NATIVE-OK")) {
        expect(res.exitCode).toBe(0)
        ran++
        continue
      }
      // UNREACHABLE, FOR A MEASURED REASON — not a pass and not a silent skip.
      // An interpreter installed under the user profile cannot be executed by
      // the container: it needs traverse on every ancestor of its path, exactly
      // as with the cwd above. Granting that would be the user-profile-wide
      // grant the filesystem-scope rules forbid.
      const underUserProfile = exe.toLowerCase().startsWith((process.env.USERPROFILE ?? "\u0000").toLowerCase())
      if (underUserProfile) {
        console.log(`[gate] ${name}: UNKNOWN - ${exe} is under the user profile, unreachable from the container (ancestor traverse)`)
        continue
      }
      throw new Error(`${name} at ${exe} produced no marker: ${JSON.stringify(res.stdout.slice(0, 120))}`)
    }
    // NON-VACUITY: at least one real native interpreter must have run, or this
    // test proves nothing about native execution at all.
    expect(ran).toBeGreaterThan(0)
  }, T)

  test("an unsupported shell NEVER reports isolation.applied, on any path", async () => {
    // Belt and braces over the specific refusal above: whatever the reason, an
    // unsupported runtime must not leave a record claiming it was contained.
    const events: IsolationEvent[] = []
    const store = new MemoryEventStore()
    const cwd = mkdtempSync(join(tmpdir(), "abdo-obu-"))
    try {
      for (const exe of ["bash", "sh", which("bash") || "bash"]) {
        const res = await launchControlledProcess({
          executable: exe,
          argv: ["-c", "echo x"],
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
            backend: backendFor(store),
          },
        })
        expect(res.outcome).toBe("refused")
      }
      expect(events.some((e) => e.type === "isolation.applied")).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, T)

  test("inherit is untouched by any of this", async () => {
    const events: IsolationEvent[] = []
    const cwd = mkdtempSync(join(tmpdir(), "abdo-obi-"))
    try {
      const res = await launchControlledProcess({
        executable: CMD,
        argv: ["/c", "echo", "INHERIT-STILL-OK"],
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
        },
      })
      expect(res.outcome).toBe("ran")
      if (res.outcome === "ran") {
        expect(res.stdout).toContain("INHERIT-STILL-OK")
        expect(res.appliedMode).toBe("inherit")
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, T)
})

function existsProfile(runId: string): boolean {
  const { existsSync } = require("node:fs") as typeof import("node:fs")
  return existsSync(profileDirFor(profileNameFor(runId)))
}
