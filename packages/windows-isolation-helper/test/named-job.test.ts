/**
 * P5c — the named job, its collision safety, and whole-tree termination.
 *
 * REAL WINDOWS THROUGHOUT. Every job here is a real kernel object, every process
 * is a real process, and every "it is gone" is the OS answering a fresh query
 * rather than this file believing a return code. The one thing a test like this
 * must never do is assert on the helper's own summary of what it did — so the
 * assertions go to `Get-CimInstance` and to a re-query of the job's member list.
 *
 * WHY THE VERB EXISTS AT ALL (finding 17): the launch path used to create its
 * job with `CreateJobObjectW(null, null)`. An anonymous job's handle dies with
 * the helper that made it, so a host that died with a child still running left a
 * tree NOTHING could ever reach again — and recovery, having no safe action,
 * deferred, which `startup.ts` turns into a blocked bootstrap for the whole
 * machine.
 *
 * TWO MEASUREMENTS SHAPED THIS FILE AND ARE PINNED BY TESTS BELOW.
 *
 *  1. A collision does NOT arrive as `ERROR_ALREADY_EXISTS` against one of our
 *     own jobs. `CreateJobObjectW` opens an existing name with
 *     `JOB_OBJECT_ALL_ACCESS`, and our protected descriptor withholds
 *     `WRITE_DAC`/`WRITE_OWNER`/`DELETE`, so the open is DENIED and no handle is
 *     ever returned. Handling only the documented code would have missed the
 *     case that actually happens.
 *
 *  2. A named job's NAME does not outlive its last handle. Assigned processes
 *     keep the OBJECT alive, but the object manager removes a temporary object's
 *     name when its handle count hits zero — so after the creating helper died,
 *     `OpenJobObjectW` returned ERROR_FILE_NOT_FOUND while the tree was
 *     provably still running.
 *
 * P5c2 CHANGED THE ANSWER TO (2), AND THIS FILE WITH IT.
 *
 * P5c kept the name alive by duplicating a rights-reduced job handle into the
 * LAUNCHED TARGET. Every target in this file is cooperative, so every test here
 * passed — and the design was still unsound: a handle in the target's own table
 * is a handle the target can close, and a grandchild spawned with
 * `bInheritHandles = FALSE` never received it at all. Either one leaves a live
 * tree whose name has been dropped.
 *
 * The holder is now a TRUSTED PER-RUN KEEPER outside the AppContainer and
 * outside the job, and the target is given no job handle whatsoever. The tests
 * below therefore assert the keeper's existence and position rather than a
 * handle in the child, and the adversarial half — a target that actively hunts
 * and closes handles — lives in `job-keeper.test.ts`, because a cooperative
 * target cannot measure this property at all.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { HELPER, helperBuilt, runDirect } from "./harness"
import { hostSidHash, isValidJobName, JOB_NAME_PREFIX, jobNamePrefixFor, newJobIdentity } from "../src/job-identity"

const READY = process.platform === "win32" && helperBuilt()

const CMD = String.raw`C:\Windows\System32\cmd.exe`
const PING = String.raw`C:\Windows\System32\ping.exe`

/** One PowerShell query. Used for the OS-side assertions, never for mutation. */
function ps(script: string): string {
  const p = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe", timeout: 60_000 })
  return p.stdout.toString().trim()
}

/**
 * Is this pid alive? Asked of the HELPER, not of PowerShell.
 *
 * RC4 §3. This used to spawn a PowerShell per call, MEASURED at ~455 ms each,
 * and it is called in a 150 ms `until` polling loop — so the instrument, not the
 * property, consumed the budget. Two tests in this file inherited bun's 5 s
 * default and timed out at 5.0 s and 6.0 s IDENTICALLY when the file ran alone,
 * which is what ruled out suite load.
 *
 * `inspect-process` is the same question answered natively: MEASURED at ~55 ms,
 * 8.3x cheaper, and it reports `alive` from `GetExitCodeProcess` rather than
 * from a WMI row count. The by-NAME queries below still need PowerShell, because
 * the helper has no verb for them.
 */
