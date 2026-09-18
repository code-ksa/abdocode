/**
 * CL-04 stage 2 — PowerShell and cmd.exe normalization.
 *
 * Same contract and same fail-closed rule as bash: anything unaccounted for
 * makes the operation `uncertain`, which the decision point escalates. What
 * differs is the syntax, and the differences are exactly where a bash-shaped
 * parser would be WRONG on Windows:
 *
 *   - the escape character is a backtick in PowerShell and `^` in cmd, NOT `\`.
 *     Treating `\` as an escape mangles every Windows path (`C:\Users\x`).
 *   - PowerShell expands `$var` and `$env:VAR`; cmd expands `%VAR%`. Both are
 *     runtime values the policy cannot see, so both are dynamic.
 *   - `(...)`, `@(...)` and `&{...}` are subexpressions/script blocks.
 *   - `Invoke-Expression`/`iex` and `call` run text as code.
 *
 * Carried over from abdo's shell handling (packages/abdo/src/tool/shell.ts),
 * so previously-solved problems are not reintroduced: leading `(`/`@(` is
 * dynamic, `$` other than a plain name is dynamic, a glob metacharacter means a
 * path is not knowable, and in cmd an argument starting with `/` is a FLAG, not
 * a path. We are deliberately stricter in one place — `$env:VAR` is treated as
 * dynamic rather than expanded, because the policy cannot see the environment
 * either, and `shell` already requires approval so the cost is nil.
 */
import type { NormalizedCommand, NormalizedOperation, ResourceAnalysis } from "@abdo/control-contracts"

export type WindowsShell = "powershell" | "cmd"

const PS_INDIRECTION = new Set(["invoke-expression", "iex", "invoke-command", "icm", "start-process", "saps"])
const CMD_INDIRECTION = new Set(["call", "start"])
const PS_CD = new Set(["cd", "chdir", "set-location", "sl", "push-location", "pushd"])
const CMD_CD = new Set(["cd", "chdir", "pushd"])
/** Nested shells: their payload is a command string we must re-parse. */
const SHELLS = new Set(["cmd", "powershell", "pwsh", "bash", "sh", "wsl"])
const SCRIPT_FLAGS = new Set(["/c", "/k", "-c", "-command", "-lc"])
const VALUE_FLAGS = new Set(["-executionpolicy", "-file", "-encodedcommand", "-outputformat", "-inputformat", "-version"])

const MAX_DEPTH = 3

const DYNAMIC_PS = [
  { re: /\$\((?:[^()]|\([^()]*\))*\)/g, reason: "subexpression" },
  { re: /@\((?:[^()]|\([^()]*\))*\)/g, reason: "array_subexpression" },
  { re: /&\s*\{[^}]*\}/g, reason: "script_block_invocation" },
  { re: /\$env:[A-Za-z_][A-Za-z0-9_]*/gi, reason: "variable_expansion" },
  { re: /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, reason: "variable_expansion" },
] as const

const DYNAMIC_CMD = [
  { re: /%[A-Za-z_][A-Za-z0-9_]*%/g, reason: "variable_expansion" },
  { re: /%%?~?[A-Za-z]\b/g, reason: "for_variable" },
  { re: /!\w+!/g, reason: "delayed_expansion" },
] as const

/** A glob metacharacter means the affected path is not knowable statically. */
const GLOB = /[?*[\]]/

interface Token {
  readonly text: string
  readonly quoted: boolean
}

/**
 * Tokenizer for both Windows shells. The escape character differs, and neither
 * is `\` — that is the whole reason this is not the bash tokenizer with a flag.
 */
