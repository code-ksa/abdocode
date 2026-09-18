/**
 * CL-16A2-C harness — runs `abdo-winiso` and returns its JSON result.
 *
 * THE PRIVILEGE PROBLEM, AND HOW IT IS SOLVED HONESTLY
 *
 * Section 8 refuses to count anything measured from an elevated shell. This
 * session's shell IS elevated (`integrity: high`), so every measurement has to
 * be taken from a medium-integrity process or it proves nothing about a normal
 * user.
 *
 * Two mechanisms were MEASURED before this one was chosen:
 *
 *   1. `runas /trustlevel:0x20000` — produces a SAFER-restricted token that
 *      still reports `elevated: true`. Rejected: it does not de-elevate.
 *   2. The UAC LINKED TOKEN (`TokenLinkedToken` + `DuplicateTokenEx` +
 *      `CreateProcessWithTokenW`) — the documented route, implemented in the
 *      helper as `deelevate`. On this machine `DuplicateTokenEx` refuses the
 *      linked handle with 1346 (ERROR_BAD_IMPERSONATION_LEVEL) even with
 *      `MAXIMUM_ALLOWED`. Recorded as a finding; the code is kept because it is
 *      the right mechanism where it works.
 *   3. Launching through `explorer.exe`, which runs at the logged-on shell's
 *      integrity. MEASURED to give `elevated: false`, `integrity: medium`.
 *      It changes nothing about the machine: no service, no scheduled task, no
 *      registry write — one temporary `.cmd` that is deleted afterwards.
 *
 * The vehicle cannot contaminate the measurement: the `.cmd` contains only
 * FIXED PATHS, and the actual arguments travel in an `--args-file` (one per
 * line), so cmd.exe never sees a `&`, `|`, `^` or `%` from a test command.
 *
 * Every result carries `elevated` and `integrity` from the process that produced
 * it, so a measurement can never be mistaken for one taken in another context.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const HELPER = join(import.meta.dir, "..", "target", "release", "abdo-winiso.exe")
export const helperBuilt = () => existsSync(HELPER)

/**
 * ONE QUEUE PER TEST PROCESS, and the pid in the name is load-bearing.
 *
 * It used to be a single shared directory. MEASURED: three servers ended up
 * running against it at once — one of them started BEFORE a rebuild, so it was
 * still serving requests with the previous binary. Requests went to whichever
 * server won the claim race, results came back from a mixture of old and new
 * code, and the suite produced fifteen failures that reproduced nowhere when
 * probed by hand. A shared queue across process generations is not a queue, it
 * is a lottery.
 *
 * With the pid in the path, a leaked server can only ever serve its own dead
 * run's directory, and its idle timeout ends it.
 */
const SCRATCH = process.env.ABDO_HARNESS_QUEUE || join(tmpdir(), `abdo-winiso-harness-${process.pid}`)

/**
 * A queue this process did NOT create, handed down by a parent.
 *
 * CL-16A2-D-R needs a child process that can be KILLED at a precise point to
 * prove the journal is durable across a real death. If that child started its
 * own de-elevation server it could never stop it — being killed is the point —
 * and every real-crash test would leak a server and a Windows Terminal window
 * that the census would (correctly) fail the round for.
 *
 * So the child is given the parent's queue instead. It adopts the running
 * server, and it must never shut that server down: the parent still needs it,
 * and the parent is the one that owns its lifetime.
 */
const ADOPTED_QUEUE = Boolean(process.env.ABDO_HARNESS_QUEUE)

/** The queue this process is using, so a parent can hand it to a child. */
export const queueDir = (): string => SCRATCH

export interface HelperResult {
  readonly schema?: string
  readonly command?: string
  readonly ok?: boolean
  readonly elevated?: boolean | null
  readonly integrity?: string
  readonly integrityRid?: number
  readonly osBuildNumber?: number
  readonly exitCode?: number | null
  readonly stdout?: string
  readonly stderr?: string
  readonly timedOut?: boolean
  readonly stage?: string
  readonly error?: string
  readonly errorCode?: number
  readonly sid?: string
  readonly profileCreated?: boolean
  readonly profileExisted?: boolean
  readonly profileDeleted?: boolean
  readonly profileDeleteHresult?: number
  readonly assignedToJob?: boolean
  readonly isProcessInJob?: boolean
  readonly hresult?: number
  readonly [k: string]: unknown
}

/**
 * The lifecycle observed for the most recent request, by WHICHEVER transport ran
 * it: the `.ev` file the queue server wrote (elevated), or the sequence
 * `runDirect` observed itself (medium). Declared here rather than beside
 * `runUnelevated` because `runDirect` writes it and is defined first — a `let`
 * in its temporal dead zone would throw on the very first helper call.
 */
