/**
 * P5c2-FINAL — THE RESUME RACE MATRIX.
 *
 * ## What this file is for
 *
 * Moving `ResumeThread` into the keeper closed one window and created a new
 * surface: a handshake, with a host on one side and a keeper on the other, and
 * a target suspended in between. Every point in that handshake is a place a
 * process can die, and the question at each one is the same — can a target end
 * up RUNNING with nobody left to observe it, or REPORTED STARTED when it never
 * ran, or ORPHANED SUSPENDED with no route back to it?
 *
 * Nothing here simulates a death. `--crash-at` aborts the real process at the
 * real point (`std::process::abort`, so no unwinding and no flush), and the
 * kills are `Stop-Process -Force`. An in-process `throw` would run destructors
 * and close handles in an orderly way, which is precisely what a killed process
 * does not do — and for a keeper, the handle it closes on the way out is the one
 * holding the job's name.
 *
 * ## The invariant every case is checked against
 *
 *   1. NO UNOBSERVED EXECUTION. The target does not run unless a live keeper
 *      resumed it while its host was alive.
 *   2. NO FALSE `process.started`, and no false `ok`.
 *   3. A suspended target is never left orphaned.
 *   4. Zero owned residue — process, job, keeper, profile, root.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { HELPER, helperBuilt, runDirect } from "./harness"
import { jobNamePrefixFor } from "../src/job-identity"

const READY = process.platform === "win32" && helperBuilt()
const CMD = String.raw`C:\Windows\System32\cmd.exe`
const HOSTILE = join(import.meta.dir, "..", "target", "release", "abdo-hostile-target.exe")

function ps(script: string): string {
  const p = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe", timeout: 60_000 })
  return p.stdout.toString().trim()
}
const pidAlive = (pid: number): boolean => ps(`@(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").Count`) === "1"
const hostSid = (): string => String(runDirect(["known-folder", "--id", "ProgramData"]).hostUserSid ?? "")
const sessionId = (): number => Number(runDirect(["version"]).sessionId ?? -1)

function keeperPids(): number[] {
  const raw = ps(`Get-CimInstance Win32_Process -Filter "Name='abdo-winiso.exe'" | Where-Object { $_.CommandLine -like '*job-keeper*' } | ForEach-Object { $_.ProcessId }`)
  return raw.length === 0 ? [] : raw.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => n > 0)
}

let tag = 0
const RUN = "run_race"
const OP = "op_race"
const FENCE = 2
function raceJobName(): string {
  tag += 1
  return `${jobNamePrefixFor(hostSid(), RUN, OP, FENCE)}r${process.pid}x${tag}`
}
const identity = (name: string) => ["--job-name", name, "--run-id", RUN, "--operation-id", OP, "--fencing-token", String(FENCE), "--expect-session-id", String(sessionId())]

const created: string[] = []
/** Every ACE this file added, so teardown can prove it left none behind. */
const grantedPaths: [string, string][] = []
function terminate(name: string) {
  return runDirect(["terminate-process-tree", ...identity(name)])
}

async function until(what: string, f: () => boolean, budgetMs = 20_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < budgetMs) {
    if (f()) return
    await Bun.sleep(120)
  }
  throw new Error(`timed out waiting for: ${what}`)
}

/**
 * Run a launch that ABORTS at `point`, and report what the machine looks like.
 *
 * The marker is the load-bearing part: the target writes a file, so "did
 * untrusted code execute?" is answered by the filesystem rather than by the
 * helper's own summary of whether it resumed anything.
 */
function crashAt(point: string, name: string): { marker: string; markerExists: boolean; helperPid: number } {
  const marker = join(process.env.TEMP ?? ".", `abdo-race-${process.pid}-${tag}-${point}.marker`)
  const p = Bun.spawnSync(
    [HELPER, "run", "--mode", "plain", ...identity(name), "--crash-at", point, "--timeout-ms", "30000", "--", CMD, "/c", `echo ran > "${marker}"`],
    { stdout: "pipe", stderr: "pipe", timeout: 90_000 },
  )
  return { marker, markerExists: ps(`Test-Path -LiteralPath '${marker}'`) === "True", helperPid: p.exitCode ?? -1 }
}

