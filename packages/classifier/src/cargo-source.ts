/**
 * CL-11.5A — Cargo command classification, from the command alone.
 *
 * Cargo differs from every Python manager already modelled in one decisive way:
 * **installing and building are the same act**. There is no "fetch the wheels
 * and unpack them" path — a dependency arrives as SOURCE and is compiled, and
 * compilation is arbitrary code execution by design:
 *
 *   - `build.rs` build scripts run as native programs at build time,
 *   - proc-macro crates run inside the compiler at compile time,
 *   - `RUSTC_WRAPPER` / `RUSTC` / `CARGO_TARGET_*_LINKER` / `CARGO_TARGET_*_RUNNER`
 *     name programs Cargo will execute,
 *   - a project-local `.cargo/config.toml` can set all of those.
 *
 * So the interesting question is not "does code run" — it does — but WHOSE code,
 * from WHERE, and with WHAT pinned. This layer answers only what the command
 * text can support; everything about actual behaviour is `unknown` until 4-B's
 * measurement, per CL-11's standing rule.
 *
 * Pure and command-only: it reports, the PDP enforces.
 */
import type { NormalizedCommand } from "@abdo/control-contracts"

export interface CargoAssessment {
  readonly isCargo: boolean
  readonly verb?: string
  /** Does this verb compile anything (build scripts + proc macros can run)? */
  readonly compiles: boolean
  /** Does this verb run project or dependency code as a program? */
  readonly executes: boolean
  /** Does it re-resolve and rewrite `Cargo.lock`? */
  readonly resolvesDependencies: boolean
  /** Does it publish or otherwise reach outward? */
  readonly outward: boolean
  /** `--locked` present — CLAIMS the lockfile may not change. */
  readonly locked: boolean
  /** `--offline` present — CLAIMS no network access. */
  readonly offline: boolean
  /** `--frozen` present — documented as `--locked --offline`. */
  readonly frozen: boolean
  /** Is lockfile immutability actually ENFORCED? `unknown` until measured. */
  readonly lockImmutabilityEnforced: "yes" | "no" | "unknown"
  /** Is network access actually PREVENTED? `unknown` until measured. */
  readonly networkPrevented: "yes" | "no" | "unknown"
  /** An explicit `--target-dir`, when given. */
  readonly targetDir?: string
  /** `--features` / `--all-features` widen what gets compiled. */
  readonly widensFeatures: boolean
  readonly blockers: readonly string[]
}

/** Verbs that invoke the compiler, so build scripts and proc macros can run. */
const COMPILING = new Set(["build", "b", "check", "c", "test", "t", "bench", "run", "r", "install", "doc", "rustc", "clippy", "fix"])
/** Verbs that execute produced or dependency binaries. */
const EXECUTING = new Set(["run", "r", "test", "t", "bench", "install"])
/** Verbs that re-resolve and may rewrite `Cargo.lock`. */
const RESOLVING = new Set(["update", "add", "remove", "generate-lockfile"])
/** Verbs that reach outward. */
const OUTWARD = new Set(["publish", "yank", "owner", "login", "logout"])
/** Everything else we recognise, so an unknown verb stays unknown. */
const OTHER = new Set(["fetch", "clean", "vendor", "tree", "metadata", "init", "new", "search", "package", "fmt", "version", "help", "locate-project", "pkgid", "verify-project", "report"])

const NONE: CargoAssessment = {
  isCargo: false,
  compiles: false,
  executes: false,
  resolvesDependencies: false,
  outward: false,
  locked: false,
  offline: false,
  frozen: false,
  lockImmutabilityEnforced: "unknown",
  networkPrevented: "unknown",
  widensFeatures: false,
  blockers: [],
}

/** Cargo's argv, or undefined for a non-cargo command. */
function cargoArgv(command: NormalizedCommand): readonly string[] | undefined {
  const base = command.program.toLowerCase().replace(/\.(exe|cmd|bat)$/i, "").replace(/^.*[/\\]/, "")
  if (base === "cargo") return command.argv
  // `rustup run <toolchain> cargo …` reaches the same place by another road.
  if (base === "rustup") {
    const i = command.argv.findIndex((a) => a.toLowerCase() === "cargo")
    if (i >= 0) return command.argv.slice(i + 1)
  }
  return undefined
}

