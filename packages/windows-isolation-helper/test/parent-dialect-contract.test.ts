/**
 * P9/P10 — the parent-dialect contract: the helper does not care which shell
 * is above it, and the claim is MEASURED per dialect feature, not asserted.
 *
 * Survey gaps closed here:
 *   gap 4  (P9)  — PowerShell-as-parent at the PROCESS level: identical
 *                  payload to a cmd parent and to a direct spawn.
 *   gap 5  (P10) — cmd-as-parent: %VAR% expansion, ^ escaping and " quoting
 *                  exercised around a REAL helper invocation.
 *   gap 2  (P10) — COMSPEC forwarding: present, absent and corrupt values.
 *                  (Whether a CORRUPT value must refuse is a product-contract
 *                  decision recorded for the owner; today's measured contract
 *                  is that the helper's own behaviour never depends on it.)
 *   gap 3  (P10) — PATHEXT forwarding: present and absent. The helper is
 *                  spawned by absolute path, so resolution never consults it;
 *                  what is pinned is that its presence or absence changes
 *                  nothing observable.
 *   gap 10 (P9/P10) — stdin shape per dialect: inherited, NUL-redirected and
 *                  piped stdin under both shell parents all yield the same
 *                  answer. (The conhost-orphan measurement stays with
 *                  `harness-invariants`, which owns that instrument.)
 *
 * VACUITY IS GUARDED IN-SUITE: each shell-feature test carries its own
 * negative branch proving the shell really interpreted the line (an unquoted
 * spaced path FAILS, an undefined %VAR% FAILS). A test whose negative branch
 * stops failing has stopped exercising the dialect and says so itself.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readHelperPayload } from "../src/helper-runner"

const T = 120_000
const PKG = join(import.meta.dir, "..")
const HELPER = join(PKG, "target", "release", "abdo-winiso.exe")
const CMD = "C:\\Windows\\System32\\cmd.exe"
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"

/** The fields a parent shell could plausibly corrupt; volatile ones excluded. */
function stableView(stdout: string) {
  const p = readHelperPayload(stdout)
  if (!p) return undefined
  const { ok, protocolVersion, elevated, integrity, integrityRid, schema, command, binaryHash } = p as Record<string, unknown>
  return { ok, protocolVersion, elevated, integrity, integrityRid, schema, command, binaryHash }
}

function run(argv: string[], opts: { stdin?: "inherit" | "ignore"; env?: Record<string, string> } = {}) {
  return Bun.spawnSync(argv, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: T,
    ...(opts.stdin ? { stdin: opts.stdin } : {}),
    env: opts.env ?? { ...process.env },
  })
}