let _lastEvents = ""
export const lastEvents = (): string => _lastEvents
let _lastBinding: LifecycleBinding = { runId: "", operationId: "" }
/** The identity the most recent `runDirect` bound its events to (RC4 §4). */
export const lastBinding = (): LifecycleBinding => _lastBinding

/**
 * Run the helper IN THIS process's context (elevated, when the shell is).
 *
 * A HELPER THAT DIED IS A HARNESS-STAGE FAILURE (RC3 section 4).
 *
 * `stage: "harness"` is what makes `harnessHelperRunner` THROW instead of
 * returning, and that distinction is the whole reason the crash matrix behaved
 * differently at medium and high integrity:
 *
 *   - At high integrity `runUnelevated` goes through the queue server, which
 *     enforces the `started -> child_started -> child_exited -> result` lifecycle
 *     and throws `HarnessFailure` when a crash injection truncates it (line 461).
 *     `lifecycle.ts` catches that, records `helper_died_during_launch`, and the
 *     run is correctly NOT `completed`.
 *   - At medium integrity `runUnelevated` short-circuits to THIS function
 *     (line 406, `if (!selfElevated()) return runDirect(...)`). Without a stage,
 *     the aborted helper came back as an ordinary value, `lifecycle.ts` never
 *     learned the helper had died, and the run folded to `completed` — failing
 *     four `recovery.test.ts` assertions for a reason that had nothing to do with
 *     the property under test.
 *
 * So the transport, not the code under test, decided the result. Unparseable
 * output is the signature of a process that died mid-write, and it is reported as
 * a harness failure here so both transports say the same thing. Note this is
 * deliberately NOT keyed on a non-zero exit code: the helper exits non-zero for
 * legitimate refusals while printing perfectly good JSON, and those must keep
 * coming back as values.
 */
let _invocationCounter = 0

export function runDirect(argv: readonly string[], timeoutMs = 90_000): HelperResult {
  // The invocation's own identity, so its events cannot be confused with another
  // call's (RC4 §4). `op` is the verb, which is what a reader recognises.
  const runId = `d${process.pid}-${++_invocationCounter}`
  const operationId = String(argv[0] ?? "")
  const events: string[] = []
  let seq = 0
  const append = (step: string, extra = "") => events.push(`${step} seq=${seq++} run=${runId} op=${operationId}${extra === "" ? "" : ` ${extra}`} t=${Date.now()}`)

  append("started")
  const p = Bun.spawnSync([HELPER, ...argv], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs })
  // THE SAME LIFECYCLE THE QUEUE SERVER RECORDS, from the same vantage point.
  //
  // RC3 section 4. In serve mode the SERVER observes the child it spawned per
  // request and writes `started -> child_started -> child_exited -> result` to
  // that request's `.ev` file (`src/main.rs` `cmd_serve`). Its `child_started`
  // is not the sandboxed target — it is the helper process serving the request.
  // In direct mode this function occupies exactly that vantage point, so the
  // analogue is precise: the helper process IS the child, its pid and exit code
  // are observed facts, and a result exists only once JSON parsed.
  //
  // Deliberately NOT a Rust change. Adding an `--events-file` to the helper
  // would move the same four facts one process further away, change the binary
  // hash and widen the protocol surface, and it would record the target rather
  // than the request — a DIFFERENT sequence from the one the invariant names.
  //
  // Held in memory rather than written to disk: the file exists in serve mode
  // only because the observer and the reader are separate processes. Here they
  // are the same process, so a file would add I/O and a race without adding a
  // single fact.
  // ── EVERY LINE IS AN OBSERVATION, NOT A FORMALITY (RC4 §4) ───────────────
  //
  // `child_started` is written ONLY when the OS really produced a process, and
  // `child_exited` ONLY when an exit was really observed. An earlier version
  // appended `child_exited` unconditionally after the call returned, which would
  // have written a complete, ordered, entirely fictional lifecycle for a spawn
  // that never created anything — the lifecycle would then have been evidence of
  // its own format rather than of the run. Negative tests in
  // `lifecycle-evidence.test.ts` pin both.
  if (p.pid > 0) append("child_started", `pid=${p.pid}`)
  if (p.exitCode !== null && p.exitCode !== undefined) append("child_exited", `pid=${p.pid} code=${p.exitCode}`)

  const out = p.stdout.toString().trim()
  try {
    const parsed = JSON.parse(out.split("\n").at(-1) ?? "{}") as HelperResult
    append("result")
    _lastEvents = events.join("\n")
    _lastBinding = { runId, operationId, pid: p.pid }
    return parsed
  } catch {
    // NO `result` LINE, and that is the point: a helper that died mid-write has
    // an incomplete lifecycle, exactly as a truncated `.ev` file does.
    _lastEvents = events.join("\n")
    return {
      ok: false,
      stage: "harness",
      exitCode: p.exitCode,
      error: `the helper produced no parseable result (exit ${p.exitCode}) — it died mid-command: ${out.slice(0, 400)} / ${p.stderr.toString().slice(0, 400)}`,
    }
  }
}

