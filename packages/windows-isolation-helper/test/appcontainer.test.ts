/**
 * CL-16A2-C — Windows AppContainer, adversarial and measured.
 *
 * Every assertion here was written AFTER the exploratory passes (`measure.ts`,
 * `measure2.ts`, `measure3.ts`) reported what this machine actually does. They
 * lock in measured reality; they are not expectations.
 *
 * TWO RULES THIS SUITE OBEYS
 *
 *  1. **Control first.** Each egress vector runs OUTSIDE the AppContainer first,
 *     through the same helper, the same pipes and the same job. A vector the
 *     control could not exercise is reported UNKNOWN and never used to prove
 *     blocking. This is not theoretical: round 2's grandchild canary lost its
 *     `$` variables to cmd.exe and printed its own script text — the only reason
 *     that was caught is that the CONTROL printed the same garbage.
 *  2. **Privilege travels with the measurement.** Every helper result carries
 *     `elevated` and `integrity` from the process that produced it, and the
 *     no-admin assertions check them. A result from an elevated shell cannot be
 *     mistaken for a no-admin proof, whatever shell the suite was started from.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { containerName, firstMissingLifecycleStep, helperBuilt, runDirect, runDirectAsync, runUnelevated, type HelperResult } from "./harness"

const WINDOWS = process.platform === "win32"
const READY = WINDOWS && helperBuilt()
const CMD = "C:\\Windows\\System32\\cmd.exe"
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const PKG_ROOT = join(process.env.LOCALAPPDATA ?? "", "Packages")
const SAMPLE_WORKSPACE = join(import.meta.dir, "..")
const T = 120_000

const run = (tag: string, extra: string[], argv: string[]) => runUnelevated(["run", "--name", containerName(tag), ...extra, "--", ...argv], 90_000)

/** Non-elevated is a PRECONDITION of every measurement, asserted on each one. */
function expectUnelevated(r: HelperResult) {
  expect(r.elevated).toBe(false)
  expect(r.integrity).toBe("medium")
}

describe.skipIf(!READY)("CL-16A2-C section 8 — no administrator, no global state", () => {
  test("the helper reports a NON-ELEVATED, medium-integrity context", async () => {
    const r = await runUnelevated(["version"])
    expectUnelevated(r)
    expect(r.ok).toBe(true)
  }, T)

  test("CreateAppContainerProfile succeeds WITHOUT elevation", async () => {
    const r = await runUnelevated(["probe"])
    expectUnelevated(r)
    expect(r.ok).toBe(true)
    expect(r.createHresult).toBe(0)
    expect(r.deleteHresult).toBe(0)
  }, T)

  test("the SID is derivable WITHOUT creating a profile, and matches the created one", async () => {
    const r = await runUnelevated(["probe"])
    expect(r.deriveHresult).toBe(0)
    expect(r.sidsMatch).toBe(true)
  }, T)
})

