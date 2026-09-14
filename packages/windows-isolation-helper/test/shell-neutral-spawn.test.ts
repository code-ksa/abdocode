/**
 * P5c2-FINAL-RC2 §2 — the isolated sweep must not care which shell started it.
 *
 * ## The defect these tests pin
 *
 * `scripts/isolated-crash-sweep.ts` used to spawn its per-point runs as
 * `Bun.spawnSync(["bun", "test", ...], { env })` — a BARE NAME resolved against
 * an explicitly supplied `env`. The official P5c2 medium round failed on it after
 * 2.7s, having measured nothing at all:
 *
 *     ENOENT: no such file or directory, uv_spawn 'bun'
 *       at scripts\isolated-crash-sweep.ts:101:17
 *
 * Given an explicit `env`, Bun resolves a bare command name against `env.PATH`
 * BY EXACT CASE. Windows environment variables are case-insensitive in the OS,
 * but `process.env` preserves whatever spelling the parent used, and the two
 * shells disagree: bash gives `PATH`, PowerShell gives `Path`. So the sweep was
 * green when its process tree was rooted in bash and failed when rooted in
 * PowerShell — a result that depended on the terminal rather than on the code.
 *
 * ## What is asserted
 *
 * The runtime is now located as `process.execPath`, an absolute path, so no PATH
 * lookup happens at all. Cases A/B/C below drive a child runner with an env
 * carrying only `PATH`, only `Path`, and NO path key whatsoever. Case C is the
 * decisive one: if the interpreter were still being found by searching a path
 * variable, an env with no path variable could not possibly work.
 *
 * These are deterministic — they construct the env explicitly instead of
 * inheriting it, so they assert the same thing no matter which shell runs them.
 */
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

const T = 120_000

/** The absolute path of the bun running this file — the sweep's `RUNTIME`. */
const RUNTIME = process.execPath

/**
 * Everything except a path variable, so each case can add exactly one (or none).
 *
 * P7 gap 11 (2026-08-04): `PATHEXT` is stripped too. This helper's contract is
 * a MINIMAL env for resolution tests, and a surviving `PATHEXT` could mask a
 * resolution bug that only appears when it is absent — exactly the state a
 * non-cmd dialect produces. The minimality is pinned by its own test below, so
 * removing either strip is a red suite, not a silent regression.
 */
function envWithoutPath(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(path|pathext)$/i.test(k)) continue
    if (k === "ABDO_HARNESS_QUEUE") continue
    if (v !== undefined) out[k] = v
  }
  return out
}

/** The real path value, whatever this shell happened to call it. */
const realPathValue = Object.entries(process.env).find(([k]) => /^path$/i.test(k))?.[1] ?? ""

/**
 * Start the runtime the way the sweep does: absolute interpreter, explicit env,
 * no shell. Returns what the child reported about itself.
 */
function spawnRuntime(env: Record<string, string>, runtime = RUNTIME) {
  return Bun.spawnSync([runtime, "-e", "console.log(`STARTED ${process.execPath}`)"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: T,
    env,
  })
}

