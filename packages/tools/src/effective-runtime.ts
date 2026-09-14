/**
 * CL-16A3-B §0.A — what ACTUALLY runs.
 *
 * THE RULE THIS REPLACES WAS WRONG. CL-16A3 flagged any argv token whose leaf
 * name was a shell, which refuses far too much: an argument whose VALUE is
 * "bash", a file called `bash.txt`, `cmd /c echo bash`, and any JSON payload
 * containing the word would all have been rejected. Refusing safe work is not
 * "fail-closed", it is just wrong, and it trains people to route around the
 * control.
 *
 * The replacement derives the EFFECTIVE RUNTIME from the grammar of each launch
 * shape:
 *
 *   - a direct executable IS the runtime. Its ARGUMENTS never change that, which
 *     is what makes every false positive above disappear;
 *   - `cmd.exe` only interprets what follows `/c` or `/k`, so only the command
 *     token of that payload matters (after any `call`/`@` prefixes);
 *   - `powershell.exe` is examined by SWITCH — `-File`, `-Command` and
 *     `-EncodedCommand` mean different things and cannot be treated alike.
 *
 * AND THE HONEST LIMIT: there is no trustworthy PowerShell parser here, so a
 * `-Command` script is scanned CONSERVATIVELY for a shell invoked in command
 * position. That scan can over-approximate, and when it does the answer is
 * `unknown` — which is refused. Over-refusing a script is acceptable; claiming
 * to have parsed PowerShell would not be. `-EncodedCommand` is never passed
 * through as a black box.
 */

export type ExecutionDialect = "direct" | "powershell" | "cmd" | "bash" | "unknown"

const BASH_LEAVES = new Set(["bash", "sh", "dash", "zsh", "bash.exe", "sh.exe", "dash.exe", "zsh.exe"])
const POWERSHELL_LEAVES = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"])
const CMD_LEAVES = new Set(["cmd", "cmd.exe"])

export const leafOf = (p: string): string => p.replace(/^"+|"+$/g, "").split(/[\\/]/).pop()?.toLowerCase() ?? ""

export const isShellLeaf = (leaf: string): boolean => BASH_LEAVES.has(leaf)

export interface EffectiveRuntime {
  readonly dialect: ExecutionDialect
  /** The program the launch shape will really execute, when determinable. */
  readonly effectiveExecutable?: string
  /** False when the shape could not be analysed safely; the dialect is unknown. */
  readonly analysable: boolean
  readonly reasonCodes: readonly string[]
}

/**
 * Split a cmd payload into tokens, honouring double quotes.
 *
 * cmd's real grammar is larger than this, which is exactly why an unparseable
 * payload yields `unknown` rather than a guess.
 */
export function tokenizeCmdPayload(payload: string): string[] {
  const out: string[] = []
  let cur = ""
  let inQuotes = false
  for (const ch of payload) {
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (cur) out.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** Prefixes that precede the real command inside a cmd payload. */
const CMD_PREFIXES = new Set(["call", "@call", "start", "@start"])

function cmdEffective(argv: readonly string[]): EffectiveRuntime {
  const switchIdx = argv.findIndex((a) => /^\/[ck]$/i.test(a.trim()))
  if (switchIdx < 0) {
    // No /c or /k: cmd is being started interactively or with other switches.
    // Nothing is interpreted, so cmd itself is the runtime.
    return { dialect: "cmd", effectiveExecutable: "cmd.exe", analysable: true, reasonCodes: [] }
  }
  const payload = argv.slice(switchIdx + 1)
  if (payload.length === 0) return { dialect: "cmd", effectiveExecutable: "cmd.exe", analysable: true, reasonCodes: [] }

  // The payload may be one quoted string or several already-separated tokens.
  const tokens = payload.length === 1 ? tokenizeCmdPayload(payload[0]!) : payload.flatMap((p) => tokenizeCmdPayload(p))
  let i = 0
  while (i < tokens.length && CMD_PREFIXES.has(tokens[i]!.toLowerCase())) i++
  const commandToken = tokens[i]
  if (!commandToken) return { dialect: "cmd", effectiveExecutable: "cmd.exe", analysable: true, reasonCodes: [] }

  if (isShellLeaf(leafOf(commandToken))) {
    // `cmd /c bash -c ...` really runs bash. THE bypass this exists to stop.
    return { dialect: "bash", effectiveExecutable: commandToken, analysable: true, reasonCodes: ["cmd_payload_invokes_posix_shell"] }
  }
  return { dialect: "cmd", effectiveExecutable: "cmd.exe", analysable: true, reasonCodes: [] }
}

/** Tokens after which a bare word is a COMMAND rather than a value. */
const PS_COMMAND_POSITION = /(^|[;&|(){}]|\bstart-process\b|\bstart\b|\biex\b|\binvoke-expression\b|\bcall\b|&)\s*$/i

/**
 * Conservatively look for a shell invoked in command position inside a
 * PowerShell script. NOT a parser, and it does not pretend to be one.
 */
export function powershellScriptInvokesShell(script: string): boolean {
  // Strip single/double-quoted string literals first, so `Write-Output "bash"`
  // and `'bash'` are not mistaken for an invocation. This is the step that kills
  // the false positives while keeping `& bash ...` visible.
  const withoutStrings = script.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
  const tokenRe = /[A-Za-z0-9_.:\\/-]+/g
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(withoutStrings)) !== null) {
    if (!isShellLeaf(leafOf(m[0]))) continue
    const before = withoutStrings.slice(0, m.index)
    if (PS_COMMAND_POSITION.test(before) || before.trim().length === 0) return true
  }
  return false
}