describe.skipIf(!READY)("CL-16A2-C section 4 — profile lifecycle is PERSISTENT STATE", () => {
  test("a DERIVED sid alone cannot start a process — the profile is mandatory", async () => {
    // This is the finding that makes the whole path stateful. If a derived SID
    // were enough, an AppContainer run would leave nothing behind at all.
    const r = await run("derived", ["--sid-source", "derive"], [CMD, "/c", "echo", "hi"])
    expectUnelevated(r)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe("CreateProcessW")
    expect(r.errorCode).toBe(2) // ERROR_FILE_NOT_FOUND
  }, T)

  test("creating a profile writes a package directory AND a registry mapping; deleting removes both", async () => {
    const name = containerName("state")
    const created = await runUnelevated(["create-profile", "--name", name])
    expectUnelevated(created)
    expect(created.ok).toBe(true)
    expect(existsSync(join(PKG_ROOT, name))).toBe(true)
    const key = `HKCU\\SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings\\${created.sid}`
    const present = Bun.spawnSync(["C:\\Windows\\System32\\reg.exe", "query", key], { stdout: "ignore", stderr: "ignore" })
    expect(present.exitCode).toBe(0)

    const deleted = await runUnelevated(["delete-profile", "--name", name])
    expect(deleted.ok).toBe(true)
    expect(existsSync(join(PKG_ROOT, name))).toBe(false)
    const gone = Bun.spawnSync(["C:\\Windows\\System32\\reg.exe", "query", key], { stdout: "ignore", stderr: "ignore" })
    expect(gone.exitCode).not.toBe(0)
  }, T)

  test("a second run on the SAME name does not create — and must not delete the first run's profile", async () => {
    // ── RC4 §2: THIS TEST USED TO PROVE THE OPPOSITE OF WHAT IT CLAIMED ─────
    //
    // It launched both runs through `Promise.all` over `runUnelevated`, which at
    // medium integrity is `Bun.spawnSync` — a call that BLOCKS THE EVENT LOOP.
    // MEASURED: the second task did not start until the first had fully
    // returned (both marks at 51 ms). So the runs were strictly sequential, run
    // A had already deleted its profile before run B began, and
    // `profileExisted: false` was the CORRECT answer to what actually happened.
    // The test was asserting concurrency while measuring serialisation.
    //
    // Now: `runDirectAsync` (real `Bun.spawn`), and the ordering is established
    // by OBSERVED STATE rather than by sleeping.
    //
    //   READY      A has acquired the profile — polled via `inspect-profile`,
    //              which is A's actual lease on the contended resource, not a
    //              guess about how long A takes to get there.
    //   CONTENTION B runs only after READY, so it necessarily overlaps A.
    //   PROOF      A is still UNSETTLED when B has finished, asserted from A's
    //              own promise. That is what makes the overlap a fact.
    //   RELEASE    A is left to finish on its own; nothing is torn down under it.
    const name = containerName("race")
    const seq: string[] = []
    const mark = (s: string) => seq.push(`${seq.length}:${s}@${Date.now()}`)

    // A holds the profile for well past B's whole lifetime.
    mark("A-launch")
    let aSettled = false
    const aPromise = runDirectAsync(["run", "--name", name, "--timeout-ms", "30000", "--", PS, "-NoProfile", "-Command", "Start-Sleep -Seconds 12; 'A-DONE'"], 90_000).then((r) => {
      aSettled = true
      return r
    })

    // READY: poll A's real state. Bounded, and a miss FAILS rather than quietly
    // continuing into a test that would then measure nothing.
    let ready = false
    for (let i = 0; i < 200 && !ready; i++) {
      await Bun.sleep(100)
      if (aSettled) break
      ready = runDirect(["inspect-profile", "--name", name]).profileExists === true
    }
    expect(ready, "run A never acquired its profile, so there was nothing to contend with").toBe(true)
    expect(aSettled, "run A finished before B even started; there was no overlap to measure").toBe(false)
    mark("A-ready")

    // CONTENTION: B starts only now, and is short.
    mark("B-launch")
    const second = await runDirectAsync(["run", "--name", name, "--timeout-ms", "30000", "--", CMD, "/c", "echo B-DONE"], 90_000)
    mark("B-done")

    // THE OVERLAP, PROVEN: B ran to completion while A was still running.
    expect(aSettled, "run A had already finished when B completed — the runs did not overlap").toBe(false)

    expect(second.ok).toBe(true)
    // The overlapping run SAW the profile and left ownership alone. Deleting it
    // would have pulled the container out from under a live run.
    expect(second.profileExisted).toBe(true)
    expect(second.profileCreated).toBe(false)
    expect(second.profileDeleted).toBe(false)

    // RELEASE: A is never killed — it is allowed to finish and is checked.
    const first = await aPromise
    mark("A-done")
    expect(first.ok).toBe(true)
    expect(first.profileCreated).toBe(true)
    expect(String(first.stdout)).toContain("A-DONE")

    // Each run's lifecycle is its OWN, carried with its result: a shared
    // `lastEvents()` slot would have been overwritten by whichever finished last.
    expect(firstMissingLifecycleStep(first.events)).toBeUndefined()
    expect(firstMissingLifecycleStep(second.events)).toBeUndefined()

    console.log(`[gate] overlap: profile=${name} A.pid=${first.pid} B.pid=${second.pid} seq=${seq.join(" ")}`)
    runDirect(["delete-profile", "--name", name])
  }, 180_000)

  test("independent parallel runs do not interfere", async () => {
    const rs = await Promise.all([run("p1", [], [CMD, "/c", "echo", "A"]), run("p2", [], [CMD, "/c", "echo", "B"]), run("p3", [], [CMD, "/c", "echo", "C"])])
    expect(rs.map((r) => r.stdout?.trim())).toEqual(["A", "B", "C"])
    for (const r of rs) expect(r.profileDeleted).toBe(true)
  }, T)
})

