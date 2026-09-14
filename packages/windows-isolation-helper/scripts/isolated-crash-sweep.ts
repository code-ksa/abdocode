/**
 * The ISOLATED crash sweep — each point in its own process, from a cleared root.
 *
 * ## Why this exists separately from the suite
 *
 * `bun test test/isorun-crash.test.ts` runs all fifteen points SEQUENTIALLY in
 * ONE process against ONE execution root. That is a real measurement and it
 * catches real things, but it cannot catch a whole class of defect: state that
 * one crash point leaves behind and that the NEXT point happens to depend on.
 * A run that only passes because its predecessor warmed something up is not a
 * run that would survive being the first thing to happen after a reboot, and
 * P4c already produced one cross-run defect of exactly that shape.
 *
 * So each point is also run ALONE: a fresh `bun test` process, filtered to one
 * test, from a root that has been cleared first, with the machine counted
 * afterwards. Fifteen invocations, fifteen independent verdicts.
 *
 * P5c2 makes this more than a formality. The launch path now starts a SECOND
 * process per run — the trusted keeper — which by design outlives its host. A
 * crash sweep is precisely where a keeper could be orphaned without anyone
 * noticing in aggregate, because the sequential run's teardown would sweep up
 * after all fifteen at once. Here, any keeper left by point N shows up as
 * residue attributed to point N.
 *
 *   bun scripts/isolated-crash-sweep.ts [label]
 *
 * ## THE RUNTIME IS LOCATED WITHOUT PATH (P5c2-FINAL-RC2)
 *
 * The inner spawn used to be `Bun.spawnSync(["bun", "test", ...], { env })` — a
 * BARE NAME resolved against the explicit `env`. That made this script's result
 * depend on WHICH SHELL STARTED IT, and the official P5c2 medium round failed on
 * it after 2.7s having measured nothing:
 *
 *     ENOENT: no such file or directory, uv_spawn 'bun'
 *
 * Given an explicit `env`, Bun resolves a bare command name against `env.PATH`
 * BY EXACT CASE. Windows env vars are case-insensitive in the OS, but
 * `process.env` preserves the parent's spelling: bash gives `PATH`, PowerShell
 * gives `Path`. So the lookup succeeded from a bash-rooted process and failed
 * from a PowerShell-rooted one. Every other gate passed because nothing else
 * combines a bare name with an explicit `env`.
 *
 * The runtime is now `process.execPath` — the absolute path of the bun already
 * running this file. There is NO PATH lookup, no `cmd.exe` or PowerShell
 * wrapper, and no `shell: true`. The explicit `env` is kept, because deleting
 * `ABDO_HARNESS_QUEUE` is the whole reason it exists, but it is no longer
 * consulted to find the interpreter — so PATH/Path casing cannot affect this
 * script at all. `test/shell-neutral-spawn.test.ts` pins that, including the
 * decisive case of an env carrying NO path key whatsoever.
 */
const label = process.argv[2] ?? "isolated"
const log = (m: string) => console.log(`[${label}] ${m}`)

/**
 * The interpreter for each isolated run: THIS bun, by absolute path.
 *
 * `ABDO_SWEEP_RUNTIME` exists solely so the regression test can point it at a
 * path that does not exist and prove that a missing interpreter is reported as
 * UNMEASURED rather than as a DIRTY verdict about the product. Nothing else sets
 * it, and it is never a PATH search — an override must also be an absolute path.
 */
const RUNTIME = process.env.ABDO_SWEEP_RUNTIME ?? process.execPath

const POINTS = [
  "after_run_requested",
  "after_root_ready",
  "after_scope_planned",
  "after_grants_intent_before_mutation",
  "after_grants_applied_before_event",
  "after_grants_verified",
  "after_prelaunch_gate",
  "after_launch_intent_before_spawn",
  "after_process_started_before_event",
  "during_process_running",
  "after_process_exited",
  "after_revocation_intent_before_restore",
  "after_revocation_verified",
  "after_cleanup_intent_before_delete",
  "before_completed",
] as const

/**
 * Which points to run. The DEFAULT IS ALL FIFTEEN and the list above is
 * untouched; this only narrows what a single invocation drives.
 *
 * `ABDO_SWEEP_POINTS` is a comma-separated subset, used by the two-shell proof
 * that one real crash point is reached from both a bash-rooted and a
 * PowerShell-rooted process. An unknown name is REFUSED rather than silently
 * ignored, and a narrowed run says so in its own output and in its
 * `--- N/M points clean ---` line, so it can never be mistaken for the full
 * sweep. The official round's gate 6 requires M == 15.
 */