const pidAlive = (pid: number): boolean => runDirect(["inspect-process", "--pid", String(pid)]).alive === true

/** The host SID, asked of the helper rather than assumed. */
const hostSid = (): string => String(runDirect(["known-folder", "--id", "ProgramData"]).hostUserSid ?? "")
const sessionId = (): number => Number(runDirect(["version"]).sessionId ?? -1)

let tag = 0
/** A name in the shape the helper accepts, unique per call. */
function testJobName(runId = "run_t", opId = "op_t", fencing = 1): string {
  tag += 1
  return `${jobNamePrefixFor(hostSid(), runId, opId, fencing)}t${process.pid}x${tag}`
}

/**
 * P5c2. The identity a named launch must now carry.
 *
 * `--run-id` / `--operation-id` / `--fencing-token` are no longer optional on a
 * named job: the trusted keeper recomputes the name's prefix from them and
 * refuses to hold a job that does not derive from the identity presented with
 * it. A launch that omitted them would be a keeper bound to nothing.
 */
function namedJobArgs(jobName: string, runId: string, opId: string, fencing: number): string[] {
  return ["--job-name", jobName, "--run-id", runId, "--operation-id", opId, "--fencing-token", String(fencing), "--expect-session-id", String(sessionId())]
}

/** Launch a tree in a named job, WITHOUT waiting for it. Returns the helper pid. */
function launchDetached(jobName: string, seconds = 90, runId = "run_t", opId = "op_t", fencing = 1): number {
  const p = Bun.spawn(
    [HELPER, "run", "--mode", "plain", ...namedJobArgs(jobName, runId, opId, fencing), "--timeout-ms", String(seconds * 1000 + 30_000), "--", CMD, "/c", `${PING} -n ${seconds} 127.0.0.1`],
    {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    },
  )
  p.unref()
  return p.pid
}

/** The keeper processes alive right now, as the OS sees them. */
function keeperPids(): number[] {
  const raw = ps(`Get-CimInstance Win32_Process -Filter "Name='abdo-winiso.exe'" | Where-Object { $_.CommandLine -like '*job-keeper*' } | ForEach-Object { $_.ProcessId }`)
  return raw.length === 0 ? [] : raw.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => n > 0)
}

/** Wait until a predicate holds, or fail loudly rather than silently continuing. */
async function until(what: string, f: () => boolean, budgetMs = 15_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < budgetMs) {
    if (f()) return
    await Bun.sleep(150)
  }
  throw new Error(`timed out waiting for: ${what}`)
}

/** Every job this file created, so the teardown can prove it left nothing. */
const created: string[] = []
const spawnedHelpers: number[] = []

function terminate(jobName: string, extra: readonly string[] = [], runId = "run_t", opId = "op_t", fencing = 1) {
  return runDirect([
    "terminate-process-tree",
    "--job-name",
    jobName,
    "--run-id",
    runId,
    "--operation-id",
    opId,
    "--fencing-token",
    String(fencing),
    "--expect-session-id",
    String(sessionId()),
    ...extra,
  ])
}

