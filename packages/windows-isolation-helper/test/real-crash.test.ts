/**
 * CL-16A2-D-R §5 — the crash matrix, done for real.
 *
 * WHAT CHANGED, AND WHY IT MATTERS
 *
 * The previous matrix threw `HostCrashed` inside the test process and then ran
 * recovery against the same `MemoryEventStore`. Nothing died, and the "durable"
 * journal never had to survive anything: it was an object in RAM belonging to a
 * process that stayed alive throughout. That proves the reconciliation logic is
 * correct GIVEN a surviving log. It cannot prove the log survives.
 *
 * Here, for each point:
 *
 *   1. a CHILD PROCESS is the host, writing to a REAL SQLite file;
 *   2. it reaches the point and blocks;
 *   3. the parent kills it with `taskkill /F /T` — no exit hook, no unwinding,
 *      no flush, no `finally`;
 *   4. the parent re-opens THE SAME DATABASE, in a different process, and
 *      recovers from it.
 *
 * Step 4 is the one the old matrix could not do at all, and it is the only step
 * that can tell durability from a shared pointer.
 *
 * The census is taken around every point, because §5 asks what each crash left
 * behind rather than only what the whole suite did.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { foldRun, runAggregateId } from "../src/journal"
import { profileNameFor, type HostCrashPoint, type LifecycleDeps } from "../src/lifecycle"
import { recover } from "../src/recovery"
import { REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import { harnessHelperRunner, helperBinaryHash, helperBuilt, queueDir, runDirect, runUnelevated } from "./harness"
import { takeCensus, type Census } from "./census"

const READY = process.platform === "win32" && helperBuilt()
const CMD = "C:\\Windows\\System32\\cmd.exe"
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const PKG_ROOT = join(process.env.LOCALAPPDATA ?? "", "Packages")
const FIXTURE = join(import.meta.dir, "fixtures", "host-crash-child.ts")
const T = 300_000

const POINTS: HostCrashPoint[] = [
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

const runId = (tag: string) => `${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`

/** Is this pid gone? Asked of the OS, because "we killed it" is not an answer. */
function processGone(pid: number): boolean {
  const p = Bun.spawnSync([PS, "-NoProfile", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'ALIVE' } else { 'GONE' }`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return p.stdout.toString().trim() === "GONE"
}

function hardKill(pid: number): void {
  // /F no politeness, /T the whole tree. Not SIGTERM, not `process.kill` with a
  // catchable signal: the point is that the host gets no chance to tidy up.
  Bun.spawnSync(["C:\\Windows\\System32\\taskkill.exe", "/PID", String(pid), "/F", "/T"], { stdout: "ignore", stderr: "ignore" })
}

/** What each crash point may leave behind, counted rather than assumed. */
function censusDelta(before: Census, after: Census): string[] {
  const bad: string[] = []
  if (after.appContainerProfiles > before.appContainerProfiles) bad.push(`appContainerProfiles ${before.appContainerProfiles} -> ${after.appContainerProfiles}`)
  if (after.conhostOrphaned > before.conhostOrphaned) bad.push(`conhostOrphaned ${before.conhostOrphaned} -> ${after.conhostOrphaned}`)
  if (after.windowsTerminals > before.windowsTerminals) bad.push(`windowsTerminals ${before.windowsTerminals} -> ${after.windowsTerminals}`)
  if (after.explorerProcesses > before.explorerProcesses) bad.push(`explorerProcesses ${before.explorerProcesses} -> ${after.explorerProcesses}`)
  return bad
}

describe.skipIf(!READY)("CL-16A2-D-R section 5 - a REAL host kill at every point", () => {
  for (const point of POINTS) {
    test(`killed at ${point}: the journal survives in SQLite and a NEW process recovers`, async () => {
      // The parent's de-elevated server must exist before the child starts, so
      // the child can adopt it rather than starting (and leaking) its own.
      await runUnelevated(["run", "--name", `abdo-winiso-warm-${process.pid}`, "--timeout-ms", "15000", "--", CMD, "/c", "echo", "warm"])

      const id = runId("rk")
      const dir = mkdtempSync(join(tmpdir(), "abdo-rk-"))
      const dbPath = join(dir, "journal.sqlite")
      const scratch = mkdtempSync(join(tmpdir(), "abdo-rks-"))
      const marker = join(dir, "reached.marker")
      writeFileSync(join(scratch, "f.txt"), "x", "utf8")
      const sddlBefore = String(runDirect(["inspect-acl", "--path", scratch]).sddl ?? "")
      const censusBefore = takeCensus()

      try {
        const child = Bun.spawn([process.execPath, FIXTURE, dbPath, id, point, marker, scratch], {
          env: { ...process.env, ABDO_HARNESS_QUEUE: queueDir() },
          stdout: "pipe",
          stderr: "pipe",
        })

        // Wait for the child to announce it is AT the point.
        let reached = false
        for (let i = 0; i < 600 && !reached; i++) {
          if (existsSync(marker)) reached = true
          else if (existsSync(`${marker}.missed`) || existsSync(`${marker}.error`)) break
          else await Bun.sleep(100)
        }
        if (!reached) {
          const why = existsSync(`${marker}.error`) ? await Bun.file(`${marker}.error`).text() : existsSync(`${marker}.missed`) ? await Bun.file(`${marker}.missed`).text() : "no marker"
          hardKill(child.pid)
          throw new Error(`the child never reached ${point}: ${why} / stderr: ${(await new Response(child.stderr).text()).slice(0, 500)}`)
        }

        // ---- THE KILL. Everything after this depends only on what is on disk.
        hardKill(child.pid)
        await Bun.sleep(400)
        expect(processGone(child.pid)).toBe(true)

        // ---- A DIFFERENT PROCESS re-opens the journal. This is the step the
        // in-memory matrix could not perform, and the only one that can tell a
        // durable log from a shared object.
        // NON-VACUITY: what did the dead host actually leave on the ACL? If the
        // grant had silently failed, "restored to the original" below would be
        // trivially true and would prove nothing. At the point AFTER the grant
        // the descriptor MUST differ from the original; at the point BEFORE it,
        // it must not.
        const sddlAtCrash = String(runDirect(["inspect-acl", "--path", scratch]).sddl ?? "")
        if (point === "after_acl_granted_before_event") {
          expect(sddlAtCrash).not.toBe(sddlBefore) // the ACE really is on disk, unrecorded
        }
        if (point === "after_acl_intent_before_grant") {
          expect(sddlAtCrash).toBe(sddlBefore) // nothing was granted yet
        }

        const store = new SqliteEventStore(dbPath)
        try {
          const before = foldRun(id, await store.read("project", runAggregateId(id)))
          // The log must actually contain the dead host's work.
          expect(before.events).toBeGreaterThan(0)
          expect(before.state).not.toBe("completed")

          const deps: LifecycleDeps = { store, helper: harnessHelperRunner(), helperBinaryHash: helperBinaryHash(), helperProtocolVersion: REQUIRED_PROTOCOL_VERSION }
          const report = await recover(deps)
          const after = foldRun(id, await store.read("project", runAggregateId(id)))

          // 1. A TRUTHFUL terminal state - never a silent success.
          expect(["completed", "manual_intervention_required"]).toContain(after.state)
          // 2. No orphaned profile.
          expect(existsSync(join(PKG_ROOT, profileNameFor(id)))).toBe(false)
          // 3. The ACL is back, or a human was told. Never quietly left granted.
          const sddlAfter = String(runDirect(["inspect-acl", "--path", scratch]).sddl ?? "")
          if (after.state === "completed") expect(sddlAfter).toBe(sddlBefore)
          expect(report.scanned).toBeGreaterThan(0)

          // EVIDENCE for the gate report: what the dead host actually left, and
          // what recovery made of it. Printed because "10 points passed" without
          // the states would hide a matrix that reached `manual_intervention`
          // everywhere and asserted almost nothing.
          const act = report.outcomes.find((o) => o.runId === id)?.action ?? "none"
          console.log(
            `[gate] crash ${point}: events=${before.events} state ${before.state} -> ${after.state} (recovery=${act}) ` +
              `acl=${sddlAfter === sddlBefore ? "restored_identical" : "DIFFERS"}`,
          )

          // 4. Recovery is IDEMPOTENT across processes too: a second pass
          //    changes nothing and claims no cleanup it did not perform.
          const second = await recover(deps)
          const afterSecond = foldRun(id, await store.read("project", runAggregateId(id)))
          expect(afterSecond.state).toBe(after.state)
          expect(second.outcomes.some((o) => o.action === "cleaned")).toBe(false)
          expect(existsSync(join(PKG_ROOT, profileNameFor(id)))).toBe(false)
        } finally {
          store.close()
        }

        // 5. What did this crash point leave on the machine?
        //
        // SETTLE FIRST, THEN JUDGE. We have just hard-killed a host in the
        // middle of a request the de-elevated server is still serving: its
        // AppContainer child has to exit and its console host has to be reaped
        // before the world is back to rest. Sampling the instant recovery
        // returns measures that teardown rather than a leak, and it produced an
        // intermittent failure here (three counters, one run in three).
        //
        // The window is BOUNDED and the assertion is unchanged: a real leak
        // never settles and still fails. This is the same correction the
        // harness gate needed when it counted a server that had not finished
        // dying - waiting for quiescence is not the same as tolerating a leak.
        let leaks = censusDelta(censusBefore, takeCensus())
        for (let i = 0; i < 20 && leaks.length; i++) {
          await Bun.sleep(500)
          leaks = censusDelta(censusBefore, takeCensus())
        }
        if (leaks.length) console.log(`[gate] crash ${point} LEAKED: ${leaks.join(" | ")}`)
        expect(leaks).toEqual([])
      } finally {
        runDirect(["delete-profile", "--name", profileNameFor(id)])
        runDirect(["delete-profile", "--name", `abdo-winiso-warm-${process.pid}`])
        rmSync(scratch, { recursive: true, force: true })
        rmSync(dir, { recursive: true, force: true })
      }
    }, T)
  }
})

describe.skipIf(!READY)("CL-16A2-D-R section 5 - the kill is real, and so is the store", () => {
  test("the SQLite journal is readable by a process that did not write it", async () => {
    // The control for the whole file. If this failed, every result above would
    // be describing something other than durability.
    const dir = mkdtempSync(join(tmpdir(), "abdo-dur-"))
    const dbPath = join(dir, "j.sqlite")
    const id = runId("dur")
    try {
      const writer = new SqliteEventStore(dbPath)
      await writer.append({
        aggregateKind: "project",
        aggregateId: runAggregateId(id),
        type: "appcontainer.run_requested",
        version: 1,
        data: { runId: id, profileName: profileNameFor(id) },
      })
      writer.close()

      // A genuinely separate process reads it back.
      const reader = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `const {SqliteEventStore} = await import("@abdo/persistence-sqlite");` +
            `const s = new SqliteEventStore(${JSON.stringify(dbPath)});` +
            `const e = await s.read("project", ${JSON.stringify(runAggregateId(id))});` +
            `console.log(JSON.stringify(e.map(x => x.type))); s.close();`,
        ],
        { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
      )
      expect(reader.stdout.toString()).toContain("appcontainer.run_requested")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, T)
})