function tokenize(input: string, shell: WindowsShell): Token[] {
  const escape = shell === "powershell" ? "`" : "^"
  const tokens: Token[] = []
  let current = ""
  let quoted = false
  let sawAny = false
  let quote: '"' | "'" | undefined
  const push = () => {
    if (sawAny) tokens.push({ text: current, quoted })
    current = ""
    quoted = false
    sawAny = false
  }
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (quote) {
      if (c === quote) quote = undefined
      else {
        current += c
        sawAny = true
      }
      continue
    }
    if (c === escape && i + 1 < input.length) {
      current += input[++i]
      sawAny = true
      continue
    }
    // PowerShell has both quote forms; cmd only understands double quotes.
    if (c === '"' || (shell === "powershell" && c === "'")) {
      quote = c as '"' | "'"
      quoted = true
      sawAny = true
      continue
    }
    if (c === " " || c === "\t") {
      push()
      continue
    }
    const two = input.slice(i, i + 2)
    if (two === "&&" || two === "||" || two === ">>") {
      push()
      tokens.push({ text: two, quoted: false })
      i++
      continue
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "\r" || c === ">" || c === "<") {
      if ((c === ">" || c === "<") && /^\d$/.test(current) && sawAny) {
        tokens.push({ text: current + c, quoted: false })
        current = ""
        sawAny = false
        continue
      }
      push()
      if (c !== "\r") tokens.push({ text: c === "\n" ? ";" : c, quoted: false })
      continue
    }
    current += c
    sawAny = true
  }
  push()
  return tokens
}

const SEPARATORS = new Set(["&&", "||", ";", "|", "&"])

/** Program name without a path or an executable suffix. */
const basename = (t: string) =>
  t
    .replace(/^.*[\\/]/, "")
    .replace(/\.(cmd|exe|bat|ps1|com)$/i, "")
    .toLowerCase()

interface State {
  cwd: string
  readonly commands: NormalizedCommand[]
  readonly dynamic: string[]
  readonly reasons: Set<string>
}