describe.skipIf(!READY)("P5c — the job's NAME", () => {
  test("the derivation refuses anything that could leave the session namespace", () => {
    const good = newJobIdentity({ hostSid: "S-1-5-21-1-2-3-1001", sessionId: 1, runId: "run_abc", operationId: "op_def", fencingToken: 7 }).jobName
    expect(isValidJobName(good)).toBe(true)
    expect(good.startsWith(JOB_NAME_PREFIX)).toBe(true)

    // EXACTLY ONE BACKSLASH — the one in `Local\`. A second would address a
    // nested object directory or walk out of the session namespace entirely,
    // which is the whole point of the `Local\` scoping.
    expect(good.split("\\").length).toBe(2)
    expect(isValidJobName(String.raw`Local\Abdo-IsolatedRun-a\b`)).toBe(false)
    expect(isValidJobName(String.raw`Global\Abdo-IsolatedRun-a`)).toBe(false)
    expect(isValidJobName(String.raw`Local\Abdo-IsolatedRun-..\..\Global\x`)).toBe(false)
    expect(isValidJobName(String.raw`Local\Abdo-IsolatedRun-C:\Windows`)).toBe(false)
    expect(isValidJobName("Local\\Abdo-IsolatedRun-")).toBe(false)
    // No path characters, no dots, no spaces.
    for (const bad of ["a.b", "a/b", "a b", "a:b", "a*b"]) {
      expect(isValidJobName(`${JOB_NAME_PREFIX}${bad}`)).toBe(false)
    }
  })

  test("two runs never share a name, and the name binds run, operation and fencing token", () => {
    const a = newJobIdentity({ hostSid: "S-1-5-21-1-2-3-1001", sessionId: 1, runId: "run_abc", operationId: "op_def", fencingToken: 7 })
    const b = newJobIdentity({ hostSid: "S-1-5-21-1-2-3-1001", sessionId: 1, runId: "run_abc", operationId: "op_def", fencingToken: 7 })
    expect(a.jobName).not.toBe(b.jobName) // the nonce
    // Change ANY bound component and the prefix moves, which is what lets the
    // helper refuse a name presented with somebody else's evidence.
    const p = jobNamePrefixFor("S-1-5-21-1-2-3-1001", "run_abc", "op_def", 7)
    expect(a.jobName.startsWith(p)).toBe(true)
    expect(jobNamePrefixFor("S-1-5-21-1-2-3-1001", "run_ZZZ", "op_def", 7)).not.toBe(p)
    expect(jobNamePrefixFor("S-1-5-21-1-2-3-1001", "run_abc", "op_ZZZ", 7)).not.toBe(p)
    expect(jobNamePrefixFor("S-1-5-21-1-2-3-1001", "run_abc", "op_def", 8)).not.toBe(p)
    expect(jobNamePrefixFor("S-1-5-21-9-9-9-9999", "run_abc", "op_def", 7)).not.toBe(p)
    // No component is model-controlled: nothing here comes from a caller string.
    expect(hostSidHash("S-1-5-21-1-2-3-1001")).toMatch(/^[0-9a-f]{16}$/)
  })

  test("the TypeScript and Rust derivations agree", () => {
    // Two copies of one rule in two languages is the drift that once cost seven
    // identity tests, so it is compared rather than trusted. The Rust side is
    // exercised through the verb: it recomputes the prefix from the evidence and
    // refuses a name that does not start with it, so a name TypeScript derived
    // must be accepted by Rust for the same inputs.
    const name = testJobName("run_agree", "op_agree", 3)
    const r = terminate(name, [], "run_agree", "op_agree", 3)
    // The job does not exist, so it stops at `terminate_job_absent` — NOT at
    // `terminate_identity_unproven`, which is what a disagreement would produce.
    expect(r.stage).toBe("terminate_job_absent")
  })
})

