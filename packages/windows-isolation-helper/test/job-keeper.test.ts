/**
 * P5c2 — THE TRUSTED KEEPER, MEASURED AGAINST A TARGET THAT FIGHTS BACK.
 *
 * ## Why this file exists at all
 *
 * P5c shipped a 431/0 suite and a hole. The hole was that a named job's NAME was
 * kept alive by a handle duplicated INTO THE TARGET, and the suite never noticed
 * because every target in it was cooperative: `cmd.exe /c ping` does not sweep
 * its handle table, does not close handles it did not open, and does not orphan
 * a grandchild on purpose. The property was measured under exactly the
 * conditions that could not break it.
 *
 * So the adversary is now a real native program (`src/hostile-target.rs`) that:
 *
 *   1. sweeps its handle table and closes everything it finds;
 *   2. probes guessed handle values with `DuplicateHandle`;
 *   3. spawns a grandchild with `bInheritHandles = FALSE`;
 *   4. exits while that grandchild keeps running.
 *
 * Under P5c, (1) or (3)+(4) each dropped the job's name with the tree still
 * alive. Under P5c2 the holder is a trusted process outside the job and outside
 * the AppContainer, and the target holds no job handle to close — so the name
 * survives all four, and that survival is what the tests below assert.
 *
 * REAL WINDOWS THROUGHOUT, as everywhere in this package: every "it is gone" is
 * a fresh OS query, never the helper's own summary of what it did.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { HELPER, helperBuilt, runDirect } from "./harness"
import { jobNamePrefixFor } from "../src/job-identity"

const READY = process.platform === "win32" && helperBuilt()

// ABSOLUTE. The helper runs with `cwd` set to `%SystemRoot%` (see `helperCwd`
// in `src/helper-runner.ts`), so a relative target path resolves against
// C:\Windows and silently fails to launch — MEASURED: the first run of this file
// produced an empty stdout and four cascading failures that all looked like
// keeper bugs.
const HOSTILE = join(import.meta.dir, "..", "target", "release", "abdo-hostile-target.exe")
const CMD = String.raw`C:\Windows\System32\cmd.exe`
const PING = String.raw`C:\Windows\System32\ping.exe`

function ps(script: string): string {
  const p = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe", timeout: 60_000 })
  return p.stdout.toString().trim()
}

/**
 * Is this pid alive? Asked of the HELPER natively (RC4 §3).
 *
 * A PowerShell per call is MEASURED at ~455 ms; `inspect-process` answers the
 * same question in ~55 ms from `GetExitCodeProcess` rather than a WMI row count.
 * This is called in polling loops and in the teardown, so the difference is the
 * difference between a hook that fits its budget and one that does not.
 */
const pidAlive = (pid: number): boolean => runDirect(["inspect-process", "--pid", String(pid)]).alive === true
const hostSid = (): string => String(runDirect(["known-folder", "--id", "ProgramData"]).hostUserSid ?? "")
const sessionId = (): number => Number(runDirect(["version"]).sessionId ?? -1)

/** Every keeper process alive right now, straight from the OS. */
function keeperPids(): number[] {
  const raw = ps(`Get-CimInstance Win32_Process -Filter "Name='abdo-winiso.exe'" | Where-Object { $_.CommandLine -like '*job-keeper*' } | ForEach-Object { $_.ProcessId }`)
  return raw.length === 0 ? [] : raw.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => n > 0)
}

let tag = 0
function testJobName(runId: string, opId: string, fencing: number): string {
  tag += 1
  return `${jobNamePrefixFor(hostSid(), runId, opId, fencing)}k${process.pid}x${tag}`
}

function identityArgs(name: string, runId: string, opId: string, fencing: number): string[] {
  return ["--job-name", name, "--run-id", runId, "--operation-id", opId, "--fencing-token", String(fencing), "--expect-session-id", String(sessionId())]
}

