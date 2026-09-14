/**
 * SSH transport 2.1 (Sprint 22) — the script travels as DATA, never as quoting.
 *
 * The usual way to run something on a remote host is to fold it into a command
 * string: PowerShell quotes for bash, bash quotes for ssh, ssh hands the whole
 * thing to a remote shell that parses it again. Every layer has its own rules,
 * and a script with a quote, a `$`, a backtick or a newline in it has to survive
 * all of them. It usually does not — a heredoc opened in one layer is closed by
 * another, and the failure looks like the remote command being wrong rather
 * than the transport eating it.
 *
 * So nothing is folded. The protocol is five argv-only steps:
 *
 *   1. UPLOAD    the script bytes go over STDIN into a file, via `dd`
 *   2. VERIFY    the remote hashes the file; it must match what was sent
 *   3. EXECUTE   the interpreter runs a FILE — nothing to re-parse
 *   4. RECEIPT   exit code, stdout, stderr and timing come back structured
 *   5. CLEAN     the file is removed on success, and KEPT on failure
 *
 * Step 2 is what makes step 3 honest: without it, "the script ran" means the
 * bytes that arrived ran, which is not the same claim as "my script ran". Step
 * 5 keeps the evidence exactly when someone needs it — a failure with the
 * script already deleted is a failure nobody can reproduce.
 */
import { createHash, randomUUID } from "crypto"

export interface ChannelResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * How argv reaches the target. Injectable so the protocol can be exercised
 * against a local process as well as a real host — the steps are identical, and
 * a transport that can only be tested against production is a transport nobody
 * tests.
 */
export interface ExecChannel {
  readonly describe: string
  exec(request: { readonly argv: readonly string[]; readonly stdin?: string; readonly timeoutMs?: number }): Promise<ChannelResult>
}

export interface SshTarget {
  /** `user@host` or a host alias from ssh_config. */
  readonly host: string
  /** Extra ssh options, each already split into argv elements. */
  readonly sshArgs?: readonly string[]
  /** Where uploads land. `/tmp` unless the host says otherwise. */
  readonly remoteTmp?: string
  /** What runs the script on the far side. */
  readonly interpreter?: string
}

/**
 * Build the argv for one remote command.
 *
 * `--` ends ssh's own option parsing, so a host or argument that begins with a
 * dash can never be read as an ssh flag. Everything after it is passed to the
 * remote as separate words.
 */
export function sshArgv(target: SshTarget, remoteArgv: readonly string[]): readonly string[] {
  return ["ssh", ...(target.sshArgs ?? []), "--", target.host, ...remoteArgv]
}

export interface TransferReceipt {
  readonly scriptPath: string
  readonly digest: string
  readonly verifiedDigest?: string
  readonly uploaded: boolean
  readonly verified: boolean
  readonly executed: boolean
  readonly cleaned: boolean
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly failure?: string
  /** Present when the script was deliberately left behind for diagnosis. */
  readonly keptForDiagnosis?: string
  /**
   * How the arguments reached the script. `payload` is verified by the digest;
   * `command_line` passes through ssh's own handling, which is measurably not
   * quote-preserving on Windows.
   */
  readonly argumentTransport?: "payload" | "command_line" | "none"
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex")

/**
 * Quote ONE argument for exactly one POSIX shell.
 *
 * Single quotes are total in POSIX sh: everything inside is literal, with no
 * escape sequences at all. The one character that cannot appear is the single
 * quote itself, which is closed, escaped and reopened.
 *
 * MEASURED, 2026-08-19, Windows -> Linux over OpenSSH: quoting an argument on
 * the ssh COMMAND LINE does not survive. `'$HOME'`, `$HOME` and `'X${HOME}Y'`
 * all arrived expanded (`/root`, `X/rootY`) — Windows `ssh.exe` does not carry
 * single quotes through to the remote command. That is why this function is
 * used to build the script's own `set --` prologue instead: quoting done once,
 * locally, inside a payload whose bytes are digest-verified, is a fact. Quoting
 * handed to an intermediate layer to re-parse is a hope.
 */
export const shellQuotePosix = (arg: string): string => "'" + arg.split("'").join("'\\''") + "'"

/** The digest a remote `sha256sum`/`shasum` line starts with. */
const parseRemoteDigest = (stdout: string): string | undefined => {
  const match = /\b([0-9a-f]{64})\b/i.exec(stdout)
  return match ? match[1]!.toLowerCase() : undefined
}

export interface RunScriptOptions {
  readonly channel: ExecChannel
  readonly target: SshTarget
  /** The script text. Anything at all — quotes, heredocs, newlines, Arabic. */
  readonly script: string
  readonly timeoutMs?: number
  /** Arguments passed to the script itself. */
  readonly args?: readonly string[]
  /** Override the generated name (tests use this; production should not). */
  readonly scriptName?: string
  readonly now?: () => number
}

/**
 * Upload, verify, execute, receipt, clean.
 *
 * Every step is argv. There is no heredoc anywhere in this file, and no string
 * is ever built by putting the script inside a command — which is the property
 * the gate checks rather than trusts.
 */
export async function runRemoteScript(options: RunScriptOptions): Promise<TransferReceipt> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const tmp = options.target.remoteTmp ?? "/tmp"
  const interpreter = options.target.interpreter ?? "bash"
  const name = options.scriptName ?? `abdo-${randomUUID()}.sh`
  const scriptPath = `${tmp}/${name}`
  // A POSIX shell can receive its arguments INSIDE the verified payload, which
  // is the only place quoting is trustworthy (see shellQuotePosix). Any other
  // interpreter has to take them on the command line, and the receipt says so
  // rather than leaving the caller to assume they were safe.
  const args = options.args ?? []
  const argumentTransport: "payload" | "command_line" | "none" =
    args.length === 0 ? "none" : /(^|\/)(ba|da|k|z)?sh$/.test(interpreter) ? "payload" : "command_line"
  const payload =
    argumentTransport === "payload" ? withArgumentPrologue(options.script, args) : options.script
  const digest = sha256(payload)
  const timeoutMs = options.timeoutMs

