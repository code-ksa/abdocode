/**
 * CL-11.4E-A — Pipenv install SOURCE classification, from the command alone.
 *
 * Third Python manager, same four layers: classify (this) -> source verifier
 * (`Pipfile` / `Pipfile.lock`: the `_meta.hash` over Pipfile, per-package
 * `hashes`, declared sources) -> target confinement (which virtualenv, or the
 * SYSTEM interpreter) -> enforcement. Only this layer exists, and it is built so
 * it cannot produce a clean verdict.
 *
 * Pipenv's shape, from its command surface:
 *   install   read Pipfile, resolve if needed, write Pipfile.lock, install
 *   sync      install EXACTLY what Pipfile.lock says, no resolution
 *   update    re-resolve and upgrade
 *   lock      regenerate Pipfile.lock only
 *   run/shell run arbitrary commands inside the environment
 *   --deploy         claims to abort when Pipfile.lock is out of date
 *   --ignore-pipfile claims to install from the lock alone
 *   --system         install into the SYSTEM interpreter, no virtualenv at all
 *
 * The claims attached to those flags are exactly that — claims. This layer
 * RECORDS them (`deploy`, `ignorePipfile`, `lockFreshnessEnforced: "unknown"`)
 * and refuses to act on them. 4E-B measures whether they do anything, the same
 * way `--no-root` was measured for Poetry and turned out not to mean what the
 * name suggests.
 *
 * Pure and command-only: it reports, the PDP enforces.
 */
import type { NormalizedCommand } from "@abdo/control-contracts"

export interface PipenvInstallSourceAssessment {
  readonly isInstall: boolean
  readonly verb?: string
  /** Does the verb re-resolve and REWRITE `Pipfile.lock`? */
  readonly resolvesDependencies: boolean
  /** `--deploy` present — CLAIMS to abort on a stale lock. */
  readonly deploy: boolean
  /** `--ignore-pipfile` present — CLAIMS to install from the lock alone. */
  readonly ignorePipfile: boolean
  /**
   * Is lock freshness actually ENFORCED by this command? `unknown` until 4E-B
   * measures it — a flag's name is not evidence.
   */
  readonly lockFreshnessEnforced: "yes" | "no" | "unknown"
  /** `--system` — installs into the system interpreter, not a virtualenv. */
  readonly systemInstall: boolean
  /** Does third-party build code run? `unknown` until measured. */
  readonly buildExecution: "yes" | "no" | "unknown"
  readonly blockers: readonly string[]
}

const PIPENV_VERBS = new Set([
  "install", "sync", "update", "lock", "uninstall", "run", "shell",
  "requirements", "graph", "check", "clean", "scripts", "verify", "open",
])
/** Verbs that re-resolve and rewrite the lockfile. */
const RESOLVING = new Set(["install", "update", "lock"])
/** Verbs that place packages into an environment. */
const INSTALLING = new Set(["install", "sync"])
/** Verbs that run whatever the caller wants inside the environment. */
const EXECUTING = new Set(["run", "shell", "open"])

const NONE: PipenvInstallSourceAssessment = {
  isInstall: false,
  resolvesDependencies: false,
  deploy: false,
  ignorePipfile: false,
  lockFreshnessEnforced: "unknown",
  systemInstall: false,
  buildExecution: "unknown",
  blockers: [],
}

/** Pipenv's argv, or undefined for a non-pipenv command. */
function pipenvArgv(command: NormalizedCommand): readonly string[] | undefined {
  const base = command.program.toLowerCase().replace(/\.(exe|cmd|bat)$/i, "").replace(/^.*[/\\]/, "")
  if (base === "pipenv") return command.argv
  if (/^python[0-9.]*$/.test(base)) {
    const mi = command.argv.indexOf("-m")
    if (mi >= 0 && command.argv[mi + 1]?.toLowerCase() === "pipenv") return command.argv.slice(mi + 2)
  }
  return undefined
}