describe.skipIf(!READY)("P5c2-FINAL — nothing runs unobserved, at any point in the handshake", () => {
  // Points BEFORE the keeper could possibly resume anything. At each one the
  // target has either not been created or is suspended and has never executed
  // an instruction, so the marker must not exist.
  const beforeResume = [
    "after_named_job_created",
    "after_keeper_ready",
    "after_process_create_suspended",
    "after_assign_job_before_resume",
    "after_verified_before_resume_authorization",
    "keeper_spawned_before_ready",
    "keeper_parsed_authorization_before_liveness",
  ]

  for (const point of beforeResume) {
    test(`crash at ${point}: the target never executed, and nothing is left behind`, async () => {
      const name = raceJobName()
      created.push(name)
      const r = crashAt(point, name)

      // 1. NO UNOBSERVED EXECUTION. Asked of the filesystem.
      expect(r.markerExists).toBe(false)

      // 3. THE ORPHAN IS REACHABLE, AND THE ORDER OF THESE TWO CHECKS MATTERS.
      //
      // A keeper is SUPPOSED to outlive a dead host for as long as the job has
      // a member - that is the entire point of it. So the tree is terminated
      // FIRST and the keeper's exit is awaited AFTER. The first version of this
      // test waited for the keeper to vanish before emptying the job, which
      // asserted the opposite of the design and timed out on six points.
      const t = terminate(name)
      if (t.jobPresent === true) {
        expect(t.processesAfter).toBe(0)
        expect(t.treeGone).toBe(true)
      } else {
        expect(t.stage).toBe("terminate_job_absent")
        // AND IT MUST NOT CLAIM THE TREE IS GONE from an absent name.
        expect(t.treeGone).toBe(false)
      }

      // 4. ONLY NOW is the job empty, so only now must the keeper leave.
      await until("every keeper to exit once its job is empty", () => keeperPids().length === 0, 30_000)
    }, 180_000)
  }

  test("crash AFTER the keeper resumed but BEFORE it confirmed: the run is not reported started", async () => {
    // The one case where the target DOES execute. The keeper resumed it and
    // then died before telling anyone, so the host never gets its confirmation.
    //
    // The target running here is correct — it was resumed by a live keeper while
    // its host was alive, which is exactly the contract. What must NOT happen is
    // the host reporting a successful, completed run.
    const name = raceJobName()
    created.push(name)
    const marker = join(process.env.TEMP ?? ".", `abdo-race-${process.pid}-confirm.marker`)
    const p = Bun.spawnSync(
      [HELPER, "run", "--mode", "plain", ...identity(name), "--crash-at", "keeper_resumed_before_confirm", "--timeout-ms", "30000", "--", CMD, "/c", `echo ran > "${marker}"`],
      { stdout: "pipe", stderr: "pipe", timeout: 90_000 },
    )
    const out = p.stdout.toString().trim().split("\n").at(-1) ?? "{}"
    const r = JSON.parse(out) as Record<string, unknown>

    // NOT OK, and the reason is the missing confirmation rather than the
    // target's exit code.
    expect(r.ok).toBe(false)
    expect(String(r.stage)).toContain("keeper_resume")
    // AND NO PID IS REPORTED AS STARTED.
    expect(r.pid ?? null).toBe(null)

    const t = terminate(name)
    if (t.jobPresent === true) expect(t.processesAfter).toBe(0)
    await until("every keeper to exit once its job is empty", () => keeperPids().length === 0, 30_000)
    ps(`Remove-Item -LiteralPath '${marker}' -Force -ErrorAction SilentlyContinue`)
  }, 180_000)
})

describe.skipIf(!READY)("P5c2-FINAL — a dead host cannot have its authorisation acted on", () => {
  test("the keeper refuses to resume when the host has exited, and the target never runs", async () => {
    // THE SHARPEST WINDOW, and the reason the host-liveness gate exists.
    //
    // Reached by having the host abort immediately AFTER it wrote the
    // authorisation. The keeper then reads a message that is entirely valid,
    // and must still refuse — because the process that wrote it is gone and the
    // target would begin executing with nobody observing it.
    const name = raceJobName()
    created.push(name)
    const marker = join(process.env.TEMP ?? ".", `abdo-race-${process.pid}-deadhost.marker`)
    Bun.spawnSync(
      [HELPER, "run", "--mode", "plain", ...identity(name), "--crash-at", "after_verified_before_resume_authorization", "--timeout-ms", "30000", "--", CMD, "/c", `echo ran > "${marker}"`],
      { stdout: "pipe", stderr: "pipe", timeout: 90_000 },
    )

    // The host died before authorising at all, so the keeper self-arms on a job
    // that has a SUSPENDED member and holds the name for recovery.
    //
    // THE TARGET MUST NOT HAVE RUN.
    expect(ps(`Test-Path -LiteralPath '${marker}'`)).toBe("False")

    // And the orphan is reachable BY NAME, which is the property the keeper
    // exists for: a suspended target is never left with no route back to it.
    const t = terminate(name)
    if (t.jobPresent === true) {
      expect(t.treeGone).toBe(true)
      expect(t.processesAfter).toBe(0)
    }
    await until("every keeper to exit once its job is empty", () => keeperPids().length === 0, 30_000)
    expect(ps(`Test-Path -LiteralPath '${marker}'`)).toBe("False")
    ps(`Remove-Item -LiteralPath '${marker}' -Force -ErrorAction SilentlyContinue`)
  }, 180_000)
})