/**
 * Run the helper WITHOUT blocking the event loop — the async counterpart of
 * `runDirect`, and the one a concurrency test has to use.
 *
 * P5c2-FINAL-RC4 §2. `Bun.spawnSync` blocks the whole loop until the child
 * exits, so two "overlapping" runs launched with `Promise.all` do not overlap at
 * all: MEASURED, the second task did not begin until the first had fully
 * returned (both marks landed at 51 ms). `appcontainer.test.ts`'s
 * overlapping-profile test was therefore measuring SERIALISATION and asserting
 * concurrency, and `profileExisted: false` was the correct answer to what
 * actually happened.
 *
 * The lifecycle evidence is recorded to exactly the same rules as `runDirect`,
 * from the same vantage point: `child_started` only once the OS has really
 * produced a process, `child_exited` only from an OBSERVED exit — here the
 * settling of `proc.exited`, which is Bun's report of the process handle
 * signalling. Nothing is appended because it would complete the sequence.
 *
 * `lastEvents()` is deliberately NOT written by this function: concurrent runs
 * would interleave into one shared slot and the last writer would win, which is
 * precisely the kind of evidence corruption the invariant exists to catch. The
 * events for a call are returned WITH its result instead.
 */
export async function runDirectAsync(argv: readonly string[], timeoutMs = 90_000): Promise<HelperResult & { events: string; binding: LifecycleBinding }> {
  const runId = `a${process.pid}-${++_invocationCounter}`
  const operationId = String(argv[0] ?? "")
  const events: string[] = []
  let seq = 0
  const append = (step: string, extra = "") => events.push(`${step} seq=${seq++} run=${runId} op=${operationId}${extra === "" ? "" : ` ${extra}`} t=${Date.now()}`)

  append("started")
  const proc = Bun.spawn([HELPER, ...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  // THE KERNEL CREATION TIME IS RECORDED HERE, and only here, because these runs
  // are the concurrent ones: a pid observed by a sibling test after this call
  // returns could genuinely have been reused, and `pid` alone would not say so.
  // The cost (~55 ms, one native call) is paid only by callers that need it.
  const startTime = proc.pid > 0 ? String(runDirect(["inspect-process", "--pid", String(proc.pid)]).startTime ?? "") : ""
  if (proc.pid > 0) append("child_started", `pid=${proc.pid} start=${startTime}`)

  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      /* it already exited */
    }
  }, timeoutMs)
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  clearTimeout(timer)
  append("child_exited", `pid=${proc.pid} code=${exitCode}`)

  const binding: LifecycleBinding = { runId, operationId, pid: proc.pid, ...(startTime === "" ? {} : { startTime }) }
  try {
    const parsed = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as HelperResult
    append("result")
    return { ...parsed, events: events.join("\n"), binding }
  } catch {
    return {
      ok: false,
      stage: "harness",
      exitCode,
      error: `the helper produced no parseable result (exit ${exitCode}) — it died mid-command: ${out.slice(0, 400)} / ${err.slice(0, 400)}`,
      events: events.join("\n"),
      binding,
    }
  }
}

let cachedElevated: boolean | undefined

/** Whether THIS process is elevated — measured by the helper, not assumed. */
export function selfElevated(): boolean {
  if (cachedElevated === undefined) cachedElevated = runDirect(["version"]).elevated === true
  return cachedElevated
}

/**
 * Run the helper in a MEDIUM-integrity (non-elevated) process and return its
 * JSON. When this process is already non-elevated, it runs directly — the
 * vehicle is only needed to get out of an elevated shell.
 */
/**
 * ONE de-elevated launch for the whole test process.
 *
 * THE INCIDENT THIS FIXES, recorded rather than quietly patched: the first
 * version launched `explorer.exe` PER HELPER CALL. Every launch allocated a
 * console, which Windows 11 turns into a Windows Terminal tab that does not
 * close when the command exits. One full suite run left the user with **885
 * terminal windows and 920 orphaned conhost processes holding ~2.2 GB**. The
 * tests were correct and the harness was destructive — and a harness that
 * wrecks the machine it measures is not a harness.
 *
 * Now `explorer.exe` runs exactly once, starting `abdo-winiso serve`, which
 * takes requests as files and runs each as a HIDDEN child (`CREATE_NO_WINDOW`).
 * Children inherit the server's medium integrity, so the privilege property is
 * identical; the window count is not.
 */
let serverStarted = false
/** The server's pid, so its liveness can be asked of the OS and not of a file. */
let serverPid = 0

