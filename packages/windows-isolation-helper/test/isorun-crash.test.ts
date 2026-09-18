/**
 * CL-16A3 MEGA-1 §5b — the REAL crash matrix for the isolated run.
 *
 * A host is killed with `taskkill /F /T` at each `RunLifecyclePoint`, and then a
 * DIFFERENT PROCESS opens the same database and reclaims what was left. Nothing
 * here simulates a crash: an in-process `throw` unwinds, runs `finally` blocks,
 * clears the heartbeat timer and gives the store a chance to flush, and every one
 * of those is something a real death does not do. The lease in particular must be
 * left UNRELEASED and still ticking, exactly as it would be after a power cut.
 *
 * What each case asserts:
 *
 *   1. the journal, read from another process, is a LEGAL PREFIX of the contract;
 *   2. the lease was NOT released, because nobody was alive to release it;
 *   3. recovery's verdict matches `crashResidueExpected()` — the P4b data that
 *      names which stages leave OS state behind, so the matrix cannot silently
 *      stop covering one;
 *   4. after recovery, ZERO owned residue: no run directory, no profile, no ACE.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RIGHTS_MODEL_VERSION } from "@abdo/tools/windows-acl-matrix"
import { removeOwnedDirectoryTree } from "../src/controlled-fs"
import { bootstrapExecutionRoot } from "../src/execution-root"
import { REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import { recoverIsolatedRuns, scanIsolatedRuns } from "../src/isorun-recovery"
import { acquireRunLease, assertMayMutate, newOperationId, releaseRunLease, renewRunLease, StaleLeaseHolder } from "../src/run-lease"
import { OWNERSHIP_PREFIX, profileDirFor } from "../src/lifecycle"
import { crashResidueExpected, validateLifecycleSequence } from "../src/run-lifecycle-events"
import type { RunLifecyclePoint } from "../src/run-lifecycle"
import { harnessHelperRunner, helperBinaryHash, helperBuilt, queueDir, runDirect, runUnelevated } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const T = 240_000
const PS = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
const FIXTURE = join(import.meta.dir, "fixtures", "isorun-crash-child.ts")
const LEASE_TTL_MS = 3_000
const PACKAGES = join(process.env.LOCALAPPDATA ?? "", "Packages")

/** Every boundary the driver announces. The matrix covers all of them. */
const POINTS: RunLifecyclePoint[] = [
  "after_run_requested",
  "after_root_ready",
  "after_scope_planned",
  "after_grants_intent_before_mutation",
  "after_grants_applied_before_event",
  "after_grants_verified",
  "after_prelaunch_gate",
  "after_launch_intent_before_spawn",
  "after_process_started_before_event",
  "during_process_running",
  "after_process_exited",
  "after_revocation_intent_before_restore",
  "after_revocation_verified",
  "after_cleanup_intent_before_delete",
  "before_completed",
]