describe.skipIf(!READY)("CL-16A2-C section 6 — network denial, control first", () => {
  const TCP = "try{ (New-Object Net.Sockets.TcpClient).Connect('8.8.8.8',53); 'OK' } catch { 'FAIL' }"
  const DNS = "try{ [Net.Dns]::GetHostEntry('example.com') | Out-Null; 'OK' } catch { 'FAIL' }"
  const HTTP = "try{ Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 http://example.com | Out-Null; 'OK' } catch { 'FAIL' }"
  const UDP =
    "try{ $u=New-Object Net.Sockets.UdpClient; $u.Client.ReceiveTimeout=4000; $u.Connect('8.8.8.8',53); [void]$u.Send([byte[]](0,0,1,0,0,1,0,0,0,0,0,0,0,0,1,0,1),17); $u.Receive([ref]$null) | Out-Null; 'OK' } catch { 'FAIL' }"
  const GC = (inner: string) => [PS, "-NoProfile", "-Command", `Start-Process -FilePath powershell -ArgumentList '-NoProfile','-Command',"${inner}" -NoNewWindow -Wait`]

  const vectors: { name: string; argv: string[] }[] = [
    { name: "TCP", argv: [PS, "-NoProfile", "-Command", TCP] },
    { name: "DNS", argv: [PS, "-NoProfile", "-Command", DNS] },
    { name: "HTTP", argv: [PS, "-NoProfile", "-Command", HTTP] },
    { name: "UDP", argv: [PS, "-NoProfile", "-Command", UDP] },
    { name: "curl.exe", argv: ["C:\\Windows\\System32\\curl.exe", "-sS", "-m", "8", "-o", "NUL", "http://example.com"] },
    { name: "a GRANDCHILD's TCP", argv: GC(TCP) },
    { name: "a GRANDCHILD's DNS", argv: GC(DNS) },
    // PATH manipulation WITHOUT cmd.exe. The first version went through
    // `cmd /c set PATH=... & powershell -Command "...$c..."`, and cmd stripped
    // the `$` variables so the child printed the script instead of running it.
    // The control caught it and the vector reported UNKNOWN — correct, but it
    // tested nothing. Setting PATH in PowerShell keeps the canary intact.
    {
      name: "a PATH-manipulated child",
      argv: [PS, "-NoProfile", "-Command", `$env:PATH = 'C:\\Windows\\System32;C:\\Windows;' + $env:PATH; Start-Process -FilePath powershell -ArgumentList '-NoProfile','-Command',"${TCP}" -NoNewWindow -Wait`],
    },
  ]

  for (const v of vectors) {
    test(`${v.name}: reachable OUTSIDE the container, blocked INSIDE it`, async () => {
      const control = await run("ctl", ["--mode", "plain", "--timeout-ms", "40000"], v.argv)
      expectUnelevated(control)
      const controlReached = control.exitCode === 0 && !/FAIL/.test(control.stdout ?? "")
      if (!controlReached) {
        console.warn(`UNKNOWN ${v.name}: the control did not reach the network (exit ${control.exitCode}, out ${JSON.stringify(control.stdout?.slice(0, 120))}); not used to prove blocking`)
        return
      }
      const inside = await run("ac", ["--timeout-ms", "40000"], v.argv)
      expectUnelevated(inside)
      // The process RAN and could not reach the network — it did not simply fail
      // to start, which would prove nothing about egress.
      expect(inside.stage).toBeUndefined()
      const blocked = /FAIL/.test(inside.stdout ?? "") || inside.exitCode !== 0
      expect(blocked).toBe(true)
    }, T)
  }

  test("LOOPBACK: reachable WITHIN the container, blocked OUT of it", async () => {
    // The precise shape matters and is NOT the Linux one. A fresh Linux netns
    // has `lo` down, so deny_all kills loopback entirely. AppContainer keeps
    // loopback usable inside the container but refuses connections to a listener
    // outside it — so a local dev server or the Abdo API on 127.0.0.1 is NOT
    // reachable from a sandboxed run, while a run's own child-to-child traffic is.
    const inside =
      "$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $l.Start(); $p=$l.LocalEndpoint.Port; " +
      "try{ (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',$p); 'IN-OK' } catch { 'IN-FAIL' }; $l.Stop()"
    const within = await run("lo1", ["--timeout-ms", "40000"], [PS, "-NoProfile", "-Command", inside])
    expect(within.stdout).toContain("IN-OK")

    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open(s) { s.end() } } })
    try {
      const reach = `try{ (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',${server.port}); 'OUT-REACHED' } catch { 'OUT-BLOCKED' }`
      const control = await run("lo2", ["--mode", "plain", "--timeout-ms", "40000"], [PS, "-NoProfile", "-Command", reach])
      if (!control.stdout?.includes("OUT-REACHED")) {
        console.warn("UNKNOWN outside-loopback: the control could not reach the listener; not used to prove blocking")
        return
      }
      const outside = await run("lo3", ["--timeout-ms", "40000"], [PS, "-NoProfile", "-Command", reach])
      expect(outside.stdout).toContain("OUT-BLOCKED")
    } finally {
      server.stop(true)
    }
  }, 180_000)
})

