/**
 * CL-16A3-B2B-ROOT-FINAL-GATE §4 — the anti-accumulation regression.
 *
 * Runs the cycle the report is required to show — start server → one request →
 * deterministic teardown → census — and asserts ZERO owned residue after EVERY
 * iteration, not merely after the last. A plateau at 1 or 2 is the exact failure
 * the formal rounds hit, so this refuses to let it hide behind a final total.
 *
 * Then it drives the teardown through the fault modes §4 lists — a killed server,
 * a torn heartbeat, an orphaned in-flight request, a temporarily locked queue,
 * and a queue that NEVER unlocks — and asserts the reaper converges to zero on
 * every recoverable one and FAILS LOUDLY (never blind-deletes, never hangs) on
 * the one that cannot be cleaned.
 *
 *   bun scripts/harness-teardown-regression.ts [--cycles 20]
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_REAP, type Census, deterministicReap, HELPER, ownedResidue, snapshot } from "./harness-teardown"

const PS = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
const FIXTURE = join(import.meta.dir, "..", "test", "fixtures", "teardown-cycle-child.ts")
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? (process.argv[i + 1] ?? d) : d
}
const CYCLES = Number(arg("cycles", "20"))
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function hardKill(pid: number): void {
  Bun.spawnSync(["C:\\Windows\\System32\\taskkill.exe", "/PID", String(pid), "/F", "/T"], { stdout: "ignore", stderr: "ignore" })
}
function serverPidOf(queue: string): number {
  try {
    return Number(JSON.parse(readFileSync(join(queue, "server.ready"), "utf8")).pid) || 0
  } catch {
    return 0
  }
}

interface Child {
  proc: import("bun").Subprocess
  queue: string
  childPid: number
  serverPid: number
  handshake: string
  commandFile: string
}

/** Spawn a cycle child, wait until its server is up and one request has run. */
async function runChild(): Promise<Child> {
  const base = mkdtempSync(join(tmpdir(), "abdo-teardown-cyc-"))
  const handshake = join(base, "handshake.json")
  const commandFile = join(base, "command")
  const proc = Bun.spawn([process.execPath, FIXTURE, handshake, commandFile], { stdout: "pipe", stderr: "pipe" })
  for (let i = 0; i < 1200; i++) {
    if (existsSync(handshake)) break
    if (existsSync(`${handshake}.error`)) throw new Error(`child could not reach the server: ${readFileSync(`${handshake}.error`, "utf8")}`)
    await Bun.sleep(100)
  }
  if (!existsSync(handshake)) {
    hardKill(proc.pid)
    throw new Error(`child never handshook: ${(await new Response(proc.stderr).text()).slice(0, 400)}`)
  }
  const { queue, pid } = JSON.parse(readFileSync(handshake, "utf8"))
  return { proc, queue, childPid: pid, serverPid: serverPidOf(queue), handshake, commandFile }
}

/** Hold a file inside the queue open with FileShare.None until released — a real lock. */
function lockQueue(queue: string, readyFlag: string, releaseFlag: string) {
  const file = join(queue, "reap.lock")
  writeFileSync(file, "x")
  const cmd = `$f=[System.IO.File]::Open('${file}','Open','Read','None'); New-Item -ItemType File -Path '${readyFlag}' -Force | Out-Null; while (-not (Test-Path -LiteralPath '${releaseFlag}')) { Start-Sleep -Milliseconds 30 }; $f.Close()`
  const h = Bun.spawn([PS, "-NoProfile", "-Command", cmd], { stdout: "ignore", stderr: "ignore" })
  for (let i = 0; i < 200 && !existsSync(readyFlag); i++) sleep(25)
  return h
}

interface Line {
  label: string
  ok: boolean
  detail: string
}
const results: Line[] = []
function record(label: string, ok: boolean, detail: string): void {
  results.push({ label, ok, detail })
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(28)} ${detail}\n`)
}

/** The owned census must be all-zero, and the reap must have neither failed nor deferred. */
function assertClean(label: string, baseline: Census, reap: Awaited<ReturnType<typeof deterministicReap>>): boolean {
  const owned = ownedResidue(baseline)
  const ok = owned.clean && reap.failures.length === 0 && reap.deferred.length === 0
  record(
    label,
    ok,
    `owned{h:${owned.ownedHelper} q:${owned.ownedQueue} wt:${owned.ownedWindowsTerminal} con:${owned.ownedConhost}} ` +
      `reap{considered:${reap.consideredQueues} reaped:${reap.queuesReaped} stopped:${reap.serversStopped} retries:${reap.retriesUsed} ${reap.teardownMs}ms}` +
      (reap.failures.length ? ` FAILURES:${JSON.stringify(reap.failures)}` : "") +
      (reap.deferred.length ? ` DEFERRED:${JSON.stringify(reap.deferred)}` : ""),
  )
  return ok
}

console.log(`=== CL-16A3-B2B-ROOT-FINAL-GATE — deterministic teardown regression (${CYCLES} cycles) ===\n`)
console.log("--- part 1: leak-then-reap, zero owned residue after EACH iteration ---")
for (let i = 1; i <= CYCLES; i++) {
  const baseline = snapshot()
  const c = await runChild()
  hardKill(c.childPid) // the test process dies WITHOUT tearing down — the server leaks
  const reap = await deterministicReap(baseline)
  assertClean(`leak #${i}`, baseline, reap)
  rmSync(join(c.handshake, ".."), { recursive: true, force: true })
}