/** Is this pid gone? Asked of the OS — "we killed it" is not an answer. */
function processIsGone(pid: number): boolean {
  const p = Bun.spawnSync([PS, "-NoProfile", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'ALIVE' } else { 'GONE' }`], { stdout: "pipe", stderr: "pipe" })
  return p.stdout.toString().trim() === "GONE"
}

/** /F no politeness, /T the whole tree. Not SIGTERM, not a catchable signal. */
function hardKill(pid: number): void {
  Bun.spawnSync([String.raw`C:\Windows\System32\taskkill.exe`, "/PID", String(pid), "/F", "/T"], { stdout: "ignore", stderr: "ignore" })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!READY)("a REAL kill at every lifecycle point, reclaimed by another process", () => {
  let scratch = ""
  let programData = ""

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "abdo-isocrash-"))
    programData = String((await runUnelevated(["known-folder", "--id", "ProgramData"])).lexicalPath ?? "")
  }, T)

  afterAll(() => {
    // MACHINE-WIDE PROFILE CHECK, and it is here because a leak once escaped
    // every per-test assertion.
    //
    // MEASURED: one full sequential sweep left a single `abdo-winiso-*` profile
    // behind, while every individual test's own "my profile is gone" assertion
    // had passed and every recovery had reported `reclaimed`. It deleted cleanly
    // when asked afterwards, and a second identical sweep left zero. So it is
    // NOT dismissed as noise — it is unexplained, and the most likely reading is
    // that Windows re-materialises `Packages\<name>` after a verified deletion
    // while the container's processes are still winding down.
    //
    // A per-run assertion cannot see that: it checks its own profile at its own
    // moment. This checks the whole machine at the end, so if it recurs it fails
    // a test instead of quietly accumulating on a user's box.
    const leaked = existsSync(PACKAGES) ? readdirSync(PACKAGES).filter((n) => n.startsWith(OWNERSHIP_PREFIX)) : []

    for (const p of [join(programData, "Abdo"), scratch]) {
      try {
        rmSync(p, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
    for (const name of leaked) runDirect(["delete-profile", "--name", name])

    if (leaked.length > 0) throw new Error(`this sweep leaked ${leaked.length} AppContainer profile(s) that recovery reported as reclaimed: ${leaked.join(", ")}`)
  })

  for (const point of POINTS) {
    test(`killed at ${point}: another process reclaims it and nothing is left`, async () => {
      const dbPath = join(scratch, `${point}.sqlite`)
      const markerPath = join(scratch, `${point}.marker`)

      // ---- 0. THE ADOPTED QUEUE MUST BE ANSWERING BEFORE THE CHILD STARTS.
      //
      // The child borrows THIS process's de-elevation queue and is forbidden
      // from starting a server of its own — a process that is about to be killed
      // could never shut one down. MEASURED across back-to-back sweeps: roughly
      // one invocation in fifteen spawned its child against a queue whose server
      // had not finished starting (or had lapsed), and the child died with
      //
      //     the adopted queue ...abdo-winiso-harness-<pid> has no live server
      //
      // which in the log looks exactly like a product failure and is not one.
      // Forcing a round-trip here makes the precondition real instead of assumed.
      expect((await runUnelevated(["version"])).ok, "the harness server must be answering before a child adopts its queue").toBe(true)

      // ---- 1. A REAL HOST, in its own process, borrowing our helper queue.
      const child = Bun.spawn([process.execPath, FIXTURE, dbPath, point, markerPath, String(LEASE_TTL_MS)], {
        env: { ...process.env, ABDO_HARNESS_QUEUE: queueDir() },
        stdout: "pipe",
        stderr: "pipe",
      })

      const deadline = Date.now() + 180_000
      while (Date.now() < deadline && !existsSync(markerPath)) {
        if (existsSync(`${markerPath}.missed`)) throw new Error(`the child never reached ${point}`)
        if (existsSync(`${markerPath}.error`)) throw new Error(`the child failed before ${point}: ${await Bun.file(`${markerPath}.error`).text()}`)
        await sleep(100)
      }
      expect(existsSync(markerPath), `the child must announce it reached ${point}`).toBe(true)

      // ---- 2. KILL IT. No unwinding, no flush, no lease release.
      hardKill(child.pid)
      const gonw = Date.now() + 30_000
      while (Date.now() < gonw && !processIsGone(child.pid)) await sleep(200)
      expect(processIsGone(child.pid), "the host must really be dead before we judge the journal").toBe(true)

      // ---- 3. A DIFFERENT PROCESS opens the same database.
      const store = new SqliteEventStore(dbPath)
      try {
        const runs = await scanIsolatedRuns(store)
        expect(runs.length, "the journal must describe exactly one isolated run").toBe(1)
        const run = runs[0]!

        // The recorded chain is a LEGAL PREFIX. A crash is legal; a gap is not.
        const verdict = validateLifecycleSequence(run.stages)
        expect(verdict.ok, `the surviving chain must be legal: ${JSON.stringify(run.stages)}`).toBe(true)

        // THE LEASE WAS NOT RELEASED. Nobody was alive to release it, and a
        // release would have been a claim that the run finished cleanly.
        expect(run.lease, "a lease must have been recorded before anything else").toBeDefined()
        expect(run.lease?.released, "a killed host cannot have released its lease").toBe(false)

        // The contract's own statement of what a crash here should leave behind.
        const expectedResidue = crashResidueExpected(run.stages)

        // ---- 4. RECOVER, with the clock advanced past the lease's expiry. The
        // owner is genuinely dead, so this is the reclaimable case.
        const outcomes = await recoverIsolatedRuns({
          store,
          helper: async ({ argv }) => runDirect(argv),
          now: () => Date.now() + LEASE_TTL_MS * 20,
          removeDirectory: removeOwnedDirectoryTree,
        })
        expect(outcomes.length).toBe(1)
        const outcome = outcomes[0]!
        expect(`${outcome.action}: ${outcome.detail}`).toContain("reclaimed")

        // ---- 5. ZERO OWNED RESIDUE, verified against WINDOWS.
        if (run.runPath) {
          expect(runDirect(["inspect-dir", "--path", run.runPath]).pathExists, `${run.runPath} must be gone`).toBe(false)
        }
        if (run.profileName) {
          expect(runDirect(["inspect-dir", "--path", profileDirFor(run.profileName)]).pathExists, `${run.profileName} must be gone`).toBe(false)
        }
        for (const g of run.grants) {
          const sddl = String(runDirect(["inspect-acl", "--path", g.path]).sddl ?? "")
          const objectGone = runDirect(["inspect-dir", "--path", g.path]).pathExists !== true
          expect(objectGone || !sddl.toLowerCase().includes(g.sid.toLowerCase()), `${g.path} must carry no ACE for ${g.sid}`).toBe(true)
        }

        // A stage that the contract says leaves OS state must actually have had
        // some — otherwise this case is passing without testing anything.
        if (expectedResidue.osStateExpected) {
          expect(run.runPath ?? run.profileName ?? (run.grants.length > 0 ? "grants" : undefined), `${point} is a mutating stage, so the run must have named at least one resource`).toBeDefined()
        }

        // ---- 6. THE REAL QUESTION: CAN THE NEXT RUN START?
        //
        // A per-path ACE assertion is NOT a substitute for this, and believing
        // it was is what let the original defect hide. The execution root is
        // SHARED per host SID and `bootstrapExecutionRoot` is fail-closed, so a
        // crashed run that leaves the root unadoptable blocks every subsequent
        // run on the machine — and recovery cannot repair it, because recovery
        // runs after bootstrap. This asserts the property that actually matters.
        const freshStore = new SqliteEventStore(join(scratch, `${point}.bootstrap.sqlite`))
        try {
          const boot = await bootstrapExecutionRoot({
            store: freshStore,
            helper: harnessHelperRunner(),
            helperProtocol: REQUIRED_PROTOCOL_VERSION,
            helperHash: helperBinaryHash(),
            // THE SAME inventory hash the crash child used. The root marker binds
            // this value, so a different string here is refused as an ownership
            // conflict — correct behaviour, and it masked the real question the
            // first time this was measured.
            profileInventory: { complete: true, hash: "crash-inventory", roots: [{ path: process.env.USERPROFILE ?? "" }] },
            rightsModelVersion: RIGHTS_MODEL_VERSION,
          })
          expect(`${boot.ok ? "" : `${(boot as { reasonCode: string }).reasonCode}: ${(boot as { detail: string }).detail}`}`, `after recovering a host killed at ${point}, a NEW host must be able to bootstrap the shared execution root`).toBe("")
        } finally {
          freshStore.close()
        }
      } finally {
        store.close()
      }
    }, T)
  }
})

describe.skipIf(!READY)("a RESTARTED host cannot finish the operation it died in the middle of", () => {
  let scratch = ""
  let programData = ""

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "abdo-isofence-"))
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

  test("its old fencing token is refused for renew, mutate AND release", async () => {
    // THE SCENARIO THIS EXISTS FOR. A host dies mid-run. Recovery legitimately
    // reclaims. A new attempt takes the run. THEN the original comes back — a
    // resumed VM, a process that was merely suspended, a retry that kept its
    // old state in memory — and tries to finish the revoke it was part-way
    // through, on resources that now belong to somebody else. The lease having
    // EXPIRED is not what stops it: by the time it wakes, expiry says nothing
    // about who owns the run now. The TOKEN is what stops it.
    const dbPath = join(scratch, "fence.sqlite")
    const markerPath = join(scratch, "fence.marker")
    expect((await runUnelevated(["version"])).ok).toBe(true)

    const child = Bun.spawn([process.execPath, FIXTURE, dbPath, "after_grants_verified", markerPath, String(LEASE_TTL_MS)], {
      env: { ...process.env, ABDO_HARNESS_QUEUE: queueDir() },
      stdout: "pipe",
      stderr: "pipe",
    })
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline && !existsSync(markerPath)) {
      if (existsSync(`${markerPath}.error`)) throw new Error(`child failed: ${await Bun.file(`${markerPath}.error`).text()}`)
      await sleep(100)
    }
    hardKill(child.pid)
    while (Date.now() < deadline && !processIsGone(child.pid)) await sleep(200)

    const store = new SqliteEventStore(dbPath)
    try {
      const run = (await scanIsolatedRuns(store))[0]!
      // The dead host's lease, exactly as it held it.
      const zombie = run.lease!
      expect(zombie.released).toBe(false)

      // RECLAIM FIRST, while the only lease belongs to a process that is dead.
      //
      // The order matters and the first draft got it wrong: it took the new
      // lease first and then expected recovery to reclaim, which recovery
      // correctly REFUSED — an expired lease whose owner is alive is the
      // contradiction law 3 defers on, and the live owner was this very test
      // process. The product was right and the test was wrong.
      const outcomes = await recoverIsolatedRuns({ store, helper: async ({ argv }) => runDirect(argv), now: () => Date.now() + 10_000_000, removeDirectory: removeOwnedDirectoryTree })
      expect(`${outcomes[0]?.action}: ${outcomes[0]?.detail}`).toContain("reclaimed")

      // NOW a new attempt takes the run — this is what a retry looks like.
      const fresh = await acquireRunLease({ store }, { runId: run.runId, operationId: newOperationId(), ownerPid: process.pid, ownerStartTime: "restarted" }, 60_000)
      expect(fresh.fencingToken).toBeGreaterThan(zombie.fencingToken)

      // The zombie is now refused for EVERY action that could touch the machine.
      await expect(renewRunLease({ store }, zombie)).rejects.toThrow(StaleLeaseHolder)
      await expect(assertMayMutate({ store }, zombie, "revoke ACL grants")).rejects.toThrow(StaleLeaseHolder)
      await expect(assertMayMutate({ store }, zombie, "delete the profile")).rejects.toThrow(StaleLeaseHolder)
      await expect(
        releaseRunLease({ store }, zombie, "completed", { clean: true, checkedAt: 0, aclPathsClean: [], aclPathsDirty: [], profileAbsent: true, runRootAbsent: true, childProcessGone: true }),
      ).rejects.toThrow(StaleLeaseHolder)

      // NON-VACUITY: the CURRENT holder may still act, so this is fencing and
      // not a guard that refuses everyone.
      await assertMayMutate({ store }, fresh, "revoke ACL grants")

      // And nothing of the dead run survives: the reclaim above was real.
      if (run.runPath) expect(runDirect(["inspect-dir", "--path", run.runPath]).pathExists).toBe(false)
      if (run.profileName) expect(runDirect(["inspect-dir", "--path", profileDirFor(run.profileName)]).pathExists).toBe(false)
    } finally {
      store.close()
    }
  }, T)
})
