/**
 * Repairing a command line that arrived in the wrong field (Sprint 47, wired
 * live).
 *
 * MEASURED. A 2B model, told plainly by the error message that `executable`
 * takes a program and `args` takes the arguments, sent this five times across
 * three runs:
 *
 *     executable: "ls -la data/"
 *     executable: "git status"
 *
 * The message was right and the model did not act on it. That is the case
 * Sprint 47 exists for: an output that is mechanically repairable should be
 * repaired rather than refused, because the alternative is a run that dies of a
 * formatting convention.
 *
 * The three rules from that sprint hold here without softening:
 *
 *   1. the repair is MECHANICAL — a quote-aware split, not a model asked what
 *      was meant;
 *   2. it is BOUNDED — one shape of mistake, and anything with shell features
 *      is refused rather than guessed at, because splitting `a && b` into argv
 *      changes what it does;
 *   3. it is MARKED — a repaired call reports that it was repaired, so a
 *      command that needed fixing never looks identical to one that arrived
 *      correct. A silent repair is how a prompt problem becomes invisible.
 */
import { needsShell, type CommandSpec } from "./command"

export interface CommandRepair {
  readonly spec: CommandSpec
  readonly repaired: boolean
  /** What was done, for the receipt and for the model's own result. */
  readonly note?: string
}

/**
 * Split a command line the way a shell would, minus the shell.
 *
 * Quote-aware, because `node -e "console.log(1)"` split on whitespace becomes
 * four arguments and runs nothing recognisable. This handles single and double
 * quotes and nothing else — anything cleverer belongs to a real shell, which
 * is what `needsShell` sends it to.
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let has = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0 || has) {
        out.push(current)
        current = ""
        has = false
      }
      continue
    }
    current += ch
  }
  if (current.length > 0 || has) out.push(current)
  return out
}

/**
 * If a whole command line arrived in `executable`, put it where it belongs.
 *
 * Refused rather than repaired when:
 *   - the line contains shell features (`|`, `&&`, redirection, globs). Splitting
 *     those into argv silently changes what the command does, and a repair that
 *     changes meaning is worse than the refusal it replaced.
 *   - `args` is already populated. Then the caller has said two different things
 *     about the same call, and guessing which it meant is not repair.
 */
export function repairCommandSpec(spec: CommandSpec): CommandRepair {
  const executable = typeof spec.executable === "string" ? spec.executable.trim() : ""
  if (executable.length === 0) return { spec, repaired: false }

  // a bare program name is already correct
  if (!/\s/.test(executable)) return { spec, repaired: false }

  // Shell features are only shell features OUTSIDE quotes. The real line the
  // model sent — `node -e "const db = require('x'); console.log(db)"` — has a
  // semicolon inside a quoted argument, and testing the raw string refused a
  // repair that was entirely safe. Refusing is the conservative direction and
  // it was still wrong: a false refusal sends the model to the shell tool for
  // a command that never needed one, which is how a guard trains people to
  // route around it.
  const outsideQuotes = executable.replace(/"[^"]*"|'[^']*'/g, "")
  if (needsShell(outsideQuotes))
    return {
      spec,
      repaired: false,
      note:
        `"${executable.slice(0, 60)}" uses shell features (pipes, &&, redirection or globs). ` +
        `It cannot be split into a program and arguments without changing what it does — use the shell tool for this one.`,
    }

  if (Array.isArray(spec.args) && spec.args.length > 0)
    return {
      spec,
      repaired: false,
      note:
        `"${executable.slice(0, 60)}" looks like a whole command line, but args[] is also filled in. ` +
        `Those are two different instructions for one call — send the program in executable and everything else in args[].`,
    }

  const parts = splitCommandLine(executable)
  if (parts.length < 2) return { spec, repaired: false }

  return {
    spec: { ...spec, executable: parts[0]!, args: parts.slice(1) },
    repaired: true,
    note: `repaired: the command line was in \`executable\`; split into executable="${parts[0]}" and ${parts.length - 1} argument(s)`,
  }
}
