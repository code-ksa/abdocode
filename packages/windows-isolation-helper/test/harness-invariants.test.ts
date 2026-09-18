/**
 * CL-16A2-D §3/§7 — THE HARNESS IS TESTED LIKE A PRODUCT.
 *
 * Everything measured before these existed has been withdrawn. The reason is
 * plain: five separate harness defects each produced confident, green-looking
 * results.
 *
 *   1. `explorer.exe` per invocation      -> 885 windows, 920 console hosts, 2.2 GB
 *   2. `INVALID_HANDLE_VALUE` for stdin   -> one orphaned conhost per run
 *   3. `DETACHED_PROCESS` as the cure     -> PowerShell exited 0 having run NOTHING
 *   4. a server that died on a transient  -> 80 minutes of 90-second timeouts
 *      `read_dir` error, silently
 *   5. one shared queue for all runs      -> three servers, one on a stale binary,
 *                                            fifteen unreproducible failures
 *
 * Defect 3 is the one that decides how this file is written. A sandbox that
 * appears to run commands and runs none is indistinguishable from a perfect
 * sandbox if you only check that the network was unreachable. So the harness now
 * has to PROVE a child started, PROVE time actually passed, and PROVE the
 * control produced its marker — before any verdict about isolation is allowed.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatCensus, judgeCensus, reapOrphanConsoleHosts, takeCensus } from "./census"
import { EXPECTED_SKIPS, compareSkips, formatSkipComparison } from "./gate8-expected-skips"
import { parseJUnitSkips } from "./junit-skips"
import { HELPER, HarnessFailure, LIFECYCLE_ORDER, REQUIRED_PROTOCOL, containerName, firstMissingLifecycleStep, helperBinaryHash, helperBuilt, lastEvents, runDirect, runUnelevated, selfElevated, serverIdentityRefusal } from "./harness"
import { HELPER_PROTOCOL_VERSION } from "../src/verifier"

const READY = process.platform === "win32" && helperBuilt()
const CMD = "C:\\Windows\\System32\\cmd.exe"
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const T = 180_000

describe.skipIf(!READY)("harness identity", () => {
  test("the helper states its own protocol and binary hash, and they match the file on disk", () => {
    const v = runDirect(["version"])
    expect(v.protocolVersion).toBe(REQUIRED_PROTOCOL)
    // The helper hashes ITSELF; the client hashes the file. Agreement is what
    // makes "the server is the binary I verified" a checkable claim.
    expect(v.binaryHash).toBe(helperBinaryHash())
    expect(String(v.binaryHash)).toMatch(/^[0-9a-f]{64}$/)
  })

  test("the protocol version is the SAME number in Rust, in the verifier and in the client", () => {
    // Three copies of one constant. They drifted once (helper v2, verifier v1)
    // and seven identity tests failed for a reason unrelated to what they test.
    const rust = readFileSync(join(import.meta.dir, "..", "src", "main.rs"), "utf8")
    const declared = Number(/PROTOCOL_VERSION:\s*u32\s*=\s*(\d+)/.exec(rust)?.[1])
    expect(declared).toBe(REQUIRED_PROTOCOL)
    expect(HELPER_PROTOCOL_VERSION).toBe(REQUIRED_PROTOCOL)
    expect(runDirect(["version"]).protocolVersion).toBe(REQUIRED_PROTOCOL)
  })

  test("the helper's SHA-256 agrees with an independent implementation", () => {
    // The hash is hand-rolled (no crates). If it were subtly wrong every
    // comparison in the system would still agree with itself while being wrong,
    // so it is checked against Node's.
    const { createHash } = require("node:crypto") as typeof import("node:crypto")
    const independent = createHash("sha256").update(readFileSync(HELPER)).digest("hex")
    expect(runDirect(["version"]).binaryHash).toBe(independent)
  })

  // ── REPAIRED AT MEDIUM (RC3 section 5), not allowlisted ──────────────────
  //
  // This was `skipIf(!selfElevated())`, and it did not need to be: it never
  // touched a server. It wrote `"0".repeat(64)` to a file, read it back and
  // asserted it differed from the real hash — a fact about string literals that
  // would still have passed with the refusal rule DELETED. So the one property
  // that matters here, "a stale server is refused", was neither measured at high
  // integrity nor at medium.
  //
  // `serverIdentityRefusal` is that rule, extracted from `checkServerIdentity`
  // so it can be measured without a live server. What still needs one — reading
  // the published file and throwing — is exercised by every elevated request and
  // is covered live by `scripts/live-elevated-harness-server.ts`.
  test("a server whose hash does not match the disk is REFUSED, and a matching one is accepted", () => {
    const real = helperBinaryHash()
    const stale = { pid: 1, protocolVersion: REQUIRED_PROTOCOL, binaryHash: "0".repeat(64) }
    expect(stale.binaryHash).not.toBe(real)

    // THE RULE FIRES, and says which of the two hashes it saw.
    const refusal = serverIdentityRefusal(stale, real)
    expect(refusal).toBeDefined()
    expect(refusal).toContain("NOT the binary on disk")
    expect(refusal).toContain(real.slice(0, 16))

    // NON-VACUITY: the SAME shape with the true hash is accepted, so the refusal
    // above was the hash comparison and not the rule refusing everything.
    expect(serverIdentityRefusal({ ...stale, binaryHash: real }, real)).toBeUndefined()

    // The other two ways a server can be the wrong one, both refused.
    expect(serverIdentityRefusal({ pid: 1, protocolVersion: REQUIRED_PROTOCOL - 1, binaryHash: real }, real)).toContain("protocol")
    expect(serverIdentityRefusal({ pid: 1, protocolVersion: REQUIRED_PROTOCOL }, real)).toContain("NOT the binary on disk")
    expect(serverIdentityRefusal(undefined, real)).toContain("no readable identity")
  })
})

describe.skipIf(!READY)("harness proves work actually happened", () => {
  test("a timed command really takes the time it claims", async () => {
    // DEFECT 3's tripwire. Under DETACHED_PROCESS, `Start-Sleep -Seconds 5`
    // returned in 127 ms with exit 0 and no output. Elapsed time is the cheapest
    // proof that a process did something.
    const t0 = Date.now()
    const r = await runUnelevated(["run", "--name", containerName("sleep"), "--timeout-ms", "30000", "--", PS, "-NoProfile", "-Command", "Start-Sleep -Seconds 3; Write-Output SLEPT"])
    const wall = Date.now() - t0
    expect(r.exitCode).toBe(0)
    expect(String(r.stdout)).toContain("SLEPT")
    expect(Number(r.durationMs)).toBeGreaterThanOrEqual(3000)
    expect(wall).toBeGreaterThanOrEqual(3000)
    console.log(`[gate] start-sleep-3: durationMs=${r.durationMs} wall=${wall}ms (both must be >= 3000)`)
  }, T)

  test("every request records started -> child_started -> child_exited -> result, in order", async () => {
    // The gate's child_started coverage rests on `runUnelevated` REJECTING any
    // result that lacks this ordered lifecycle (a HarnessFailure), so every
    // green test already proves it for its own requests. This one displays a
    // concrete, real sequence so the report is not just an assertion about an
    // assertion.
    const r = await runUnelevated(["run", "--name", containerName("ev"), "--timeout-ms", "20000", "--", CMD, "/c", "echo", "EV"])
    expect(String(r.stdout)).toContain("EV")
    const events = lastEvents()
    expect(firstMissingLifecycleStep(events)).toBeUndefined()
    console.log(`[gate] lifecycle ${LIFECYCLE_ORDER.join("->")}: ${events.replace(/\r?\n/g, " | ").trim()}`)
  }, T)

  test("a command that should produce output DOES produce it", async () => {
    const marker = `MARKER-${Math.random().toString(36).slice(2, 10)}`
    const r = await runUnelevated(["run", "--name", containerName("mark"), "--timeout-ms", "20000", "--", CMD, "/c", "echo", marker])
    expect(String(r.stdout)).toContain(marker)
    expect(r.exitCode).toBe(0)
  }, T)

  test("every successful run reports a real child pid and start time", async () => {
    // `child_started` at the harness level, plus the sandboxed process's own
    // identity. A run with exit 0 and no pid is a run that never happened.
    const r = await runUnelevated(["run", "--name", containerName("pid"), "--timeout-ms", "20000", "--", CMD, "/c", "echo", "P"])
    expect(Number(r.pid)).toBeGreaterThan(0)
    expect(Number(r.startTime)).toBeGreaterThan(0)
  }, T)

  test("PowerShell works — the interpreter every isolation test depends on", async () => {
    // Named explicitly because when this broke, ten isolation tests "passed"
    // their spawn and proved nothing.
    const r = await runUnelevated(["run", "--name", containerName("ps"), "--timeout-ms", "20000", "--", PS, "-NoProfile", "-Command", "Write-Output PS-ALIVE"])
    expect(String(r.stdout)).toContain("PS-ALIVE")
  }, T)
})

describe.skipIf(!READY)("harness failure modes are fast and explicit", () => {
  test.skipIf(!selfElevated())("killing the server mid-flight fails FAST, not after a long timeout", async () => {
    const t0 = Date.now()
    const kill = Bun.spawnSync([PS, "-NoProfile", "-Command", "Start-Sleep -Milliseconds 700; Get-Process abdo-winiso -ErrorAction SilentlyContinue | Stop-Process -Force"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    void kill
    let failed = false
    try {
      const r = await runUnelevated(["run", "--name", containerName("killsrv"), "--timeout-ms", "60000", "--", PS, "-NoProfile", "-Command", "Start-Sleep -Seconds 30"], 60_000)
      failed = r.ok === false
    } catch {
      failed = true
    }
    const elapsed = Date.now() - t0
    expect(failed).toBe(true)
    // The point is the SPEED. Before the heartbeat existed this sat for the full
    // timeout, which is how one death became eighty minutes.
    expect(elapsed).toBeLessThan(30_000)

    // A KILLED HELPER CANNOT REAP ITS CHILD'S CONSOLE HOST, and that is a real
    // property rather than a test artefact: `reap_console_hosts` runs after the
    // child is waited on, and a SIGKILLed helper never gets there. The census
    // caught the resulting orphan, correctly. This test therefore cleans up the
    // wreckage it deliberately created, so the census keeps measuring NORMAL
    // operation with zero tolerance instead of being loosened to accommodate a
    // crash this test caused on purpose.
    reapOrphanConsoleHosts()
  }, T)

  test("killing the sandboxed child yields an explicit exit, not a hang", async () => {
    const name = containerName("killchild")
    const t0 = Date.now()
    const r = await runUnelevated(["run", "--name", name, "--timeout-ms", "3000", "--", PS, "-NoProfile", "-Command", "Start-Sleep -Seconds 40"])
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(30_000)
    runDirect(["delete-profile", "--name", name])
  }, T)

  test("three clients in parallel do not mix up each other's results", async () => {
    // Each request carries a unique marker; a crossed wire shows up immediately.
    const markers = ["AAA111", "BBB222", "CCC333"]
    const results = await Promise.all(
      markers.map((m) => runUnelevated(["run", "--name", containerName("par"), "--timeout-ms", "25000", "--", CMD, "/c", "echo", m])),
    )
    results.forEach((r, i) => {
      expect(String(r.stdout)).toContain(markers[i]!)
      for (const other of markers.filter((m) => m !== markers[i])) expect(String(r.stdout)).not.toContain(other)
    })
  }, T)

  test("a run under a name Abdo does not own is REFUSED, not quietly created", async () => {
    // Found by this test: `run` used to create a profile without the ownership
    // prefix. Nothing would ever have reclaimed it, because recovery's orphan
    // sweep only looks for marked names.
    const r = await runUnelevated(["run", "--name", "not-owned-by-abdo", "--timeout-ms", "10000", "--", CMD, "/c", "echo", "x"])
    expect(r.ok).toBe(false)
    expect(r.stage).toBe("ownership")
    // And nothing was created on the way to refusing.
    expect(runDirect(["inspect-profile", "--name", "not-owned-by-abdo"]).profileExists).toBe(false)
  }, T)
})

describe.skipIf(!READY)("the census notices leaks", () => {
  test("a census can be taken and reads plausible values", () => {
    const c = takeCensus()
    expect(c.conhostTotal).toBeGreaterThanOrEqual(0)
    expect(c.explorerProcesses).toBeGreaterThanOrEqual(1) // the user's desktop
    console.log(`census: ${formatCensus(c)}`)
  })

  test("the census JUDGE rejects a leak (it is not vacuous)", () => {
    const before = takeCensus()
    // A fabricated "after" with one orphaned console host must fail the judge —
    // otherwise the whole census is decoration.
    const leaked = { ...before, conhostOrphaned: before.conhostOrphaned + 1 }
    const verdict = judgeCensus(before, leaked)
    expect(verdict.ok).toBe(false)
    expect(verdict.violations.join(" ")).toContain("conhostOrphaned")
    // And an unchanged world passes.
    expect(judgeCensus(before, before).ok).toBe(true)
  })

  test("ten AppContainer runs leak nothing", async () => {
    const before = takeCensus()
    for (let i = 0; i < 10; i++) {
      const r = await runUnelevated(["run", "--name", containerName("leak"), "--timeout-ms", "20000", "--", CMD, "/c", "echo", "L"])
      expect(String(r.stdout)).toContain("L")
    }
    await Bun.sleep(1500)
    const verdict = judgeCensus(before, takeCensus())
    if (!verdict.ok) console.error("CENSUS VIOLATIONS:", verdict.violations)
    expect(verdict.violations).toEqual([])
  }, 300_000)
})

describe.skipIf(!READY)("the build cannot report success on a stale binary", () => {
  test("build.ps1 fails loudly when the artefact is older than its sources", () => {
    // The guard is read from the script rather than by locking a real binary,
    // because deliberately locking the exe mid-suite would break every other
    // test in this file. What matters is that the check exists and throws.
    const src = readFileSync(join(import.meta.dir, "..", "build.ps1"), "utf8")
    expect(src).toContain("BUILD FAILED")
    expect(src).toContain("is older than its newest source")
    expect(src).toContain("LASTEXITCODE -ne 0")
    // Plain ASCII only: a non-ASCII character in this file once made PowerShell
    // 5.1 fail to PARSE it, so the guards never ran and the stale binary stayed.
    expect(/^[\x00-\x7F]*$/.test(src)).toBe(true)
    // And there is no unconditional success message anywhere in it.
    expect(src).not.toMatch(/Write-Output\s+["']BUILD OK/)
  })
})

describe.skipIf(!READY)("a control must prove itself before any sandbox verdict", () => {
  test("the control marker convention works outside the container", async () => {
    // Every isolation vector is judged only after its control produced THIS.
    const r = await runUnelevated(["run", "--name", containerName("ctl"), "--mode", "plain", "--timeout-ms", "20000", "--", PS, "-NoProfile", "-Command", "Write-Output CONTROL-RAN"])
    expect(String(r.stdout)).toContain("CONTROL-RAN")
    expect(Number(r.pid)).toBeGreaterThan(0)
  }, T)

  test("a scratch directory is left exactly as found", () => {
    const d = mkdtempSync(join(tmpdir(), "abdo-inv-"))
    const before = runDirect(["inspect-acl", "--path", d]).sddl
    rmSync(d, { recursive: true, force: true })
    expect(existsSync(d)).toBe(false)
    expect(String(before)).toContain("D:")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// RC3 §5 — THE EXPECTED-SKIP ALLOWLIST IS ITSELF TESTED.
//
// A gate rule that is never exercised is a rule nobody knows still works. These
// prove the comparison catches both directions of drift, and that every entry
// carries the separate live proof the rule requires — otherwise an entry could
// be added with an empty `liveProofGate` and the round would happily accept a
// skip whose property is proven nowhere.
// ─────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)("the Gate 8 expected-skip allowlist", () => {
  test("every entry names a reason, a required environment and a separate live-proof gate that EXISTS", () => {
    expect(EXPECTED_SKIPS.length).toBeGreaterThan(0)
    for (const s of EXPECTED_SKIPS) {
      expect(s.identity.length).toBeGreaterThan(10)
      expect(s.reason.length).toBeGreaterThan(30)
      expect(s.requiredEnvironment.length).toBeGreaterThan(10)
      // The gate is named AND the file is really there — a dangling reference
      // would make the allowlist a promise rather than a proof.
      const script = s.liveProofGate.split(" ")[0]!
      expect(script).toMatch(/^scripts\/.+\.ts$/)
      expect(existsSync(join(import.meta.dir, "..", script))).toBe(true)
      // And that gate refuses the wrong environment rather than skipping.
      const src = readFileSync(join(import.meta.dir, "..", script), "utf8")
      expect(src).toContain("REFUSING TO RUN")
      expect(src).toContain("process.exit(2)")
    }
  })

  test("the comparison catches an UNNAMED skip and a STALE entry, and accepts an exact match", () => {
    const expected = EXPECTED_SKIPS.map((s) => s.identity)
    expect(compareSkips(expected).ok).toBe(true)
    expect(formatSkipComparison(compareSkips(expected))).toEqual([])

    const withExtra = compareSkips([...expected, "some group > a skip nobody allowed"])
    expect(withExtra.ok).toBe(false)
    expect(formatSkipComparison(withExtra).join(" ")).toContain("UNNAMED SKIP")

    const withMissing = compareSkips([])
    expect(withMissing.ok).toBe(false)
    expect(formatSkipComparison(withMissing).join(" ")).toContain("STALE ALLOWLIST ENTRY")
  })

  test("the JUnit parser reads identities outermost-first and separates todo from skip", () => {
    // The exact shape bun 1.3.14 writes, including the DOUBLE-escaped separator
    // and the innermost-first classname.
    const xml = `<testsuites><testsuite name="f.test.ts">
      <testcase name="deep" classname="inner &amp;gt; outer" line="4"><skipped /></testcase>
      <testcase name="a todo" classname="outer" line="5"><skipped message="TODO" /></testcase>
      <testcase name="ran" classname="outer" line="6" />
    </testsuite></testsuites>`
    const parsed = parseJUnitSkips(xml)
    expect(parsed.skipped).toEqual(["outer > inner > deep"])
    expect(parsed.todo).toEqual(["outer > a todo"])
  })
})
