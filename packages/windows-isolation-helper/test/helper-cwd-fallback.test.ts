/**
 * P8 gap 7 — `helperCwd()`'s hardcoded fallback, TESTED instead of trusted.
 *
 * `helperCwd()` is `process.env.SystemRoot ?? "C:\\Windows"`. The survey's
 * point: the allowlist in `helperChildEnv` only forwards variables that exist,
 * so a host whose env lacks `SystemRoot` hands the helper child a cwd chosen by
 * the fallback literal — and no test had ever run that branch.
 *
 * MEASURED ON THE WAY HERE, and worth its own line: **Bun injects `SYSTEMROOT`
 * and `WINDIR` into every spawned child**, even when the call passes an
 * explicit `env` that omits them (probed 2026-08-04, Bun 1.3.14: a child given
 * `{PATH}` alone still sees both). A child-process version of this test is
 * therefore structurally vacuous — the stripped variables reappear. So the
 * branch is exercised IN-PROCESS: `helperCwd()` reads `process.env` at call
 * time, and deleting the variables here reaches the real fallback through the
 * real production functions, with the REAL helper spawned from the fallback
 * cwd. The variables are restored in `finally`, and restoration is asserted.
 *
 * That measurement also matters for P10's env-inheritance work: an "explicit
 * env" under Bun on Windows is explicit PLUS `SYSTEMROOT`/`WINDIR`.
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { probeHelperSelfReport } from "../src/helper-runner"

const T = 120_000
const PKG = join(import.meta.dir, "..")
const HELPER = join(PKG, "target", "release", "abdo-winiso.exe")

describe.skipIf(process.platform !== "win32")("P8 gap 7 — the helperCwd fallback branch really works", () => {
  test("with SystemRoot and windir removed from the host env, the fallback cwd still runs the REAL helper", () => {
    const saved: Record<string, string | undefined> = {}
    const doomed = Object.keys(process.env).filter((k) => /^(systemroot|windir)$/i.test(k))
    // Vacuity guard in the other direction: the branch is only proven if the
    // variables were actually present to remove.
    expect(doomed.length).toBeGreaterThan(0)
    try {
      for (const k of doomed) {
        saved[k] = process.env[k]
        delete process.env[k]
      }
      expect(Object.keys(process.env).filter((k) => /^(systemroot|windir)$/i.test(k))).toEqual([])
      // The REAL production probe, spawning the REAL helper from the fallback
      // cwd. A wrong fallback literal (the C:WindowsTemp shape) would surface
      // here as a spawn failure or a typed error.
      const r = probeHelperSelfReport(HELPER)
      expect(r.ok).toBe(true)
      expect(r.protocolVersion).toBe(10)
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v
    }
    // Restoration is part of the contract of this test, not an afterthought.
    expect(Object.keys(process.env).filter((k) => /^(systemroot|windir)$/i.test(k)).sort()).toEqual(doomed.sort())
  }, T)

  test("with SystemRoot present the same probe answers identically — both branches of helperCwd work", () => {
    const r = probeHelperSelfReport(HELPER)
    expect(r.ok).toBe(true)
    expect(r.protocolVersion).toBe(10)
  }, T)
})
