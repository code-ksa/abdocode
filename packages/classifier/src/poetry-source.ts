/**
 * CL-11.4D-A — Poetry install SOURCE classification, from the command alone.
 *
 * Poetry is the second Python manager, and it gets the same 4-layer treatment
 * pip got: classify (this file) -> source verifier (`poetry.lock` content-hash,
 * per-package hashes, `[[tool.poetry.source]]` repositories) -> target
 * confinement (which virtualenv it writes to) -> enforcement. Only the first
 * layer exists so far, and it deliberately cannot produce a clean verdict.
 *
 * HONESTY CONSTRAINT. Poetry is not installed on either platform this was
 * written on, so nothing here claims measured runtime behaviour. CL-11's
 * suppression measurement set the rule and it applies unchanged: an unmeasured
 * property is `unknown`, never `no`. The things that need a real Poetry —
 * whether `--no-root` truly avoids every build backend, where the virtualenv
 * lands under each `virtualenvs.*` setting, whether any flag suppresses
 * dependency build execution — are 4D-B, and until then this layer emits
 * `poetry_verifier_not_implemented` so no Poetry command can reach auto-allow
 * by accident.
 *
 * Pure and command-only: it reports, the PDP enforces.
 */
import type { NormalizedCommand } from "@abdo/control-contracts"

export interface PoetryInstallSourceAssessment {
  readonly isInstall: boolean
  readonly verb?: string
  /** Does the verb re-resolve and REWRITE `poetry.lock`? (`add`/`update`/`lock`) */
  readonly resolvesDependencies: boolean
  /** Does it build+install the ROOT project (its build backend runs)? */
  readonly installsRootProject: "yes" | "no" | "unknown"
  /** Does third-party build code run? `unknown` until measured with a real Poetry. */
  readonly buildExecution: "yes" | "no" | "unknown"
  /** Extras/groups pull in more than the default set. */
  readonly widensDependencySet: boolean
  readonly target: {
    /** An interpreter named on the command (`poetry env use <python>`). */
    readonly interpreter?: string
  }
  readonly blockers: readonly string[]
}

const POETRY_VERBS = new Set(["install", "add", "update", "lock", "sync", "run", "env", "build", "publish", "remove"])
/** Verbs that re-resolve and rewrite the lockfile. */
const RESOLVING = new Set(["add", "update", "lock"])
/** Verbs that place packages into an environment. */
const INSTALLING = new Set(["install", "add", "sync"])

const NONE: PoetryInstallSourceAssessment = {
  isInstall: false,
  resolvesDependencies: false,
  installsRootProject: "unknown",
  buildExecution: "unknown",
  widensDependencySet: false,
  target: {},
  blockers: [],
}

/** Poetry's argv, or undefined for a non-poetry command. */
function poetryArgv(command: NormalizedCommand): readonly string[] | undefined {
  const program = command.program
  const base = program.toLowerCase().replace(/\.(exe|cmd|bat)$/i, "").replace(/^.*[/\\]/, "")
  if (base === "poetry") return command.argv
  // `python -m poetry …` — the module form.
  if (/^python[0-9.]*$/.test(base)) {
    const mi = command.argv.indexOf("-m")
    if (mi >= 0 && command.argv[mi + 1]?.toLowerCase() === "poetry") return command.argv.slice(mi + 2)
  }
  return undefined
}