function assessOne(command: NormalizedCommand): CargoAssessment {
  const argv = cargoArgv(command)
  if (!argv) return NONE
  // `+nightly` style toolchain overrides come before the verb.
  const verb = argv.find((a) => !a.startsWith("-") && !a.startsWith("+"))?.toLowerCase()
  if (!verb) return { ...NONE, isCargo: true, blockers: ["cargo_verb_unknown"] }

  const flags = argv.filter((a) => a.startsWith("-")).map((a) => a.toLowerCase())
  const has = (...names: string[]) => names.some((n) => flags.includes(n) || flags.some((f) => f.startsWith(`${n}=`)))
  const blockers: string[] = []

  const known = COMPILING.has(verb) || RESOLVING.has(verb) || OUTWARD.has(verb) || OTHER.has(verb)
  if (!known) blockers.push(`cargo_verb_unmodelled:${verb}`)

  // A `+toolchain` override picks a different compiler entirely.
  const toolchainOverride = argv.find((a) => a.startsWith("+"))
  if (toolchainOverride) blockers.push(`cargo_toolchain_override:${toolchainOverride.slice(1)}`)

  const frozen = has("--frozen")
  const locked = has("--locked") || frozen
  const offline = has("--offline") || frozen

  // Both are CLAIMS made by flag names. Poetry's `--no-root` did not mean what
  // it sounded like; nothing is believed here until 4-B measures it.
  const lockImmutabilityEnforced: "yes" | "no" | "unknown" = "unknown"
  const networkPrevented: "yes" | "no" | "unknown" = "unknown"

  const compiles = COMPILING.has(verb)
  const executes = EXECUTING.has(verb)
  const resolvesDependencies = RESOLVING.has(verb)
  const outward = OUTWARD.has(verb)

  // Compiling IS execution in Cargo: build.rs runs as a native program and
  // proc-macro crates run inside rustc. There is no flag that turns that off,
  // so this is unconditional for every compiling verb.
  if (compiles) blockers.push("cargo_build_scripts_may_execute", "cargo_proc_macros_may_execute")
  if (executes) blockers.push("cargo_executes_built_binaries")
  if (resolvesDependencies) blockers.push("cargo_resolves_and_rewrites_lock")
  if (outward) blockers.push(`cargo_outward_operation:${verb}`)
  if (verb === "install") blockers.push("cargo_install_writes_outside_workspace")

  if (compiles || resolvesDependencies) {
    if (!locked) blockers.push("cargo_lock_may_change")
    if (!offline) blockers.push("cargo_network_allowed")
  }

  // `.cargo/config.toml`, RUSTC_WRAPPER, RUSTFLAGS and linker/runner settings
  // all name programs Cargo will execute, and none of them appear in argv.
  if (compiles) blockers.push("cargo_toolchain_config_unresolved")

  let targetDir: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--target-dir") { targetDir = argv[i + 1]; break }
    if (a.startsWith("--target-dir=")) { targetDir = a.slice("--target-dir=".length); break }
  }
  const widensFeatures = has("--features", "-F", "--all-features")

  if (compiles || resolvesDependencies) blockers.push("cargo_verifier_not_implemented")

  return {
    isCargo: true, verb, compiles, executes, resolvesDependencies, outward,
    locked, offline, frozen, lockImmutabilityEnforced, networkPrevented,
    ...(targetDir !== undefined ? { targetDir } : {}),
    widensFeatures, blockers,
  }
}

/** Worst-wins across a compound command. */
export function assessCargo(commands: readonly NormalizedCommand[]): CargoAssessment {
  const seen = commands.map(assessOne).filter((a) => a.isCargo)
  if (seen.length === 0) return NONE
  const primary = seen.find((a) => a.compiles) ?? seen[0]!
  const order = { no: 0, unknown: 1, yes: 2 } as const
  const worst = (pick: (a: CargoAssessment) => "yes" | "no" | "unknown") =>
    seen.reduce<"yes" | "no" | "unknown">((w, a) => (order[pick(a)] >= order[w] ? pick(a) : w), "no")

  return {
    isCargo: true,
    ...(primary.verb ? { verb: primary.verb } : {}),
    compiles: seen.some((a) => a.compiles),
    executes: seen.some((a) => a.executes),
    resolvesDependencies: seen.some((a) => a.resolvesDependencies),
    outward: seen.some((a) => a.outward),
    locked: seen.every((a) => a.locked),
    offline: seen.every((a) => a.offline),
    frozen: seen.every((a) => a.frozen),
    lockImmutabilityEnforced: worst((a) => a.lockImmutabilityEnforced),
    networkPrevented: worst((a) => a.networkPrevented),
    ...(primary.targetDir !== undefined ? { targetDir: primary.targetDir } : {}),
    widensFeatures: seen.some((a) => a.widensFeatures),
    blockers: [...new Set(seen.flatMap((a) => a.blockers))],
  }
}