console.log("\n--- part 2: the clean path also self-cleans (child tears itself down) ---")
{
  const baseline = snapshot()
  const c = await runChild()
  writeFileSync(c.commandFile, "stop")
  await c.proc.exited
  await Bun.sleep(500)
  const reap = await deterministicReap(baseline)
  // The child removed its own queue, so the reaper should find nothing to do.
  const ok = assertClean("clean self-teardown", baseline, reap) && reap.consideredQueues === 0
  record("clean leaves no queue", ok, `consideredQueues=${reap.consideredQueues}`)
  rmSync(join(c.handshake, ".."), { recursive: true, force: true })
}

console.log("\n--- part 3: fault injection ---")
// A killed server: the reaper finds it already dead and just removes the queue.
{
  const baseline = snapshot()
  const c = await runChild()
  if (c.serverPid > 0) hardKill(c.serverPid)
  hardKill(c.childPid)
  await Bun.sleep(400)
  assertClean("server killed", baseline, await deterministicReap(baseline))
  rmSync(join(c.handshake, ".."), { recursive: true, force: true })
}
// A torn heartbeat: server.ready truncated to empty — death must be proved by pid, not the beat.
{
  const baseline = snapshot()
  const c = await runChild()
  try {
    writeFileSync(join(c.queue, "server.ready"), "")
  } catch {}
  hardKill(c.childPid)
  assertClean("torn heartbeat", baseline, await deterministicReap(baseline))
  rmSync(join(c.handshake, ".."), { recursive: true, force: true })
}
// An orphaned in-flight request: a .busy/.tmp left behind by a worker that died with the server.
{
  const baseline = snapshot()
  const c = await runChild()
  try {
    writeFileSync(join(c.queue, "orphan.busy"), "argv")
    writeFileSync(join(c.queue, "orphan.tmp"), "half")
  } catch {}
  hardKill(c.childPid)
  assertClean("orphaned request", baseline, await deterministicReap(baseline))
  rmSync(join(c.handshake, ".."), { recursive: true, force: true })
}
// A queue locked, then freed: the reaper retries and succeeds — retriesUsed must be > 0.
{
  const baseline = snapshot()
  const c = await runChild()
  if (c.serverPid > 0) hardKill(c.serverPid) // stop the server so only OUR lock blocks removal
  hardKill(c.childPid)
  await Bun.sleep(400)
  const ready = join(tmpdir(), `abdo-teardown-lock-ready-${process.pid}`)
  const release = join(tmpdir(), `abdo-teardown-lock-release-${process.pid}`)
  const holder = lockQueue(c.queue, ready, release)
  // Release the lock ~1.2s in, while the reaper (15s rm budget) is still retrying.
  const releaser = Bun.spawn([PS, "-NoProfile", "-Command", `Start-Sleep -Milliseconds 1200; New-Item -ItemType File -Path '${release}' -Force | Out-Null`], { stdout: "ignore", stderr: "ignore" })
  const reap = await deterministicReap(baseline)
  await holder.exited
  await releaser.exited
  rmSync(ready, { force: true })
  rmSync(release, { force: true })
  const owned = ownedResidue(baseline)
  const ok = owned.clean && reap.retriesUsed > 0 && reap.failures.length === 0
  record("queue locked then freed", ok, `retries=${reap.retriesUsed} owned.clean=${owned.clean} ${reap.teardownMs}ms`)
  rmSync(join(c.handshake, ".."), { recursive: true, force: true })
}
// A queue that NEVER unlocks: the reaper must FAIL rm_timeout — not hang, not blind-delete.
{
  const baseline = snapshot()
  const c = await runChild()
  if (c.serverPid > 0) hardKill(c.serverPid)
  hardKill(c.childPid)
  await Bun.sleep(400)
  const ready = join(tmpdir(), `abdo-teardown-stuck-ready-${process.pid}`)
  const release = join(tmpdir(), `abdo-teardown-stuck-release-${process.pid}`)
  const holder = lockQueue(c.queue, ready, release)
  const reap = await deterministicReap(baseline, { ...DEFAULT_REAP, rmTimeoutMs: 1_500 })
  const failedRight = reap.failures.some((f) => f.reason === "rm_timeout") && existsSync(c.queue)
  record("queue never unlocks -> FAIL", failedRight, `failures=${JSON.stringify(reap.failures)} queueStillThere=${existsSync(c.queue)} (round would FAIL, no blind delete)`)
  // Release and clean up the deliberately-stuck queue ourselves.
  writeFileSync(release, "")
  await holder.exited
  await deterministicReap(baseline)
  rmSync(ready, { force: true })
  rmSync(release, { force: true })
  rmSync(join(c.handshake, ".."), { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
if (failed.length) {
  console.log("FAILED:")
  for (const f of failed) console.log(`  - ${f.label}: ${f.detail}`)
}
process.exit(failed.length ? 1 : 0)
