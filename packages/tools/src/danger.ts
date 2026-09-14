/**
 * Dangerous-command guard.
 *
 * These operations are irreversible or destructive; the model may propose them,
 * but they never run without going through the approval gate. Detection is
 * conservative (matches the command's intent, tolerating flag order/whitespace).
 */

export interface DangerMatch {
  readonly dangerous: boolean
  readonly rule?: string
}

/**
 * Each rule names the PROGRAM it is about, when it has one. CL-04 resolves the
 * real program of every command, so a rule can be checked against the command it
 * actually describes instead of against any text containing the words. Without
 * this, `echo "rm -rf /"` classifies as a destructive delete — the arguments of
 * `echo` are data, not a command.
 *
 * `undefined` = not about one program (a fork bomb, SQL inside a query
 * argument) and is matched against the whole string.
 */
const RULES: ReadonlyArray<readonly [string, RegExp, string | undefined]> = [
  ["rm -rf", /\brm\s+(-[a-z]*\s+)*-?[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, "rm"],
  ["drop database/table", /\bdrop\s+(database|table|schema)\b/i, undefined],
  ["truncate table", /\btruncate\s+table\b/i, undefined],
  ["iptables flush", /\biptables\s+(-F|--flush)\b/i, "iptables"],
  ["ufw disable", /\bufw\s+disable\b/i, "ufw"],
  ["systemctl disable/stop", /\bsystemctl\s+(disable|stop|mask)\b/i, "systemctl"],
  ["docker prune", /\bdocker\s+system\s+prune\b/i, "docker"],
  ["reboot/shutdown", /\b(reboot|shutdown|halt|poweroff)\b/i, undefined],
  ["userdel", /\buserdel\b/i, "userdel"],
  ["recursive chmod/chown", /\b(chmod|chown)\s+(-[a-z]*\s+)*-R\b|\b(chmod|chown)\s+-R/i, undefined],
  ["mkfs", /\bmkfs\b/i, "mkfs"],
  ["dd to device", /\bdd\s+.*of=\/dev\//i, "dd"],
  ["fork bomb", /:\(\)\s*\{\s*:\|:&\s*\}/, undefined],
  ["git push --force", /\bgit\s+push\b.*--force(?!-with-lease)/i, "git"],
  ["kill -9 / killall", /\bkillall\b|\bkill\s+-9\b/i, undefined],
]

/** Classify a RAW shell command string (used when no parse is available). */
export function classifyCommand(command: string): DangerMatch {
  for (const [rule, re] of RULES) {
    if (re.test(command)) return { dangerous: true, rule }
  }
  return { dangerous: false }
}

/**
 * Classify a RESOLVED command (CL-04): the program is known, so a
 * program-specific rule applies only when it IS that program.
 */
export function classifyResolved(program: string, argv: readonly string[]): DangerMatch {
  const line = [program, ...argv].join(" ")
  for (const [rule, re, forProgram] of RULES) {
    if (forProgram !== undefined && forProgram !== program) continue
    if (re.test(line)) return { dangerous: true, rule }
  }
  return { dangerous: false }
}

/** Pull a command string out of arbitrary tool input, if present. */
export function commandOf(input: unknown): string | undefined {
  if (typeof input === "string") return input
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>
    for (const k of ["command", "cmd", "script", "sql", "query"]) {
      if (typeof o[k] === "string") return o[k] as string
    }
  }
  return undefined
}
