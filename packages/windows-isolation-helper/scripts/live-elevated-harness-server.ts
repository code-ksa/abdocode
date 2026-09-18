/**
 * P5c2-FINAL-RC3 §5 — THE SEPARATE LIVE PROOF FOR THE ELEVATED-ONLY HARNESS
 * TRANSPORT.
 *
 * The Medium expected-skip allowlist (`test/gate8-expected-skips.ts`) may only
 * name a test whose omitted proof is supplied SOMEWHERE. This is that somewhere
 * for the one entry it has:
 *
 *   harness-invariants.test.ts
 *     "harness failure modes are fast and explicit >
 *      killing the server mid-flight fails FAST, not after a long timeout"
 *
 * WHY THAT TEST CANNOT RUN AT MEDIUM
 * ──────────────────────────────────
 * There is no server to kill. `runUnelevated` uses the de-elevation QUEUE SERVER
 * only when the shell is elevated (`harness.ts`); at medium integrity it calls
 * `runDirect`, which spawns the helper as an ordinary child and has no server,
 * no `server.ready` heartbeat and no fail-fast path. Running it at medium would
 * kill a process that is not there and time nothing — a test that passes while
 * measuring nothing, which is the failure mode this package exists to refuse.
 *
 * It is NOT re-implemented against `runDirect`. That would be a different
 * property (a killed child) wearing the name of this one (a killed server), and
 * the 80-minute stall this guards against was specifically a dead SERVER that
 * every subsequent request waited out in full.
 *
 * Like `live-elevated-refusal.ts`, this REFUSES to run unless the host is really
 * elevated: it never skips and never passes vacuously.
 *
 *   From an ELEVATED shell:  bun scripts/live-elevated-harness-server.ts
 *
 * Exit 0 = proven. Exit 2 = wrong environment (NOT a pass). Exit 1 = failed.
 */
import { join } from "node:path"
import { HELPER, REQUIRED_PROTOCOL, containerName, firstMissingLifecycleStep, helperBinaryHash, helperBuilt, lastEvents, queueDir, runUnelevated, selfElevated, serverIdentityRefusal, stopServer } from "../test/harness"
import { existsSync, readFileSync } from "node:fs"

