/**
 * CL-16A2-D §10/§11 — how the helper is invoked, and what is verified first.
 *
 * TWO RUNNERS EXIST AND THE DIFFERENCE IS THE POLICY.
 *
 *  - `directHelperRunner` is the PRODUCTION shape. It spawns the helper with the
 *    host's own token and REFUSES when the host is elevated. It contains no
 *    de-elevation of any kind: no linked-token duplication, no `explorer.exe`,
 *    no `runas`. A test asserts that by scanning this file, because "we would
 *    never do that" is not a guarantee.
 *  - The de-elevating runner used by the tests lives in `test/harness.ts` and is
 *    a MEASUREMENT HARNESS ONLY. It exists because this session's shell is
 *    elevated; it is not importable from here and nothing in `src/` references
 *    it.
 *
 * Every call re-verifies the helper's identity BEFORE the OS is touched (§11).
 * An unverifiable helper is not run.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"

export const REQUIRED_PROTOCOL_VERSION = 10

export interface HelperInvocation {
  readonly argv: readonly string[]
  readonly timeoutMs?: number
}

export interface HelperResponse {
  readonly ok?: boolean
  readonly protocolVersion?: number
  readonly elevated?: boolean | null
  readonly integrity?: string
  readonly [k: string]: unknown
}

/** The port the lifecycle depends on. Injecting it is what lets the tests run. */
export interface HelperRunner {
  (invocation: HelperInvocation): Promise<HelperResponse>
}

export interface HelperIdentityNow {
  readonly path: string
  readonly realPath: string
  readonly binaryHash: string
  readonly binaryBytes: number
  readonly redirected: boolean
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex")

/** Measure the helper on disk RIGHT NOW. Never cached: caching it is the bug. */
export function helperIdentityNow(helperPath: string): HelperIdentityNow | undefined {
  if (!existsSync(helperPath)) return undefined
  let realPath: string
  try {
    realPath = realpathSync(helperPath)
  } catch {
    return undefined
  }
  return {
    path: helperPath,
    realPath,
    binaryHash: sha256(readFileSync(helperPath)),
    binaryBytes: statSync(helperPath).size,
    redirected: realPath.toLowerCase() !== helperPath.toLowerCase(),
  }
}

export class StaleIsolationEvidence extends Error {
  readonly reasonCode = "stale_isolation_evidence"
  constructor(readonly moved: readonly string[], detail: string) {
    super(`stale_isolation_evidence: ${detail}`)
  }
}

export class ElevatedHostNotSupported extends Error {
  readonly reasonCode = "elevated_host_not_supported"
  constructor() {
    super(
      "elevated_host_not_supported: the AppContainer path is only supported when Abdo itself runs non-elevated. " +
        "It will NOT silently de-elevate — a hidden privilege drop is a security decision the operator has to make, not a convenience.",
    )
  }
}

/**
 * CL-16A3-B2C1 §4 — THE ONE PLACE A HELPER PROCESS STARTS.
 *
 * There used to be three `Bun.spawnSync` calls for two operations: the runner's
 * elevation probe, the runner's invocation, and a THIRD in `backend.ts` doing
 * the same `version` probe again. Three primitives for one capability is how
 * "running the helper" quietly becomes a general exception — the next spawn goes
 * wherever is convenient, and the file-level allowlist covers it.
 *
 * Everything a spawn of the helper is allowed to be is fixed here:
 *   - an ABSOLUTE path the caller has already proved (existence, realpath, hash);
 *   - argv passed as an ARRAY — there is no shell, so no quoting or metacharacter
 *     surface exists at all;
 *   - an EXPLICIT environment: only the named Windows variables below are
 *     forwarded, so nothing a caller happens to have in `process.env` reaches the
 *     child. It is a fixed allowlist, not a filter over arbitrary input;
 *   - an EXPLICIT working directory (the system root — a directory that always
 *     exists and that the helper never reads from), so the child never inherits
 *     a cwd that could be a workspace, a UNC path, or a deleted directory;
 *   - a bounded timeout on every call.
 *
 * STDIN IS LEFT INHERITED, and that is a MEASURED decision that overruled the
 * obvious one. Setting `stdin: "ignore"` looked strictly safer — the helper
 * reads nothing from it — but it made `harness-invariants` fail with
 * `conhostOrphaned grew by 1` on ten consecutive AppContainer runs: detaching
 * stdin causes Windows to hand the child its own console, and that console
 * outlives it. Nineteen of nineteen tests pass with stdin inherited and eighteen
 * with it ignored, isolated and repeated. A tidier-looking spawn option that
 * leaks a process on the user's machine is not a hardening.
 */
const HELPER_ENV_KEYS = ["SystemRoot", "windir", "SystemDrive", "PATHEXT", "COMSPEC", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramData", "PATH"] as const

function helperChildEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of HELPER_ENV_KEYS) {
    const v = process.env[k]
    if (typeof v === "string") env[k] = v
  }
  return env
}

