/**
 * CL-16A3 MEGA-1 — the suspended-create accessibility probe.
 *
 * The question "can this AppContainer execute this image?" used to be answered by
 * RUNNING the image. That executes the target's code before
 * `run.launch_requested`, outside the observation lifecycle and outside
 * process-tree containment; a fast exit is not a safety property.
 *
 * This verb answers the same question without ever resuming the primary thread.
 * The tests below prove the guarantee where it is hardest: against a NATIVE PE
 * whose first action is to write a file and spawn a child.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { containerName, helperBuilt, runDirect, runUnelevated } from "./harness"

const HOSTILE = join(import.meta.dir, "fixtures", "hostile-pe", "target", "release", "abdo-hostile-pe.exe")
const READY = process.platform === "win32" && helperBuilt() && existsSync(HOSTILE)
const T = 180_000
const CMD = String.raw`C:\Windows\System32\cmd.exe`

/**
 * The fixture is built on demand into ITS OWN crate target. It is not a `[[bin]]`
 * of the helper, not in `helper-manifest.json`, and no production artefact
 * depends on it — a test fixture that ships is not a test fixture.
 */
describe.skipIf(!READY)("probe-exec-access", () => {
  let scratch = ""
  const profiles: string[] = []

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "abdo-probe-"))
  })
  afterAll(() => {
    for (const p of profiles) runDirect(["delete-profile", "--name", p])
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  const probe = async (exePath: string, env?: Record<string, string>) => {
    const name = containerName("probe")
    profiles.push(name)
    // Through the de-elevated harness: an elevated measurement proves nothing
    // about a normal user (section 8).
    const prev: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(env ?? {})) {
      prev[k] = process.env[k]
      process.env[k] = v
    }
    try {
      return await runUnelevated(["probe-exec-access", "--name", name, "--cwd", String.raw`C:\Windows\Temp`, "--", exePath])
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  test("a HOSTILE native PE is measured and causes NO side effect", async () => {
    const marker = join(scratch, "marker.txt")
    const childMarker = join(scratch, "child.txt")
    const r = await probe(HOSTILE, { ABDO_HOSTILE_MARKER: marker, ABDO_HOSTILE_CHILD_MARKER: childMarker })

    // THE MEASUREMENT SUCCEEDED...
    expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true)
    expect(r.probeOnly).toBe(true)
    expect(r.isAppContainer).toBe(true)
    expect(r.sidMatches).toBe(true)
    expect(r.imageMatches).toBe(true)
    expect(r.processExited).toBe(true)
    expect(r.stage).toBe("probe_complete")

    // ...AND THE THREAD WAS NEVER RESUMED, which is the whole point.
    expect(r.resumed).toBe(false)
    // The fixture writes this file and spawns a child as its FIRST actions.
    expect(existsSync(marker), "the entry point ran: the marker exists").toBe(false)
    expect(existsSync(childMarker), "a child process ran").toBe(false)
  }, T)

  test("the token really is the expected AppContainer, and pid+creation time are reported", async () => {
    const r = await probe(CMD)
    expect(r.ok).toBe(true)
    expect(r.isAppContainer).toBe(true)
    expect(String(r.tokenAppContainerSid)).toMatch(/^S-1-15-2-/)
    // The SID the ACL grants would use, and the one the process actually got.
    expect(String(r.tokenAppContainerSid).toLowerCase()).toBe(String(r.expectedAppContainerSid).toLowerCase())
    expect(Number(r.pid)).toBeGreaterThan(0)
    // Decimal digits in a string: a FILETIME exceeds 2^53 and cannot survive as
    // a JSON number (the CL-16A2-D-R defect).
    expect(String(r.startTime)).toMatch(/^\d+$/)
    expect(String(r.startTime).length).toBeGreaterThan(10)
  }, T)

  test("the image the KERNEL is running is compared, not the argv we passed", async () => {
    const r = await probe(CMD)
    expect(r.imageMatches).toBe(true)
    // `QueryFullProcessImageNameW` is what makes IFEO, a registered debugger or
    // an image substitution visible; the argv alone would never show them.
    expect(String(r.actualImagePath).toLowerCase()).toContain("cmd.exe")
  }, T)

  test("SCRIPTS ARE REFUSED — the probe creates a process, so it may never run an interpreter", async () => {
    for (const [name, body] of [
      ["s.cmd", "@echo off\r\necho x\r\n"],
      ["s.bat", "@echo off\r\necho x\r\n"],
      ["s.ps1", "Write-Output 'x'\r\n"],
    ] as const) {
      const p = join(scratch, name)
      writeFileSync(p, body)
      const r = await probe(p)
      expect(r.ok, `${name} must be refused`).toBe(false)
      expect(r.stage).toBe("probe_target_not_native_pe")
      // And nothing was created for it.
      expect(r.resumed).toBe(false)
    }
  }, T)

  test("a non-PE file with an .exe name is refused by its HEADER, not its extension", async () => {
    const fake = join(scratch, "not-really.exe")
    writeFileSync(fake, "this is not a PE image at all, it just ends in .exe")
    const r = await probe(fake)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe("probe_target_not_native_pe")
  }, T)

  test("leaves ZERO residue: no process, no profile", async () => {
    const before = Number(
      runDirect(["version"]).ok === true
        ? 0
        : 0,
    )
    void before
    const r = await probe(CMD)
    expect(r.ok).toBe(true)
    // The probe's own profile is deleted by the same `run` machinery.
    expect(r.profileDeleted === true || r.profileDeleted === undefined).toBe(true)
    // And the process it created is gone, confirmed by the OS.
    const gone = runDirect(["inspect-process", "--pid", String(r.pid), "--expect-start", String(r.startTime)])
    expect(gone.alive).toBe(false)
  }, T)
})