/** Is this pid really gone? The authoritative answer, used before claiming death. */
function processIsGone(pid: number): boolean {
  const p = Bun.spawnSync([String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, "-NoProfile", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'ALIVE' } else { 'GONE' }`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return p.stdout.toString().trim() === "GONE"
}
const READY = () => join(SCRATCH, "server.ready")

/**
 * Is the server alive RIGHT NOW? It heartbeats `server.ready` twice a second, so
 * a stale file means it is gone.
 *
 * This check exists because of a real 80-minute stall: the server died a minute
 * into a run, and every subsequent call sat out its full 90-second timeout
 * before failing. Nothing was watching, so a dead server looked exactly like a
 * slow one.
 */
function serverAlive(): boolean {
  try {
    return Date.now() - statSync(READY()).mtimeMs < 5_000
  } catch {
    return false
  }
}

export class HarnessFailure extends Error {
  readonly reasonCode = "harness_failure"
}

/**
 * The lifecycle every executed request must record, in order (CL-16A2-D rule 4).
 * The helper writes these lines to the request's `.ev` file (see `cmd_serve`).
 */
export const LIFECYCLE_ORDER = ["started", "child_started", "child_exited", "result"] as const

/** The first lifecycle step NOT found in order, or undefined when all are present. */
export function firstMissingLifecycleStep(events: string): string | undefined {
  let cursor = 0
  for (const line of events.split(/\r?\n/)) {
    if (cursor < LIFECYCLE_ORDER.length && line.startsWith(LIFECYCLE_ORDER[cursor]!)) cursor++
  }
  return cursor < LIFECYCLE_ORDER.length ? LIFECYCLE_ORDER[cursor] : undefined
}

/**
 * P5c2-FINAL-RC4 §4 — the lifecycle bound to an IDENTITY, and validated strictly.
 *
 * `firstMissingLifecycleStep` above answers one question: are the four steps
 * present, in order? That is necessary and nowhere near sufficient. It accepts a
 * sequence that repeats a step, one whose timestamps run backwards, one whose
 * `result` was recorded before the exit it claims to follow, and — worst — one
 * assembled from a DIFFERENT invocation's events, because nothing in the line
 * says which run it belongs to. Under concurrency that last one is not
 * hypothetical: two runs writing to a shared slot produce exactly it.
 *
 * So an event carries its binding:
 *
 *   started seq=0 run=<runId> op=<verb> t=<ms>
 *   child_started seq=1 run=<runId> op=<verb> pid=<pid> start=<creationTime> t=<ms>
 *   child_exited seq=2 run=<runId> op=<verb> pid=<pid> code=<exit> t=<ms>
 *   result seq=3 run=<runId> op=<verb> t=<ms>
 *
 * `start=` is the kernel creation time and is recorded only when the caller asks
 * for it, because obtaining it costs a helper invocation of its own (~55 ms
 * MEASURED) and the suite makes hundreds of calls. It is not needed for
 * correctness within one invocation — the harness holds the subprocess for the
 * whole call, so the kernel cannot reuse that pid underneath it — and it IS
 * recorded wherever a pid outlives the call that produced it.
 */
export interface LifecycleBinding {
  readonly runId: string
  readonly operationId: string
  /** When known: the pid every child_* event must name. */
  readonly pid?: number
  /** When known: the creation time that pins the pid against reuse. */
  readonly startTime?: string
}

const parseEventLine = (line: string): { step: string; fields: Record<string, string> } | undefined => {
  const t = line.trim()
  if (t === "") return undefined
  const [step, ...rest] = t.split(/\s+/)
  const fields: Record<string, string> = {}
  for (const kv of rest) {
    const i = kv.indexOf("=")
    if (i > 0) fields[kv.slice(0, i)] = kv.slice(i + 1)
  }
  return { step: step!, fields }
}

/**
 * Every way a lifecycle can be wrong, named. Empty means the evidence is sound.
 *
 * Deliberately returns ALL problems rather than the first: a sequence that is
 * both duplicated and misbound should say so, or fixing one fault would reveal
 * the next only on the following run.
 */
export function validateLifecycle(events: string, binding: LifecycleBinding): string[] {
  const problems: string[] = []
  const parsed = events.split(/\r?\n/).map(parseEventLine).filter((e): e is NonNullable<typeof e> => e !== undefined)

  if (parsed.length === 0) return ["no lifecycle events were recorded at all"]

  const seen = new Map<string, number>()
  let lastSeq = -1
  let lastT = -1
  let exitedAt = -1
  let resultAt = -1

  parsed.forEach((e, i) => {
    if (!(LIFECYCLE_ORDER as readonly string[]).includes(e.step)) {
      problems.push(`unknown lifecycle step "${e.step}" at index ${i}`)
      return
    }
    // DUPLICATES: a step recorded twice means the recorder ran twice, or two
    // invocations' events were merged.
    if (seen.has(e.step)) problems.push(`duplicate lifecycle event "${e.step}" (already at index ${seen.get(e.step)}, again at ${i})`)
    seen.set(e.step, i)

    // BINDING: an event that does not name THIS invocation is somebody else's.
    if (e.fields.run !== binding.runId) problems.push(`"${e.step}" carries run=${e.fields.run ?? "(absent)"}, expected ${binding.runId}`)
    if (e.fields.op !== binding.operationId) problems.push(`"${e.step}" carries op=${e.fields.op ?? "(absent)"}, expected ${binding.operationId}`)

    // SEQUENCE: strictly increasing, no gaps tolerated at the start.
    const seq = Number(e.fields.seq)
    if (!Number.isInteger(seq)) problems.push(`"${e.step}" has no integer seq (got ${e.fields.seq ?? "(absent)"})`)
    else if (seq <= lastSeq) problems.push(`non-monotonic seq on "${e.step}": ${seq} follows ${lastSeq}`)
    else lastSeq = seq

    // TIME: never runs backwards.
    const t = Number(e.fields.t)
    if (!Number.isFinite(t)) problems.push(`"${e.step}" has no timestamp`)
    else if (t < lastT) problems.push(`time runs backwards at "${e.step}": ${t} < ${lastT}`)
    else lastT = t

    // PID IDENTITY on the child events.
    if (e.step === "child_started" || e.step === "child_exited") {
      if (binding.pid !== undefined && Number(e.fields.pid) !== binding.pid) {
        problems.push(`"${e.step}" names pid ${e.fields.pid ?? "(absent)"}, expected ${binding.pid}`)
      }
      if (binding.startTime !== undefined && e.step === "child_started" && e.fields.start !== binding.startTime) {
        problems.push(`"child_started" names creation time ${e.fields.start ?? "(absent)"}, expected ${binding.startTime} — the pid was reused`)
      }
    }
    if (e.step === "child_exited") exitedAt = i
    if (e.step === "result") resultAt = i
  })

  // MISSING: every step is required.
  for (const step of LIFECYCLE_ORDER) if (!seen.has(step)) problems.push(`missing lifecycle event "${step}"`)

  // CAUSALITY: a result cannot precede the exit it reports on. This is the one
  // ordering rule that is not implied by the sequence numbers — a recorder could
  // number them correctly and still have emitted the result first.
  if (exitedAt >= 0 && resultAt >= 0 && resultAt < exitedAt) {
    problems.push(`"result" was recorded before "child_exited" — the outcome cannot be known before the process ended`)
  }

  return problems
}

/**
 * The server must BE the binary this client verified.
 *
 * It publishes its protocol version and its own SHA-256 in `server.ready`; the
 * client hashes the file on disk and compares. A mismatch is refused outright.
 * This exists because a server started before a rebuild once kept serving
 * requests with the previous binary, and the only symptom was fifteen test
 * failures that reproduced nowhere.
 */
export interface ServerIdentity {
  readonly pid?: number
  readonly protocolVersion?: number
  readonly binaryHash?: string
  readonly exePath?: string
}

/**
 * THE REFUSAL RULE ITSELF, as a pure predicate: the reason to refuse a server's
 * published identity, or `undefined` to accept it.
 *
 * RC3 section 5. This was inlined in `checkServerIdentity`, which needs a live
 * queue server and therefore only exists at high integrity — so the test that
 * covered it was marked `skipIf(!selfElevated())` and did not run in an
 * authoritative round. What that test actually did was write a file containing
 * `"0".repeat(64)` and assert it differed from the real hash, which is a fact
 * about string literals: it would have passed with the rule deleted.
 *
 * Extracted so the RULE can be measured without a server, at any integrity. The
 * caller below is unchanged in behaviour; it is now the only part that needs one.
 */
export function serverIdentityRefusal(ready: ServerIdentity | undefined, onDiskHash: string): string | undefined {
  if (ready === undefined) return "the server published no readable identity"
  if (ready.protocolVersion !== REQUIRED_PROTOCOL) {
    return `server protocol v${ready.protocolVersion}, this client requires v${REQUIRED_PROTOCOL}`
  }
  if (!ready.binaryHash || ready.binaryHash !== onDiskHash) {
    return (
      `the running server is NOT the binary on disk (server ${String(ready.binaryHash).slice(0, 16)}…, disk ${onDiskHash.slice(0, 16)}…). ` +
      `A stale server is serving requests with old code; stop it and re-run.`
    )
  }
  return undefined
}

function checkServerIdentity(): void {
  let ready: { pid?: number; protocolVersion?: number; binaryHash?: string; exePath?: string } | undefined
  // A TORN READ IS NOT A DEAD SERVER. The heartbeat lands atomically whenever it
  // can, but its last-resort path is a plain write, and reading that mid-write
  // yields an empty or truncated file. Re-reading resolves it in microseconds;
  // treating the first bad read as fatal reported healthy servers as dead.
  let lastError: unknown
  for (let i = 0; i < 25 && ready === undefined; i++) {
    try {
      ready = JSON.parse(readFileSync(READY(), "utf8"))
    } catch (e) {
      lastError = e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  if (ready === undefined) {
    throw new HarnessFailure(`the server published no readable identity after 25 attempts (${lastError instanceof Error ? lastError.message : String(lastError)})`)
  }
  const refusal = serverIdentityRefusal(ready, helperBinaryHash())
  if (refusal) throw new HarnessFailure(refusal)
  serverPid = typeof ready.pid === "number" ? ready.pid : 0
}

export const REQUIRED_PROTOCOL = 10

/**
 * Shut down servers left by test processes that are no longer running.
 *
 * Each run owns a `...-harness-<pid>` directory, so a directory whose pid is
 * dead belongs to nobody. Without this the machine slowly accumulates idle
 * servers across runs — and one of them holding an old binary is what produced
 * fifteen unreproducible failures earlier.
 */
function reapStaleServers(): void {
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith("abdo-winiso-harness-")) continue
      const pid = Number(name.slice("abdo-winiso-harness-".length))
      if (!Number.isFinite(pid) || pid === process.pid) continue
      try {
        process.kill(pid, 0) // still alive: leave its server alone
        continue
      } catch {
        /* the owning test process is gone */
      }
      try {
        writeFileSync(join(tmpdir(), name, "shutdown.req"), "", "utf8")
      } catch {
        /* nothing to shut down */
      }
      // AND TAKE THE DIRECTORY WITH IT. Asking a dead run's server to stop but
      // leaving its queue behind is why these accumulated indefinitely: nothing
      // in the system ever deleted one. The owning test process is gone — proved
      // above — so this directory belongs to nobody. If its server is somehow
      // still winding down the removal fails harmlessly and the next run retries.
      try {
        const dir = join(tmpdir(), name)
        const beat = join(dir, "server.ready")
        const serverGone = !existsSync(beat) || Date.now() - statSync(beat).mtimeMs > 10_000
        if (serverGone) rmSync(dir, { recursive: true, force: true })
      } catch {
        /* the next run will try again */
      }
    }
  } catch {
    /* TEMP unreadable; not worth failing a test over */
  }
}

function startServer(): void {
  if (serverStarted && serverAlive()) return
  // A LIVE SERVER ALREADY OWNS THIS QUEUE — adopt it instead of racing it. This
  // is what lets a child process inherit its parent's server, and it is also
  // simply correct: the queue's exclusive lock means a second server would exit
  // immediately anyway, after allocating a console nobody would ever reap.
  if (serverAlive()) {
    serverStarted = true
    return
  }
  if (ADOPTED_QUEUE) {
    // The parent's server is expected to be there. Starting one here would take
    // ownership of a queue this process does not own.
    throw new HarnessFailure(`the adopted queue ${SCRATCH} has no live server`)
  }
  reapStaleServers()
  mkdirSync(SCRATCH, { recursive: true })
  for (const f of ["server.ready", "server.exit"]) rmSync(join(SCRATCH, f), { force: true })
  const cmdFile = join(SCRATCH, "server.cmd")
  // Fixed paths only; no test command ever reaches cmd.exe.
  // A SHORT idle timeout on purpose: if the suite dies without running its exit
  // hook, the server must reap itself in minutes rather than sit on the user's
  // machine. The heartbeat lets the harness restart one that timed out.
  writeFileSync(cmdFile, `@echo off\r\n"${HELPER}" serve --requests "${SCRATCH}" --idle-ms 300000\r\n`, "utf8")
  // `Bun.spawn`, NOT `Bun.spawnSync`. MEASURED: a run stalled for six minutes
  // before its server appeared, with the test process pinned at 100% CPU and
  // nothing queued — a synchronous wait on `explorer.exe`, which normally
  // returns instantly but is under no obligation to. Launching a fire-and-forget
  // process must never be able to block the caller; the readiness heartbeat is
  // what tells us it worked, not the return of the spawn.
  Bun.spawn(["C:\\Windows\\explorer.exe", cmdFile], { stdout: "ignore", stderr: "ignore" }).unref()
  serverStarted = true
}

/** Wait for the server to be answering, restarting it once if it is not. */
async function ensureServer(): Promise<boolean> {
  startServer()
  for (let i = 0; i < 200; i++) {
    if (serverAlive()) return true
    await Bun.sleep(50)
  }
  serverStarted = false
  startServer()
  for (let i = 0; i < 200; i++) {
    if (serverAlive()) return true
    await Bun.sleep(50)
  }
  return false
}

/** Ask the de-elevated server to exit. Called from the suite's teardown. */
export function stopServer(): void {
  // NEVER shut down a queue handed to us by a parent: it is still using it.
  if (ADOPTED_QUEUE) return
  if (!serverStarted) return
  serverStarted = false
  try {
    writeFileSync(join(SCRATCH, "shutdown.req"), "", "utf8")
  } catch {
    /* the server is already gone */
    return
  }
  // WAIT FOR THE SERVER TO ACTUALLY DIE BEFORE REMOVING ITS QUEUE.
  //
  // The earlier version wrote `shutdown.req` and then IMMEDIATELY `rmSync`d the
  // directory. That races the server's poll: the deletion usually removes
  // `shutdown.req` before the server sees it, so the server never shuts down on
  // request and survives on its five-minute idle timeout instead. Its
  // de-elevation console — a Windows Terminal window on Windows 11 — is
  // therefore still standing when the census runs three seconds later, and the
  // gate fails `windowsTerminals` every single time. Measured: killing the
  // server closes that window with it, so a clean shutdown here is what makes
  // the census honest. Exit hooks cannot await, so the wait is synchronous.
  //
  // The server deletes `server.ready` on exit, so `serverAlive()` goes false the
  // moment it is gone.
  for (let i = 0; i < 80; i++) {
    // up to ~20s
    if (!serverAlive()) break
    Bun.sleepSync(250)
  }
  // A short grace for the process (and its terminal window) to fully tear down
  // after it stops heartbeating.
  Bun.sleepSync(300)
  // The queue is this process's own, so removing it takes nothing else with it.
  //
  // RETRIED, because a single attempt in a silent catch was losing. The exiting
  // server polls this directory in a loop, and Windows refuses to delete a
  // directory while another process has it open — so the removal failed, the
  // catch swallowed it, and one queue directory per `bun test` invocation
  // survived. A 40-run battery left exactly 40 of them.
  for (let i = 0; i < 15; i++) {
    try {
      rmSync(SCRATCH, { recursive: true, force: true })
      if (!existsSync(SCRATCH)) return
    } catch {
      /* the server still holds a handle; give it a moment and try again */
    }
    Bun.sleepSync(200)
  }
}

// Belt AND braces, because the failure mode here is leaving a process on a
// user's machine:
//   1. `afterAll` in the preloaded `test/setup-teardown.ts` — the hook that
//      actually runs under `bun test`;
//   2. this `exit` hook, which covers the SCRIPT contexts (the round runner, the
//      evidence and regression scripts) that are not test processes;
//   3. the server's own idle timeout, so even a hard kill of the runner cannot
//      leave it running indefinitely.
//
// MEASURED, and it invalidated what this comment used to claim: `process.on
// ("exit")` is NEVER called under `bun test`. A probe test whose only job was to
// write a file from an `exit` handler produced no file. So every `bun test`
// invocation left its server running and its queue undeletable — which is the
// whole reason residue could only settle at "2, reaped by the next run" instead
// of at zero. Hence (1); this hook alone was never enough.
process.on("exit", stopServer)
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stopServer(); process.exit(130) })

