/**
 * CL-16A3-B2B-ROOT-FINAL-GATE — deterministic harness teardown.
 *
 * WHY THIS EXISTS. The formal rounds passed their product proofs but ended in a
 * NON-STATIONARY state: `helper 0 -> 1`, `conhost 15 -> 16`, `queue dirs = 2`,
 * and the second queue was only ever cleaned by the NEXT `bun test` invocation's
 * `reapStaleServers()`. "Reaped by the next run" is not zero residue: run one
 * round and stop, and a de-elevation server, its Windows-11 console window and
 * two queue directories are left on the machine. A gate cannot depend on a later
 * invocation to make its own boundary clean.
 *
 * WHAT THIS PROVIDES.
 *   1. An OWNED census that separates what the round created from the machine's
 *      standing processes. `abdo-winiso.exe` is ours by name; a de-elevation
 *      console (`WindowsTerminal`/`conhost`) is attributed by "new since the
 *      round began", which over-approximates in the SAFE direction — it can only
 *      raise a false alarm, never hide a leak.
 *   2. A deterministic reaper that, for every round-owned queue, shuts its server
 *      down, waits for the OS to CONFIRM the server process is gone (pid AND
 *      creation time, so a reused pid is never mistaken for a live server), then
 *      removes the queue with bounded retries. Any survivor is
 *      `round_cleanup_failed`; unknown liveness is DEFERRED, never blind-deleted.
 *
 * This is measurement-harness code (CL-16A2-D §10). It touches no product path.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PS = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
export const HELPER = join(import.meta.dir, "..", "target", "release", "abdo-winiso.exe")
export const QUEUE_PREFIX = "abdo-winiso-harness-"

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// ───────────────────────────── process census ─────────────────────────────

export interface ProcInfo {
  readonly pid: number
  readonly name: string // lower-cased image name, e.g. "abdo-winiso.exe"
  readonly ppid: number
  readonly createdMs: number // epoch ms of process creation, from the OS
}

/**
 * One CIM query for every process that could belong to the harness. The creation
 * time comes back as epoch milliseconds computed in PowerShell — a Windows
 * FILETIME exceeds 2^53, so it is never carried through JSON as a raw number.
 */
export function scanProcesses(): ProcInfo[] {
  const cmd =
    "$e=[datetime]'1970-01-01Z';" +
    "Get-CimInstance Win32_Process -Filter \"Name='abdo-winiso.exe' or Name='WindowsTerminal.exe' or Name='conhost.exe'\" " +
    "| ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; name=$_.Name; ppid=$_.ParentProcessId; ms=[int64](($_.CreationDate.ToUniversalTime()-$e).TotalMilliseconds) } } " +
    "| ConvertTo-Json -Compress"
  const p = Bun.spawnSync([PS, "-NoProfile", "-Command", cmd], { stdout: "pipe", stderr: "pipe" })
  const out = p.stdout.toString().trim()
  if (!out) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(out)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.map((r: any) => ({
    pid: Number(r.pid),
    name: String(r.name ?? "").toLowerCase(),
    ppid: Number(r.ppid),
    createdMs: Number(r.ms),
  }))
}

/** Every `abdo-winiso-harness-*` queue directory on disk, as full paths. */
export function listQueues(): string[] {
  try {
    return readdirSync(tmpdir())
      .filter((n) => n.startsWith(QUEUE_PREFIX))
      .map((n) => join(tmpdir(), n))
  } catch {
    return []
  }
}

const pidsOf = (procs: readonly ProcInfo[], name: string) => procs.filter((p) => p.name === name).map((p) => p.pid)

export interface Census {
  readonly ts: number
  readonly procs: readonly ProcInfo[]
  readonly queues: readonly string[]
  readonly helperPids: readonly number[]
  readonly windowsTerminalPids: readonly number[]
  readonly conhostPids: readonly number[]
}