function assessOne(command: NormalizedCommand): PoetryInstallSourceAssessment {
  const argv = poetryArgv(command)
  if (!argv) return NONE
  const verb = argv.find((a) => !a.startsWith("-"))?.toLowerCase()
  if (!verb || !POETRY_VERBS.has(verb)) return { ...NONE, ...(verb ? { verb } : {}) }

  const flags = argv.filter((a) => a.startsWith("-")).map((a) => a.toLowerCase())
  const has = (...names: string[]) => names.some((n) => flags.includes(n) || flags.some((f) => f.startsWith(`${n}=`)))
  const blockers: string[] = []

  // `poetry run` is not an install at all — it is an execution surface, and a
  // large one: it runs whatever follows inside the project environment.
  if (verb === "run") {
    blockers.push("poetry_run_executes_arbitrary_code")
    return { ...NONE, verb, blockers }
  }

  // `poetry env use <python>` changes which environment every later command
  // targets.
  //
  // MEASURED 4D-B: it does NOT adopt the venv you point it at. Given
  // `<somewhere>/bin/python` it selected that INTERPRETER VERSION and then
  // created its own environment in the cache
  // (`Creating virtualenv …-py3.12 in …/cache/virtualenvs`). 4D-A implied the
  // named path becomes the target; it does not — so the interpreter is recorded
  // as a version selector, and the destination stays unresolved.
  if (verb === "env") {
    const i = argv.indexOf("use")
    const interpreter = i >= 0 ? argv[i + 1] : undefined
    blockers.push("poetry_env_mutation")
    return { ...NONE, verb, ...(interpreter ? { target: { interpreter } } : {}), blockers }
  }

  const resolvesDependencies = RESOLVING.has(verb)
  if (resolvesDependencies) blockers.push("poetry_resolves_and_rewrites_lock")

  // The root project is installed unless `--no-root`.
  //
  // MEASURED 4D-B (Poetry 1.8.3, Ubuntu 24.04): this does NOT build it. Poetry
  // installs the root EDITABLE, as a `.pth` pointing at the source directory —
  // proved with a marker-writing PEP 517 backend that fired zero hooks, against
  // a control showing the same backend fires when called directly. It held for a
  // setuptools root with a `setup.py` too. 4D-A assumed root install implied
  // build execution; that assumption was wrong.
  //
  // The risk is real but different: the project's own SOURCE goes on `sys.path`.
  const noRoot = has("--no-root")
  const installsRootProject: "yes" | "no" | "unknown" = INSTALLING.has(verb) ? (noRoot ? "no" : "yes") : "unknown"
  if (installsRootProject === "yes") blockers.push("poetry_root_installed_editable")

  // Build execution comes from the DEPENDENCIES, not the root.
  //
  // MEASURED 4D-B: with `--no-root`, a path dependency (plain and `develop`), an
  // sdist and a git dependency ALL executed their `setup.py`. `--no-root`
  // excludes only the root. And there is no `--only-binary :all:` equivalent in
  // 1.8.3 — `poetry install --help` offers none, and `installer.no-binary` is
  // the INVERSE (it forces source builds) and defaults to null.
  //
  // So this is unconditional, and now for a measured reason rather than an
  // unmeasured one. The tri-state stays so a future version with a real no-build
  // proof can produce "no".
  const buildExecution: "yes" | "no" | "unknown" = "yes"
  blockers.push("build_may_execute")

  const widensDependencySet = has("--all-extras", "--extras", "-e", "--with", "--all-groups")

  // Poetry picks its own virtualenv from configuration (`virtualenvs.in-project`,
  // `virtualenvs.path`, an active VIRTUAL_ENV, or a cache directory keyed by a
  // hash of the project path). None of that is on the command line, so the
  // destination cannot be confined from the command alone.
  if (INSTALLING.has(verb)) blockers.push("poetry_env_unresolved")

  // Nothing may auto-allow while the source verifier and target confinement do
  // not exist. This is removed by 4D-C, not before.
  if (INSTALLING.has(verb) || resolvesDependencies) blockers.push("poetry_verifier_not_implemented")

  return {
    isInstall: INSTALLING.has(verb),
    verb,
    resolvesDependencies,
    installsRootProject,
    buildExecution,
    widensDependencySet,
    target: {},
    blockers,
  }
}

/** Worst-wins across a compound command, exactly as the pip assessor does. */
export function assessPoetryInstallSource(commands: readonly NormalizedCommand[]): PoetryInstallSourceAssessment {
  const seen = commands.map(assessOne).filter((a) => a.verb !== undefined)
  if (seen.length === 0) return NONE
  const installs = seen.filter((a) => a.isInstall)
  const primary = installs[0] ?? seen[0]!
  const order = { no: 0, unknown: 1, yes: 2 } as const
  const worst = (pick: (a: PoetryInstallSourceAssessment) => "yes" | "no" | "unknown") =>
    seen.reduce<"yes" | "no" | "unknown">((w, a) => (order[pick(a)] >= order[w] ? pick(a) : w), "no")

  return {
    isInstall: installs.length > 0,
    ...(primary.verb ? { verb: primary.verb } : {}),
    resolvesDependencies: seen.some((a) => a.resolvesDependencies),
    installsRootProject: worst((a) => a.installsRootProject),
    buildExecution: worst((a) => a.buildExecution),
    widensDependencySet: seen.some((a) => a.widensDependencySet),
    target: primary.target,
    blockers: [...new Set(seen.flatMap((a) => a.blockers))],
  }
}