export async function runUnelevated(argv: readonly string[], timeoutMs = 90_000): Promise<HelperResult> {
  if (!selfElevated()) {
    const r = runDirect(argv, timeoutMs)
    // THE INVARIANT, ENFORCED ON BOTH TRANSPORTS (RC3 section 4).
    //
    // The queue path below refuses a result whose request did not record a
    // whole, ordered lifecycle. Until RC3 the medium path returned straight from
    // `runDirect` and enforced nothing, so at the only integrity an
    // authoritative round runs at, the ordered-lifecycle coverage the gate
    // report claimed was not being checked for a single request.
    //
    // A helper that died mid-write is returned as a harness-stage VALUE first,
    // exactly as before, so the crash matrix keeps seeing what it saw: those
    // runs deliberately truncate the lifecycle and `lifecycle.ts` is the thing
    // meant to observe it.
    if (r.stage === "harness") return r
    const missing = firstMissingLifecycleStep(_lastEvents)
    if (missing) {
      throw new HarnessFailure(`an incomplete lifecycle for ${argv[0]}: missing "${missing}". The command's execution is unproven. Events: ${JSON.stringify(_lastEvents)}`)
    }
    return r
  }
  if (!(await ensureServer())) {
    return { ok: false, error: "the de-elevated helper server would not start", stage: "harness" }
  }
  checkServerIdentity()

  const id = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  const reqFile = join(SCRATCH, `${id}.req`)
  const resFile = join(SCRATCH, `${id}.res`)
  // One argument per line, exactly as before: the server never builds a shell
  // string out of them.
  writeFileSync(reqFile, argv.join("\r\n"), "utf8")

  const evFile = join(SCRATCH, `${id}.ev`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(resFile)) {
      try {
        const parsed = JSON.parse(readFileSync(resFile, "utf8"))
        // THE INVARIANT: a result is only believable if a child actually ran.
        // An `exit=0` with no `child_started` is a harness failure, not a pass —
        // it is what a sandbox looks like when it silently executes nothing.
        // THE LIFECYCLE FILE MAY STILL BE LANDING. The result and the last event
        // line are separate writes, so a client that reads once the instant the
        // result appears can catch the events mid-flush — and since both files
        // are deleted immediately afterwards, that read is the only chance there
        // will ever be. Under 20-way parallelism this reported an "incomplete
        // lifecycle" for a request that had in fact run to completion.
        //
        // The invariant is NOT relaxed: the lifecycle must still be whole below.
        // This only distinguishes "not written YET" from "never written".
        let events = ""
        for (let i = 0; i < 50; i++) {
          try {
            events = readFileSync(evFile, "utf8")
          } catch {
            events = ""
          }
          if (firstMissingLifecycleStep(events) === undefined) break
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
        }
        rmSync(resFile, { force: true })
        rmSync(evFile, { force: true })
        _lastEvents = events
        // THE INVARIANT (CL-16A2-D rule 4): a result is only believable if the
        // request records a FULL, ORDERED lifecycle —
        //   started -> child_started -> child_exited -> result.
        // `child_started` alone is not enough. A child that never exited, or a
        // result written with no recorded exit, both mean "we do not actually
        // know what happened", and an `exit=0` with no child is exactly what a
        // sandbox looks like when it silently runs nothing. Enforcing the whole
        // order here is what lets the report claim child_started coverage for
        // EVERY successful request rather than a sampled one.
        const missing = firstMissingLifecycleStep(events)
        if (missing) {
          throw new HarnessFailure(`an incomplete lifecycle for ${argv[0]}: missing "${missing}". The command's execution is unproven. Events: ${JSON.stringify(events)}`)
        }
        return parsed
      } catch (e) {
        if (e instanceof HarnessFailure) throw e
        /* the rename is still in flight */
      }
    }
    // FAIL FAST ON A DEAD SERVER. Waiting out the full timeout for a process
    // that no longer exists is how one silent death turned into 80 minutes of
    // nothing happening.
    if (!serverAlive()) {
      // A STALE HEARTBEAT IS A SUSPICION, NOT A DEATH CERTIFICATE. The file can
      // go stale while the process is perfectly healthy — a beat that lost a
      // race to land is indistinguishable from one that was never written. So
      // the OS is asked directly, and only a pid that is really gone counts as
      // death. Six failures in a 380-run battery were healthy servers reported
      // dead this way, every one of them a harness verdict on a live process.
      if (serverPid > 0 && !processIsGone(serverPid)) {
        await Bun.sleep(25)
        continue
      }
      let why = "unknown"
      try {
        why = readFileSync(join(SCRATCH, "server.exit"), "utf8") || "no exit record"
      } catch {
        /* it did not even manage to say why */
      }
      for (const f of [reqFile, resFile]) rmSync(f, { force: true })
      return { ok: false, error: `the de-elevated helper server died (reason: ${why})`, stage: "harness" }
    }
    await Bun.sleep(25)
  }
  for (const f of [reqFile, resFile]) rmSync(f, { force: true })
  return { ok: false, error: `the de-elevated helper produced no result within ${timeoutMs}ms`, stage: "harness" }
}