const REQUESTED = (process.env.ABDO_SWEEP_POINTS ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "")
const UNKNOWN = REQUESTED.filter((r) => !(POINTS as readonly string[]).includes(r))
if (UNKNOWN.length > 0) {
  log(`REFUSING TO START: ABDO_SWEEP_POINTS names unknown point(s): ${UNKNOWN.join(", ")}`)
  process.exit(2)
}
const SELECTED = REQUESTED.length > 0 ? (POINTS as readonly string[]).filter((p) => REQUESTED.includes(p)) : (POINTS as readonly string[])

const PS = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`

function ps(script: string): string {
  const p = Bun.spawnSync([PS, "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe", timeout: 120_000 })
  return p.stdout.toString().trim()
}

/**
 * What this machine owns right now.
 *
 * KEEPERS ARE COUNTED SEPARATELY from other helper processes. They run the same
 * image, so a bare `abdo-winiso.exe` count would fold "a keeper was orphaned"
 * into "a helper was orphaned" — two different defects with two different
 * causes, and the first one is new in P5c2.
 */
function census(): { helpers: number; keepers: number; profiles: number; hostiles: number } {
  const helpers = Number(ps(`@(Get-CimInstance Win32_Process -Filter "Name='abdo-winiso.exe'").Count`))
  const keepers = Number(
    ps(`@(Get-CimInstance Win32_Process -Filter "Name='abdo-winiso.exe'" | Where-Object { $_.CommandLine -like '*job-keeper*' }).Count`),
  )
  const profiles = Number(ps(`@(Get-ChildItem "$env:LOCALAPPDATA\\Packages" -Filter "abdo-winiso-*" -ErrorAction SilentlyContinue).Count`))
  const hostiles = Number(ps(`@(Get-CimInstance Win32_Process -Filter "Name='abdo-hostile-target.exe'").Count`))
  return { helpers, keepers, profiles, hostiles }
}

const fmt = (c: ReturnType<typeof census>) => `helpers=${c.helpers}(keepers=${c.keepers}) profiles=${c.profiles} hostiles=${c.hostiles}`

const before = census()
log(`BEFORE ${fmt(before)}`)
if (before.helpers > 0 || before.profiles > 0) {
  log(`REFUSING TO START: the machine is not clean. A sweep that begins with residue cannot attribute residue to a point.`)
  process.exit(2)
}

/**
 * `state` is recorded alongside `ok` so the FINAL verdict can tell a harness
 * failure from a product failure. The per-point conditions below are unchanged —
 * `pass >= 1 && fail === 0 && clean` is still OK, and `harness_failure` is still
 * UNMEASURED. What changes is only that UNMEASURED no longer collapses into
 * "RESULT: DIRTY" at the bottom, which would report a broken driver as a defect
 * in the mechanism under test.
 */
const results: { point: string; ok: boolean; state: "ok" | "dirty" | "unmeasured"; detail: string }[] = []

log(`runtime ${RUNTIME}`)
if (SELECTED.length !== POINTS.length) log(`NARROWED RUN: ${SELECTED.length} of ${POINTS.length} points (${SELECTED.join(", ")}) — NOT the full sweep`)

for (const point of SELECTED) {
  const started = Date.now()
  // ONE PROCESS PER POINT, `-t` filtered down to the single test that kills at
  // this boundary.
  //
  // `ABDO_HARNESS_QUEUE` IS DELIBERATELY NOT SET, and the first version of this
  // script set it — producing fifteen instant identical failures that looked
  // like a catastrophic regression and were entirely my own. That variable means
  // "ADOPT a queue whose server a PARENT already runs" (`ADOPTED_QUEUE` in
  // `test/harness.ts`), so setting it without such a parent makes every test
  // fail in 30ms with `the adopted queue ... has no live server`.
  //
  // Each isolated run must OWN its queue, which is precisely what the default
  // does: a per-pid directory with a server this process starts and stops. That
  // is also what "in its own process" is supposed to mean here.
  const env = { ...process.env }
  delete env.ABDO_HARNESS_QUEUE
  // The interpreter is an ABSOLUTE PATH (`RUNTIME`), so no PATH lookup happens
  // and the explicit `env` above cannot influence which binary starts. Same argv
  // as before, no shell.
  //
  // The spawn is guarded because a runtime that cannot be started throws rather
  // than returning a non-zero exit: the unguarded version turned that into an
  // unhandled exception that killed the whole sweep mid-flight, which is exactly
  // how the official round ended up with no verdict at all. A missing interpreter
  // is a HARNESS failure — UNMEASURED — and never a DIRTY verdict about the
  // mechanism under test.
  let out: string
  try {
    const p = Bun.spawnSync([RUNTIME, "test", "test/isorun-crash.test.ts", "-t", `killed at ${point}:`], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 600_000,
      env,
    })
    out = `${p.stdout.toString()}\n${p.stderr.toString()}`
  } catch (e) {
    const detail = `UNMEASURED — harness_failure: the runtime could not be started (${RUNTIME}): ${e instanceof Error ? e.message : String(e)}`
    results.push({ point, ok: false, state: "unmeasured", detail })
    log(`HARN ${point.padEnd(40)} ${detail}`)
    continue
  }
  const passMatch = out.match(/(\d+) pass/)
  const failMatch = out.match(/(\d+) fail/)
  const pass = Number(passMatch?.[1] ?? 0)
  const fail = Number(failMatch?.[1] ?? 1)

  // A HARNESS FAILURE IS NOT A CRASH-POINT FAILURE, and conflating them is how a
  // broken driver gets reported as fifteen regressions. `harness_failure` means
  // the test never reached the thing it measures — the queue, the de-elevation
  // server, the built binary — so it is called out as UNMEASURED rather than
  // counted as a verdict about this boundary.
  if (out.includes("harness_failure")) {
    const detail = `UNMEASURED — the harness failed before the crash point ran: ${(out.match(/error: ([^\n]+)/)?.[1] ?? "").slice(0, 120)}`
    results.push({ point, ok: false, state: "unmeasured", detail })
    log(`HARN ${point.padEnd(40)} ${detail}`)
    continue
  }

  // RESIDUE IS ATTRIBUTED TO THIS POINT, measured immediately after it and
  // before anything else runs. That attribution is the entire reason for
  // isolating the points in the first place.
  const after = census()
  const clean = after.helpers === 0 && after.keepers === 0 && after.profiles === 0 && after.hostiles === 0
  const ok = pass >= 1 && fail === 0 && clean
  const detail = `${pass} pass / ${fail} fail · ${fmt(after)} · ${((Date.now() - started) / 1000).toFixed(1)}s`
  results.push({ point, ok, state: ok ? "ok" : "dirty", detail })
  log(`${ok ? "OK  " : "FAIL"} ${point.padEnd(40)} ${detail}`)
  if (!clean) {
    // Printed, not swallowed: a leak here names the exact boundary that leaked.
    log(`      ^ RESIDUE ATTRIBUTED TO ${point}`)
  }
}

const failed = results.filter((r) => !r.ok)
const unmeasured = results.filter((r) => r.state === "unmeasured")
const dirty = results.filter((r) => r.state === "dirty")
log(`--- ${results.length - failed.length}/${results.length} points clean ---`)
for (const f of failed) log(`FAILED: ${f.point} — ${f.detail}`)
log(`AFTER  ${fmt(census())}`)

// A HARNESS FAILURE IS NOT A PRODUCT VERDICT. If any point never ran, this sweep
// did not measure the mechanism and must not pronounce on it — reporting DIRTY
// there would blame the isolation code for a broken driver. DIRTY is reserved for
// points that actually ran and actually leaked or failed.
//
// Exit codes: 0 CLEAN · 1 DIRTY · 2 refused to start · 3 UNMEASURED. Distinct, so
// a caller can tell "the mechanism leaked" from "the sweep never ran".
if (unmeasured.length > 0) {
  log(`RESULT: UNMEASURED — ${unmeasured.length} point(s) never ran; ${dirty.length} of the points that did run were dirty`)
  log(`No verdict about the isolation mechanism can be drawn from this sweep.`)
  process.exit(3)
}
log(failed.length === 0 ? "RESULT: CLEAN" : "RESULT: DIRTY")
process.exit(failed.length === 0 ? 0 : 1)