function collectDynamic(raw: string, shell: WindowsShell, state: State): void {
  const rules = shell === "powershell" ? DYNAMIC_PS : DYNAMIC_CMD
  for (const { re, reason } of rules) {
    for (const m of raw.matchAll(re)) {
      state.dynamic.push(m[0])
      state.reasons.add(reason)
    }
  }
  // A leading `(` or `@(` is a subexpression whose result becomes the command.
  if (shell === "powershell" && /^\s*@?\(/.test(raw)) {
    state.dynamic.push(raw.trim())
    state.reasons.add("subexpression")
  }
}

/** Windows paths are case-insensitive and use either separator. */
function joinCwd(base: string, dir: string): string {
  const clean = dir.replace(/^["']|["']$/g, "")
  if (/^[A-Za-z]:/.test(clean) || clean.startsWith("\\\\") || clean.startsWith("/")) return clean.replace(/\\/g, "/")
  const parts = [...base.split(/[\\/]/).filter(Boolean), ...clean.split(/[\\/]/).filter(Boolean)]
  const out: string[] = []
  for (const p of parts) {
    if (p === ".") continue
    if (p === "..") out.pop()
    else out.push(p)
  }
  return out.join("/")
}

function parseSegment(tokens: Token[], shell: WindowsShell, state: State, depth: number): void {
  const redirections: NormalizedCommand["redirections"][number][] = []
  const kept: Token[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (!t.quoted && (t.text === ">" || t.text === ">>" || t.text === "<" || t.text === "1>" || t.text === "2>")) {
      const target = tokens[i + 1]
      if (target) {
        redirections.push({ kind: t.text === "<" ? "in" : t.text === ">>" ? "append" : "out", target: target.text })
        i++
      }
      continue
    }
    kept.push(t)
  }
  let rest = kept
  const env: Record<string, string> = {}

  for (let guard = 0; guard < 8 && rest.length > 0; guard++) {
    const head = basename(rest[0]!.text)

    if (SHELLS.has(head)) {
      if (depth >= MAX_DEPTH) {
        state.dynamic.push(rest.map((t) => t.text).join(" "))
        state.reasons.add("nesting_too_deep")
        return
      }
      let i = 1
      while (i < rest.length) {
        const flag = rest[i]!.text.toLowerCase()
        if (SCRIPT_FLAGS.has(flag)) {
          const inner = rest.slice(i + 1).map((t) => t.text).join(" ")
          // A nested shell may be a DIFFERENT shell: `cmd /c "bash -lc ..."`.
          const innerShell: WindowsShell = head === "cmd" ? "cmd" : "powershell"
          collectDynamic(inner, innerShell, state)
          for (const seg of splitSegments(tokenize(inner, innerShell))) parseSegment(seg, innerShell, state, depth + 1)
          return
        }
        if (VALUE_FLAGS.has(flag)) i += 2
        else if (flag.startsWith("-") || flag.startsWith("/")) i++
        else break
      }
      state.dynamic.push(rest.map((t) => t.text).join(" "))
      state.reasons.add("opaque_shell_invocation")
      return
    }

    if ((shell === "powershell" ? PS_INDIRECTION : CMD_INDIRECTION).has(head)) {
      state.dynamic.push(rest.map((t) => t.text).join(" "))
      state.reasons.add("indirect_execution")
      return
    }

    if ((shell === "powershell" ? PS_CD : CMD_CD).has(head)) {
      // `cd /d C:\x` — in cmd a leading `/` is a FLAG, never a path.
      const dir = rest.slice(1).find((t) => !(t.text.startsWith("-") || (shell === "cmd" && t.text.startsWith("/"))))
      if (dir) state.cwd = joinCwd(state.cwd, dir.text)
      return
    }

    // `set VAR=value` (cmd) / `$env:VAR = "value"` (PowerShell, already dynamic).
    if (shell === "cmd" && head === "set" && rest[1] && rest[1].text.includes("=")) {
      const [name, ...v] = rest[1].text.split("=")
      env[name!] = v.join("=")
      return
    }

    // A script file's contents are invisible to us; resolving it to a program
    // name would claim knowledge we do not have.
    if (/\.(bat|cmd|ps1|sh|psm1)$/i.test(rest[0]!.text)) {
      state.dynamic.push(rest.map((t) => t.text).join(" "))
      state.reasons.add("opaque_script_file")
      return
    }
    state.commands.push({
      program: head,
      argv: rest.slice(1).map((t) => t.text),
      cwd: state.cwd,
      env,
      redirections,
      background: false,
    })
    return
  }
}

function splitSegments(tokens: Token[]): Token[][] {
  const out: Token[][] = []
  let current: Token[] = []
  for (const t of tokens) {
    if (!t.quoted && SEPARATORS.has(t.text)) {
      if (current.length > 0) out.push(current)
      current = []
      continue
    }
    current.push(t)
  }
  if (current.length > 0) out.push(current)
  return out
}

function resourcesOf(commands: readonly NormalizedCommand[]): ResourceAnalysis {
  const writes: string[] = []
  const reads: string[] = []
  let globbed = false
  for (const c of commands) {
    for (const r of c.redirections) {
      if (GLOB.test(r.target)) globbed = true
      if (r.kind === "in") reads.push(r.target)
      else writes.push(r.target)
    }
  }
  // A glob target is not a known path — say so rather than list a pattern as if
  // it were a file (an abdo lesson: a leading glob has no usable prefix).
  if (globbed || (writes.length === 0 && reads.length === 0)) return { analysis: "unknown" }
  return { analysis: "partial", ...(reads.length > 0 ? { reads } : {}), ...(writes.length > 0 ? { writes } : {}) }
}

export function normalizeWindows(command: string, shell: WindowsShell, options: { cwd?: string } = {}): NormalizedOperation {
  const state: State = { cwd: options.cwd ?? "", commands: [], dynamic: [], reasons: new Set() }
  collectDynamic(command, shell, state)
  try {
    for (const seg of splitSegments(tokenize(command, shell))) parseSegment(seg, shell, state, 0)
  } catch {
    state.reasons.add("parser_error")
    state.dynamic.push(command)
  }
  if (state.commands.length === 0 && state.dynamic.length === 0) {
    state.reasons.add("no_command_resolved")
    state.dynamic.push(command)
  }
  const certain = state.dynamic.length === 0 && state.reasons.size === 0
  return {
    kind: "shell",
    shell,
    summary: state.commands.length > 0 ? state.commands.map((c) => [c.program, ...c.argv].join(" ")).join(" | ").slice(0, 200) : `${shell}: ${command.slice(0, 120)}`,
    certainty: certain ? "parsed" : "uncertain",
    commands: state.commands,
    cwd: state.cwd,
    ...(state.dynamic.length > 0 ? { unknownDynamicSegments: state.dynamic } : {}),
    ...(state.reasons.size > 0 ? { uncertainReasons: [...state.reasons].sort() } : {}),
    resources: resourcesOf(state.commands),
  }
}
