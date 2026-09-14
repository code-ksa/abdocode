/**
 * CL-11 — JS install SOURCE & INTEGRITY, from the command alone.
 *
 * Lifecycle suppression stops code at install time; it says nothing about where
 * the packages come from or whether the resolution is pinned. Those are the
 * supply-chain questions, and they decide whether an install may auto-allow at
 * all:
 *
 *   - `npm ci` reproduces the lockfile EXACTLY and fails when the lockfile is
 *     missing or out of sync — npm enforces this, so the `ci` verb is itself the
 *     lockfile-integrity guarantee. `install`/`i`/`add`/`update` RESOLVE new
 *     versions and rewrite the lockfile: a supply-chain change, not a
 *     reproduction.
 *   - a custom `--registry`, an inline `npm_config_registry`, or a git/URL/
 *     tarball/shorthand spec pulls from a source the default registry did not
 *     vet.
 *
 * Pure and command-only. It reports; the PDP turns anything but the
 * deterministic, default-source subset into `ask`.
 *
 * LIMIT stated, not hidden: this sees the COMMAND, not the workspace. A git
 * dependency baked into the lockfile, or a registry set in `.npmrc`, is a
 * FILESYSTEM fact and is out of this module's reach — it belongs to a host-side
 * integrity check (the next step of this sub-slice), and until that lands the
 * deterministic subset is "clean as far as the command shows", never a proof
 * that the lockfile's own contents are registry-only.
 */
import type { NormalizedCommand } from "@abdo/control-contracts"

export interface InstallSourceAssessment {
  /** This command performs a package install of a modelled JS manager. */
  readonly isInstall: boolean
  /** The `ci` form: reproduces the lockfile, fails if it is missing/mismatched. */
  readonly deterministic: boolean
  /** `install`/`add`/`update` resolve new versions and rewrite the lockfile. */
  readonly mutatesLockfile: boolean
  /** A registry other than the default was named (`--registry` / env). */
  readonly customRegistry: boolean
  /** A dependency spec that is not a plain registry package (git/url/tarball/…). */
  readonly nonRegistrySource: boolean
  /** `--offline` / `--prefer-offline` / `--frozen-lockfile` present. */
  readonly offline: boolean
  /** The manager, when recognised. */
  readonly manager?: string
  /** Machine-readable reasons this is not the clean deterministic subset. */
  readonly blockers: readonly string[]
}

/** JS managers whose install source this module reasons about. */
const JS_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"])
/** Verbs that RESOLVE and rewrite the lockfile (not a deterministic reproduce). */
const RESOLVING_VERBS = new Set(["install", "i", "add", "update", "up", "upgrade"])
/** The deterministic, lockfile-pinned install verbs, per manager spelling. */
const DETERMINISTIC_VERBS = new Set(["ci", "install-frozen-lockfile"])
const OFFLINE_FLAGS = new Set(["--offline", "--prefer-offline", "--frozen-lockfile"])
const REGISTRY_FLAGS = new Set(["--registry"])

const words = (argv: readonly string[]) => argv.filter((a) => !a.startsWith("-") && !/^\/[A-Za-z?]/.test(a)).map((a) => a.toLowerCase())

/** Does a dependency argument name a source other than a registry package? */
function isNonRegistrySpec(arg: string): boolean {
  // git+…, https://…, http://…, git://, ssh://, a .tgz/.tar.gz tarball,
  // `github:`/`gitlab:`/`bitbucket:`/`file:`/`link:` protocols, and the bare
  // `user/repo` GitHub shorthand.
  if (/^(git\+|git:|ssh:|https?:)/i.test(arg)) return true
  if (/\.(tgz|tar\.gz)$/i.test(arg)) return true
  if (/^(github|gitlab|bitbucket|file|link|git):/i.test(arg)) return true
  if (/^[\w.-]+\/[\w.-]+$/.test(arg) && !arg.startsWith("@")) return true // user/repo shorthand
  return false
}

/** Assess ONE resolved command. */
function assessOne(command: NormalizedCommand): InstallSourceAssessment {
  const program = command.program.toLowerCase()
  const none: InstallSourceAssessment = {
    isInstall: false, deterministic: false, mutatesLockfile: false,
    customRegistry: false, nonRegistrySource: false, offline: false, blockers: [],
  }
  if (!JS_MANAGERS.has(program)) return none
  const verbs = words(command.argv)
  const verb = verbs[0]
  const bareInstalls = program === "yarn" && verb === undefined
  const isResolving = (verb !== undefined && RESOLVING_VERBS.has(verb)) || bareInstalls
  const isDeterministic = verb !== undefined && DETERMINISTIC_VERBS.has(verb)
  if (!isResolving && !isDeterministic) return { ...none, manager: program }

  const blockers: string[] = []
  const mutatesLockfile = isResolving
  if (mutatesLockfile) blockers.push("resolves_and_mutates_lockfile")

  const customRegistry =
    command.argv.some((a, i) => REGISTRY_FLAGS.has(a) || a.startsWith("--registry=")) ||
    Object.keys(command.env).some((k) => k.toLowerCase() === "npm_config_registry")
  if (customRegistry) blockers.push("custom_registry")

  // Dependency args are the non-flag words after the verb.
  const nonRegistrySource = verbs.slice(1).some(isNonRegistrySpec) || command.argv.slice(1).some((a) => !a.startsWith("-") && isNonRegistrySpec(a))
  if (nonRegistrySource) blockers.push("non_registry_source")

  const offline = command.argv.some((a) => OFFLINE_FLAGS.has(a))

  return {
    isInstall: true,
    deterministic: isDeterministic && !mutatesLockfile,
    mutatesLockfile,
    customRegistry,
    nonRegistrySource,
    offline,
    manager: program,
    blockers,
  }
}

/** Worst-wins across a compound command: any install member's blockers count,
 *  and a chain is an install if any member is. */
export function assessInstallSource(commands: readonly NormalizedCommand[]): InstallSourceAssessment {
  const installs = commands.map(assessOne).filter((a) => a.isInstall)
  if (installs.length === 0) {
    return { isInstall: false, deterministic: false, mutatesLockfile: false, customRegistry: false, nonRegistrySource: false, offline: false, blockers: [] }
  }
  const blockers = [...new Set(installs.flatMap((a) => a.blockers))]
  return {
    isInstall: true,
    // Deterministic only if EVERY install member is (one resolving member dirties it).
    deterministic: installs.every((a) => a.deterministic),
    mutatesLockfile: installs.some((a) => a.mutatesLockfile),
    customRegistry: installs.some((a) => a.customRegistry),
    nonRegistrySource: installs.some((a) => a.nonRegistrySource),
    offline: installs.every((a) => a.offline),
    manager: installs[0]!.manager,
    blockers,
  }
}
