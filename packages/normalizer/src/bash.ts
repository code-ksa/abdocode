/**
 * CL-04 stage 1 — Bash normalization.
 *
 * Turns a command STRING into what it actually does, so the decision point
 * reasons about an operation instead of matching text. `rm -rf x`,
 * `cmd /c "rm -rf x"` and `env A=1 sudo rm -rf x` are one operation with one
 * identity; `echo "rm -rf x"` is not that operation at all.
 *
 * THE SAFETY RULE, and the reason this file is conservative to the point of
 * being boring: anything the parser cannot fully account for — a command
 * substitution, an `eval`, a variable that decides the program — makes the whole
 * operation `certainty: "uncertain"` and lists the offending segment. Uncertain
 * is a risk INPUT that the PDP escalates. There is no code path from "we could
 * not parse this" to "allow".
 *
 * Not a shell. It does not expand, glob, resolve or execute anything.
 * PowerShell and cmd.exe are stage 2; an unsupported shell is `uncertain`.
 */
import type { NormalizedCommand, NormalizedOperation } from "@abdo/control-contracts"

/** Wrappers that decorate a command without changing what it does. */
const PREFIX_WRAPPERS = new Set(["sudo", "env", "cross-env", "corepack", "command", "time", "nice", "nohup", "doas"])
/** Shells whose real command lives in a `-c`-style argument. */
const SHELL_WRAPPERS = new Set(["cmd", "powershell", "pwsh", "sh", "bash", "zsh", "dash", "ash"])
const SCRIPT_FLAGS = new Set(["/c", "/k", "-c", "-command", "-lc", "-lic", "-ic"])
/** Shell flags that consume a following value. */
const VALUE_FLAGS = new Set(["-executionpolicy", "-file", "-encodedcommand", "-outputformat", "-inputformat"])
/** Constructs whose effect depends on runtime data we do not have. */
const DYNAMIC = [
  { re: /\$\((?:[^()]|\([^()]*\))*\)/g, reason: "command_substitution" },
  { re: /`[^`]*`/g, reason: "backtick_substitution" },
  { re: /<\((?:[^()]|\([^()]*\))*\)/g, reason: "process_substitution" },
  { re: /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, reason: "variable_expansion" },
] as const
/** Programs that run text as code — the parse says nothing about what runs. */
const INDIRECTION = new Set(["eval", "exec", "source", "."])

const MAX_DEPTH = 3

export interface BashNormalizeOptions {
  /** The tool's own working directory, relative to the workspace. */
  readonly cwd?: string
}

interface Token {
  readonly text: string
  /** True when the token came from a quoted region: its separators are inert. */
  readonly quoted: boolean
}

/** Quote-aware tokenizer. Records whether a token was quoted, because a quoted
 *  `&&` is data and an unquoted one is control flow. */
function tokenize(input: string): Token[] {
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
    if (c === "\\" && i + 1 < input.length) {
      current += input[++i]
      sawAny = true
      // An ESCAPED separator is data. Without this the token `&&` produced by
      // `a \&\& b` is indistinguishable from real control flow, and the guard
      // sees a second command that does not exist.
      quoted = true
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      quoted = true
      sawAny = true
      continue
    }
    if (c === " " || c === "\t") {
      push()
      continue
    }
    // Operators are their own tokens even when glued to a word (`make test;`),
    // otherwise `a; b` parses as one command called `a;` — and a separator that
    // silently vanishes is exactly how a second command hides from the guard.
    const two = input.slice(i, i + 2)
    if (two === "&&" || two === "||" || two === "|&" || two === ">>") {
      push()
      tokens.push({ text: two, quoted: false })
      i++
      continue
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === ">" || c === "<") {
      // Keep an fd prefix attached: `2>` stays `2>`.
      if ((c === ">" || c === "<") && /^\d$/.test(current) && sawAny) {
        tokens.push({ text: current + c, quoted: false })
        current = ""
        sawAny = false
        continue
      }
      push()
      tokens.push({ text: c === "\n" ? ";" : c, quoted: false })
      continue
    }
    current += c
    sawAny = true
  }
  push()
  return tokens
}

/** Operators that separate commands. `|&` and `&` handled with them. */
const SEPARATORS = new Set(["&&", "||", ";", "|", "|&", "&", "\n"])

const isEnvAssignment = (t: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)
const basename = (t: string) => t.replace(/^.*[\\/]/, "").replace(/\.(cmd|exe|bat|ps1)$/i, "").toLowerCase()

interface Segment {
  readonly tokens: Token[]
  readonly background: boolean
}

/** Split the token stream on UNQUOTED separators. */
function segments(tokens: Token[]): Segment[] {
  const out: Segment[] = []
  let current: Token[] = []
  for (const t of tokens) {
    if (!t.quoted && SEPARATORS.has(t.text)) {
      if (current.length > 0) out.push({ tokens: current, background: t.text === "&" })
      current = []
      continue
    }
    current.push(t)
  }
  if (current.length > 0) out.push({ tokens: current, background: false })
  return out
}

/** Join a relative cd onto the accumulated cwd, honouring `..` and absolutes. */
function joinCwd(base: string, dir: string): string {
  if (dir.startsWith("/") || /^[A-Za-z]:/.test(dir)) return dir
  const parts = [...base.split("/").filter(Boolean), ...dir.split("/").filter(Boolean)]
  const out: string[] = []
  for (const p of parts) {
    if (p === ".") continue
    if (p === "..") out.pop()
    else out.push(p)
  }
  return out.join("/")
}

interface ParseState {
  cwd: string
  readonly commands: NormalizedCommand[]
  readonly dynamic: string[]
  readonly reasons: Set<string>
}

/** Collect dynamic constructs from RAW text (quoting does not make them inert
 *  inside double quotes, and we do not try to be clever about which). */
function collectDynamic(raw: string, state: ParseState): void {
  for (const { re, reason } of DYNAMIC) {
    for (const m of raw.matchAll(re)) {
      state.dynamic.push(m[0])
      state.reasons.add(reason)
    }
  }
}

function parseSegment(seg: Segment, state: ParseState, depth: number): void {
  let tokens = seg.tokens
  const env: Record<string, string> = {}
  const redirections: NormalizedCommand["redirections"][number][] = []

  // Redirections are pulled out first so they never look like arguments.
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
    // Attached forms: `>out.txt`
    const attached = !t.quoted ? /^(>>|>|<)(.+)$/.exec(t.text) : null
    if (attached) {
      redirections.push({ kind: attached[1] === "<" ? "in" : attached[1] === ">>" ? "append" : "out", target: attached[2]! })
      continue
    }
    kept.push(t)
  }
  tokens = kept

  // Inline environment assignments precede the program.
  while (tokens.length > 0 && !tokens[0]!.quoted && isEnvAssignment(tokens[0]!.text)) {
    const [name, ...rest] = tokens[0]!.text.split("=")
    env[name!] = rest.join("=")
    tokens = tokens.slice(1)
  }

  for (let guard = 0; guard < 8 && tokens.length > 0; guard++) {
    const head = basename(tokens[0]!.text)

    if (PREFIX_WRAPPERS.has(head)) {
      tokens = tokens.slice(1)
      while (tokens.length > 0 && !tokens[0]!.quoted && isEnvAssignment(tokens[0]!.text)) {
        const [name, ...rest] = tokens[0]!.text.split("=")
        env[name!] = rest.join("=")
        tokens = tokens.slice(1)
      }
      continue
    }

    if (SHELL_WRAPPERS.has(head)) {
      if (depth >= MAX_DEPTH) {
        state.dynamic.push(tokens.map((t) => t.text).join(" "))
        state.reasons.add("nesting_too_deep")
        return
      }
      let i = 1
      while (i < tokens.length) {
        const flag = tokens[i]!.text.toLowerCase()
        if (SCRIPT_FLAGS.has(flag)) {
          // The rest is a command STRING — re-parse it from scratch.
          const inner = tokens.slice(i + 1).map((t) => t.text).join(" ")
          collectDynamic(inner, state)
          for (const s of segments(tokenize(inner))) parseSegment(s, state, depth + 1)
          return
        }
        if (VALUE_FLAGS.has(flag)) i += 2
        else if (flag.startsWith("-") || flag.startsWith("/")) i++
        else break // a script path — its contents are not visible to us
      }
      state.dynamic.push(tokens.map((t) => t.text).join(" "))
      state.reasons.add("opaque_shell_invocation")
      return
    }

    if (INDIRECTION.has(head)) {
      // `eval`/`source` run text we cannot see. Never resolve to a program.
      state.dynamic.push(tokens.map((t) => t.text).join(" "))
      state.reasons.add("indirect_execution")
      return
    }

    if (head === "cd" || head === "pushd") {
      const dir = tokens.slice(1).find((t) => !t.text.startsWith("-"))
      if (dir) state.cwd = joinCwd(state.cwd, dir.text)
      return // `cd` itself is not an operation worth recording
    }

    // A real program.
    state.commands.push({
      program: head,
      argv: tokens.slice(1).map((t) => t.text),
      cwd: state.cwd,
      env,
      redirections,
      background: seg.background,
    })
    return
  }
}

/**
 * Normalize a Bash command line.
 *
 * Everything the parser cannot account for is surfaced, never swallowed: the
 * result is `uncertain` with the offending segments listed and a machine-
 * readable reason for each class.
 */
export function normalizeBash(command: string, options: BashNormalizeOptions = {}): NormalizedOperation {
  const state: ParseState = { cwd: options.cwd ?? "", commands: [], dynamic: [], reasons: new Set() }
  collectDynamic(command, state)
  try {
    for (const seg of segments(tokenize(command))) parseSegment(seg, state, 0)
  } catch (e) {
    state.reasons.add("parser_error")
    state.dynamic.push(command)
    void e
  }
  // A command that resolved to nothing is not "safe", it is unaccounted for.
  if (state.commands.length === 0 && state.dynamic.length === 0) {
    state.reasons.add("no_command_resolved")
    state.dynamic.push(command)
  }
  const certain = state.dynamic.length === 0 && state.reasons.size === 0
  return {
    kind: "shell",
    shell: "bash",
    summary: summarize(state.commands, command),
    certainty: certain ? "parsed" : "uncertain",
    commands: state.commands,
    cwd: state.cwd,
    resources: resourcesOf(state.commands),
    ...(state.dynamic.length > 0 ? { unknownDynamicSegments: state.dynamic } : {}),
    ...(state.reasons.size > 0 ? { uncertainReasons: [...state.reasons].sort() } : {}),
  }
}

/**
 * Resource effects. Redirections are the only thing stage 1 can state honestly,
 * so the analysis is `partial` at best and `unknown` when there is nothing to
 * report — never empty arrays implying "touches nothing". Argument-level reads
 * and writes, and network targets, are CL-05.
 */
function resourcesOf(commands: readonly NormalizedCommand[]): import("@abdo/control-contracts").ResourceAnalysis {
  const writes: string[] = []
  const reads: string[] = []
  for (const c of commands) {
    for (const r of c.redirections) {
      if (r.kind === "in") reads.push(r.target)
      else writes.push(r.target)
    }
  }
  if (writes.length === 0 && reads.length === 0) return { analysis: "unknown" }
  return { analysis: "partial", ...(reads.length > 0 ? { reads } : {}), ...(writes.length > 0 ? { writes } : {}) }
}

function summarize(commands: readonly NormalizedCommand[], raw: string): string {
  if (commands.length === 0) return `shell: ${raw.slice(0, 120)}`
  return commands.map((c) => [c.program, ...c.argv].join(" ")).join(" | ").slice(0, 200)
}
