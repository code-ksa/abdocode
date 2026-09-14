/**
 * The structured command (Sprint 21) — argv, not a sentence.
 *
 * The shell tool takes a STRING and runs it through `bash -lc`, which means
 * every argument that contains a space, a quote, a `$`, a backtick or a
 * backslash has to be quoted correctly by whoever wrote the string — and the
 * writer is usually a model. That is the single richest source of "the command
 * did not do what it looked like it would do": a path with a space silently
 * splits into two arguments, `$HOME` expands, a filename with a quote in it
 * ends the argument early, and a Windows path's backslashes are eaten.
 *
 * A `CommandSpec` removes the question. The executable and each argument are
 * separate values that reach the process untouched, because nothing ever
 * concatenates them. There is no quoting to get wrong when there is no string.
 *
 * SCOPE, stated rather than implied: this covers a single program with
 * arguments. Pipes, `&&`, redirection and globbing are shell FEATURES, and a
 * command that genuinely needs them still goes through the shell tool as text —
 * `needsShell` says which is which, so the choice is explicit instead of
 * accidental.
 */

export interface CommandSpec {
  /** The program. Never a sentence, never with arguments baked in. */
  readonly executable: string
  readonly args: readonly string[]
  /** Workspace-relative; the tool resolves and verifies it. */
  readonly cwd?: string
  /**
   * Environment variable NAMES this command needs. Values are supplied by the
   * enforcement point from its own overlay — a spec that carried values would
   * put secrets in the log the moment the command was recorded.
   */
  readonly envHandles?: readonly string[]
  readonly stdin?: string
  readonly timeoutMs?: number
}

export interface CommandProblem {
  readonly field: string
  readonly detail: string
}

/** Shell metacharacters that only mean something to a shell. */
const SHELL_FEATURES = /[|&;<>()$`\\"'*?\[\]{}~\n]|\$\(|\|\||&&/

/**
 * Does this text need a shell at all?
 *
 * Used to keep the two paths honest: a caller reaching for the string tool with
 * something that has no shell features is quoting by hand for no reason, and a
 * caller trying to smuggle `&&` through a structured argument should be told it
 * will be a literal argument rather than an operator.
 */
export const needsShell = (text: string): boolean => SHELL_FEATURES.test(text)

/**
 * Validate a spec. Returns the problems rather than throwing, because the
 * caller is often a model and a list of what is wrong is more useful than a
 * stack trace.
 */
export function validateCommand(spec: CommandSpec): CommandProblem[] {
  const problems: CommandProblem[] = []
  if (typeof spec.executable !== "string" || spec.executable.trim().length === 0) {
    problems.push({ field: "executable", detail: "an executable is required" })
  } else {
    // A NUL byte truncates the program name at the OS boundary — the classic
    // way to make a check see one program and the kernel run another.
    if (spec.executable.includes("\0")) problems.push({ field: "executable", detail: "contains a NUL byte" })
    if (/\s/.test(spec.executable.trim())) {
      problems.push({
        field: "executable",
        detail: `"${spec.executable}" looks like a command line, not a program — put the arguments in args[]`,
      })
    }
  }
  if (!Array.isArray(spec.args)) {
    problems.push({ field: "args", detail: "args must be an array (use [] for none)" })
  } else {
    spec.args.forEach((a, i) => {
      if (typeof a !== "string") problems.push({ field: `args[${i}]`, detail: "every argument must be a string" })
      else if (a.includes("\0")) problems.push({ field: `args[${i}]`, detail: "contains a NUL byte" })
    })
  }
  if (spec.timeoutMs !== undefined && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0)) {
    problems.push({ field: "timeoutMs", detail: "must be a positive number of milliseconds" })
  }
  for (const name of spec.envHandles ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      problems.push({ field: "envHandles", detail: `"${name}" is not a valid environment variable name` })
    }
    if (/=/.test(name)) problems.push({ field: "envHandles", detail: "handles are NAMES; values come from the enforcement point" })
  }
  return problems
}

/** What actually gets spawned. No shell, no concatenation, no quoting. */
export const toArgv = (spec: CommandSpec): readonly string[] => [spec.executable, ...spec.args]

/**
 * A human-readable rendering, FOR DISPLAY AND LOGS ONLY.
 *
 * It is deliberately not round-trippable and nothing executes it. Producing a
 * "safe string" that can be re-parsed is how a structured command quietly turns
 * back into a quoting problem; the argv above is the only thing that runs.
 */
export function renderForDisplay(spec: CommandSpec): string {
  const quote = (s: string): string => (/^[A-Za-z0-9_./:@%+=-]+$/.test(s) && s.length > 0 ? s : JSON.stringify(s))
  return [quote(spec.executable), ...spec.args.map(quote)].join(" ")
}

/** Stable identity of a command, for idempotency keys and ledgers. */
export function commandDigestInput(spec: CommandSpec): string {
  // The separator is a NUL because it is the one byte an argument cannot
  // contain (validate rejects it) — so no two different arg lists can produce
  // the same digest input by rearranging where a boundary appears.
  return [spec.executable, ...spec.args, spec.cwd ?? ""].join("\0")
}
