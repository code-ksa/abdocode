/**
 * P7 gaps 6 and 12 — the MEDIUM-ONLY scenarios the pure-string suite refused to
 * fake (`dialect-payload-contract.test.ts` bottom block).
 *
 * Every abnormal condition here is REAL, not simulated: the timeout case kills
 * the real helper with the runner's own timeout; the non-zero case is a real
 * Windows executable exiting non-zero on the `version` argv; the garbage case is
 * a real executable that exits 0 while printing something that is not JSON; and
 * the parent-dialect cases run the real helper under a real cmd.exe and a real
 * powershell.exe parent.
 *
 * These spawn processes, so their outcome is environment-dependent by design:
 * they are Medium-session work, run with workers drained.
 */
import { describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { directHelperRunner, HelperExitContractViolated, HelperOutputUnreadable, probeHelperSelfReport, readHelperPayload, REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"

const HELPER = join(import.meta.dir, "..", "target", "release", "abdo-winiso.exe")
const CMD = "C:\\Windows\\System32\\cmd.exe"
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"

// A real executable that exits NON-ZERO when handed the `version` argv: where.exe
// searches for a file called "version", finds none, and exits 1|2 with prose on
// stderr. Nothing about the failure is simulated.
const NONZERO_EXIT_STUB = "C:\\Windows\\System32\\where.exe"

// A real executable that exits ZERO while writing non-JSON prose to stdout:
// attrib.exe prints "File not found - version" and still exits 0.
const EXIT0_GARBAGE_STUB = "C:\\Windows\\System32\\attrib.exe"

// P7-R1: a real child that prints a VALID JSON object and then exits 7 on the
// `version` argv. probeHelperSelfReport spawns [helperPath, "version"], and a
// .cmd stub is a real process (cmd.exe interpreting the file), not a result
// object constructed by the test. Each test writes its own copy to a temp
// directory OUTSIDE the repository and deletes it again.
function writeExit7Stub(): string {
  const stub = join(tmpdir(), `abdo-p7-exit7-${randomUUID()}.cmd`)
  writeFileSync(stub, `@echo off\r\necho {"ok":true,"protocolVersion":10}\r\nexit /b 7\r\n`, "utf8")
  return stub
}

const HELPER_RUNNER_SOURCE = join(import.meta.dir, "..", "src", "helper-runner.ts")

describe("gap 12 — the exit-code contract against real abnormal exits", () => {
  it("a helper killed by the spawn timeout raises HelperExitContractViolated, never parses as a refusal", () => {
    // The REAL helper, killed by a REAL 1 ms timeout. Bun reports no exit code
    // for a killed child, and the contract says: that output is not an answer.
    let threw: unknown
    try {
      probeHelperSelfReport(HELPER, 1)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(HelperExitContractViolated)
    const v = threw as HelperExitContractViolated
    // Killed-by-timeout must surface as the exit contract failing, and the
    // payload (whatever partial line exists) must not have been consulted.
    expect(v.name).toBe("HelperExitContractViolated")
  })

  it("a real non-zero exit raises HelperExitContractViolated carrying the code", () => {
    let threw: unknown
    try {
      probeHelperSelfReport(NONZERO_EXIT_STUB, 30_000)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(HelperExitContractViolated)
    const v = threw as HelperExitContractViolated
    expect(v.exitCode).not.toBe(0)
    expect(v.exitCode).not.toBeNull()
  })

  it("stdout from a non-zero exit is not accepted as a response even when it parses", async () => {
    // A real child printing a VALID JSON object and then exiting 7: under the
    // old reader this was accepted as an answer; under the contract the exit
    // code is checked FIRST, so the valid JSON must never be consulted. The
    // earlier body of this test asserted `p.exitCode === 0` about its own
    // local variable and stayed green with the guard removed; this one drives
    // the functions that implement the contract. Removing the exit-code-first
    // guard from production now makes this test fail.
    const stub = writeExit7Stub()
    try {
      // Independent measurement of the stub: it really exits 7 with a payload
      // the reader can parse.
      const raw = Bun.spawnSync([stub, "version"], { stdout: "pipe", stderr: "pipe", timeout: 30_000 })
      expect(raw.exitCode).toBe(7)
      expect(readHelperPayload(raw.stdout.toString())?.protocolVersion).toBe(10)

      // probeHelperSelfReport must refuse the run…
      let threw: unknown
      try {
        probeHelperSelfReport(stub, 30_000)
      } catch (e) {
        threw = e
      }
      expect(threw).toBeInstanceOf(HelperExitContractViolated)
      const v = threw as HelperExitContractViolated
      expect(v.exitCode).toBe(7)
      // …and the refusal is the exit code, not a parse failure: the very
      // stdout the error carries was parseable.
      expect(readHelperPayload(v.stdoutHead)?.protocolVersion).toBe(10)

      // directHelperRunner applies the same exit-code-first guard.
      let threwDirect: unknown
      try {
        await directHelperRunner(stub)({ argv: ["version"], timeoutMs: 30_000 })
      } catch (e) {
        threwDirect = e
      }
      expect(threwDirect).toBeInstanceOf(HelperExitContractViolated)
      expect((threwDirect as HelperExitContractViolated).exitCode).toBe(7)
    } finally {
      rmSync(stub, { force: true })
    }
  })

  it("a real exit-0 process with unparseable stdout raises HelperOutputUnreadable, not a SyntaxError", () => {
    let threw: unknown
    try {
      probeHelperSelfReport(EXIT0_GARBAGE_STUB, 30_000)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(HelperOutputUnreadable)
    expect((threw as Error).name).toBe("HelperOutputUnreadable")
  })

  it("structured refusals keep exiting 0: the real helper refuses INSIDE the payload, not via the exit code", () => {
    // An unknown subcommand: the helper's emit() path answers ok:false and still
    // exits 0 — that is the contract gap 12 was read off.
    const p = Bun.spawnSync([HELPER, "definitely-not-a-subcommand"], { stdout: "pipe", stderr: "pipe", timeout: 30_000 })
    expect(p.exitCode).toBe(0)
    const parsed = readHelperPayload(p.stdout.toString())
    expect(parsed).toBeDefined()
    expect(parsed!.ok).toBe(false)
  })
})

describe("NC-P7-12a — the exit-code guard in probeHelperSelfReport is load-bearing", () => {
  it("with the guard mutated out, a crashed child's JSON is returned as an answer", async () => {
    // The control mechanism: read the REAL source, remove exactly the guard
    // under test (asserting the removal actually matched — if the guard text
    // moves or disappears this fails loudly instead of silently passing),
    // import the mutated copy from a temp directory OUTSIDE the repository,
    // and assert it loses the property the guard provides. EOL is normalized
    // first: the working tree is checked out CRLF on Windows, but a template
    // literal's cooked value holds LF.
    const source = readFileSync(HELPER_RUNNER_SOURCE, "utf8").replace(/\r\n/g, "\n")
    const guard = `  const { stdout, stderr, exitCode } = spawnHelper(helperPath, ["version"], timeoutMs)
  if (exitCode !== 0) throw new HelperExitContractViolated(exitCode, stdout.slice(0, 300), stderr.slice(0, 300))`
    expect(source.split(guard).length).toBe(2)
    const mutated = source.replace(guard, `  const { stdout, stderr, exitCode } = spawnHelper(helperPath, ["version"], timeoutMs)`)
    expect(mutated).not.toBe(source)

    const tmp = join(tmpdir(), `abdo-nc-p7-12a-${randomUUID()}.ts`)
    const stub = writeExit7Stub()
    try {
      writeFileSync(tmp, mutated, "utf8")
      const mod = await import(pathToFileURL(tmp).href)
      // The real module refuses the crashed child…
      let threw: unknown
      try {
        probeHelperSelfReport(stub, 30_000)
      } catch (e) {
        threw = e
      }
      expect(threw).toBeInstanceOf(HelperExitContractViolated)
      // …the mutated module returns its JSON as an answer: the guard is what
      // stops a crash being read as a response.
      const got = mod.probeHelperSelfReport(stub, 30_000)
      expect(got.ok).toBe(true)
      expect(got.protocolVersion).toBe(10)
    } finally {
      rmSync(tmp, { force: true })
      rmSync(stub, { force: true })
    }
  })
})

describe("gap 6 — the real helper through real shell parents (starts gaps 4 and 5)", () => {
  it("a version call through a cmd.exe parent yields protocol 10 through the dialect-tolerant reader", () => {
    // No embedded quotes: the helper path contains no spaces, and cmd's quote
    // stripping interacts badly with the quoting Bun applies to argv elements.
    const p = Bun.spawnSync([CMD, "/d", "/c", `${HELPER} version`], { stdout: "pipe", stderr: "pipe", timeout: 30_000 })
    expect(p.exitCode).toBe(0)
    const parsed = readHelperPayload(p.stdout.toString())
    expect(parsed?.protocolVersion).toBe(REQUIRED_PROTOCOL_VERSION)
  })

  it("a version call through a PowerShell parent yields protocol 10 through the dialect-tolerant reader", () => {
    const p = Bun.spawnSync([PS, "-NoProfile", "-NonInteractive", "-Command", "&", HELPER, "version"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    })
    expect(p.exitCode).toBe(0)
    const parsed = readHelperPayload(p.stdout.toString())
    expect(parsed?.protocolVersion).toBe(REQUIRED_PROTOCOL_VERSION)
  })
})
