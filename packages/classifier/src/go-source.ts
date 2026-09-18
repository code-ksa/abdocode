/**
 * CL-11.6A — Go command classification, from the command alone.
 *
 * Go's surface is unusual in two ways that matter here.
 *
 * First, the split between "read about the module graph" and "compile and run
 * it" is real — `go mod verify`, `go list` and `go mod download` plausibly touch
 * no project code — which is the opposite of Cargo, where even `check` executes
 * dependency code. Whether that promise holds is exactly what 6A measures; this
 * layer records the shape and believes nothing.
 *
 * Second, Go has an unusually large set of ENVIRONMENT-shaped execution and
 * routing surfaces that never appear in argv: `GOFLAGS` injects flags into every
 * invocation, `-toolexec`/`-exec` name programs the toolchain runs, `CC`/`CXX`
 * pick a compiler for cgo, `GOPROXY`/`GOSUMDB`/`GOPRIVATE`/`GOINSECURE` decide
 * where modules come from and whether they are checked, and `GOTOOLCHAIN` can
 * make Go DOWNLOAD AND RUN A DIFFERENT TOOLCHAIN. `go env -w` writes a
 * persistent global config file that changes all of the above for every later
 * run — a durable, machine-wide side effect from an innocuous-looking command.
 *
 * Pure and command-only: it reports, the PDP enforces. Behavioural claims are
 * `unknown` until the measurement half settles them.
 */
import type { NormalizedCommand } from "@abdo/control-contracts"

export interface GoAssessment {
  readonly isGo: boolean
  /** `build`, `mod download`, `env -w`, … — the sub-command as written. */
  readonly verb?: string
  /** Does it compile project or dependency code? */
  readonly compiles: boolean
  /** Does it run project code (tests, main, generate directives)? */
  readonly executesProjectCode: boolean
  /** Does it write `go.mod` / `go.sum` / `vendor/`? */
  readonly mutatesModuleFiles: boolean
  /** `go env -w` / `go clean -modcache`: durable, outside the workspace. */
  readonly mutatesGlobalState: boolean
  /** `-mod=` as written: readonly | vendor | mod | undefined. */
  readonly modMode?: string
  /** Is module-file immutability actually ENFORCED? `unknown` until measured. */
  readonly moduleImmutabilityEnforced: "yes" | "no" | "unknown"
  /** Is network access actually PREVENTED? `unknown` until measured. */
  readonly networkPrevented: "yes" | "no" | "unknown"
  /** Flags that name a program the toolchain will execute. */
  readonly executionFlags: readonly string[]
  /** An explicit `-o` output path, when given. */
  readonly outputPath?: string
  readonly blockers: readonly string[]
}

/** Sub-commands that invoke the compiler. */
const COMPILING = new Set(["build", "test", "run", "install", "vet", "generate"])
/** Sub-commands that run project code. */
const EXECUTING = new Set(["test", "run", "generate"])
/** Sub-commands that can rewrite go.mod / go.sum / vendor. */
const MUTATING = new Set(["get", "tidy", "vendor", "work"])
/** Read-shaped sub-commands — the 6A measurement decides if that is true. */
const READ_SHAPED = new Set(["list", "env", "version", "verify", "download", "why", "graph", "fmt", "doc"])

/** Flags whose VALUE is a program the toolchain executes. */
const EXEC_FLAGS = ["-toolexec", "-exec"] as const

const NONE: GoAssessment = {
  isGo: false,
  compiles: false,
  executesProjectCode: false,
  mutatesModuleFiles: false,
  mutatesGlobalState: false,
  moduleImmutabilityEnforced: "unknown",
  networkPrevented: "unknown",
  executionFlags: [],
  blockers: [],
}

function goArgv(command: NormalizedCommand): readonly string[] | undefined {
  const base = command.program.toLowerCase().replace(/\.(exe|cmd|bat)$/i, "").replace(/^.*[/\\]/, "")
  if (base === "go") return command.argv
  if (base === "gofmt") return ["fmt"] // a separate binary, same intent
  return undefined
}