/** A point-in-time census. The `ts` is the round-window start for owned attribution. */
export function snapshot(): Census {
  const procs = scanProcesses()
  return {
    ts: Date.now(),
    procs,
    queues: listQueues(),
    helperPids: pidsOf(procs, "abdo-winiso.exe"),
    windowsTerminalPids: pidsOf(procs, "windowsterminal.exe"),
    conhostPids: pidsOf(procs, "conhost.exe"),
  }
}

export interface OwnedResidue {
  // Exact ownership: nothing else on the machine runs `abdo-winiso`, and a queue
  // directory carries the pid of the process that created it.
  readonly ownedHelper: number
  readonly ownedHelperPids: readonly number[]
  readonly ownedQueue: number
  readonly ownedQueues: readonly string[]
  // Over-approximated ownership (new-since-round-start), reported honestly: a
  // de-elevation console cannot exist without its server, and the server count
  // above is exact — so these corroborate rather than stand alone.
  readonly ownedWindowsTerminal: number
  readonly ownedConhost: number
  // Standing machine state, so a report can show the round changed nothing it
  // did not own.
  readonly systemWideConhost: number
  readonly systemWideWindowsTerminal: number
  readonly conhostDelta: number
  readonly windowsTerminalDelta: number
  /** True when the round left nothing it created behind. */
  readonly clean: boolean
}

/**
 * What the round still owns, computed against the baseline it started from.
 *
 * A helper process or queue directory that was not present at the start is the
 * round's, full stop. A console that appeared during the round window is counted
 * as owned too — an over-count is a false FAIL, which is the direction a gate is
 * allowed to err in; an under-count would let a leak pass.
 */
export function ownedResidue(baseline: Census, now: Census = snapshot()): OwnedResidue {
  const baseHelper = new Set(baseline.helperPids)
  const baseWt = new Set(baseline.windowsTerminalPids)
  const baseCon = new Set(baseline.conhostPids)
  const baseQueue = new Set(baseline.queues)
  const windowStart = baseline.ts

  const ownedHelperPids = now.helperPids.filter((p) => !baseHelper.has(p))
  const ownedQueues = now.queues.filter((q) => !baseQueue.has(q))
  const newInWindow = (name: string, base: Set<number>) => now.procs.filter((p) => p.name === name && !base.has(p.pid) && p.createdMs >= windowStart).length
  const ownedWindowsTerminal = newInWindow("windowsterminal.exe", baseWt)
  const ownedConhost = newInWindow("conhost.exe", baseCon)

  const clean = ownedHelperPids.length === 0 && ownedQueues.length === 0 && ownedWindowsTerminal === 0 && ownedConhost === 0
  return {
    ownedHelper: ownedHelperPids.length,
    ownedHelperPids,
    ownedQueue: ownedQueues.length,
    ownedQueues,
    ownedWindowsTerminal,
    ownedConhost,
    systemWideConhost: now.conhostPids.length,
    systemWideWindowsTerminal: now.windowsTerminalPids.length,
    conhostDelta: now.conhostPids.length - baseline.conhostPids.length,
    windowsTerminalDelta: now.windowsTerminalPids.length - baseline.windowsTerminalPids.length,
    clean,
  }
}

// ───────────────────────────── liveness probes ────────────────────────────

interface ProcessIdentity {
  readonly alive: boolean
  readonly pidReused: boolean
  readonly startTime: string
}

/**
 * Is a pid the live process we mean? Answered by the helper, which compares pid
 * AND creation time — so a reused pid reads as `alive:false, pidReused:true`,
 * and our dead server is never confused with whatever inherited its number.
 */
export function inspectProcess(pid: number, expectStart?: string): ProcessIdentity {
  const argv = ["inspect-process", "--pid", String(pid)]
  if (expectStart) argv.push("--expect-start", expectStart)
  const p = Bun.spawnSync([HELPER, ...argv], { stdout: "pipe", stderr: "pipe" })
  try {
    const j = JSON.parse(p.stdout.toString().trim().split("\n").at(-1) ?? "{}")
    return { alive: j.alive === true, pidReused: j.pidReused === true, startTime: String(j.startTime ?? "") }
  } catch {
    // A helper that cannot answer is not evidence of death.
    return { alive: true, pidReused: false, startTime: "" }
  }
}

