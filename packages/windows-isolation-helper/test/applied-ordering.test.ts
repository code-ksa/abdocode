/**
 * CL-16A2-E §0/§1 — `isolation.applied` must be TRUE when it is written.
 *
 * THE DEFECT THIS FIXES, in code I had just committed: the launcher wrote
 * `isolation.applied` before calling the backend. For a wrapper mechanism that
 * is the correct fail-safe order — the spawn on the next line establishes the
 * isolation, so a crash in between leaves an applied-with-no-result rather than
 * a run with no record. For a BACKEND it is simply false: the backend is what
 * creates the container, grants the ACLs, starts the process suspended, assigns
 * the job and resumes it, so a record written beforehand claims a protection
 * that does not exist yet — and would still claim it if every one of those steps
 * then failed.
 *
 * `isolation.applied` is now written only after the backend reports that each
 * stage was OBSERVED. These tests inject a failure at each stage in turn and
 * assert the record never appears early.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { INHERIT_PROFILE, UNMEASURED_CAPABILITY, launchControlledProcess, type IsolationBackend, type IsolationBackendResult, type IsolationEvent } from "@abdo/tools/launcher"
import { DENY_ALL_PROFILE, ISOLATION_VERSION, type IsolationCapabilityReport } from "@abdo/tools/isolation"
import { APPCONTAINER_MECHANISM } from "../src/backend"

const CMD = "C:\\Windows\\System32\\cmd.exe"
const WIN = process.platform === "win32"

/** A capability report that says the mechanism is available. */
const capability = (): IsolationCapabilityReport => ({
  platform: process.platform,
  mechanism: APPCONTAINER_MECHANISM,
  denyAll: "supported",
  processTree: "supported",
  childInheritance: "supported",
  loopbackInsideDenyAll: "unknown",
  requiresElevation: false,
  mutatesGlobalState: false,
  reasonCodes: [],
  evidenceHash: "cap-fixed-for-ordering-tests",
  isolationVersion: ISOLATION_VERSION,
})

const FULL_EVIDENCE = {
  profileCreated: true,
  profileOwnedByRun: true,
  aclApplied: true,
  childCreatedInContainer: true,
  assignedToJob: true,
  resumed: true,
} as const

/** A backend that returns exactly what a test tells it to. */
const fakeBackend = (result: Partial<IsolationBackendResult>, mechanism = APPCONTAINER_MECHANISM): IsolationBackend => ({
  mechanism,
  run: async () => ({
    ok: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: false,
    childStarted: true,
    appliedEvidence: { ...FULL_EVIDENCE },
    ...result,
  }),
})