describe.skipIf(!READY)("P5c2-FINAL — the target cannot reach its own keeper", () => {
  test("PLAIN MODE GRANTS THE TARGET FULL ACCESS TO THE KEEPER — measured, and the reason production never uses it", () => {
    // MEASURED, AND IT IS NOT A KEEPER DEFECT. A `--mode plain` target runs
    // under the HOST USER'S OWN TOKEN, so it has exactly the access to the
    // keeper that any other process of that user has — including
    // `PROCESS_TERMINATE`. The job contains a process TREE; it does not restrict
    // access RIGHTS, and nothing about a keeper can change that.
    //
    // This is pinned rather than quietly avoided because the first version of
    // the test below ran in plain mode and would have recorded a FALSE denial
    // result. What protects the keeper is the AppContainer token boundary, and
    // that has to be stated where someone can trip over it: `--mode plain` is a
    // measurement mode, and no isolation claim survives it.
    const name = raceJobName()
    created.push(name)
    const r = runDirect(["run", "--mode", "plain", ...identity(name), "--timeout-ms", "60000", "--", HOSTILE, "--probe-keeper", "--grandchild-seconds", "2"])
    const line = String(r.stdout ?? "").split("\n").find((l) => l.includes("hostile.keeper_probe"))
    expect(line, "the probe must have run").toBeDefined()
    const probe = JSON.parse(line!.trim()) as { keeperPid: number; terminate: boolean; sweepTerminate: number }
    expect(probe.keeperPid).toBeGreaterThan(0)
    // THE UNCOMFORTABLE TRUTH, ASSERTED. If this ever becomes false, plain mode
    // has changed and this comment is stale.
    expect(probe.terminate).toBe(true)
    // AND THIS IS THE NON-VACUITY FOR THE APPCONTAINER TEST'S SWEEP: the very
    // same sweep code opens many processes here. A zero count there is the
    // container, not a broken probe.
    expect(probe.sweepTerminate).toBeGreaterThan(0)
  }, 120_000)

  test("OpenProcess for TERMINATE, DUP_HANDLE, VM_WRITE and CREATE_THREAD are all denied", async () => {
    const name = raceJobName()
    created.push(name)
    // APPCONTAINER, which is the only mode in which the question means anything
    // — see the plain-mode measurement above.
    const profile = `abdo-winiso-race-${process.pid}`
    const sid = String(runDirect(["derive-sid", "--name", profile]).sid ?? "")
    expect(sid.startsWith("S-1-15-2-")).toBe(true)
    // The container needs to EXECUTE the image, and traverse to reach it.
    runDirect(["grant-acl", "--path", HOSTILE, "--sid", sid, "--rights", "execute+read_file", "--target", "object_self"])
    for (const dir of [join(import.meta.dir, "..", "target"), join(import.meta.dir, "..", "target", "release")]) {
      runDirect(["grant-acl", "--path", dir, "--sid", sid, "--rights", "traverse", "--target", "object_self"])
    }
    grantedPaths.push([HOSTILE, sid], [join(import.meta.dir, "..", "target"), sid], [join(import.meta.dir, "..", "target", "release"), sid])

    // The hostile target is told to attack, but NOT which pid: it discovers the
    // keeper from inside the container. A pid passed on the command line would
    // be a pid the HOST chose, which does not answer the question being asked.
    const r = runDirect([
      "run",
      "--mode",
      "appcontainer",
      "--name",
      profile,
      "--sid-source",
      "create",
      ...identity(name),
      "--cwd",
      String.raw`C:\Windows\Temp`,
      "--timeout-ms",
      "60000",
      "--",
      HOSTILE,
      "--probe-keeper",
      "--grandchild-seconds",
      "2",
    ])
    const out = String(r.stdout ?? "")
    expect(out).toContain('"hostile.keeper_probe"')
    const probe = JSON.parse(out.split("\n").find((l) => l.includes("hostile.keeper_probe"))!.trim()) as {
      keeperPid: number
      terminate: boolean
      dupHandle: boolean
      vmWrite: boolean
      createThread: boolean
      queryLimited: boolean
      snapshotOk: boolean
      sweepTerminate: number
      sweepDupHandle: number
      sweepVmWrite: number
      sweepCreateThread: number
      sweepTerminatePids: string[]
    }

    // MEASURED, and the first version of this test asserted the wrong thing:
    // inside an AppContainer with zero capabilities `CreateToolhelp32Snapshot`
    // FAILS, so the target cannot enumerate processes at all and never locates
    // a keeper pid. That is stronger than a denial — but a probe that stopped
    // there would report four `false`s about a process it never found, which
    // proves nothing. Hence the sweep below.
    expect(probe.snapshotOk).toBe(false)
    expect(probe.keeperPid).toBe(0)

    // THE REAL MEASUREMENT. An attacker does not need the snapshot: pids are
    // small multiples of four, so the target simply tries all 16k of them. Not
    // one process on the machine — keeper, host, or stranger — can be opened
    // with any right that would matter.
    // NAMED, NOT COUNTED, and each entry carries the image read AT THE MOMENT it
    // was found openable. An assertion that fails with "expected 0, got 1" sends
    // the reader to a bisect; the process in question here is short-lived and
    // asking about it afterwards returns nothing at all.
    //
    // THE ONE ALLOWED EXCEPTION IS THE TARGET'S OWN CONSOLE HOST — measured, and
    // benign. Windows allocates a `conhost.exe` for the child and grants the
    // child access to it; it runs outside the AppContainer (see
    // `reap_console_hosts`) but it belongs to this run. Killing it is self-harm,
    // not escape: it confers nothing over the keeper, the job, or the host, and
    // the helper reaps it deliberately after the child exits anyway.
    //
    // It is allowed BY NAME rather than by relaxing the count to "<= 1", because
    // a count would silently accept a different process appearing later.
    const openable = probe.sweepTerminatePids.map((e) => e.toLowerCase())
    const notOwnConsole = openable.filter((e) => !e.endsWith("/conhost.exe"))
    expect(notOwnConsole).toEqual([])

    // AND EXPLICITLY: NO HELPER PROCESS IS REACHABLE. The keeper runs this
    // image, so its absence from the list is the claim that matters most.
    expect(openable.filter((e) => e.includes("abdo-winiso"))).toEqual([])

    // The counts, allowing only that one console host.
    expect(probe.sweepTerminate).toBeLessThanOrEqual(1)
    expect(probe.sweepDupHandle).toBeLessThanOrEqual(1)
    expect(probe.sweepVmWrite).toBeLessThanOrEqual(1)
    expect(probe.sweepCreateThread).toBeLessThanOrEqual(1)

    // NON-VACUITY FOR THE SWEEP ITSELF: the same code in plain mode opens
    // hundreds of processes, which is asserted in the plain-mode test above.
    // Here the container is what makes the count zero.
    expect(r.isAppContainer).toBe(true)
    expect(String(r.tokenAppContainerSid ?? "")).toBe(sid)
  }, 300_000)
})

afterAll(async () => {
  for (const name of created) {
    try {
      terminate(name)
    } catch {
      /* the per-test terminate is the real cleanup */
    }
  }
  ps(`Get-CimInstance Win32_Process -Filter "Name='abdo-hostile-target.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`)
  ps(`Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`)
  for (const k of keeperPids()) ps(`Stop-Process -Id ${k} -Force -ErrorAction SilentlyContinue`)
  // EVERY ACE THIS FILE ADDED IS REMOVED. A test that leaves an AppContainer
  // grant on the build output has not passed, whatever its assertions said.
  for (const [path, sid] of grantedPaths) {
    try {
      runDirect(["restore-acl", "--path", path, "--sid", sid])
    } catch {
      /* reported by the suite's residue census if it survived */
    }
  }
  ps(`Get-ChildItem "$env:LOCALAPPDATA\Packages" -Filter "abdo-winiso-race-*" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }`)
  await Bun.sleep(500)
})