describe.skipIf(!READY)("CL-16A2-C section 7 — the Job Object contains the tree", () => {
  const SLEEPER = [PS, "-NoProfile", "-Command", "Start-Sleep -Seconds 40"]
  const DETACHER = [CMD, "/c", "start /b powershell -NoProfile -Command Start-Sleep -Seconds 40 & powershell -NoProfile -Command Start-Sleep -Seconds 40"]

  test("a timeout kills a real sleeper", async () => {
    const r = await run("t", ["--timeout-ms", "2500"], SLEEPER)
    expect(r.timedOut).toBe(true)
    expect(Number(r.durationMs)).toBeLessThan(15_000)
  }, T)

  test("a grandchild started with Start-Process is killed too", async () => {
    const r = await run(
      "gc",
      ["--timeout-ms", "3000"],
      [PS, "-NoProfile", "-Command", "Start-Process -FilePath powershell -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 40' -WindowStyle Hidden; Start-Sleep -Seconds 40"],
    )
    expect(r.timedOut).toBe(true)
    expect(Number(r.durationMs)).toBeLessThan(15_000)
  }, T)

  test("CONTROL: without a job the SAME detach attempt escapes the kill", async () => {
    // This is what makes the assertions above mean something. With `--no-job`
    // the helper has no job to terminate, the detached process keeps the pipe
    // open, and the run takes its full 40 seconds instead of ~3.
    //
    // ── RC4 §1: WHY THIS FAILED, AND WHAT IT WAS REALLY MEASURING ──────────
    //
    // It failed at medium integrity with `contained.durationMs = 40782`, and the
    // first hypothesis — that the detached grandchild had ESCAPED the job — was
    // WRONG. `diagnostics/containment-probe.rs` reads the kernel's own member
    // list and proves the `start /b` child IS a member (4 of them) and IS reaped
    // by `TerminateJobObject`, in five process shapes across three environments.
    //
    // The real cause was a PRODUCT defect: `--timeout-ms` bounded only the
    // INITIAL process, not the run. In AppContainer mode `cmd.exe` cannot reach
    // the working directory, so it prints "The current directory is invalid.",
    // fails its synchronous command and exits at once — which is NOT a timeout,
    // so the kill path never ran — while the detached grandchild held the
    // inherited pipe and the helper's drain waited for it with no deadline.
    //
    // With the drain now bounded by the run's budget, the contained arm ends in
    // ~3 s because the job IS terminated, and the `--no-job` arm still takes its
    // full 40 s because there is no job to terminate. So this control now
    // separates exactly what it claims to.
    const contained = await run("j1", ["--timeout-ms", "3000"], DETACHER)
    const escaped = await run("j2", ["--no-job", "--timeout-ms", "3000"], DETACHER)
    expect(Number(contained.durationMs)).toBeLessThan(15_000)
    expect(Number(escaped.durationMs)).toBeGreaterThan(30_000)

    // The contained arm ended because the RUN's budget was enforced, and the
    // helper says which clock ran out. Without this the timing assertion above
    // would pass again the moment the drain became unbounded and the target
    // simply happened to be quick.
    expect(contained.timedOut).toBe(true)
    console.log(`[gate] detach control: contained=${contained.durationMs}ms (timedOut=${contained.timedOut}, drainTimedOut=${contained.drainTimedOut}) escaped=${escaped.durationMs}ms`)
  }, 180_000)

  test("REGRESSION (RC4 §1): a descendant holding the pipe cannot outlive the run's timeout", async () => {
    // THE DEFECT, PINNED. Measured before the fix: `--timeout-ms 3000` produced
    // `durationMs 40547` with `timedOut: false` and no kill issued — an
    // untrusted target could extend its run without limit by exiting quickly and
    // leaving a descendant holding the inherited stdout/stderr pipe.
    //
    // The initial process here exits IMMEDIATELY and deliberately, so the only
    // thing that can end this run is the drain deadline.
    const t0 = Date.now()
    const r = await run("drain", ["--mode", "plain", "--timeout-ms", "4000"], [
      CMD,
      "/c",
      `start /b ${PS} -NoProfile -Command Start-Sleep -Seconds 40 & exit 0`,
    ])
    const wall = Date.now() - t0

    // Bounded by the run's budget, with generous headroom for the terminate and
    // the 5 s collection grace — and far below the 40 s the descendant wanted.
    expect(Number(r.durationMs)).toBeLessThan(20_000)
    expect(wall).toBeLessThan(30_000)
    // And it is REPORTED, not silently absorbed: the run says it ran out of time
    // and says the overrun came from the drain rather than the first process.
    expect(r.timedOut).toBe(true)
    expect(r.drainTimedOut).toBe(true)
    console.log(`[gate] drain deadline: durationMs=${r.durationMs} wall=${wall}ms timedOut=${r.timedOut} drainTimedOut=${r.drainTimedOut}`)
  }, 120_000)

  test("REGRESSION (RC4 §1): a normal run is NOT reported as a drain overrun", async () => {
    // Non-vacuity for the pair above. If `drainTimedOut` were simply always true
    // the regression test would pass while measuring nothing, so an ordinary
    // fast run must report both flags false.
    const r = await run("nodrain", ["--mode", "plain", "--timeout-ms", "20000"], [CMD, "/c", "echo", "QUICK"])
    expect(String(r.stdout)).toContain("QUICK")
    expect(r.timedOut).toBe(false)
    expect(r.drainTimedOut).toBe(false)
  }, T)

  test("large output is capped and does not deadlock", async () => {
    const r = await run("big", ["--timeout-ms", "60000"], [PS, "-NoProfile", "-Command", "1..40000 | ForEach-Object { 'x' * 60 }"])
    expect(r.ok).toBe(true)
    expect(r.timedOut).toBe(false)
    expect((r.stdout ?? "").length).toBeLessThanOrEqual(1 << 20)
  }, T)

  test("stdout, stderr and a non-zero exit code all survive the container", async () => {
    const r = await run("io", [], [CMD, "/c", "echo out& echo err 1>&2& exit /b 7"])
    expect(r.stdout).toContain("out")
    expect(r.stderr).toContain("err")
    expect(r.exitCode).toBe(7)
  }, T)
})