describe.skipIf(!READY)("P5c — creation and collision", () => {
  test("a unique named job is created with an explicit, protected, owner-only descriptor", () => {
    const name = testJobName()
    created.push(name)
    const r = runDirect(["run", "--mode", "plain", ...namedJobArgs(name, "run_t", "op_t", 1), "--timeout-ms", "10000", "--", CMD, "/c", "echo made-it"])
    expect(r.ok).toBe(true)
    expect(r.jobName).toBe(name)
    expect(String(r.stdout ?? "")).toContain("made-it")

    const sddl = String(r.jobSecurityDescriptor ?? "")
    const sid = hostSid()
    // PROTECTED, so nothing is inherited from the object directory.
    expect(sddl).toContain("D:P")
    // Exactly ONE ACE, for the host SID, with the exact mask.
    expect(sddl.match(/\(/g)?.length).toBe(1)
    expect(sddl.toLowerCase()).toContain(sid.toLowerCase())
    expect(sddl.toLowerCase()).toContain("0x12000f")
    // The absences are the security property, and they are asserted rather than
    // assumed: no Everyone, no Authenticated Users, no Builtin Users, no
    // AppContainer, and no write-owner/write-dac for anybody.
    for (const forbidden of [";;;WD)", ";;;AU)", ";;;BU)", ";;;AC)", "S-1-1-0", "S-1-5-11", "S-1-5-32-545", "S-1-15-2-"]) {
      expect(sddl).not.toContain(forbidden)
    }
    // No breakaway of any kind: children cannot leave the job.
    expect(r.jobLimitFlags).toBe(0)
    // And it is NOT kill-on-close, which is what lets the tree outlive a crash.
    expect(Number(r.jobLimitFlags)).not.toBe(0x2000)
    expect(r.isProcessInJob).toBe(true)
    expect(r.jobDrained).toBe(true)
    expect(r.jobMembersAfter).toBe(0)

    // P5c2. THE KEEPER RAN, ARMED, AND WAS REAPED — asserted on the normal path
    // and not only in the crash tests, because a keeper that quietly failed to
    // start would otherwise be invisible until the one run that needed it.
    expect(r.keeperReady).toBe(true)
    expect(Number(r.keeperPid)).toBeGreaterThan(0)
    expect(r.keeperArmed).toBe(true)
    // It exits on an OS-CONFIRMED empty job, and this run's job is empty above.
    expect(r.keeperExited).toBe(true)
    expect(keeperPids()).not.toContain(Number(r.keeperPid))
    // AND THE FIELD IT REPLACED IS GONE, not merely false. A `false` here would
    // read as a keep-alive that failed rather than as one that no longer exists.
    expect(r.childKeepAliveHandle).toBeUndefined()
  })

  test("a pre-created job with the SAME name is refused, and is left completely untouched", async () => {
    const name = testJobName()
    created.push(name)
    // A REAL holder: another helper owns this name and has a live tree in it.
    const holderPid = launchDetached(name)
    spawnedHelpers.push(holderPid)
    await until("the holder's tree to start", () => ps(`@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'").Count`) !== "0")
    const beforePings = ps(`@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'").Count`)

    const r = runDirect(["run", "--mode", "plain", ...namedJobArgs(name, "run_t", "op_t", 1), "--timeout-ms", "10000", "--", CMD, "/c", "echo SHOULD-NOT-RUN"])

    expect(r.stage).toBe("named_job_collision")
    expect(r.ok).toBe(false)
    // NO PROCESS WAS CREATED. This is the assertion that matters: the refusal
    // has to precede the spawn, not follow it.
    expect(r.pid ?? null).toBe(null)
    expect(r.assignedToJob).toBe(false)
    expect(String(r.stdout ?? "")).not.toContain("SHOULD-NOT-RUN")

    // NOT ADOPTED AND NOT TERMINATED: the holder's tree is exactly as it was.
    expect(ps(`@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'").Count`)).toBe(beforePings)
    expect(pidAlive(holderPid)).toBe(true)

    // MEASURED, and the reason this test asserts the code rather than the errno:
    // against one of OUR jobs the collision surfaces as ACCESS_DENIED, because
    // the protected descriptor denies the ALL_ACCESS open that CreateJobObjectW
    // performs on an existing name. No handle is ever returned.
    expect(r.collisionHandleReturned).toBe(false)
    expect(r.errorCode).toBe(5)

    const killed = terminate(name)
    expect(killed.treeGone).toBe(true)
  })

  test("a name held by a DIFFERENT kernel object type is refused, and that object survives", async () => {
    const name = testJobName()
    // A named EVENT, not a job, squatting on the name. `Local\` is the same
    // namespace the job would be created in.
    const script = `
      $e = New-Object System.Threading.EventWaitHandle($false, 'ManualReset', '${name}')
      Write-Output 'EVENT-CREATED'
      Start-Sleep -Seconds 20
      $e.Close()
    `
    const squatter = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    // Wait for the event to actually exist, or the test proves nothing.
    const rdr = squatter.stdout.getReader()
    const first = await rdr.read()
    expect(new TextDecoder().decode(first.value ?? new Uint8Array())).toContain("EVENT-CREATED")

    const r = runDirect(["run", "--mode", "plain", ...namedJobArgs(name, "run_t", "op_t", 1), "--timeout-ms", "10000", "--", CMD, "/c", "echo SHOULD-NOT-RUN"])
    expect(r.ok).toBe(false)
    // Either shape is a refusal; both leave the squatter alone and start nothing.
    expect(["named_job_name_type_conflict", "named_job_collision"]).toContain(String(r.stage))
    expect(r.pid ?? null).toBe(null)
    expect(String(r.stdout ?? "")).not.toContain("SHOULD-NOT-RUN")
    // The squatter is untouched — we never terminate a name we did not create.
    expect(pidAlive(squatter.pid)).toBe(true)
    squatter.kill()
  })
})

describe.skipIf(!READY)("P5c — the evidence a terminate demands", () => {
  test("a wrong session is refused before the job is even opened", () => {
    const name = testJobName()
    const r = runDirect(["terminate-process-tree", "--job-name", name, "--run-id", "run_t", "--operation-id", "op_t", "--fencing-token", "1", "--expect-session-id", String(sessionId() + 77)])
    expect(r.ok).toBe(false)
    expect(r.stage).toBe("terminate_session_mismatch")
  })

  test("a wrong operationId or fencingToken cannot name someone else's job", async () => {
    const name = testJobName("run_fence", "op_fence", 4)
    created.push(name)
    const holderPid = launchDetached(name, 90, "run_fence", "op_fence", 4)
    spawnedHelpers.push(holderPid)
    await until("the holder's tree", () => ps(`@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'").Count`) !== "0")

    // Right name, WRONG operation id.
    const wrongOp = terminate(name, [], "run_fence", "op_SOMETHING_ELSE", 4)
    expect(wrongOp.ok).toBe(false)
    expect(wrongOp.stage).toBe("terminate_identity_unproven")

    // Right name, WRONG run id.
    const wrongRun = terminate(name, [], "run_SOMETHING_ELSE", "op_fence", 4)
    expect(wrongRun.stage).toBe("terminate_identity_unproven")

    // THE STALE-OWNER CASE. An owner fenced out at token 4 cannot terminate a
    // job minted under a higher token: its own token is baked into the name it
    // would have to produce, so it cannot even spell the newer job's name.
    const staleOwner = terminate(name, [], "run_fence", "op_fence", 3)
    expect(staleOwner.ok).toBe(false)
    expect(staleOwner.stage).toBe("terminate_identity_unproven")

    // And through all of that the tree was never touched.
    expect(pidAlive(holderPid)).toBe(true)
    const killed = terminate(name, [], "run_fence", "op_fence", 4)
    expect(killed.treeGone).toBe(true)
  })

  test("a member pid presented with the WRONG creation time is refused as pid reuse", async () => {
    const name = testJobName("run_reuse", "op_reuse", 1)
    created.push(name)
    const holderPid = launchDetached(name, 90, "run_reuse", "op_reuse", 1)
    spawnedHelpers.push(holderPid)
    await until("the holder's tree", () => ps(`@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'").Count`) !== "0")

    // The REAL initial process — the helper's direct child. Asked of the OS, so
    // the pid this test claims about is genuinely a member of the job.
    //
    // P5c2 MADE "THE HELPER'S FIRST CHILD" AMBIGUOUS, and this test caught it by
    // failing: a named launch now spawns TWO children, the trusted keeper and
    // the target, and `Select-Object -First 1` returned whichever the OS listed
    // first. When that was the keeper the assertion below stopped measuring
    // anything — the keeper is deliberately NOT a job member, and the verb's
    // pid-reuse check only fires for a pid that IS one (which is correct: an
    // initial process that has exited while its grandchildren live is legitimate
    // and must not be refused).
    //
    // So the target is selected by what it IS rather than by launch order.
    const initialPid = Number(ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${holderPid}" | Where-Object { $_.Name -eq 'cmd.exe' } | Select-Object -First 1).ProcessId`))
    expect(initialPid).toBeGreaterThan(0)
    // AND IT IS NOT THE KEEPER. Asserted rather than assumed, because the whole
    // point of the selection above is that these two are different processes.
    expect(keeperPids()).not.toContain(initialPid)

    // A pid alone is not an identity. Presenting a member's pid with a creation
    // time that does not match means the caller's evidence describes a DIFFERENT
    // process that has since been given that number — the exact confusion that
    // makes a recovery terminate the wrong thing.
    const reused = terminate(name, ["--expect-initial-pid", String(initialPid), "--expect-initial-start", "133000000000000001"], "run_reuse", "op_reuse", 1)
    expect(reused.ok).toBe(false)
    expect(reused.stage).toBe("terminate_pid_reuse_refused")
    expect(reused.terminated).toBe(false)

    // AND NOTHING WAS TERMINATED. The refusal has to precede the kill.
    expect(pidAlive(initialPid)).toBe(true)
    expect(pidAlive(holderPid)).toBe(true)

    // NON-VACUITY: the SAME call with the true creation time succeeds, so the
    // refusal above was the creation-time check and not some unrelated failure.
    const truthful = terminate(name, [], "run_reuse", "op_reuse", 1)
    expect(truthful.treeGone).toBe(true)
    await until("the initial process to exit", () => !pidAlive(initialPid))
    // A BUDGET DERIVED FROM THE TEST'S OWN BOUNDED WAITS, not a number raised
    // until it passed (RC4 §3). Two `until` calls at 15 s each is 30 s of
    // deliberate waiting before any overhead, so bun's 5 s default could never
    // have been survivable and the timeout was never evidence about the product.
  }, 60_000)
})

describe.skipIf(!READY)("P5c — a dead helper, a live tree, and a later reclaim", () => {
  test("child AND grandchild are job members, the tree outlives its helper, and a NEW helper ends it", async () => {
    const name = testJobName("run_orphan", "op_orphan", 2)
    created.push(name)
    const helperPid = launchDetached(name, 90, "run_orphan", "op_orphan", 2)
    spawnedHelpers.push(helperPid)
    await until("the tree to start", () => ps(`@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'").Count`) !== "0")

    // KILL THE HELPER, not the tree. This is the crash the whole phase is about.
    ps(`Stop-Process -Id ${helperPid} -Force`)
    await until("the helper to die", () => !pidAlive(helperPid))

    // THE PROPERTY: the tree is still running with nothing holding it.
    const pingPid = Number(ps(`(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Select-Object -First 1).ProcessId`))
    expect(pingPid).toBeGreaterThan(0)
    expect(pidAlive(pingPid)).toBe(true)

    // A COMPLETELY NEW HELPER PROCESS opens the recorded job by name.
    const r = terminate(name, [], "run_orphan", "op_orphan", 2)
    expect(r.jobPresent).toBe(true)

    // Already an array: the helper emits these as raw JSON, so the envelope's
    // own parse has done the work. `String(...)` on it yields "[object Object]".
    const before = (r.before ?? []) as { pid: number; image: string }[]
    // The direct child AND its own child are both members: no breakaway flag was
    // ever set, so descendants stay in the job.
    const images = before.map((p) => p.image.toLowerCase())
    expect(images.some((i) => i.endsWith("cmd.exe"))).toBe(true)
    expect(images.some((i) => i.endsWith("ping.exe"))).toBe(true)
    expect(before.length).toBeGreaterThanOrEqual(2)

    // TERMINATED AND PROVED: the job's own member list is empty, no observed
    // process survived, and the OS agrees about the grandchild.
    expect(r.terminated).toBe(true)
    expect(r.drained).toBe(true)
    expect(r.processesAfter).toBe(0)
    expect(r.after ?? []).toEqual([])
    expect(r.stillAlive ?? []).toEqual([])
    expect(r.treeGone).toBe(true)
    expect(r.ok).toBe(true)
    await until("the OS to agree the grandchild is gone", () => !pidAlive(pingPid))
    // THREE `until` calls at 15 s each — 45 s of deliberate bounded waiting —
    // plus a helper kill and two terminates. Derived, not raised until green.
  }, 90_000)

  test("an absent job name is reported as UNPROVEN, never as a terminated tree", () => {
    // The measurement that produced this rule: a name does not outlive its last
    // handle, so `job_absent` once returned `ok:true, treeGone:true` while the
    // recorded tree was still running. That is a verification reported without a
    // measurement, and it is exactly what this package exists to refuse.
    const name = testJobName("run_absent", "op_absent", 1)
    const r = terminate(name, [], "run_absent", "op_absent", 1)
    expect(r.jobPresent).toBe(false)
    expect(r.stage).toBe("terminate_job_absent")
    expect(r.treeGone).toBe(false)
    expect(r.ok).toBe(false)
  })

  test("an UNRELATED process and an UNRELATED named job are both untouched", async () => {
    // A bystander with the same image name as our tree's members, so a
    // kill-by-image-name implementation would take it and this test would catch
    // that.
    const bystander = Bun.spawn([CMD, "/c", `${PING} -n 40 127.0.0.1`], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    bystander.unref()

    const mine = testJobName("run_mine", "op_mine", 1)
    const other = testJobName("run_other", "op_other", 1)
    created.push(mine, other)
    const minePid = launchDetached(mine, 90, "run_mine", "op_mine", 1)
    const otherPid = launchDetached(other, 90, "run_other", "op_other", 1)
    spawnedHelpers.push(minePid, otherPid)
    await until("both trees", () => Number(ps(`@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'").Count`)) >= 3)

    const r = terminate(mine, [], "run_mine", "op_mine", 1)
    expect(r.treeGone).toBe(true)

    // The other job's helper and the bystander are both still running.
    expect(pidAlive(otherPid)).toBe(true)
    expect(pidAlive(bystander.pid)).toBe(true)
    // And the other job is still openable and still has its members.
    const otherStill = terminate(other, [], "run_other", "op_other", 1)
    expect(otherStill.jobPresent).toBe(true)
    expect(Number(otherStill.processesBefore)).toBeGreaterThanOrEqual(1)
    expect(otherStill.treeGone).toBe(true)

    expect(pidAlive(bystander.pid)).toBe(true)
    bystander.kill()
  })
})

afterAll(async () => {
  // EVERY job this file created is proved gone, and every helper it spawned.
  // A test file that leaks a process onto the user's machine has not passed.
  for (const name of created) {
    try {
      terminate(name, [], "run_t", "op_t", 1)
    } catch {
      /* the name is bound to its own run id; the per-test terminate is the real cleanup */
    }
  }
  // ── RC4 §3: ONE PowerShell, NOT ONE PER PROCESS ─────────────────────────
  //
  // This hook timed out — reported as an `(unnamed)` failure, because a hook has
  // no test identity even in the JUnit report. The blocking operation was
  // identified rather than guessed at: every `ps()` call spawns a PowerShell,
  // MEASURED at ~455 ms, and this hook made one per surviving helper plus a
  // by-name sweep, on top of an unconditional 500 ms sleep. With a handful of
  // helpers that alone exceeds bun's 5 s hook budget.
  //
  // The cost is the TEST INSTRUMENT's, not the product's, so the fix is to stop
  // paying it: liveness is now native (`inspect-process`, ~55 ms), the kills are
  // collapsed into a SINGLE invocation, and the blanket sleep is gone. Nothing
  // about what gets cleaned up changed — a leaked process still fails the run,
  // it is just no longer the harness that spends the budget.
  const stragglers = spawnedHelpers.filter((pid) => pidAlive(pid))
  const idList = stragglers.join(",")
  ps(
    `${idList === "" ? "" : `Stop-Process -Id ${idList} -Force -ErrorAction SilentlyContinue; `}` +
      `Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  )
})