/** The owning test process — asked of the OS, not assumed from "it exited". */
export function ownerPidGone(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return true
  const p = Bun.spawnSync([PS, "-NoProfile", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'ALIVE' } else { 'GONE' }`], { stdout: "pipe", stderr: "pipe" })
  return p.stdout.toString().trim() === "GONE"
}

/** The pid the queue directory encodes — the process that created it. */
export function ownerPidOfQueue(dir: string): number {
  const base = dir.split(/[\\/]/).pop() ?? ""
  return Number(base.slice(QUEUE_PREFIX.length))
}

function readServerPid(dir: string): number {
  try {
    const j = JSON.parse(readFileSync(join(dir, "server.ready"), "utf8"))
    return typeof j.pid === "number" ? j.pid : 0
  } catch {
    return 0
  }
}

function heartbeatFresh(dir: string, withinMs: number): boolean {
  try {
    return Date.now() - statSync(join(dir, "server.ready")).mtimeMs < withinMs
  } catch {
    return false
  }
}

function hasLiveRequest(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.endsWith(".busy"))
  } catch {
    return false
  }
}

// ───────────────────────────── the reaper ─────────────────────────────────

export interface ReapOptions {
  readonly serverStopTimeoutMs: number
  readonly rmTimeoutMs: number
  readonly rmRetryDelayMs: number
  readonly settleMs: number
}

export const DEFAULT_REAP: ReapOptions = {
  serverStopTimeoutMs: 25_000,
  rmTimeoutMs: 15_000,
  rmRetryDelayMs: 200,
  settleMs: 1_500,
}

export interface QueueOutcome {
  readonly queue: string
  readonly serverPid: number
  readonly serverStopped: boolean
  readonly retries: number
  readonly removed: boolean
  readonly deferred: boolean
  readonly reason?: string
}

/**
 * A single removal loop, retried because Windows refuses to delete a directory
 * another process still has open. Split out so a unit test can drive it against
 * a really-locked directory without a server in the loop.
 */
export function removeWithRetries(dir: string, deadline: number, retryDelayMs: number): { removed: boolean; retries: number } {
  let retries = 0
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* still held open; try again below */
    }
    if (!existsSync(dir)) return { removed: true, retries }
    if (Date.now() >= deadline) return { removed: false, retries }
    retries++
    sleep(retryDelayMs)
  }
}

/**
 * Reap ONE round-owned queue, obeying the deletion rules:
 *   - the owner process (whose pid names the queue) must be gone;
 *   - the server must be CONFIRMED dead — pid+creation time, or a stale beat and
 *     a released lock when the pid is unreadable;
 *   - no request may still be in flight;
 *   - unknown liveness is DEFERRED, never blind-deleted.
 */
export function reapQueue(dir: string, opts: ReapOptions = DEFAULT_REAP): QueueOutcome {
  const serverPid = readServerPid(dir)
  const base: Omit<QueueOutcome, "removed" | "deferred" | "retries" | "serverStopped"> = { queue: dir, serverPid }

  // Rule: the owner must be gone. A live owner means this queue is still in use
  // (or its liveness is unknown) — defer, do not touch it.
  const owner = ownerPidOfQueue(dir)
  if (Number.isFinite(owner) && owner > 0 && !ownerPidGone(owner)) {
    return { ...base, serverStopped: false, retries: 0, removed: false, deferred: true, reason: "owner_alive_unknown_liveness" }
  }

  // Anchor the server's identity NOW, so the wait below cannot be fooled by pid
  // reuse: `--expect-start` pins the exact process we are shutting down.
  let expectStart = ""
  if (serverPid > 0) expectStart = inspectProcess(serverPid).startTime

  const confirmedDead = (): boolean => {
    if (serverPid > 0) return !inspectProcess(serverPid, expectStart || undefined).alive
    // No readable pid (a torn `server.ready`): fall back to a stale beat AND a
    // released exclusive lock. Both must hold before death is asserted.
    return !heartbeatFresh(dir, 8_000) && !existsSync(join(dir, "server.lock"))
  }

  // If anything says the server is alive, ask it to stop and WAIT for the OS to
  // confirm — a heartbeat going quiet is not the same as a process exiting, and
  // it is the process exiting that closes the console window the census counts.
  const looksAlive = heartbeatFresh(dir, 5_000) || existsSync(join(dir, "server.lock")) || (serverPid > 0 && inspectProcess(serverPid, expectStart || undefined).alive)
  let serverStopped = !looksAlive
  if (looksAlive) {
    try {
      writeFileSync(join(dir, "shutdown.req"), "", "utf8")
    } catch {
      /* the directory may already be going away */
    }
    const deadline = Date.now() + opts.serverStopTimeoutMs
    while (Date.now() < deadline) {
      if (confirmedDead()) {
        serverStopped = true
        break
      }
      sleep(150)
    }
    if (!serverStopped) {
      // Never delete a queue whose server we could not confirm dead: doing so
      // pulls the directory out from under a live process and proves nothing.
      return { ...base, serverStopped: false, retries: 0, removed: false, deferred: false, reason: "server_would_not_stop" }
    }
  }

  // The server is dead; any `.busy` left behind is an orphan of a request whose
  // worker died with it, and goes away with the directory.
  if (hasLiveRequest(dir) && !confirmedDead()) {
    return { ...base, serverStopped, retries: 0, removed: false, deferred: false, reason: "request_in_flight" }
  }

  const { removed, retries } = removeWithRetries(dir, Date.now() + opts.rmTimeoutMs, opts.rmRetryDelayMs)
  return { ...base, serverStopped, retries, removed, deferred: false, reason: removed ? undefined : "rm_timeout" }
}

export interface ReapResult {
  readonly teardownMs: number
  readonly consideredQueues: number
  readonly queuesReaped: number
  readonly serversStopped: number
  readonly retriesUsed: number
  readonly failures: readonly { queue: string; reason: string }[]
  readonly deferred: readonly { queue: string; reason: string }[]
  readonly outcomes: readonly QueueOutcome[]
}

/**
 * Deterministically reap everything the round owns, then settle so consoles have
 * closed before the caller takes its AFTER census. Returns the evidence a report
 * must show; the caller FAILS the round on any failure, any deferral, or any
 * non-zero owned residue.
 */
export async function deterministicReap(baseline: Census, opts: ReapOptions = DEFAULT_REAP): Promise<ReapResult> {
  const start = Date.now()
  const baseQueue = new Set(baseline.queues)
  const owned = listQueues().filter((q) => !baseQueue.has(q))
  const outcomes: QueueOutcome[] = []
  const failures: { queue: string; reason: string }[] = []
  const deferred: { queue: string; reason: string }[] = []
  let queuesReaped = 0
  let serversStopped = 0
  let retriesUsed = 0

  for (const q of owned) {
    const o = reapQueue(q, opts)
    outcomes.push(o)
    retriesUsed += o.retries
    if (o.serverStopped) serversStopped++
    if (o.removed) queuesReaped++
    else if (o.deferred) deferred.push({ queue: q, reason: o.reason ?? "deferred" })
    else failures.push({ queue: q, reason: o.reason ?? "unknown" })
  }

  // Give the killed servers' Windows-11 console windows a bounded moment to tear
  // down before the caller re-censuses — measured to close with the process.
  await Bun.sleep(opts.settleMs)

  return {
    teardownMs: Date.now() - start,
    consideredQueues: owned.length,
    queuesReaped,
    serversStopped,
    retriesUsed,
    failures,
    deferred,
    outcomes,
  }
}
