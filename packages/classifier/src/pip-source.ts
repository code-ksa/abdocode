/**
 * CL-11.4A — pip install SOURCE & build classification, from the command alone.
 *
 * pip's safety questions mirror npm's but with different mechanisms, MEASURED
 * 2026-07-24 (pip 26.0.1):
 *
 *   - `--require-hashes` is pip's INTEGRITY gate: it refuses any requirement
 *     without a hash, and turns on automatically once any requirement carries
 *     one. A `-r requirements.txt --require-hashes` install is the hash-pinned,
 *     deterministic path — the analog of a lockfile with integrity.
 *   - a source distribution BUILDS by executing setup.py / the build backend.
 *     `--only-binary :all:` avoids that for INDEX installs (wheels only) but was
 *     measured NOT to help a LOCAL path — the build ran anyway.
 *   - git / URL / tarball / local-path / editable specs pull from outside the
 *     index, unvetted.
 *
 * Pure and command-only; it reports, the PDP (4C) enforces. The clean subset it
 * recognises: an index install from a requirements file under `--require-hashes`
 * with no git/url/local/editable source. The requirements FILE's own hashes and
 * the allowed index are filesystem facts — that is the 4B verifier, not this.
 */
import type { NormalizedCommand } from "@abdo/control-contracts"

export interface PipInstallSourceAssessment {
  readonly isInstall: boolean
  readonly verb?: string
  readonly sources: {
    readonly index: boolean
    readonly git: boolean
    readonly url: boolean
    readonly vcs: boolean
    readonly localPath: boolean
    readonly editable: boolean
  }
  /** `--require-hashes` present — pip will refuse any unhashed requirement. */
  readonly requireHashes: boolean
  /** `--only-binary :all:` — wheels only, so an INDEX install runs no build. */
  readonly onlyBinaryAll: boolean
  /** A `-r/--requirement` file supplies the requirements (its hashes -> 4B). */
  readonly hasRequirementsFile: boolean
  /** The `-r`/`-c` file paths named on the command — what the 4B verifier reads. */
  readonly requirementsFiles: readonly string[]
  /** Does the command run third-party build code (setup.py / build backend)? */
  readonly buildExecution: "yes" | "no" | "unknown"
  /**
   * CL-11.4C2 target identity — WHERE this install writes, from the command.
   * `python -m pip` names an interpreter (its identity decides site-packages); a
   * bare `pip` does not, so its environment is unknowable. `--target`/`--user`/
   * `--prefix`/`--root` redirect the destination. Confinement to the workspace is
   * a FILESYSTEM fact (the verifier), not decided here.
   */
  readonly target: {
    /** Invoked as `python -m pip` (interpreter identity available). */
    readonly viaPythonModule: boolean
    /** The interpreter program named (`python`, `./venv/bin/python`, …), when known. */
    readonly interpreter?: string
    /** A `--target DIR` value, when present. */
    readonly targetDir?: string
    readonly userSite: boolean
    readonly customPrefix: boolean
    readonly customRoot: boolean
  }
  /** CL-11.4C6 — `--keyring-provider` as written, lowercased, when present.
   *  `import` and `subprocess` are both code-execution surfaces. */
  readonly keyringProvider?: string
  readonly blockers: readonly string[]
}

const PIP_PROGRAMS = new Set(["pip", "pip3"])
const PYTHON_PROGRAMS = new Set(["python", "python3", "py"])
const INSTALL_VERBS = new Set(["install", "download", "wheel"])
const VCS_PREFIX = /^(git\+|hg\+|svn\+|bzr\+|git:|hg:|svn:|bzr:)/i

/** Extract pip's argv + the invocation identity, or undefined for a non-pip cmd. */
function pipArgv(command: NormalizedCommand): { argv: readonly string[]; viaPythonModule: boolean; interpreter?: string } | undefined {
  const program = command.program.toLowerCase()
  // A bare `pip`/`pip3`, OR an explicit path ending in pip (…/venv/bin/pip).
  if (PIP_PROGRAMS.has(program) || /(^|[/\\])pip3?(\.exe)?$/i.test(command.program)) {
    return { argv: command.argv, viaPythonModule: false }
  }
  // `python -m pip` — the interpreter is the program (possibly a path).
  const base = program.replace(/\.exe$/i, "").replace(/^.*[/\\]/, "")
  if (PYTHON_PROGRAMS.has(base) || /^python[0-9.]*$/i.test(base)) {
    const mi = command.argv.indexOf("-m")
    if (mi >= 0 && command.argv[mi + 1]?.toLowerCase() === "pip") {
      return { argv: command.argv.slice(mi + 2), viaPythonModule: true, interpreter: command.program }
    }
  }
  return undefined
}

