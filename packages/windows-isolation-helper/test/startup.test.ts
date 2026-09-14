/**
 * CL-16A3 MEGA-1 §5b — the startup path, proved to actually run recovery.
 *
 * `reclaimBeforeBootstrap` was written, tested, and called by nothing. This
 * file exists so that can never quietly become true again: it drives the REAL
 * production entry point (`prepareExecutionRoot`) and asserts the ordering and
 * the refusals from the outside.
 *
 * The live case is the one that matters. A host is killed at the exact point
 * that poisons the shared execution root — just after its ACEs land — and then
 * `prepareExecutionRoot` must, unaided:
 *
 *   1. find the durable trusted-root evidence,
 *   2. reclaim the abandoned run,
 *   3. get a clean `bootstrapExecutionRoot`,
 *   4. and permit a new run to start.
 *
 * Before this wiring, step 3 failed forever: bootstrap refused the drifted
 * root, and recovery ran only after bootstrap, so nothing ever repaired it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RIGHTS_MODEL_VERSION } from "@abdo/tools/windows-acl-matrix"
import { removeOwnedDirectoryTree } from "../src/controlled-fs"
import { REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import { executeIsolatedRun } from "../src/run-lifecycle"
import { executionRootPathFor, prepareExecutionRoot, StartupEvents } from "../src/startup"
import { harnessHelperRunner, helperBinaryHash, helperBuilt, queueDir, runDirect, runUnelevated } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const T = 240_000
const CMD = String.raw`C:\Windows\System32\cmd.exe`
const FIXTURE = join(import.meta.dir, "fixtures", "isorun-crash-child.ts")
const LEASE_TTL_MS = 3_000
const INVENTORY = { complete: true, hash: "crash-inventory", roots: [{ path: process.env.USERPROFILE ?? "" }] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const processIsGone = (pid: number): boolean =>
  Bun.spawnSync([String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, "-NoProfile", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'ALIVE' } else { 'GONE' }`], {
    stdout: "pipe",
    stderr: "pipe",
  })
    .stdout.toString()
    .trim() === "GONE"

describe.skipIf(!READY)("prepareExecutionRoot — recovery runs BEFORE bootstrap, for real", () => {
  let scratch = ""
  let programData = ""

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "abdo-startup-"))
    programData = String((await runUnelevated(["known-folder", "--id", "ProgramData"])).lexicalPath ?? "")
  }, T)

  afterAll(() => {
    for (const p of [join(programData, "Abdo"), scratch]) {
      try {
        rmSync(p, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  })

  const deps = (store: SqliteEventStore) => ({
    store,
    helper: harnessHelperRunner(),
    helperProtocol: REQUIRED_PROTOCOL_VERSION,
    helperHash: helperBinaryHash(),
    profileInventory: INVENTORY,
    rightsModelVersion: RIGHTS_MODEL_VERSION,
    removeDirectory: removeOwnedDirectoryTree,
    now: () => Date.now() + LEASE_TTL_MS * 20,
  })

  test("on a CLEAN machine it bootstraps and sweeps nothing", async () => {
    rmSync(join(programData, "Abdo"), { recursive: true, force: true })
    const store = new SqliteEventStore(join(scratch, "clean.sqlite"))
    try {
      const r = await prepareExecutionRoot(deps(store))
      expect(`${r.ok ? "" : `${r.reasonCode}: ${r.detail}`}`).toBe("")
      if (!r.ok) return
      // No root existed, so there was no durable evidence and NOTHING was swept.
      // An unknown root is left alone, never "repaired".
      expect(r.recovery).toEqual([])
      expect(r.rootPath).toBe(executionRootPathFor(programData, r.hostSid))
    } finally {
      store.close()
    }
  }, T)

  test("THE REAL ONE: a crash-poisoned root is repaired and a new run then starts", async () => {
    rmSync(join(programData, "Abdo"), { recursive: true, force: true })
    const dbPath = join(scratch, "poisoned.sqlite")
    const markerPath = join(scratch, "poisoned.marker")

    // ---- A host dies exactly where it leaves an ACE on the SHARED root.
    expect((await runUnelevated(["version"])).ok).toBe(true)
    const child = Bun.spawn([process.execPath, FIXTURE, dbPath, "after_grants_applied_before_event", markerPath, String(LEASE_TTL_MS)], {
      env: { ...process.env, ABDO_HARNESS_QUEUE: queueDir() },
      stdout: "pipe",
      stderr: "pipe",
    })
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline && !existsSync(markerPath)) {
      if (existsSync(`${markerPath}.error`)) throw new Error(`child failed: ${await Bun.file(`${markerPath}.error`).text()}`)
      await sleep(100)
    }
    Bun.spawnSync([String.raw`C:\Windows\System32\taskkill.exe`, "/PID", String(child.pid), "/F", "/T"], { stdout: "ignore", stderr: "ignore" })
    while (Date.now() < deadline && !processIsGone(child.pid)) await sleep(200)

    const store = new SqliteEventStore(dbPath)
    try {
      // NON-VACUITY: prove the root really is poisoned first, so a pass below
      // cannot be a machine that never needed repairing.
      const rootPath = executionRootPathFor(programData, String((await runUnelevated(["known-folder", "--id", "ProgramData"])).hostUserSid ?? ""))
      const poisoned = String(runDirect(["inspect-acl", "--path", rootPath]).sddl ?? "")
      expect(poisoned, "the crash must have left an AppContainer ACE on the shared root").toMatch(/S-1-15-2-/)

      // ---- THE PRODUCTION ENTRY POINT, unaided.
      const r = await prepareExecutionRoot(deps(store))
      expect(`${r.ok ? "" : `${r.reasonCode}: ${r.detail}`}`).toBe("")
      if (!r.ok) return

      // It swept, and it reclaimed rather than deferred.
      expect(r.recovery.length).toBeGreaterThan(0)
      expect(r.recovery.every((o) => o.action === "reclaimed" || o.action === "nothing_to_do")).toBe(true)

      // The root is clean again — no container ACE survives.
      expect(String(runDirect(["inspect-acl", "--path", r.rootPath]).sddl ?? "")).not.toMatch(/S-1-15-2-/)

      // The ordering is recorded, not merely performed.
      const types = (await store.read("project", "winiso:startup")).map((e) => e.type)
      expect(types).toContain(StartupEvents.Requested)
      expect(types).toContain(StartupEvents.RecoverySwept)
      expect(types).toContain(StartupEvents.Ready)
      expect(types.indexOf(StartupEvents.RecoverySwept)).toBeLessThan(types.indexOf(StartupEvents.Ready))

      // ---- AND A NEW RUN ACTUALLY STARTS. This is the property that was
      // broken: before the wiring, the host was permanently unable to run.
      const run = await executeIsolatedRun(
        {
          store,
          helper: harnessHelperRunner(),
          helperProtocol: REQUIRED_PROTOCOL_VERSION,
          helperHash: helperBinaryHash(),
          executionRootPath: r.rootPath,
          executionRootFinalPath: r.finalPath,
          hostSid: r.hostSid,
          profileInventory: { complete: true, hash: INVENTORY.hash, roots: [process.env.USERPROFILE ?? ""] },
          rightsModelVersion: RIGHTS_MODEL_VERSION,
          stateEpoch: "post-recovery",
        },
        { executablePath: CMD, args: ["/c", "echo", "AFTER-RECOVERY"], dialect: "cmd", decisionId: "post-rec", timeoutMs: 30_000 },
      )
      expect(`${run.reasonCode ?? ""} ${run.detail ?? ""}`.trim()).toBe("")
      expect(run.output?.stdout ?? "").toContain("AFTER-RECOVERY")
    } finally {
      store.close()
    }
  }, T)

  test("a run needing intervention BLOCKS bootstrap — recovery failure is not a warning", async () => {
    // A run inside the trusted root whose evidence is incomplete: no original
    // descriptor. Recovery must defer, and startup must then refuse rather than
    // bootstrap over a machine whose state nobody understands.
    rmSync(join(programData, "Abdo"), { recursive: true, force: true })
    const store = new SqliteEventStore(join(scratch, "blocked.sqlite"))
    try {
      // Establish a real root first, so durable trusted-root evidence exists.
      const first = await prepareExecutionRoot(deps(store))
      expect(first.ok).toBe(true)
      if (!first.ok) return

      // Plant an abandoned run inside it, missing its originalSddl.
      const runId = "run_blockedaaaaaaaaaaaaaaaa"
      const agg = `winiso:isorun:${runId}`
      const append = (type: string, data: Record<string, unknown>) => store.append({ aggregateKind: "project", aggregateId: agg, type, version: 1, data })
      await append("run.requested", { runId, profileName: "abdo-winiso-blocked", hostPid: 999999, hostStartTime: "1" })
      await append("run.root_ready", { runId, runPath: join(first.rootPath, "runs", runId) })
      await append("isorun.lease_acquired", { runId, operationId: "op_b", fencingToken: 1, ownerPid: 999999, ownerStartTime: "1", ttlMs: 1000, heldAt: 1000, expiresAt: 2000 })
      await append("execution_run.grants_mutating", { runId, path: first.rootPath, sid: "S-1-15-2-blocked" }) // no originalSddl

      const second = await prepareExecutionRoot(deps(store))
      expect(second.ok).toBe(false)
      if (second.ok) return
      expect(second.reasonCode).toBe("recovery_requires_intervention")
      expect(second.detail).toContain("originalSddl")
      const types = (await store.read("project", "winiso:startup")).map((e) => e.type)
      expect(types).toContain(StartupEvents.Blocked)
    } finally {
      store.close()
    }
  }, T)
})