async function launch(backend: IsolationBackend, events: IsolationEvent[], hooks?: Parameters<typeof launchControlledProcess>[0]["hooks"]) {
  const cwd = mkdtempSync(join(tmpdir(), "abdo-ord-"))
  try {
    return await launchControlledProcess({
      executable: CMD,
      argv: ["/c", "echo", "x"],
      cwd,
      env: { PATH: process.env.PATH ?? "" },
      isolationProfile: DENY_ALL_PROFILE,
      capability: capability(),
      timeoutMs: 30_000,
      evidence: {
        profile: DENY_ALL_PROFILE,
        capability: capability(),
        approvalGranted: false,
        emit: (e) => {
          events.push(e)
        },
        backend,
      },
      ...(hooks ? { hooks } : {}),
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

const hasApplied = (events: IsolationEvent[]) => events.some((e) => e.type === "isolation.applied")

describe("CL-16A2-E section 0 - applied is never written early", () => {
  test("the happy path DOES write it, and only after requested + capability_checked", async () => {
    const events: IsolationEvent[] = []
    const res = await launch(fakeBackend({}), events)
    expect(res.outcome).toBe("ran")
    const types = events.map((e) => e.type)
    expect(types).toContain("isolation.applied")
    expect(types.indexOf("isolation.applied")).toBeGreaterThan(types.indexOf("isolation.requested"))
    expect(types.indexOf("isolation.applied")).toBeGreaterThan(types.indexOf("isolation.capability_checked"))
    // It is the LAST record, because it is a statement about a finished fact.
    expect(types.at(-1)).toBe("isolation.applied")
  })

  test("a backend that REFUSES leaves no applied record", async () => {
    const events: IsolationEvent[] = []
    const res = await launch(fakeBackend({ ok: false, reasonCode: "elevated_host_not_supported", detail: "refused" }), events)
    expect(res.outcome).toBe("refused")
    if (res.outcome === "refused") expect(res.reasonCode).toBe("elevated_host_not_supported")
    expect(hasApplied(events)).toBe(false)
    expect(events.some((e) => e.type === "isolation.failed")).toBe(true)
  })

  test("a backend that THROWS leaves no applied record", async () => {
    const events: IsolationEvent[] = []
    const res = await launch(
      {
        mechanism: APPCONTAINER_MECHANISM,
        run: async () => {
          throw new Error("the container could not be created")
        },
      },
      events,
    )
    expect(res.outcome).toBe("refused")
    expect(hasApplied(events)).toBe(false)
  })

  test("no child_started: refused, and no applied record", async () => {
    const events: IsolationEvent[] = []
    const res = await launch(fakeBackend({ childStarted: false }), events)
    expect(res.outcome).toBe("refused")
    if (res.outcome === "refused") expect(res.reasonCode).toBe("isolation_child_never_started")
    expect(hasApplied(events)).toBe(false)
  })

  test("EVERY stage in turn: a single missing proof prevents applied", async () => {
    // The point of doing all six: a launcher that only checked `childStarted`
    // would pass the test above and still record `applied` for a process that
    // never entered a job or was never resumed.
    for (const stage of Object.keys(FULL_EVIDENCE) as (keyof typeof FULL_EVIDENCE)[]) {
      const events: IsolationEvent[] = []
      const res = await launch(fakeBackend({ appliedEvidence: { ...FULL_EVIDENCE, [stage]: false } }), events)
      expect(res.outcome).toBe("refused")
      if (res.outcome === "refused") {
        expect(res.reasonCode).toBe("isolation_not_established")
        expect(res.detail).toContain(stage)
      }
      expect(hasApplied(events)).toBe(false)
      const failed = events.find((e) => e.type === "isolation.failed")
      expect(failed?.failureReason).toBe("isolation_not_established")
    }
  })

  test("a backend that omits the evidence entirely is refused", async () => {
    const events: IsolationEvent[] = []
    const res = await launch(fakeBackend({ appliedEvidence: undefined }), events)
    expect(res.outcome).toBe("refused")
    if (res.outcome === "refused") expect(res.reasonCode).toBe("isolation_not_established")
    expect(hasApplied(events)).toBe(false)
  })
})

describe("CL-16A2-E section 1 - the backend and its seams cannot be reached from outside", () => {
  test("swapping the MECHANISM between the decision and the spawn is stale evidence", async () => {
    const events: IsolationEvent[] = []
    const res = await launch(fakeBackend({}), events, { backendMechanismNow: () => "some-other-mechanism" })
    expect(res.outcome).toBe("refused")
    if (res.outcome === "refused") {
      expect(res.reasonCode).toBe("stale_isolation_evidence")
      expect(res.detail).toContain("backendMechanism")
    }
    expect(hasApplied(events)).toBe(false)
  })

  test("the backend is NOT consulted for inherit, even when one is supplied", async () => {
    const events: IsolationEvent[] = []
    const cwd = mkdtempSync(join(tmpdir(), "abdo-ord2-"))
    try {
      const res = await launchControlledProcess({
        executable: WIN ? CMD : "/bin/echo",
        argv: WIN ? ["/c", "echo", "INHERIT"] : ["INHERIT"],
        cwd,
        env: { PATH: process.env.PATH ?? "" },
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
          backend: {
            mechanism: APPCONTAINER_MECHANISM,
            run: async () => {
              throw new Error("a backend must never run for inherit")
            },
          },
        },
      })
      expect(res.outcome).toBe("ran")
      if (res.outcome === "ran") expect(res.appliedMode).toBe("inherit")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("NOTHING in the model-facing surface can name a backend, a mechanism or a SID", async () => {
    // The grant is built by the enforcement point and reaches a tool through
    // `ToolContext.execution`. If any of these names appeared in the shell's
    // input schema, a model could ask for them.
    // Asserted as an EXACT set rather than by scanning for forbidden words: a
    // substring search over source is both fragile (`sid` matches inside
    // ordinary words) and weak (it cannot notice a new field nobody thought to
    // forbid). The model may name these three things and nothing else.
    const { shellTool } = await import("@abdo/builtin-tools/shell")
    const schema = shellTool(tmpdir()).inputSchema as { properties?: Record<string, unknown> }
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["command", "cwd", "timeoutMs"])
  })

  test("the PRODUCTION backend source contains no de-elevation and no harness import", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "backend.ts"), "utf8")
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\*.*$/gm, "")
    for (const banned of ["explorer.exe", "CreateProcessWithToken", "TokenLinkedToken", "runas", "trustlevel"]) {
      expect(code).not.toContain(banned)
    }
    // And no file under src/ reaches into the test harness.
    const dir = join(import.meta.dir, "..", "src")
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /harnessHelperRunner|runUnelevated|from ["'].*\/test\//.test(readFileSync(join(dir, f), "utf8")))
    expect(offenders).toEqual([])
  })

  test("the self-report seam is INJECTION-ONLY: it has no env or argv route", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "backend.ts"), "utf8")
    // The seam exists as a parameter. It must not be readable from the
    // environment or from process arguments, which is how it could otherwise be
    // turned on in production without a code change.
    expect(src).toContain("selfReport?: HelperSelfReport")
    expect(src).not.toMatch(/process\.env\[[^\]]*SELF_REPORT/i)
    expect(src).not.toMatch(/process\.env\.[A-Z_]*SELF_REPORT/i)
    expect(src).not.toContain("process.argv")
  })
})