function assessOne(command: NormalizedCommand): PipenvInstallSourceAssessment {
  const argv = pipenvArgv(command)
  if (!argv) return NONE
  const verb = argv.find((a) => !a.startsWith("-"))?.toLowerCase()
  if (!verb || !PIPENV_VERBS.has(verb)) return { ...NONE, ...(verb ? { verb } : {}) }

  const flags = argv.filter((a) => a.startsWith("-")).map((a) => a.toLowerCase())
  const has = (...names: string[]) => names.some((n) => flags.includes(n) || flags.some((f) => f.startsWith(`${n}=`)))
  const blockers: string[] = []

  if (EXECUTING.has(verb)) {
    blockers.push("pipenv_executes_arbitrary_code")
    return { ...NONE, verb, blockers }
  }

  const resolvesDependencies = RESOLVING.has(verb)
  if (resolvesDependencies) blockers.push("pipenv_resolves_and_rewrites_lock")

  const deploy = has("--deploy")
  const ignorePipfile = has("--ignore-pipfile")

  // MEASURED 4E-B (Pipenv 2023.12.1) — and unlike Poetry's `--no-root`, this
  // flag does what its name says:
  //   `install --deploy` on a stale lock -> rc=2, "Your Pipfile.lock (448457)
  //     is out of date. Expected: (2110f5). ERROR:: Aborting deploy"
  //   `install` without it   -> rc=0 and it SILENTLY RE-LOCKS
  //     ("Pipfile.lock out of date, updating to ...")
  //   `sync` on a stale lock -> rc=0, installs the LOCK's versions and never
  //     looks at the Pipfile
  //   `sync --deploy`        -> rc=2, "No such option: --deploy"
  // So freshness is enforced ONLY by `install --deploy`. That is the awkward
  // part: the one verb that checks freshness is also the one that re-resolves
  // when the check is absent.
  const lockFreshnessEnforced: "yes" | "no" | "unknown" =
    verb === "install" && deploy ? "yes" : INSTALLING.has(verb) ? "no" : "unknown"
  if (verb === "sync" && deploy) blockers.push("pipenv_sync_rejects_deploy")
  if (INSTALLING.has(verb) && lockFreshnessEnforced === "no") blockers.push("pipenv_lock_freshness_not_enforced")

  // `--system` skips the virtualenv entirely and writes to the interpreter
  // Pipenv happens to be running under — the widest possible destination.
  const systemInstall = has("--system")
  if (systemInstall) blockers.push("pipenv_system_install")

  // Pipenv chooses its virtualenv from configuration (PIPENV_VENV_IN_PROJECT, a
  // WORKON_HOME/data dir, or an already-active VIRTUAL_ENV). None of that is on
  // the command line, so the destination cannot be confined from the command.
  if (INSTALLING.has(verb) && !systemInstall) blockers.push("pipenv_env_unresolved")

  // MEASURED 4E-B: a wheel-only Pipfile ran NO build code, while path, editable
  // path, sdist and git dependencies ALL executed their `setup.py`. So whether a
  // build runs is a property of the Pipfile, which this command-only layer
  // cannot read — `unknown` is the honest answer here, and the file verifier
  // will settle it. What IS measured is that NO command flag prevents it: there
  // is no `--only-binary` equivalent, so the blocker is unconditional.
  const buildExecution: "yes" | "no" | "unknown" = "unknown"
  if (INSTALLING.has(verb)) blockers.push("build_may_execute")

  // Nothing auto-allows while the source verifier and target confinement do not
  // exist. Removed by a later slice, not before.
  if (INSTALLING.has(verb) || resolvesDependencies) blockers.push("pipenv_verifier_not_implemented")

  return {
    isInstall: INSTALLING.has(verb),
    verb,
    resolvesDependencies,
    deploy,
    ignorePipfile,
    lockFreshnessEnforced,
    systemInstall,
    buildExecution,
    blockers,
  }
}

/** Worst-wins across a compound command, as the pip and Poetry assessors do. */
export function assessPipenvInstallSource(commands: readonly NormalizedCommand[]): PipenvInstallSourceAssessment {
  const seen = commands.map(assessOne).filter((a) => a.verb !== undefined)
  if (seen.length === 0) return NONE
  const installs = seen.filter((a) => a.isInstall)
  const primary = installs[0] ?? seen[0]!
  const order = { no: 0, unknown: 1, yes: 2 } as const
  const worst = (pick: (a: PipenvInstallSourceAssessment) => "yes" | "no" | "unknown") =>
    seen.reduce<"yes" | "no" | "unknown">((w, a) => (order[pick(a)] >= order[w] ? pick(a) : w), "no")

  return {
    isInstall: installs.length > 0,
    ...(primary.verb ? { verb: primary.verb } : {}),
    resolvesDependencies: seen.some((a) => a.resolvesDependencies),
    deploy: seen.every((a) => a.deploy),
    ignorePipfile: seen.some((a) => a.ignorePipfile),
    lockFreshnessEnforced: worst((a) => a.lockFreshnessEnforced),
    systemInstall: seen.some((a) => a.systemInstall),
    buildExecution: worst((a) => a.buildExecution),
    blockers: [...new Set(seen.flatMap((a) => a.blockers))],
  }
}