describe.skipIf(process.platform !== "win32")("P5c2-FINAL-RC2 - the runtime is located without PATH", () => {
  test("the sweep's runtime is an absolute path, not a bare name", () => {
    expect(RUNTIME).not.toBe("bun")
    expect(existsSync(RUNTIME)).toBe(true)
    // An absolute Windows path, so CreateProcess needs no search list.
    expect(RUNTIME).toMatch(/^[A-Za-z]:[\\/]/)
  })

  test("P7 gap 11: envWithoutPath is MINIMAL — no PATH variant and no PATHEXT variant survives", () => {
    const env = envWithoutPath()
    expect(Object.keys(env).filter((k) => /^path$/i.test(k))).toEqual([])
    expect(Object.keys(env).filter((k) => /^pathext$/i.test(k))).toEqual([])
    // The strip is by case-insensitive NAME, not by the spelling this shell used.
    expect(Object.hasOwn(env, "PATHEXT")).toBe(false)
    expect(Object.hasOwn(env, "PathExt")).toBe(false)
    expect(Object.hasOwn(env, "pathext")).toBe(false)
  })

  test("A. an env carrying only PATH (bash spelling) starts the runtime", () => {
    const env = { ...envWithoutPath(), PATH: realPathValue }
    expect(Object.keys(env).filter((k) => /^path$/i.test(k))).toEqual(["PATH"])
    const p = spawnRuntime(env)
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toContain("STARTED")
  }, T)

  test("B. an env carrying only Path (PowerShell spelling) starts the runtime", () => {
    // THE EXACT SHAPE THAT BROKE THE ROUND. With a bare name, Bun looked up
    // `env.PATH`, found nothing, and failed with ENOENT.
    const env = { ...envWithoutPath(), Path: realPathValue }
    expect(Object.keys(env).filter((k) => /^path$/i.test(k))).toEqual(["Path"])
    expect(Object.hasOwn(env, "PATH")).toBe(false)
    const p = spawnRuntime(env)
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toContain("STARTED")
  }, T)

  test("C. an env with NO path key at all still starts the runtime", () => {
    // THE DECISIVE CASE. No path variable exists under any spelling, so a
    // PATH-searching implementation could not start anything. This passing is
    // what proves the interpreter is found by absolute path.
    const env = envWithoutPath()
    expect(Object.keys(env).filter((k) => /^path$/i.test(k))).toEqual([])
    const p = spawnRuntime(env)
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toContain("STARTED")
  }, T)

  test("the child really is the same bun, and no shell was interposed", () => {
    const p = spawnRuntime(envWithoutPath())
    expect(p.exitCode).toBe(0)
    // The child reports its own execPath; it must be the interpreter we named.
    const reported = p.stdout.toString().trim().replace(/^STARTED /, "")
    expect(reported.toLowerCase()).toBe(RUNTIME.toLowerCase())
  }, T)

  test("RECORDED: the bare name is what fails, and only with an explicit env", () => {
    // Not an assertion about Bun's behaviour — a measurement, logged so the
    // reason the sweep changed is visible in the round's own output rather than
    // only in a commit message. Asserting the bug still exists would make this
    // test fail the day Bun fixes it, which is not the property we care about.
    const pathOnlyLower = { ...envWithoutPath(), Path: realPathValue }
    let bare: string
    try {
      const p = Bun.spawnSync(["bun", "-e", "console.log('STARTED')"], { stdout: "pipe", stderr: "pipe", timeout: T, env: pathOnlyLower })
      bare = p.exitCode === 0 ? "started" : `exit=${p.exitCode}`
    } catch (e) {
      bare = `threw ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`
    }
    console.log(`[gate] bare "bun" with a Path-only env: ${bare} · absolute execPath: started`)
    // The property that matters, and it holds either way:
    expect(spawnRuntime(pathOnlyLower).exitCode).toBe(0)
  }, T)
})

describe.skipIf(process.platform !== "win32")("P5c2-FINAL-RC2 - a missing runtime is UNMEASURED, never DIRTY", () => {
  test("a runtime path that does not exist is a harness failure, not a product verdict", () => {
    const missing = join(import.meta.dir, "..", "target", "release", "definitely-not-a-real-runtime.exe")
    expect(existsSync(missing)).toBe(false)

    // The sweep guards this spawn precisely so it becomes UNMEASURED. Unguarded
    // it threw, which killed the sweep mid-flight and produced no verdict at all
    // — how the official round ended with nothing measured.
    let threwOrFailed = false
    try {
      const p = spawnRuntime(envWithoutPath(), missing)
      threwOrFailed = p.exitCode !== 0
    } catch {
      threwOrFailed = true
    }
    expect(threwOrFailed).toBe(true)
  }, T)

  test("END TO END: the sweep reports UNMEASURED and exits 3 when its runtime is missing", () => {
    const sweep = join(import.meta.dir, "..", "scripts", "isolated-crash-sweep.ts")
    const missing = join(import.meta.dir, "..", "target", "release", "definitely-not-a-real-runtime.exe")
    const env = { ...envWithoutPath(), Path: realPathValue, ABDO_SWEEP_RUNTIME: missing, ABDO_SWEEP_POINTS: "after_run_requested" }

    const p = Bun.spawnSync([RUNTIME, sweep, "unmeasured-negative-test"], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      timeout: T,
      env,
    })
    const out = `${p.stdout.toString()}\n${p.stderr.toString()}`

    // UNMEASURED, and specifically NOT a claim about the isolation mechanism.
    expect(out).toContain("UNMEASURED")
    expect(out).toContain("harness_failure")
    expect(out).toContain("RESULT: UNMEASURED")
    expect(out).not.toContain("RESULT: DIRTY")
    expect(out).not.toContain("RESULT: CLEAN")
    expect(out).toContain("No verdict about the isolation mechanism can be drawn")
    // Exit 3 is reserved for "never ran", distinct from 1 (dirty) and 2 (refused).
    expect(p.exitCode).toBe(3)
    console.log(`[gate] missing runtime -> RESULT: UNMEASURED, exit ${p.exitCode} (not DIRTY)`)
  }, T)
})