function powershellEffective(argv: readonly string[]): EffectiveRuntime {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!.toLowerCase()
    if (/^-(e|ec|enc|encodedcommand)$/.test(a)) {
      // NEVER a black box. Supporting it would require fingerprinting the
      // decoded content, which is a separate, explicit decision.
      return { dialect: "unknown", analysable: false, reasonCodes: ["powershell_encoded_command_not_supported"] }
    }
    if (/^-(f|file)$/.test(a)) {
      const file = argv[i + 1]
      if (!file) return { dialect: "unknown", analysable: false, reasonCodes: ["powershell_file_switch_without_path"] }
      // The script's CONTENT is not read here; whether the file is inside a
      // proven scope is the scope planner's question, not this one's.
      return { dialect: "powershell", effectiveExecutable: file, analysable: true, reasonCodes: ["powershell_file_scope_must_be_proven"] }
    }
    if (/^-(c|command)$/.test(a)) {
      const script = argv.slice(i + 1).join(" ")
      if (powershellScriptInvokesShell(script)) {
        return { dialect: "unknown", analysable: false, reasonCodes: ["powershell_script_may_invoke_posix_shell"] }
      }
      return { dialect: "powershell", effectiveExecutable: "powershell.exe", analysable: true, reasonCodes: [] }
    }
  }
  return { dialect: "powershell", effectiveExecutable: "powershell.exe", analysable: true, reasonCodes: [] }
}

export const isAbsoluteWindowsPath = (p: string): boolean => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\")

/**
 * Derive the effective runtime from an ALREADY-SEPARATED executable and argv.
 *
 * Pure, host-side, and it takes no command string: a string whose interpretation
 * is the question cannot answer the question.
 */
export function deriveEffectiveRuntime(executable: string, argv: readonly string[]): EffectiveRuntime {
  const leaf = leafOf(executable)

  if (isShellLeaf(leaf)) {
    return { dialect: "bash", effectiveExecutable: executable, analysable: true, reasonCodes: ["executable_is_posix_shell"] }
  }
  if (CMD_LEAVES.has(leaf)) return cmdEffective(argv)
  if (POWERSHELL_LEAVES.has(leaf)) return powershellEffective(argv)

  // A DIRECT EXECUTABLE IS THE RUNTIME, and its arguments do not change that.
  // This single rule is what makes `--flag=bash`, `bash.txt` and a JSON payload
  // mentioning bash all correctly uninteresting.
  if (isAbsoluteWindowsPath(executable) || executable.startsWith("/")) {
    return { dialect: "direct", effectiveExecutable: executable, analysable: true, reasonCodes: [] }
  }
  return { dialect: "unknown", analysable: false, reasonCodes: ["executable_not_absolute"] }
}
