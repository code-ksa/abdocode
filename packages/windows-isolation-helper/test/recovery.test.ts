/**
 * CL-16A2-D §8/§9/§10 — the crash matrix, concurrency, and the elevated-host
 * policy.
 *
 * HOW A CRASH IS SIMULATED, stated plainly so the result is not read as more
 * than it is:
 *
 *  - **Helper crashes are REAL.** `--crash-at` calls `std::process::abort()`
 *    inside the child: no unwinding, no destructors, no flush.
 *  - **Host crashes abort the orchestrator with `HostCrashed`, which nothing
 *    catches or cleans up after.** From the journal's point of view that is
 *    exactly a kill: the durable log is the host's only state, and no `finally`
 *    is allowed to run. The one thing it does not reproduce is a torn write, and
 *    the event store is append-only per event, so a partial event cannot exist.
 *
 * After each crash, recovery runs against the SAME event store — the state a
 * restarted host would load — and the world is inspected for orphans.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryEventStore } from "@abdo/event-store"
import { AC, foldRun, runAggregateId } from "../src/journal"
import { executeRun, HostCrashed, profileNameFor, type HostCrashPoint, type LifecycleDeps } from "../src/lifecycle"
import { listOwnedProfiles, recover, scanRuns } from "../src/recovery"
import { directHelperRunner, ElevatedHostNotSupported, REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import { HELPER, OWNERSHIP_PREFIX, harnessHelperRunner, helperBinaryHash, helperBuilt, runDirect, selfElevated } from "./harness"
import { reapOrphanConsoleHosts } from "./census"

const READY = process.platform === "win32" && helperBuilt()
const CMD = "C:\\Windows\\System32\\cmd.exe"
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const PKG_ROOT = join(process.env.LOCALAPPDATA ?? "", "Packages")
const T = 300_000

const runId = (tag: string) => `${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const deps = (store = new MemoryEventStore()): LifecycleDeps => ({
  store,
  helper: harnessHelperRunner(),
  helperBinaryHash: helperBinaryHash(),
  helperProtocolVersion: REQUIRED_PROTOCOL_VERSION,
})
const profileDir = (id: string) => join(PKG_ROOT, profileNameFor(id))

// ------------------------------------------------------------- the crash matrix

const HOST_POINTS: HostCrashPoint[] = [
  "after_run_requested",
  "after_profile_intent_before_create",
  "after_profile_created_before_event",
  "after_acl_intent_before_grant",
  "after_acl_granted_before_event",
  "after_process_started_before_event",
  "during_process_running",
  "after_process_exit_before_acl_restore",
  "after_acl_restore_before_event",
  "after_profile_delete_before_event",
]

describe.skipIf(!READY)("CL-16A2-D section 8 — HOST crash at every point, then recovery", () => {
  for (const point of HOST_POINTS) {
    test(`crash at ${point}: recovery leaves no orphan and the journal ends honestly`, async () => {
      const store = new MemoryEventStore()
      const d = deps(store)
      const id = runId("hc")
      const scratch = mkdtempSync(join(tmpdir(), "abdo-hc-"))
      writeFileSync(join(scratch, "f.txt"), "x", "utf8")
      const sddlBefore = String(runDirect(["inspect-acl", "--path", scratch]).sddl ?? "")
      try {
        let crashed = false
        try {
          await executeRun(d, { runId: id, argv: [CMD, "/c", "echo", "x"], grants: [{ path: scratch, rights: "rx" }], timeoutMs: 20_000, hostCrashAt: point })
        } catch (e) {
          crashed = e instanceof HostCrashed
        }
        expect(crashed).toBe(true)

        // A restarted host loads exactly this log and nothing else.
        const before = foldRun(id, await store.read("project", runAggregateId(id)))
        expect(before.state).not.toBe("completed")

        const report = await recover(deps(store))
        const after = foldRun(id, await store.read("project", runAggregateId(id)))

        // 1. The journal reaches a TRUTHFUL terminal state.
        expect(["completed", "manual_intervention_required"]).toContain(after.state)
        // 2. No orphaned profile.
        expect(existsSync(profileDir(id))).toBe(false)
        // 3. No unexplained ACL: the descriptor is back, or a human was told.
        const sddlAfter = String(runDirect(["inspect-acl", "--path", scratch]).sddl ?? "")
        if (after.state === "completed") expect(sddlAfter).toBe(sddlBefore)
        // 4. Recovery is honest about what it did.
        expect(report.scanned).toBeGreaterThan(0)

        // 5. RECOVERY IS IDEMPOTENT: running it again changes nothing and fails
        //    nothing. This is the property that makes it safe to run at every
        //    startup, including one that crashed during recovery.
        const second = await recover(deps(store))
        const afterSecond = foldRun(id, await store.read("project", runAggregateId(id)))
        expect(afterSecond.state).toBe(after.state)
        expect(second.outcomes.some((o) => o.action === "cleaned")).toBe(false)
        expect(existsSync(profileDir(id))).toBe(false)
      } finally {
        runDirect(["delete-profile", "--name", profileNameFor(id)])
        rmSync(scratch, { recursive: true, force: true })
      }
    }, T)
  }
})

describe.skipIf(!READY)("CL-16A2-D section 8 — HELPER crash (a real abort) at every point", () => {
  for (const point of ["after_process_create_suspended", "after_assign_job_before_resume", "after_resume", "after_process_exit"]) {
    test(`helper aborts at ${point}: no orphan process, no orphan profile`, async () => {
      const store = new MemoryEventStore()
      const d = deps(store)
      const id = runId("hx")
      const marker = join(tmpdir(), `abdo-hx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`)
      try {
        // The child would write the marker if it survived the helper's death.
        await executeRun(d, {
          runId: id,
          argv: [PS, "-NoProfile", "-Command", `Start-Sleep -Seconds 6; Set-Content -Path '${marker}' -Value survived`],
          grants: [],
          timeoutMs: 25_000,
          helperCrashAt: point,
        })
        const after = foldRun(id, await store.read("project", runAggregateId(id)))
        // The helper died mid-launch, so the run cannot be `completed` on the
        // first pass — the journal says so rather than guessing.
        expect(after.state).not.toBe("completed")

        await recover(deps(store))
        expect(existsSync(profileDir(id))).toBe(false)

        await Bun.sleep(8_000)
        // KILL_ON_JOB_CLOSE: the job handle died with the helper, so the child
        // went with it. Nothing survived to write the marker.
        expect(existsSync(marker)).toBe(false)
      } finally {
        rmSync(marker, { force: true })
        runDirect(["delete-profile", "--name", profileNameFor(id)])
        // This test ABORTS the helper on purpose, so the helper never reaches
        // `reap_console_hosts` and its child's console host is orphaned. Real
        // consequence of a real crash — cleaned up here so the run-level census
        // can keep zero tolerance for leaks during NORMAL operation.
        reapOrphanConsoleHosts()
      }
    }, T)
  }
})

// -------------------------------------------------------------------- recovery

describe.skipIf(!READY)("CL-16A2-D section 6 — recovery refuses what it must", () => {
  test("it NEVER deletes a profile without Abdo's ownership marker", async () => {
    // Belt and braces: the helper refuses, and the refusal is observable.
    const res = runDirect(["delete-profile", "--name", "someone-elses-container"])
    expect(res.ok).toBe(false)
    expect(res.stage).toBe("ownership")
  })

  test("it skips a run whose process is still ALIVE", async () => {
    const store = new MemoryEventStore()
    const id = runId("alive")
    // A journal that looks like a crashed run, but with this test process's own
    // pid — which is definitively alive.
    const agg = runAggregateId(id)
    const base = { runId: id, profileName: profileNameFor(id), sid: "", stateEpoch: 0 }
    await store.append({ aggregateKind: "project", aggregateId: agg, type: AC.RunRequested, version: 1, data: { ...base, grants: [] } })
    await store.append({ aggregateKind: "project", aggregateId: agg, type: AC.ProcessStarted, version: 1, data: { ...base, pid: process.pid } })
    const report = await recover(deps(store))
    const mine = report.outcomes.find((o) => o.runId === id)
    expect(mine?.action).toBe("skipped_alive")
    // And it did NOT close the run behind the live process's back.
    expect(foldRun(id, await store.read("project", agg)).state).not.toBe("completed")
  }, T)

  test("a REUSED pid does not make a dead run look alive", async () => {
    // MEASURED during a full-suite run: a crashed run stayed stuck in
    // `profile_deleting` forever because an unrelated process had inherited its
    // pid, and recovery — asking only "is pid N alive?" — kept skipping it. A
    // pid is not an identity on Windows; pid + creation time is.
    const store = new MemoryEventStore()
    const id = runId("reuse")
    const agg = runAggregateId(id)
    const name = profileNameFor(id)
    runDirect(["ensure-profile", "--name", name])
    try {
      const base = { runId: id, profileName: name, sid: "", stateEpoch: 0 }
      await store.append({ aggregateKind: "project", aggregateId: agg, type: AC.RunRequested, version: 1, data: { ...base, grants: [] } })
      // This process's pid is definitely alive — but with a start time that is
      // definitely NOT its own, so the identity check must reject it.
      await store.append({
        aggregateKind: "project",
        aggregateId: agg,
        type: AC.ProcessStarted,
        version: 1,
        data: { ...base, pid: process.pid, startTime: "1" },
      })
      const inspected = runDirect(["inspect-process", "--pid", String(process.pid), "--expect-start", "1"])
      expect(inspected.alive).toBe(false)
      expect(inspected.pidReused).toBe(true)

      const report = await recover(deps(store))
      expect(report.outcomes.find((o) => o.runId === id)?.action).not.toBe("skipped_alive")
      expect(existsSync(join(PKG_ROOT, name))).toBe(false)
    } finally {
      runDirect(["delete-profile", "--name", name])
    }
  }, T)

  test("an ORPHAN profile with no journal at all is swept", async () => {
    // The worst case: the host lost its log entirely. The ownership marker on
    // the profile name is the only thing left, and it is enough.
    const orphan = `${OWNERSHIP_PREFIX}orphan-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
    const created = runDirect(["ensure-profile", "--name", orphan])
    expect(created.profileExists).toBe(true)
    try {
      const report = await recover(deps(new MemoryEventStore()))
      expect(report.orphanProfilesRemoved).toContain(orphan)
      expect(existsSync(join(PKG_ROOT, orphan))).toBe(false)
    } finally {
      runDirect(["delete-profile", "--name", orphan])
    }
  }, T)

  test("a profile a LIVE run still owns is not swept by a concurrent recovery", async () => {
    const store = new MemoryEventStore()
    const id = runId("live")
    const agg = runAggregateId(id)
    const name = profileNameFor(id)
    runDirect(["ensure-profile", "--name", name])
    try {
      await store.append({
        aggregateKind: "project",
        aggregateId: agg,
        type: AC.ProcessStarted,
        version: 1,
        data: { runId: id, profileName: name, pid: process.pid, stateEpoch: 0 },
      })
      const report = await recover(deps(store))
      expect(report.orphanProfilesRemoved).not.toContain(name)
      expect(existsSync(join(PKG_ROOT, name))).toBe(true)
    } finally {
      runDirect(["delete-profile", "--name", name])
    }
  }, T)

  test("two recoveries running AT THE SAME TIME do not fight", async () => {
    const store = new MemoryEventStore()
    const d = deps(store)
    const id = runId("dblrec")
    try {
      await executeRun(d, { runId: id, argv: [CMD, "/c", "echo", "x"], grants: [], timeoutMs: 20_000, hostCrashAt: "after_profile_created_before_event" }).catch(() => {})
      const [a, b] = await Promise.all([recover(deps(store)), recover(deps(store))])
      expect(existsSync(profileDir(id))).toBe(false)
      // Both report; neither throws; the union of what they did is one cleanup.
      expect(a.scanned + b.scanned).toBeGreaterThan(0)
      expect(foldRun(id, await store.read("project", runAggregateId(id))).state).toBe("completed")
    } finally {
      runDirect(["delete-profile", "--name", profileNameFor(id)])
    }
  }, T)
})

// ------------------------------------------------------------------ concurrency

describe.skipIf(!READY)("CL-16A2-D section 9 — parallelism", () => {
  test("20 parallel runs: no name collision, no leftovers, all completed", async () => {
    const store = new MemoryEventStore()
    const d = deps(store)
    const ids = Array.from({ length: 20 }, (_, i) => runId(`par${i}`))
    try {
      const results = await Promise.all(ids.map((id) => executeRun(d, { runId: id, argv: [CMD, "/c", "echo", id], grants: [], timeoutMs: 30_000 })))
      expect(results.every((r) => r.state === "completed")).toBe(true)
      expect(new Set(results.map((r) => r.profileName)).size).toBe(20) // no collision
      for (const id of ids) expect(existsSync(profileDir(id))).toBe(false)
      const owned = (await listOwnedProfiles()).filter((n) => ids.some((id) => n === profileNameFor(id)))
      expect(owned).toEqual([])
    } finally {
      for (const id of ids) runDirect(["delete-profile", "--name", profileNameFor(id)])
    }
  }, 600_000)

  test("two runs on the SAME workspace: neither removes the other's access", async () => {
    const store = new MemoryEventStore()
    const d = deps(store)
    const a = runId("wsA")
    const b = runId("wsB")
    const scratch = mkdtempSync(join(tmpdir(), "abdo-ws-"))
    const file = join(scratch, "shared.txt")
    writeFileSync(file, "shared-content", "utf8")
    const sddlBefore = String(runDirect(["inspect-acl", "--path", scratch]).sddl ?? "")
    try {
      // A holds its grant while B runs and finishes.
      const [ra, rb] = await Promise.all([
        executeRun(d, { runId: a, argv: [PS, "-NoProfile", "-Command", `Start-Sleep -Seconds 4; Get-Content '${file}'`], grants: [{ path: scratch, rights: "rx" }], timeoutMs: 30_000 }),
        (async () => {
          await Bun.sleep(800)
          return executeRun(d, { runId: b, argv: [CMD, "/c", "type", file], grants: [{ path: scratch, rights: "rx" }], timeoutMs: 30_000 })
        })(),
      ])
      // BOTH could read: B's grant did not interfere with A's, and A's restore
      // did not race B's read.
      expect(ra.exitCode).toBe(0)
      expect(rb.exitCode).toBe(0)
      expect(ra.state).toBe("completed")
      expect(rb.state).toBe("completed")
      // And the directory is exactly as it started.
      expect(String(runDirect(["inspect-acl", "--path", scratch]).sddl ?? "")).toBe(sddlBefore)
    } finally {
      for (const id of [a, b]) runDirect(["delete-profile", "--name", profileNameFor(id)])
      rmSync(scratch, { recursive: true, force: true })
    }
  }, T)

  test("nested parent/child directories: an inner grant survives the outer restore", async () => {
    const store = new MemoryEventStore()
    const d = deps(store)
    const outerId = runId("outer")
    const innerId = runId("inner")
    const parent = mkdtempSync(join(tmpdir(), "abdo-nest-"))
    const { mkdirSync } = await import("node:fs")
    const child = join(parent, "child")
    mkdirSync(child)
    writeFileSync(join(child, "f.txt"), "nested", "utf8")
    const parentBefore = String(runDirect(["inspect-acl", "--path", parent]).sddl ?? "")
    try {
      const [outer, inner] = await Promise.all([
        executeRun(d, { runId: outerId, argv: [PS, "-NoProfile", "-Command", "Start-Sleep -Seconds 4"], grants: [{ path: parent, rights: "rx" }], timeoutMs: 30_000 }),
        (async () => {
          await Bun.sleep(600)
          return executeRun(d, { runId: innerId, argv: [CMD, "/c", "type", join(child, "f.txt")], grants: [{ path: child, rights: "rx" }], timeoutMs: 30_000 })
        })(),
      ])
      expect(inner.exitCode).toBe(0) // the inner run could read through its own grant
      expect(outer.state).toBe("completed")
      expect(inner.state).toBe("completed")
      expect(String(runDirect(["inspect-acl", "--path", parent]).sddl ?? "")).toBe(parentBefore)
    } finally {
      for (const id of [outerId, innerId]) runDirect(["delete-profile", "--name", profileNameFor(id)])
      rmSync(parent, { recursive: true, force: true })
    }
  }, T)

  test("a path swapped for another object after the grant is refused, not silently mutated", async () => {
    // §11: the resource IDENTITY is re-checked before the restore touches it.
    const store = new MemoryEventStore()
    const d = deps(store)
    const id = runId("swap")
    const real = mkdtempSync(join(tmpdir(), "abdo-swap-real-"))
    try {
      const agg = runAggregateId(id)
      const name = profileNameFor(id)
      const sid = String(runDirect(["ensure-profile", "--name", name]).sid)
      const before = String(runDirect(["inspect-acl", "--path", real]).sddl ?? "")
      runDirect(["grant-acl", "--path", real, "--sid", sid, "--rights", "rx"])
      const granted = String(runDirect(["inspect-acl", "--path", real]).sddl ?? "")
      // A journal that remembers a DIFFERENT object at this path.
      const base = { runId: id, profileName: name, sid, stateEpoch: 0 }
      await store.append({ aggregateKind: "project", aggregateId: agg, type: AC.RunRequested, version: 1, data: { ...base, grants: [{ path: real, rights: "rx" }] } })
      await store.append({
        aggregateKind: "project",
        aggregateId: agg,
        type: AC.AclGranted,
        version: 1,
        data: { ...base, path: real, resourceIdentity: "deadbeef:0000000000000001", rights: "rx", originalSddl: before, originalSddlHash: "x", grantedSddl: granted, grantedSddlHash: "y" },
      })
      await store.append({ aggregateKind: "project", aggregateId: agg, type: AC.ProcessExited, version: 1, data: { ...base, exitCode: 0 } })

      await recover(deps(store))
      const after = foldRun(id, await store.read("project", agg))
      expect(after.state).toBe("manual_intervention_required")
      expect(after.reasonCodes).toContain("stale_isolation_evidence")
      // Nothing was touched: the ACE is still exactly where it was.
      expect(String(runDirect(["inspect-acl", "--path", real]).sddl ?? "")).toBe(granted)
    } finally {
      const name = profileNameFor(id)
      const sid = String(runDirect(["inspect-profile", "--name", name]).sid)
      runDirect(["restore-acl", "--path", real, "--sid", sid, "--expect-granted-sddl", "", "--original-sddl", "D:"])
      runDirect(["delete-profile", "--name", name])
      rmSync(real, { recursive: true, force: true })
    }
  }, T)
})

// -------------------------------------------------------- the elevated-host policy

describe("CL-16A2-D section 10 — an elevated host refuses, explicitly", () => {
  test("the PRODUCTION runner contains NO de-elevation mechanism", () => {
    // A scan, not a promise. `explorer.exe`, the linked token and `runas` are
    // all measurement-harness tools; if one ever appears on the production path
    // it will be because someone chose to add it, and this fails first.
    const src = readFileSync(join(import.meta.dir, "..", "src", "helper-runner.ts"), "utf8")
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\*.*$/gm, "")
    for (const banned of ["explorer.exe", "CreateProcessWithToken", "TokenLinkedToken", "runas", "deelevate", "trustlevel"]) {
      expect(code).not.toContain(banned)
    }
  })

  test("no file under src/ reaches for the de-elevating harness", async () => {
    const { readdirSync } = await import("node:fs")
    const dir = join(import.meta.dir, "..", "src")
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /harnessHelperRunner|runUnelevated|from ["'].*\/test\//.test(readFileSync(join(dir, f), "utf8")))
    expect(offenders).toEqual([])
  })

  test.skipIf(!READY)("on an elevated host the production runner REFUSES rather than de-elevating", async () => {
    if (!selfElevated()) {
      console.warn("UNKNOWN: this shell is NOT elevated, so the refusal path cannot be exercised here")
      return
    }
    const run = directHelperRunner(HELPER)
    let refused: unknown
    try {
      await run({ argv: ["version"] })
    } catch (e) {
      refused = e
    }
    expect(refused).toBeInstanceOf(ElevatedHostNotSupported)
    expect((refused as ElevatedHostNotSupported).reasonCode).toBe("elevated_host_not_supported")
  }, T)

  test.skipIf(!READY)("a swapped helper binary is refused as stale_isolation_evidence, before any OS call", async () => {
    const run = directHelperRunner(HELPER, "0".repeat(64))
    let err: { reasonCode?: string } | undefined
    try {
      await run({ argv: ["version"] })
    } catch (e) {
      err = e as { reasonCode?: string }
    }
    expect(err?.reasonCode).toBe("stale_isolation_evidence")
  }, T)
})

describe.skipIf(!READY)("CL-16A2-D — the journal is a faithful record", () => {
  test("scanRuns rebuilds every run from the log alone", async () => {
    const store = new MemoryEventStore()
    const d = deps(store)
    const ids = [runId("s1"), runId("s2")]
    try {
      for (const id of ids) await executeRun(d, { runId: id, argv: [CMD, "/c", "echo", "x"], grants: [], timeoutMs: 20_000 })
      const runs = await scanRuns(store)
      expect(runs.map((r) => r.runId).sort()).toEqual([...ids].sort())
      expect(runs.every((r) => r.state === "completed")).toBe(true)
    } finally {
      for (const id of ids) runDirect(["delete-profile", "--name", profileNameFor(id)])
    }
  }, T)
})