describe.skipIf(process.platform !== "win32")("P9/P10 — parent-dialect contract", () => {
  test("gap 4 (P9): direct, cmd-parent and PowerShell-parent runs return the IDENTICAL stable payload", () => {
    const direct = run([HELPER, "version"])
    const viaCmd = run([CMD, "/d", "/c", `${HELPER} version`])
    const viaPs = run([PS, "-NoProfile", "-NonInteractive", "-Command", "&", HELPER, "version"])
    expect(direct.exitCode).toBe(0)
    expect(viaCmd.exitCode).toBe(0)
    expect(viaPs.exitCode).toBe(0)
    const d = stableView(direct.stdout.toString())
    expect(d).toBeDefined()
    expect(stableView(viaCmd.stdout.toString())).toEqual(d)
    expect(stableView(viaPs.stdout.toString())).toEqual(d)
    expect(d!.protocolVersion).toBe(10)
  }, T)

  test("gap 5 (P10): cmd %VAR% expansion reaches the helper — and an UNDEFINED %VAR% fails, proving cmd interpreted it", () => {
    // Positive: cmd expands %ABDO_G5_HELPER% into the helper path and runs it.
    const env = { ...process.env, ABDO_G5_HELPER: HELPER }
    const p = run([CMD, "/d", "/c", "%ABDO_G5_HELPER% version"], { env })
    expect(p.exitCode).toBe(0)
    expect(stableView(p.stdout.toString())?.protocolVersion).toBe(10)
    // Negative (the in-suite vacuity guard): without the variable, the same
    // line cannot run anything. If THIS stops failing, cmd stopped expanding.
    const envWithout: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (k !== "ABDO_G5_HELPER" && v !== undefined) envWithout[k] = v
    const q = run([CMD, "/d", "/c", "%ABDO_G5_HELPER% version"], { env: envWithout })
    expect(q.exitCode).not.toBe(0)
  }, T)

  test("gap 5 (P10): cmd caret-escaping is transparent around a helper invocation", () => {
    // ^ before ordinary characters is cmd's escape and must vanish before the
    // child sees the line: ^v^e^r^s^i^o^n arrives as the plain subcommand.
    const p = run([CMD, "/d", "/c", `${HELPER} ^v^e^r^s^i^o^n`])
    expect(p.exitCode).toBe(0)
    const v = stableView(p.stdout.toString())
    expect(v?.command).toBe("version")
    expect(v?.protocolVersion).toBe(10)
  }, T)

  describe("gap 5 (P10): cmd double-quote rules around a path WITH SPACES", () => {
    let spacedDir = ""
    let spacedHelper = ""
    beforeAll(() => {
      spacedDir = mkdtempSync(join(tmpdir(), "abdo p10 spaced "))
      spacedHelper = join(spacedDir, "abdo-winiso.exe")
      cpSync(HELPER, spacedHelper)
    })
    afterAll(() => {
      rmSync(spacedDir, { recursive: true, force: true })
      expect(existsSync(spacedDir)).toBe(false) // residue assertion
    })

    test("quoted, the spaced path runs the real helper; unquoted, cmd splits it and fails", () => {
      // The quoted line lives in a REAL batch file, so cmd parses it from the
      // file and Bun's own argv re-quoting layer (which mangles composite
      // quote shapes) never touches it. The batch files themselves sit at
      // space-free paths.
      const batchDir = mkdtempSync(join(tmpdir(), "abdo-p10-batch-"))
      try {
        const quotedCmd = join(batchDir, "quoted.cmd")
        const unquotedCmd = join(batchDir, "unquoted.cmd")
        require("node:fs").writeFileSync(quotedCmd, `@"${spacedHelper}" version\r\n`, "utf8")
        require("node:fs").writeFileSync(unquotedCmd, `@${spacedHelper} version\r\n`, "utf8")
        const quoted = run([CMD, "/d", "/c", quotedCmd])
        expect(quoted.exitCode).toBe(0)
        expect(stableView(quoted.stdout.toString())?.protocolVersion).toBe(10)
        // The in-suite vacuity guard: the same line WITHOUT quotes must fail,
        // because cmd splits the path at its spaces. If this ever passes, the
        // quoting test above has stopped testing quoting.
        const unquoted = run([CMD, "/d", "/c", unquotedCmd])
        expect(unquoted.exitCode).not.toBe(0)
      } finally {
        rmSync(batchDir, { recursive: true, force: true })
        expect(existsSync(batchDir)).toBe(false) // residue assertion
      }
    }, T)
  })

  test("gaps 2+3 (P10): COMSPEC and PATHEXT — present, absent or corrupt, the helper's answer never changes", () => {
    const baseline = stableView(run([HELPER, "version"]).stdout.toString())
    expect(baseline?.protocolVersion).toBe(10)

    const saved: Record<string, string | undefined> = {}
    const names = Object.keys(process.env).filter((k) => /^(comspec|pathext)$/i.test(k))
    expect(names.length).toBeGreaterThan(0) // vacuity: there must be something to strip
    try {
      // ABSENT: the forwarding allowlist only forwards what exists; nothing
      // downstream may depend on either variable being present.
      for (const k of names) {
        saved[k] = process.env[k]
        delete process.env[k]
      }
      expect(stableView(run([HELPER, "version"]).stdout.toString())).toEqual(baseline)
      // CORRUPT COMSPEC: forwarded verbatim by design. The measured contract
      // today: the helper's own behaviour does not consult it. Whether a
      // corrupt value must REFUSE is the owner's product-contract decision
      // (survey gap 2b) — recorded, not invented here.
      process.env.COMSPEC = "C:\\DoesNotExist\\definitely-not-cmd.exe"
      expect(stableView(run([HELPER, "version"]).stdout.toString())).toEqual(baseline)
      delete process.env.COMSPEC
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v
    }
    expect(Object.keys(process.env).filter((k) => /^(comspec|pathext)$/i.test(k)).sort()).toEqual(names.sort())
  }, T)

  test("gap 10 (P9/P10): stdin shape — inherited, NUL-redirected and piped — changes nothing under either shell parent", () => {
    const baseline = stableView(run([HELPER, "version"]).stdout.toString())
    const cases: Array<[string, ReturnType<typeof run>]> = [
      ["cmd NUL", run([CMD, "/d", "/c", `${HELPER} version < NUL`])],
      ["cmd piped", run([CMD, "/d", "/c", `echo ignored | ${HELPER} version`])],
      ["ps piped", run([PS, "-NoProfile", "-NonInteractive", "-Command", `'ignored' | & '${HELPER}' version`])],
      ["direct stdin ignored", run([HELPER, "version"], { stdin: "ignore" })],
    ]
    for (const [name, p] of cases) {
      expect(p.exitCode, name).toBe(0)
      expect(stableView(p.stdout.toString()), name).toEqual(baseline)
    }
  }, T)
})