/**
 * CL-16A2-D — a `HelperRunner` for the tests.
 *
 * MEASUREMENT HARNESS ONLY (§10). It de-elevates through `explorer.exe` so the
 * suite can run from this session's elevated shell. The PRODUCTION runner
 * (`src/helper-runner.ts`) does none of this and refuses outright when the host
 * is elevated — a test asserts that the production file contains no
 * de-elevation mechanism at all.
 */
export function harnessHelperRunner(): (inv: { argv: readonly string[]; timeoutMs?: number }) => Promise<HelperResult> {
  return async ({ argv, timeoutMs }) => {
    const r = await runUnelevated(argv, timeoutMs ?? 120_000)
    if (r.protocolVersion !== undefined && r.protocolVersion !== REQUIRED_PROTOCOL) {
      throw new Error(`stale_isolation_evidence: helper protocol v${r.protocolVersion}, expected v${REQUIRED_PROTOCOL}`)
    }
    if (typeof r.error === "string" && r.stage === "harness") throw new Error(r.error)
    return r
  }
}

/** SHA-256 of the built helper — the identity the journal pins. */
export function helperBinaryHash(): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto")
  const { readFileSync } = require("node:fs") as typeof import("node:fs")
  return createHash("sha256").update(readFileSync(HELPER)).digest("hex")
}

/**
 * A unique AppContainer name per run — parallel tests must not collide.
 *
 * The `abdo-winiso-` prefix is Abdo's OWNERSHIP MARKER (CL-16A2-D §6). The
 * helper refuses to create or delete any profile without it, so a profile
 * belonging to some other application can never be cleaned up by recovery, no
 * matter what a journal claims.
 */
export const OWNERSHIP_PREFIX = "abdo-winiso-"
export const containerName = (tag: string) => `${OWNERSHIP_PREFIX}${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 64)