/** Is a dependency argument a local filesystem path (not an index name)? */
function isLocalPath(arg: string): boolean {
  if (arg === "." || arg === "..") return true
  if (/^\.\.?[/\\]/.test(arg)) return true // ./x  ../x
  if (/^[/\\]/.test(arg)) return true // /abs  \abs
  if (/^[a-zA-Z]:[/\\]/.test(arg)) return true // C:\ windows
  if (/\.(whl|tar\.gz|tgz|zip)$/i.test(arg) && !/^https?:/i.test(arg)) return true // a local archive file
  return false
}

const isUrl = (arg: string) => /^https?:\/\//i.test(arg) && !VCS_PREFIX.test(arg)
const isGit = (arg: string) => /^git\+/i.test(arg) || /^git:/i.test(arg)
const isVcs = (arg: string) => VCS_PREFIX.test(arg) && !isGit(arg)

function assessOne(command: NormalizedCommand): PipInstallSourceAssessment {
  const none: PipInstallSourceAssessment = {
    isInstall: false,
    sources: { index: false, git: false, url: false, vcs: false, localPath: false, editable: false },
    requireHashes: false, onlyBinaryAll: false, hasRequirementsFile: false, requirementsFiles: [], buildExecution: "no",
    target: { viaPythonModule: false, userSite: false, customPrefix: false, customRoot: false },
    blockers: [],
  }
  const parsed = pipArgv(command)
  if (!parsed) return none
  const { argv, viaPythonModule, interpreter } = parsed
  const verb = argv.find((a) => !a.startsWith("-"))?.toLowerCase()
  if (!verb || !INSTALL_VERBS.has(verb)) return { ...none, ...(verb ? { verb } : {}) }

  const flags = argv.filter((a) => a.startsWith("-")).map((a) => a.toLowerCase())
  const requireHashes = flags.includes("--require-hashes")
  const onlyBinaryAll = argv.some((a, i) => {
    const v = a.toLowerCase()
    if (v === "--only-binary=:all:") return true
    if (v === "--only-binary") return argv[i + 1] === ":all:"
    return false
  })
  const editable = flags.includes("-e") || flags.includes("--editable")
  const userSite = flags.includes("--user")
  const customPrefix = flags.includes("--prefix")
  const customRoot = flags.includes("--root")
  let targetDir: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--target" || a === "-t") { targetDir = argv[i + 1]; break }
    if (a.startsWith("--target=")) { targetDir = a.slice("--target=".length); break }
  }

  // CL-11.4C6 — pip's keyring integration is a code-execution and credential
  // surface: `import` loads the `keyring` package in-process, `subprocess` runs
  // a `keyring` EXECUTABLE off PATH. The auto-allow path forces it off, so a
  // command that explicitly turns it back on cannot ride that path.
  let keyringProvider: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--keyring-provider") { keyringProvider = argv[i + 1]?.toLowerCase(); break }
    if (a.toLowerCase().startsWith("--keyring-provider=")) { keyringProvider = a.slice("--keyring-provider=".length).toLowerCase(); break }
  }

  // Dependency specs: non-flag args after the verb, and the value of -r/-e.
  const hasRequirementsFile = argv.some((a) => a === "-r" || a === "--requirement" || a.startsWith("--requirement="))
  const requirementsFiles: string[] = []
  const specs: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === verb) continue
    if (a === "-r" || a === "--requirement") { if (argv[i + 1]) requirementsFiles.push(argv[i + 1]!); i++; continue }
    if (a.startsWith("--requirement=")) { requirementsFiles.push(a.slice("--requirement=".length)); continue }
    if (a === "-e" || a === "--editable") { specs.push(argv[i + 1] ?? "."); i++; continue }
    if (a.startsWith("-")) {
      // `--only-binary :all:` takes a following value that is not a spec.
      if (a.toLowerCase() === "--only-binary") i++
      continue
    }
    specs.push(a)
  }

  const sources = {
    index: false, git: false, url: false, vcs: false, localPath: false, editable,
  }
  for (const s of specs) {
    if (isGit(s)) sources.git = true
    else if (isVcs(s)) sources.vcs = true
    else if (isUrl(s)) sources.url = true
    else if (isLocalPath(s)) sources.localPath = true
    else sources.index = true // a plain name/pinned requirement
  }

  const nonIndex = sources.git || sources.url || sources.vcs || sources.localPath || sources.editable
  const blockers: string[] = []
  if (nonIndex) blockers.push("non_index_source")
  if (!requireHashes) blockers.push("hashes_not_required")
  // A package NAMED directly (not via -r) is loosely resolved — even with a
  // pin, the safe subset routes through a hash-checked requirements file.
  if (sources.index && !hasRequirementsFile) blockers.push("direct_unpinned_spec")

  // Build execution: a non-index source builds; an index install builds only
  // when a wheel is unavailable — `--only-binary :all:` forbids that, so an
  // index-only install with it runs no build. Local paths ignore the flag.
  const buildExecution: "yes" | "no" | "unknown" = nonIndex
    ? "yes"
    : onlyBinaryAll
      ? "no"
      : "unknown"
  // Untrusted build code (setup.py / build backend) MAY run unless the command
  // forces wheels-only. `--only-binary :all:` is the one command-side proof of
  // no build, so the clean auto-allow subset requires it.
  if (buildExecution !== "no") blockers.push("build_may_execute")

  // CL-11.4C2 target identity. `--user`/`--prefix`/`--root` write OUTSIDE the
  // project; a bare `pip` names no interpreter, so its environment is unknowable
  // — neither can auto-allow. Confinement of `--target`/venv to the workspace is
  // the verifier's call (filesystem), added there.
  if (userSite) blockers.push("user_site_install")
  if (customPrefix) blockers.push("custom_prefix")
  if (customRoot) blockers.push("custom_root")
  if (!viaPythonModule && targetDir === undefined) blockers.push("bare_pip_unknown_interpreter")
  // Re-enabling keyring asks for either an in-process import or a PATH lookup of
  // a `keyring` executable. Neither belongs on an unattended path.
  if (keyringProvider !== undefined && keyringProvider !== "disabled") blockers.push(`keyring_provider_enabled:${keyringProvider}`)

  return {
    isInstall: true, verb, sources, requireHashes, onlyBinaryAll, hasRequirementsFile, requirementsFiles, buildExecution,
    target: { viaPythonModule, ...(interpreter ? { interpreter } : {}), ...(targetDir !== undefined ? { targetDir } : {}), userSite, customPrefix, customRoot },
    ...(keyringProvider !== undefined ? { keyringProvider } : {}),
    blockers,
  }
}