const helperCwd = () => process.env.SystemRoot ?? "C:\\Windows"

/** stdout/stderr/exit code of one helper run. The ONLY holder of the spawn primitive. */
function spawnHelper(helperPath: string, argv: readonly string[], timeoutMs: number): { stdout: string; stderr: string; exitCode: number | null } {
  // [CL-00A:ALLOW windows_helper_process_port]
  const p = Bun.spawnSync([helperPath, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    // stdin: inherited on purpose — see the note above; "ignore" leaks a conhost.
    timeout: timeoutMs,
    env: helperChildEnv(),
    cwd: helperCwd(),
  })
  return { stdout: p.stdout.toString(), stderr: p.stderr.toString(), exitCode: p.exitCode }
}

/**
 * P7/P8 gap 12 — THE HELPER'S EXIT-CODE CONTRACT, which until now was simply
 * absent: the exit code was discarded, so a helper that died abnormally and a
 * helper that answered normally were indistinguishable as long as *something*
 * JSON-shaped reached stdout.
 *
 * The contract is not invented here, it is read off the helper. `emit` in
 * `src/main.rs` is the process's SINGLE exit path and it always
 * `std::process::exit(0)`; a refusal is carried as `ok:false` plus `stage` and
 * `error` INSIDE the payload. So for this helper:
 *
 *   exit 0            — the helper ran and answered. `ok` decides success.
 *   exit non-zero     — the helper never reached `emit`: it crashed, was killed
 *                       by the timeout, or could not start. Whatever is on
 *                       stdout is NOT an answer and must not be parsed as one.
 *   exit null         — Bun reports no code (killed by signal / timeout).
 *
 * Treating a non-zero exit as "look for JSON anyway" is how a crashed helper
 * gets mistaken for a refusal, which is the one confusion this program cannot
 * afford: a refusal means the machine was left alone, a crash means nobody
 * knows.
 */
export class HelperExitContractViolated extends Error {
  constructor(readonly exitCode: number | null, readonly stdoutHead: string, readonly stderrHead: string) {
    super(
      `the helper exited ${exitCode === null ? "by signal" : `with code ${exitCode}`}; it always exits 0 when it answers, so this output is not an answer` +
        ` / stdout: ${stdoutHead} / stderr: ${stderrHead}`,
    )
    this.name = "HelperExitContractViolated"
  }
}

/** The helper's stdout carried no JSON object this host could read. */
export class HelperOutputUnreadable extends Error {
  constructor(readonly stdoutHead: string, readonly stderrHead: string) {
    super(`the helper produced no readable JSON object: ${stdoutHead} / ${stderrHead}`)
    this.name = "HelperOutputUnreadable"
  }
}

/**
 * P7/P9/P10 gap 6 — FIND THE PAYLOAD WITHOUT ASSUMING THE DIALECT.
 *
 * The old reader was `JSON.parse(stdout.trim().split("\n").at(-1))`, and its
 * three assumptions are all things a Windows shell is entitled to break:
 *
 *   - that lines end in "\n". Under cmd and PowerShell they end in "\r\n", and a
 *     "\r" that survives on an interior line is part of that line's text.
 *   - that the payload is the LAST line. A shell banner, a trailing prompt, or
 *     anything a parent process appends after the helper's own newline shifts it.
 *   - that a UTF-8 BOM is not present. `.trim()` happens to strip a LEADING BOM
 *     (U+FEFF is whitespace per the spec) but not one after a banner line.
 *
 * So the payload is SEARCHED FOR rather than positioned: scan from the end for
 * the first line that parses as a JSON *object*, after stripping CR and BOM from
 * each candidate. Scanning from the end keeps the old preference for the last
 * payload when a helper legitimately emits more than one.
 *
 * A line that parses as a bare number, string or array is NOT accepted — the
 * helper's answers are objects, and a stray "3" from a shell must not become a
 * HelperResponse.
 */