function terminate(name: string, runId: string, opId: string, fencing: number, extra: readonly string[] = []) {
  return runDirect(["terminate-process-tree", ...identityArgs(name, runId, opId, fencing), ...extra])
}

async function until(what: string, f: () => boolean, budgetMs = 20_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < budgetMs) {
    if (f()) return
    await Bun.sleep(150)
  }
  throw new Error(`timed out waiting for: ${what}`)
}

const created: string[] = []
const spawned: number[] = []

/**
 * Launch the HOSTILE target in a named job, detached. Returns the helper pid.
 *
 * `--linger-seconds` is what makes the orphan scenario reachable at all. On the
 * normal path the helper WAITS for its target and then terminates the whole job,
 * so a target that exits immediately has its own grandchild reaped by its own
 * host — correct behaviour that completely hides the case under test. The
 * lingering window is where the test kills the host, after which the target
 * exits on its own and the grandchild is left with nothing but the keeper.
 */
function launchHostile(name: string, runId: string, opId: string, fencing: number, grandchildSeconds = 60, lingerSeconds = 12): number {
  const p = Bun.spawn(
    [
      HELPER,
      "run",
      "--mode",
      "plain",
      ...identityArgs(name, runId, opId, fencing),
      "--timeout-ms",
      "120000",
      "--",
      HOSTILE,
      "--grandchild-seconds",
      String(grandchildSeconds),
      "--linger-seconds",
      String(lingerSeconds),
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  )
  p.unref()
  return p.pid
}

describe.skipIf(!READY)("P5c2 — a hostile target cannot drop its own job's name", () => {
  test("the target sweeps and closes every handle it can find, and the job name survives", async () => {
    const name = testJobName("run_hostile", "op_hostile", 1)
    created.push(name)

    // Run it SYNCHRONOUSLY first so the adversary's own report is captured. The
    // helper waits for the target, and the target exits after spawning its
    // grandchild — so this returns while the grandchild is still running.
    const r = runDirect(["run", "--mode", "plain", ...identityArgs(name, "run_hostile", "op_hostile", 1), "--timeout-ms", "60000", "--", HOSTILE, "--grandchild-seconds", "45"])

    // THE ADVERSARY DID WHAT IT CLAIMS TO DO. Without this the test could pass
    // against a target that silently failed to sweep anything.
    const out = String(r.stdout ?? "")
    expect(out).toContain('"hostile.swept"')
    expect(out).toContain('"hostile.spawned"')
    const swept = JSON.parse(out.split("\n").find((l) => l.includes("hostile.swept"))!.trim()) as { handlesClosed: number; inAnyJob: boolean }
    // It really closed handles — a sweep that closed nothing proves nothing.
    expect(swept.handlesClosed).toBeGreaterThan(0)
    // And it really was contained: it is in a job, though it holds no handle to
    // one. That pair is the whole design in one assertion.
    expect(swept.inAnyJob).toBe(true)

    // THE KEEPER ARMED AND THE TARGET NEVER GOT A JOB HANDLE.
    expect(r.keeperArmed).toBe(true)
    expect(r.childKeepAliveHandle).toBeUndefined()
  }, 120_000)

  test("the target exits leaving a grandchild that inherited NOTHING, and the tree stays reachable BY NAME", async () => {
    const name = testJobName("run_orphan2", "op_orphan2", 3)
    created.push(name)
    const helperPid = launchHostile(name, "run_orphan2", "op_orphan2", 3, 90, 20)
    spawned.push(helperPid)

    // The grandchild is running. Its parent has already swept and closed its
    // whole handle table by now and is sitting in its linger window.
    await until("the grandchild to start", () => Number(ps(`@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'").Count`)) > 0)
    const grandchildPid = Number(ps(`(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Select-Object -First 1).ProcessId`))
    expect(grandchildPid).toBeGreaterThan(0)

    // KILL THE HOST FIRST — that is what makes this an orphan rather than a
    // normal teardown. A helper that reaches its own wait would terminate the
    // job itself, which is correct behaviour and hides the case entirely.
    ps(`Stop-Process -Id ${helperPid} -Force -ErrorAction SilentlyContinue`)
    await until("the host to die", () => !pidAlive(helperPid))

    // Then the target exits on its own, leaving the grandchild behind. Now
    // NOTHING that ever held a handle to this job is alive except the keeper:
    // the creating helper is dead, the target is dead and had burned its handle
    // table before it went, and the surviving grandchild inherited nothing by
    // construction.
    //
    // THIS IS THE EXACT STATE P5c COULD NOT SURVIVE.
    await until("the hostile target to exit", () => ps(`@(Get-CimInstance Win32_Process -Filter "Name='abdo-hostile-target.exe'").Count`) === "0", 40_000)

    // The keeper is still there, and the grandchild is still running.
    const keepers = keeperPids()
    expect(keepers.length).toBeGreaterThan(0)
    expect(pidAlive(grandchildPid)).toBe(true)

    // THE PROPERTY: a brand new helper still reaches the whole tree BY NAME.
    const r = terminate(name, "run_orphan2", "op_orphan2", 3)
    expect(r.jobPresent).toBe(true)
    const before = (r.before ?? []) as { pid: number; image: string }[]
    // The grandchild — which never received a handle and whose parent is gone —
    // is a member, because no breakaway flag was ever set.
    expect(before.some((p) => p.pid === grandchildPid)).toBe(true)

    expect(r.terminated).toBe(true)
    expect(r.drained).toBe(true)
    expect(r.processesAfter).toBe(0)
    expect(r.stillAlive ?? []).toEqual([])
    expect(r.treeGone).toBe(true)
    expect(r.ok).toBe(true)
    await until("the OS to agree the grandchild is gone", () => !pidAlive(grandchildPid))

    // AND THE KEEPER EXITS ON ITS OWN once the job is OS-confirmed empty. It is
    // never killed by the reclaim — it leaves because its own query said empty.
    await until("the keeper to exit", () => keeperPids().every((p) => !keepers.includes(p)))
  }, 180_000)
})

describe.skipIf(!READY)("P5c2 — the keeper's position and its blast radius", () => {
  test("the keeper is outside the job it holds, and an unrelated process and job are untouched", async () => {
    // A bystander with the same image name as our tree's members: a
    // kill-by-image implementation would take it, and this catches that.
    const bystander = Bun.spawn([CMD, "/c", `${PING} -n 60 127.0.0.1`], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    bystander.unref()

    const mine = testJobName("run_k1", "op_k1", 1)
    const other = testJobName("run_k2", "op_k2", 1)
    created.push(mine, other)
    // A long linger keeps both HOSTS alive for the whole test, so what is being
    // compared is two live runs rather than two races against their own teardown.
    const minePid = launchHostile(mine, "run_k1", "op_k1", 1, 90, 90)
    const otherPid = launchHostile(other, "run_k2", "op_k2", 1, 90, 90)
    spawned.push(minePid, otherPid)
    await until("both trees", () => Number(ps(`@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'").Count`)) >= 3)

    const keepersBefore = keeperPids()
    // TWO RUNS, TWO KEEPERS. A shared keeper would make one run's shutdown the
    // other run's outage.
    expect(keepersBefore.length).toBeGreaterThanOrEqual(2)

    // NO KEEPER IS A MEMBER OF THE JOB IT HOLDS. Asked of the job's own member
    // list rather than inferred from how the keeper was launched — a keeper
    // inside the job would be terminated with the tree it must outlive.
    const r = terminate(mine, "run_k1", "op_k1", 1)
    const members = ((r.before ?? []) as { pid: number }[]).map((p) => p.pid)
    for (const k of keepersBefore) expect(members).not.toContain(k)
    expect(r.treeGone).toBe(true)

    // The OTHER run is completely unaffected: its keeper still lives, its name
    // still opens, and its members are still there.
    const otherStill = terminate(other, "run_k2", "op_k2", 1)
    expect(otherStill.jobPresent).toBe(true)
    expect(Number(otherStill.processesBefore)).toBeGreaterThanOrEqual(1)
    expect(otherStill.treeGone).toBe(true)

    expect(pidAlive(bystander.pid)).toBe(true)
    bystander.kill()
  }, 180_000)

  test("NO UNRELATED INHERITABLE HANDLE reaches the target, even though the launch holds several", () => {
    // P5c2 §2, measured as a DIFFERENCE rather than asserted as an intention.
    //
    // At the moment the target is created, a NAMED launch is holding two
    // inheritable handles a plain launch is not: the keeper's arm event and its
    // shutdown event. Both are marked inheritable — they have to be, to reach
    // the keeper — and NEITHER is named in the target's
    // PROC_THREAD_ATTRIBUTE_HANDLE_LIST.
    //
    // These are the right sentinels precisely because they are not synthetic.
    // If `bInheritHandles = TRUE` were used without an explicit list, the target
    // would receive both, and an untrusted program would then be able to
    // `SetEvent` its own keeper's arm and shutdown events — signalling the
    // process whose entire job is to outlive it.
    //
    // The adversary sweeps handle values 4..8192 and reports how many
    // `DuplicateHandle` succeeded on. If the two events crossed, the named count
    // would exceed the plain one. Equality is the proof.
    const plain = runDirect(["run", "--mode", "plain", "--timeout-ms", "60000", "--", HOSTILE, "--grandchild-seconds", "2"])
    const name = testJobName("run_sentinel", "op_sentinel", 1)
    created.push(name)
    const named = runDirect(["run", "--mode", "plain", ...identityArgs(name, "run_sentinel", "op_sentinel", 1), "--timeout-ms", "60000", "--", HOSTILE, "--grandchild-seconds", "2"])

    const sweep = (r: Record<string, unknown>) =>
      JSON.parse(
        String(r.stdout ?? "")
          .split("\n")
          .find((l) => l.includes("hostile.swept"))!
          .trim(),
      ) as { handlesDuplicated: number; inAnyJob: boolean }

    const a = sweep(plain)
    const b = sweep(named)
    // NON-VACUITY: the sweep really did reach handles in both runs, so an
    // equality of zeroes cannot pass for a proof.
    expect(a.handlesDuplicated).toBeGreaterThan(0)
    expect(b.handlesDuplicated).toBeGreaterThan(0)
    // AND THE NAMED LAUNCH GAVE THE TARGET NOTHING EXTRA, despite holding two
    // more inheritable handles than the plain one at the moment of the spawn.
    expect(b.handlesDuplicated).toBe(a.handlesDuplicated)
    // The named run really was the named run: it was contained in a job.
    expect(b.inAnyJob).toBe(true)
    expect(named.keeperArmed).toBe(true)
  }, 120_000)

  test("a keeper refuses a job name that does not derive from the identity it was given", () => {
    // The keeper recomputes the name's prefix from the runId/operationId/
    // fencingToken it was handed and refuses a name that does not start with it.
    // Presented through the launch path: a name minted for one identity, offered
    // with another. The launch must refuse, and nothing may be created.
    const name = testJobName("run_real", "op_real", 5)
    const r = runDirect(["run", "--mode", "plain", ...identityArgs(name, "run_IMPOSTOR", "op_real", 5), "--timeout-ms", "20000", "--", CMD, "/c", "echo SHOULD-NOT-RUN"])
    expect(r.ok).toBe(false)
    expect(String(r.stdout ?? "")).not.toContain("SHOULD-NOT-RUN")
    expect(r.pid ?? null).toBe(null)
    // No keeper was left holding anything.
    expect(keeperPids().length).toBe(0)
  }, 60_000)
})

describe.skipIf(!READY)("P5c2 — killing the keeper is an explicit unrecoverable state, never a false clean", () => {
  test("a dead keeper with a live tree reports UNPROVEN, and never treeGone", async () => {
    const name = testJobName("run_kk", "op_kk", 1)
    created.push(name)
    const helperPid = launchHostile(name, "run_kk", "op_kk", 1, 90, 20)
    spawned.push(helperPid)
    await until("the grandchild to start", () => Number(ps(`@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'").Count`)) > 0)
    const grandchildPid = Number(ps(`(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Select-Object -First 1).ProcessId`))

    const keepers = keeperPids()
    expect(keepers.length).toBeGreaterThan(0)

    // Kill the host, then KILL THE KEEPER. Nothing holds a handle to the job any
    // more, so the object manager drops its NAME while the tree keeps running.
    ps(`Stop-Process -Id ${helperPid} -Force -ErrorAction SilentlyContinue`)
    await until("the host to die", () => !pidAlive(helperPid))
    for (const k of keepers) ps(`Stop-Process -Id ${k} -Force -ErrorAction SilentlyContinue`)
    await until("the keeper to die", () => keepers.every((k) => !pidAlive(k)))
    await until("the hostile target to exit", () => ps(`@(Get-CimInstance Win32_Process -Filter "Name='abdo-hostile-target.exe'").Count`) === "0", 40_000)

    // The tree is STILL RUNNING and now unreachable by name.
    expect(pidAlive(grandchildPid)).toBe(true)

    // THE ASSERTION THAT MATTERS. `terminate-process-tree` must report that it
    // cannot prove anything — never `ok:true, treeGone:true`, which is what the
    // verb did before P5c finding 22 and which would let a sweep restore ACLs
    // out from under a live process.
    const r = terminate(name, "run_kk", "op_kk", 1)
    expect(r.jobPresent).toBe(false)
    expect(r.stage).toBe("terminate_job_absent")
    expect(r.treeGone).toBe(false)
    expect(r.ok).toBe(false)

    // And it is still running afterwards: the refusal terminated nothing.
    expect(pidAlive(grandchildPid)).toBe(true)
    ps(`Stop-Process -Id ${grandchildPid} -Force -ErrorAction SilentlyContinue`)
  }, 180_000)
})

afterAll(async () => {
  for (const name of created) {
    for (const id of [
      ["run_hostile", "op_hostile", 1],
      ["run_orphan2", "op_orphan2", 3],
      ["run_k1", "op_k1", 1],
      ["run_k2", "op_k2", 1],
      ["run_kk", "op_kk", 1],
    ] as const) {
      try {
        terminate(name, id[0], id[1], id[2])
      } catch {
        /* the per-test terminate is the real cleanup; this is the backstop */
      }
    }
  }
  // ── RC4 §3: ONE PowerShell, NOT SIX PLUS ONE PER PROCESS ────────────────
  //
  // This hook timed out — an `(unnamed)` failure, because a hook has no test
  // identity even in JUnit. The blocking operation was identified rather than
  // guessed at: every `ps()` spawns a PowerShell, MEASURED at ~455 ms, and this
  // hook made one per surviving pid, two by-name sweeps, one to LIST the keepers
  // and one more per keeper — then slept 500 ms unconditionally. That is several
  // seconds of instrument against a 5 s hook budget, before the product does any
  // work at all.
  //
  // Everything the hook actually has to do is expressible in a single
  // invocation, and the sweep is unchanged in what it removes: keepers, hostile
  // targets, stray PINGs and this file's own helpers. A test file that leaves
  // any of them behind still fails the run — the census is what enforces that,
  // and it is untouched.
  const stragglers = spawned.filter((pid) => pidAlive(pid))
  const idList = stragglers.join(",")
  ps(
    `${idList === "" ? "" : `Stop-Process -Id ${idList} -Force -ErrorAction SilentlyContinue; `}` +
      `Get-CimInstance Win32_Process -Filter "Name='abdo-hostile-target.exe' OR Name='PING.EXE'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; ` +
      `Get-CimInstance Win32_Process -Filter "Name='abdo-winiso.exe'" | Where-Object { $_.CommandLine -like '*job-keeper*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  )
})