function assessOne(command: NormalizedCommand): GoAssessment {
  const argv = goArgv(command)
  if (!argv) return NONE
  const positional = argv.filter((a) => !a.startsWith("-"))
  const head = positional[0]?.toLowerCase()
  if (!head) return { ...NONE, isGo: true, blockers: ["go_verb_unknown"] }

  // `go mod <sub>`, `go work <sub>`, `go tool <name>` are two-word verbs.
  const sub = positional[1]?.toLowerCase()
  const verb = (head === "mod" || head === "work" || head === "tool") && sub ? `${head} ${sub}` : head

  const flags = argv.filter((a) => a.startsWith("-"))
  const flagNames = flags.map((f) => f.split("=")[0]!.toLowerCase())
  const hasFlag = (n: string) => flagNames.includes(n)
  const blockers: string[] = []

  // `go tool <anything>` runs a toolchain program directly — compile, link,
  // objdump, or an arbitrary installed tool.
  if (head === "tool") blockers.push(`go_tool_direct_invocation:${sub ?? "?"}`)

  const compiles = COMPILING.has(head)
  const executesProjectCode = EXECUTING.has(head)
  const mutatesModuleFiles = MUTATING.has(head) || verb === "mod tidy" || verb === "mod vendor" || head === "get"
  // `go env -w` writes Go's PERSISTENT global config; `go clean -modcache`
  // deletes a cache shared with everything else on the machine.
  const mutatesGlobalState = (verb === "env" && (hasFlag("-w") || hasFlag("-u"))) || (head === "clean" && hasFlag("-modcache"))

  if (compiles) blockers.push("go_compiles_code")
  if (executesProjectCode) blockers.push("go_executes_project_code")
  if (head === "generate") blockers.push("go_generate_runs_directives")
  if (head === "install") blockers.push("go_install_writes_gobin")
  if (mutatesModuleFiles) blockers.push("go_mutates_module_files")
  if (mutatesGlobalState) blockers.push("go_mutates_global_state")

  // -mod= decides whether go.mod/go.sum may be rewritten. Recorded, not believed.
  const modFlag = flags.find((f) => f.startsWith("-mod="))
  const modMode = modFlag?.slice("-mod=".length).toLowerCase()
  const moduleImmutabilityEnforced: "yes" | "no" | "unknown" = "unknown"
  const networkPrevented: "yes" | "no" | "unknown" = "unknown"
  if (modMode === "mod") blockers.push("go_mod_mode_writable")

  // Flags that name a program to execute, plus overlay which rewrites the file
  // the toolchain sees without touching the disk.
  const executionFlags: string[] = []
  for (const f of EXEC_FLAGS) if (hasFlag(f)) { executionFlags.push(f); blockers.push(`go_exec_flag:${f.slice(1)}`) }
  if (hasFlag("-overlay")) blockers.push("go_overlay_rewrites_sources")
  if (hasFlag("-modfile")) blockers.push("go_alternate_modfile")
  if (hasFlag("-buildmode")) blockers.push("go_buildmode_set")

  let outputPath: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-o") { outputPath = argv[i + 1]; break }
    if (argv[i]!.startsWith("-o=")) { outputPath = argv[i]!.slice(3); break }
  }

  // Everything that routes modules or names a compiler lives in the ENVIRONMENT,
  // never in argv: GOFLAGS, GOPROXY, GOSUMDB, GOPRIVATE, GOINSECURE, GONOSUMDB,
  // GOTOOLCHAIN, CC, CXX, CGO_ENABLED, GOWORK. A command-only layer cannot see
  // any of them, so it must say so rather than imply the command is the whole
  // story.
  blockers.push("go_environment_surface_unresolved")

  // For `go mod download` / `go work sync` the recognisable word is the SUB,
  // not the head — `mod` alone says nothing about what will happen.
  const shapeWord = (head === "mod" || head === "work") && sub ? sub : head
  const recognised =
    COMPILING.has(head) || MUTATING.has(head) || READ_SHAPED.has(shapeWord) ||
    MUTATING.has(shapeWord) || head === "clean" || head === "tool"

  // GOTOOLCHAIN can make Go fetch and run a DIFFERENT toolchain entirely, so it
  // is unresolved for anything that actually engages the toolchain.
  if (recognised && head !== "tool") blockers.push("go_toolchain_selection_unresolved")
  if (!recognised) blockers.push(`go_verb_unmodelled:${verb}`)
  blockers.push("go_verifier_not_implemented")

  return {
    isGo: true, verb, compiles, executesProjectCode, mutatesModuleFiles, mutatesGlobalState,
    ...(modMode ? { modMode } : {}),
    moduleImmutabilityEnforced, networkPrevented, executionFlags,
    ...(outputPath !== undefined ? { outputPath } : {}),
    blockers,
  }
}

/** Worst-wins across a compound command. */
export function assessGo(commands: readonly NormalizedCommand[]): GoAssessment {
  const seen = commands.map(assessOne).filter((a) => a.isGo)
  if (seen.length === 0) return NONE
  const primary = seen.find((a) => a.compiles) ?? seen[0]!
  const order = { no: 0, unknown: 1, yes: 2 } as const
  const worst = (pick: (a: GoAssessment) => "yes" | "no" | "unknown") =>
    seen.reduce<"yes" | "no" | "unknown">((w, a) => (order[pick(a)] >= order[w] ? pick(a) : w), "no")

  return {
    isGo: true,
    ...(primary.verb ? { verb: primary.verb } : {}),
    compiles: seen.some((a) => a.compiles),
    executesProjectCode: seen.some((a) => a.executesProjectCode),
    mutatesModuleFiles: seen.some((a) => a.mutatesModuleFiles),
    mutatesGlobalState: seen.some((a) => a.mutatesGlobalState),
    ...(primary.modMode ? { modMode: primary.modMode } : {}),
    moduleImmutabilityEnforced: worst((a) => a.moduleImmutabilityEnforced),
    networkPrevented: worst((a) => a.networkPrevented),
    executionFlags: [...new Set(seen.flatMap((a) => a.executionFlags))],
    ...(primary.outputPath !== undefined ? { outputPath: primary.outputPath } : {}),
    blockers: [...new Set(seen.flatMap((a) => a.blockers))],
  }
}