/** Worst-wins across a compound command: any pip install member's blockers count. */
export function assessPipInstallSource(commands: readonly NormalizedCommand[]): PipInstallSourceAssessment {
  const installs = commands.map(assessOne).filter((a) => a.isInstall)
  if (installs.length === 0) {
    return {
      isInstall: false,
      sources: { index: false, git: false, url: false, vcs: false, localPath: false, editable: false },
      requireHashes: false, onlyBinaryAll: false, hasRequirementsFile: false, requirementsFiles: [], buildExecution: "no",
      target: { viaPythonModule: false, userSite: false, customPrefix: false, customRoot: false },
      blockers: [],
    }
  }
  const order = { no: 0, unknown: 1, yes: 2 } as const
  const build = installs.reduce<"yes" | "no" | "unknown">((w, a) => (order[a.buildExecution] >= order[w] ? a.buildExecution : w), "no")
  return {
    isInstall: true,
    verb: installs[0]!.verb,
    sources: {
      index: installs.some((a) => a.sources.index),
      git: installs.some((a) => a.sources.git),
      url: installs.some((a) => a.sources.url),
      vcs: installs.some((a) => a.sources.vcs),
      localPath: installs.some((a) => a.sources.localPath),
      editable: installs.some((a) => a.sources.editable),
    },
    requireHashes: installs.every((a) => a.requireHashes),
    onlyBinaryAll: installs.every((a) => a.onlyBinaryAll),
    hasRequirementsFile: installs.some((a) => a.hasRequirementsFile),
    requirementsFiles: [...new Set(installs.flatMap((a) => a.requirementsFiles))],
    target: installs[0]!.target,
    // Worst-wins: if ANY member of a compound command re-enables keyring, the
    // whole command carries that fact. `disabled` never masks an enabling one.
    ...(() => {
      const enabled = installs.find((a) => a.keyringProvider !== undefined && a.keyringProvider !== "disabled")
      const any = enabled ?? installs.find((a) => a.keyringProvider !== undefined)
      return any?.keyringProvider !== undefined ? { keyringProvider: any.keyringProvider } : {}
    })(),
    buildExecution: build,
    blockers: [...new Set(installs.flatMap((a) => a.blockers))],
  }
}