const PS = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`

const log = (m: string) => console.log(`[live-elevated-harness-server] ${m}`)
const failures: string[] = []
function check(what: string, cond: boolean, detail = ""): void {
  if (cond) log(`OK   ${what}`)
  else {
    log(`FAIL ${what}${detail ? ` — ${detail}` : ""}`)
    failures.push(what)
  }
}

if (process.platform !== "win32") {
  log("REFUSING: not win32.")
  process.exit(2)
}
if (!helperBuilt()) {
  log(`REFUSING: the helper is not built at ${HELPER}. Run build.ps1 first.`)
  process.exit(2)
}
if (!selfElevated()) {
  log("REFUSING TO RUN: this shell is NOT elevated, so the harness uses the direct transport and there is no queue server to kill.")
  log("This is NOT a pass and must never be recorded as one. Re-run from an elevated shell.")
  process.exit(2)
}

// ── 1. THE SERVER TRANSPORT IS REALLY IN USE. ─────────────────────────────
//
// Asserted before anything is killed: otherwise a run that silently fell back to
// the direct path would "prove" the fail-fast property of a server that was
// never involved.
const warmup = await runUnelevated(["run", "--name", containerName("live-warm"), "--timeout-ms", "20000", "--", PS, "-NoProfile", "-Command", "Write-Output WARM"])
check("a request through the queue server succeeds", String(warmup.stdout).includes("WARM"), JSON.stringify(warmup.error ?? warmup.stdout).slice(0, 200))
check("the request is measured at MEDIUM integrity despite the elevated shell", warmup.elevated === false && warmup.integrity === "medium", `elevated=${String(warmup.elevated)} integrity=${String(warmup.integrity)}`)

const readyPath = join(queueDir(), "server.ready")
check("the server published a readiness file (the direct transport has none)", existsSync(readyPath), readyPath)

// The lifecycle here is the SERVER's own `.ev` file, not the observer-side
// sequence `runDirect` records. Both must satisfy the same invariant.
check("the server recorded a whole, ordered lifecycle for that request", firstMissingLifecycleStep(lastEvents()) === undefined, JSON.stringify(lastEvents()))
log(`   server lifecycle: ${lastEvents().replace(/\r?\n/g, " | ").trim()}`)

// ── 2. THE IDENTITY RULE, AGAINST THE FILE A REAL SERVER PUBLISHED. ───────
//
// `serverIdentityRefusal` is measured as a pure rule at medium
// (`harness-invariants.test.ts`). What only exists here is a REAL published
// identity to apply it to.
let published: { pid?: number; protocolVersion?: number; binaryHash?: string } | undefined
try {
  published = JSON.parse(readFileSync(readyPath, "utf8"))
} catch (e) {
  check("the published identity is readable", false, String(e))
}
if (published) {
  const onDisk = helperBinaryHash()
  check("the LIVE server's published identity is accepted", serverIdentityRefusal(published, onDisk) === undefined, String(serverIdentityRefusal(published, onDisk)))
  check("the live server publishes the protocol this client requires", published.protocolVersion === REQUIRED_PROTOCOL, `published=${String(published.protocolVersion)}`)
  check("the live server IS the binary on disk", published.binaryHash === onDisk, `published=${String(published.binaryHash).slice(0, 16)}… disk=${onDisk.slice(0, 16)}…`)
  // And the same rule refuses that same real server once one field is wrong.
  check("the rule refuses the live server when its hash is doctored", serverIdentityRefusal({ ...published, binaryHash: "0".repeat(64) }, onDisk) !== undefined)
}

// ── 3. THE PROPERTY: A KILLED SERVER FAILS FAST. ──────────────────────────
//
// The 80-minute stall this exists for: the server died a minute into a run and
// every later call sat out its full 90-second timeout. The point is the SPEED of
// the failure, so a 60-second request is issued and the server is killed 700 ms
// in; a client that waits out the timeout takes 60 s, one that notices takes
// seconds.
const t0 = Date.now()
Bun.spawnSync([PS, "-NoProfile", "-Command", "Start-Sleep -Milliseconds 700; Get-Process abdo-winiso -ErrorAction SilentlyContinue | Stop-Process -Force"], { stdout: "ignore", stderr: "ignore" })
let failed = false
let how = ""
try {
  const r = await runUnelevated(["run", "--name", containerName("live-killsrv"), "--timeout-ms", "60000", "--", PS, "-NoProfile", "-Command", "Start-Sleep -Seconds 30"], 60_000)
  failed = r.ok === false
  how = `returned ok=${String(r.ok)} stage=${String(r.stage)} error=${String(r.error).slice(0, 120)}`
} catch (e) {
  failed = true
  how = `threw ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`
}
const elapsed = Date.now() - t0
check("the request FAILED rather than hanging or falsely succeeding", failed, how)
check(`it failed FAST (${elapsed}ms, budget 30000ms)`, elapsed < 30_000, `${elapsed}ms`)
log(`   failure mode: ${how}`)

// ── 4. LEAVE NOTHING BEHIND. ──────────────────────────────────────────────
//
// A killed helper cannot reap its child's console host — `reap_console_hosts`
// runs after the child is waited on and a killed helper never gets there — so
// this script cleans up the wreckage it deliberately created rather than leaving
// it for a census that is entitled to zero tolerance.
stopServer()
const { reapOrphanConsoleHosts } = await import("../test/census")
reapOrphanConsoleHosts()

log("")
if (failures.length === 0) {
  log(`RESULT: LIVE ELEVATED HARNESS-SERVER PROOF PASSED (server transport in use, identity applied to a real published file, kill detected in ${elapsed}ms)`)
  process.exit(0)
}
log(`RESULT: FAILED — ${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`)
process.exit(1)