export function readHelperPayload(stdout: string): HelperResponse | undefined {
  const lines = stdout.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    // Strip CR (CRLF dialects) and any BOM, wherever the line sits.
    const candidate = lines[i]!.replace(/﻿/g, "").replace(/\r/g, "").trim()
    if (candidate.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as HelperResponse
      }
    } catch {
      // Not this line. Keep walking backwards rather than giving up on the
      // whole stream because its last line happened to be shell noise.
    }
  }
  return undefined
}

/**
 * Ask the helper to describe itself. `version` is the one command that cannot
 * change the machine, which is why both the elevation refusal and the trust
 * verifier are allowed to call it before anything is decided.
 *
 * Exported so `backend.ts` does not need a spawn of its own — it had one, and
 * that duplicate is the reason this port exists.
 */
export function probeHelperSelfReport(helperPath: string, timeoutMs = 30_000): HelperResponse {
  const { stdout, stderr, exitCode } = spawnHelper(helperPath, ["version"], timeoutMs)
  if (exitCode !== 0) throw new HelperExitContractViolated(exitCode, stdout.slice(0, 300), stderr.slice(0, 300))
  const parsed = readHelperPayload(stdout)
  // A raw SyntaxError used to escape from here, which told the caller nothing
  // about WHICH helper or WHAT it said. The failure is now typed and carries
  // the evidence.
  if (!parsed) throw new HelperOutputUnreadable(stdout.slice(0, 300), stderr.slice(0, 300))
  return parsed
}

/**
 * Production runner. Pinning the binary hash at decision time and passing it in
 * makes a swap between the decision and the call a refusal rather than a
 * different program running under the decision's authority.
 */
export function directHelperRunner(helperPath: string, pinnedBinaryHash?: string): HelperRunner {
  /**
   * Elevation is decided ONCE, BEFORE the first command that can change
   * anything.
   *
   * This used to be checked on the way OUT: the command was spawned, its JSON
   * was parsed, and only then was `elevated` inspected. For `version` that is
   * harmless. For `ensure-profile` — the lifecycle's very first helper call —
   * it means an elevated host CREATES A REAL APPCONTAINER PROFILE and only
   * afterwards refuses, leaving a profile on the machine that no journal entry
   * describes, because the completion event is never written. The refusal has
   * to precede the mutation to mean anything.
   */
  let elevationProbe: boolean | undefined

  return async ({ argv, timeoutMs = 120_000 }) => {
    const now = helperIdentityNow(helperPath)
    if (!now) throw new StaleIsolationEvidence(["helperPath"], `the helper is not readable at ${helperPath}`)
    if (now.redirected) throw new StaleIsolationEvidence(["helperRealPath"], `${helperPath} resolves to ${now.realPath}: a redirection at the helper's path is refused on its own`)
    if (pinnedBinaryHash && pinnedBinaryHash !== now.binaryHash) {
      throw new StaleIsolationEvidence(["helperBinaryHash"], `the helper binary changed between the decision and this call`)
    }
    // Probe with the one command that cannot change the machine, and refuse
    // before spawning anything that can.
    if (argv[0] !== "version") {
      if (elevationProbe === undefined) {
        try {
          elevationProbe = probeHelperSelfReport(helperPath).elevated === true
        } catch {
          throw new StaleIsolationEvidence(["helperVersion"], "the helper could not report its own privilege level")
        }
      }
      if (elevationProbe) throw new ElevatedHostNotSupported()
    }
    const { stdout, stderr, exitCode } = spawnHelper(helperPath, argv, timeoutMs)
    // The exit code is checked BEFORE the output is read. A crashed or
    // timed-out helper can still have written a partial line, and parsing that
    // as an answer is how "the machine was left alone" gets confused with
    // "nobody knows what happened".
    if (exitCode !== 0) throw new HelperExitContractViolated(exitCode, stdout.slice(0, 300), stderr.slice(0, 300))
    const parsed = readHelperPayload(stdout)
    if (!parsed) throw new HelperOutputUnreadable(stdout.slice(0, 300), stderr.slice(0, 300))
    if (parsed.protocolVersion !== REQUIRED_PROTOCOL_VERSION) {
      throw new StaleIsolationEvidence(["helperProtocolVersion"], `the helper speaks v${parsed.protocolVersion}; this host requires v${REQUIRED_PROTOCOL_VERSION}`)
    }
    // §10. The refusal is HERE, after the helper has reported its own privilege,
    // so it rests on a measurement rather than on an assumption about the shell.
    if (parsed.elevated === true) throw new ElevatedHostNotSupported()
    return parsed
  }
}