describe.skipIf(!READY)("CL-16A2-C section 5 — filesystem scope", () => {
  test("with NO ACL change, the container cannot read the workspace", async () => {
    const r = await run("fs", [], [CMD, "/c", "type", join(SAMPLE_WORKSPACE, "package.json")])
    expect(r.ok).toBe(false)
    expect(r.stderr).toContain("Access is denied")
  }, T)

  test("with NO ACL change, the container cannot write into the workspace", async () => {
    const probe = join(SAMPLE_WORKSPACE, "ac-probe.txt")
    const r = await run("fs2", [], [CMD, "/c", `echo x > "${probe}"`])
    expect(r.ok).toBe(false)
    expect(existsSync(probe)).toBe(false)
  }, T)

  test("a scoped ACL grant to the RUN'S OWN SID works non-elevated, and REVERTS exactly", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "abdo-acl-"))
    const file = join(scratch, "readme.txt")
    writeFileSync(file, "workspace-content", "utf8")
    const name = containerName("acl")
    const created = await runUnelevated(["create-profile", "--name", name])
    const sid = String(created.sid ?? "")
    expect(sid).toMatch(/^S-1-15-2-/)
    const icacls = (...args: string[]) => Bun.spawnSync(["C:\\Windows\\System32\\icacls.exe", ...args], { stdout: "pipe", stderr: "pipe" })
    const before = icacls(scratch).stdout.toString().trim()
    try {
      const denied = await runUnelevated(["run", "--name", name, "--timeout-ms", "20000", "--", CMD, "/c", "type", file])
      expect(denied.ok).toBe(false)

      // READ+EXECUTE on ONE directory, for THIS run's SID. Not Full Control, not
      // the user's profile — the smallest grant that answers the question.
      expect(icacls(scratch, "/grant", `*${sid}:(OI)(CI)(RX)`, "/T").exitCode).toBe(0)
      const allowed = await runUnelevated(["run", "--name", name, "--timeout-ms", "20000", "--", CMD, "/c", "type", file])
      expect(allowed.ok).toBe(true)
      expect(allowed.stdout).toContain("workspace-content")

      expect(icacls(scratch, "/remove:g", `*${sid}`, "/T").exitCode).toBe(0)
      // Byte-identical, not merely "looks similar": a grant that cannot be
      // reverted exactly is a permanent change to the machine.
      expect(icacls(scratch).stdout.toString().trim()).toBe(before)
      const deniedAgain = await runUnelevated(["run", "--name", name, "--timeout-ms", "20000", "--", CMD, "/c", "type", file])
      expect(deniedAgain.ok).toBe(false)
    } finally {
      await runUnelevated(["delete-profile", "--name", name])
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 180_000)
})