  const base = {
    scriptPath,
    digest,
    argumentTransport,
    uploaded: false,
    verified: false,
    executed: false,
    cleaned: false,
    exitCode: null as number | null,
    stdout: "",
    stderr: "",
  }

  // ── 1. upload: the bytes go over stdin, so no layer ever parses them ──
  const upload = await options.channel.exec({
    argv: sshArgv(options.target, ["dd", `of=${scriptPath}`, "status=none"]),
    stdin: payload,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })
  if (upload.exitCode !== 0) {
    return { ...base, durationMs: now() - startedAt, failure: `upload failed: ${upload.stderr.trim() || `exit ${upload.exitCode}`}` }
  }

  // ── 2. verify: what is over there must be what was sent ──────────────
  const verify = await options.channel.exec({
    argv: sshArgv(options.target, ["sha256sum", scriptPath]),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })
  const verifiedDigest = parseRemoteDigest(verify.stdout)
  if (verify.exitCode !== 0 || verifiedDigest === undefined) {
    return {
      ...base,
      uploaded: true,
      durationMs: now() - startedAt,
      failure: `verification could not be performed: ${verify.stderr.trim() || `exit ${verify.exitCode}`}`,
      keptForDiagnosis: scriptPath,
    }
  }
  if (verifiedDigest !== digest) {
    // The bytes that arrived are not the bytes that were sent. Executing them
    // would be running something nobody wrote.
    return {
      ...base,
      uploaded: true,
      verifiedDigest,
      durationMs: now() - startedAt,
      failure: `digest mismatch: sent ${digest.slice(0, 12)}…, remote has ${verifiedDigest.slice(0, 12)}…`,
      keptForDiagnosis: scriptPath,
    }
  }

  // ── 3. execute: an interpreter running a FILE, with nothing to re-parse ──
  const run = await options.channel.exec({
    argv: sshArgv(options.target, [interpreter, scriptPath, ...(argumentTransport === "command_line" ? (options.args ?? []) : [])]),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })

  // ── 5. clean, but ONLY on success ────────────────────────────────────
  let cleaned = false
  if (run.exitCode === 0) {
    const rm = await options.channel.exec({
      argv: sshArgv(options.target, ["rm", "-f", scriptPath]),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })
    cleaned = rm.exitCode === 0
  }

  return {
    scriptPath,
    digest,
    argumentTransport,
    verifiedDigest,
    uploaded: true,
    verified: true,
    executed: true,
    cleaned,
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    durationMs: now() - startedAt,
    ...(run.exitCode === 0
      ? {}
      : {
          failure: `script exited ${run.exitCode}`,
          // Deleting the script here would delete the only copy of what
          // actually ran — the thing anyone diagnosing this needs first.
          keptForDiagnosis: scriptPath,
        }),
  }
}

/**
 * Put the arguments inside the script, as `set --`.
 *
 * The script then reads them through `$@` exactly as if they had been passed on
 * the command line — except that the quoting was done here, once, and the bytes
 * are covered by the digest the remote verifies before anything runs.
 */
export function withArgumentPrologue(script: string, args: readonly string[]): string {
  if (args.length === 0) return script
  const prologue = "set -- " + args.map(shellQuotePosix).join(" ")
  // A shebang must stay on line 1, so the prologue goes after it when present.
  if (script.startsWith("#!")) {
    const cut = script.indexOf("\n")
    if (cut !== -1) return script.slice(0, cut + 1) + prologue + "\n" + script.slice(cut + 1)
  }
  return prologue + "\n" + script
}

/** Markers of the nesting this transport exists to avoid. */
const NESTING = /<<-?\s*['"]?\w+|`[^`]*`|\$\(|\\"|\\'/

/**
 * Does this argv fold a script into a command string?
 *
 * Used by the gate. It looks for heredoc openers, command substitution and
 * escaped quotes — the shapes that appear when one layer's text is being made
 * safe for another layer to re-parse.
 */
export const hasNestedQuoting = (argv: readonly string[]): boolean => argv.some((a) => NESTING.test(a))
