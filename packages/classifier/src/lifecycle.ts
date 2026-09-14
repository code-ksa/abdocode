/**
 * CL-11 — does this package-manager command execute code that nobody in this
 * repository wrote?
 *
 * `npm install` is filed as `package.install`, which reads like fetching files.
 * It is not. Every fetched package may carry `preinstall`/`install`/`postinstall`
 * scripts, and they run as the current user, with the current environment, at
 * install time. The same is true of a pip sdist's `setup.py`, a crate's
 * `build.rs`, a gem's native extension, and a Gradle build file — which IS a
 * program. That is the most under-modelled execution path in the whole tool
 * surface, so it is stated as a FACT here, separately from any policy about it.
 *
 * Three things this module refuses to do:
 *   - guess. An unmodelled manager or verb is `"unknown"`, never `"no"`.
 *     "We did not model it" and "it runs nothing" are different claims, and
 *     turning the first into the second is how arbitrary code execution comes to
 *     look inert.
 *   - decide. It reports; the risk model and the PDP do what they do with it.
 *   - accept a suppression flag it has not verified. A flag counts only when it
 *     really disables scripts for THAT manager (`--ignore-scripts` means nothing
 *     to `cargo`).
 */
import type { NormalizedCommand } from "@abdo/control-contracts"

/** Does the command execute third-party code as part of its normal operation? */
export type LifecycleVerdict = "yes" | "no" | "unknown"

export interface LifecycleAssessment {
  /**
   * IMPLICIT code from FETCHED packages — install hooks, sdist builds, build
   * scripts. Fires without being named. Suppressible by a measured overlay.
   */
  readonly thirdPartyScripts: LifecycleVerdict
  /**
   * IMPLICIT code from THIS repository's own manifest — the `preinstall`/
   * `postinstall` around an install, the `pre<x>`/`post<x>` around `npm run x`.
   * It fires automatically, so it is suppressible the same way. This is NOT the
   * script the user asked to run — see `explicitScript`.
   */
  readonly implicitProjectScripts: LifecycleVerdict
  /**
   * The script the command EXPLICITLY invokes: `npm test`, `npm start`, `npm run
   * build`. This is code execution the user asked for, and MEASURED 2026-07-23,
   * `npm_config_ignore_scripts=true`/`--ignore-scripts` do NOT stop it — they
   * only remove its `pre`/`post` wrappers. So it is a SEPARATE verdict: the
   * lifecycle constraint must never claim to have blocked it. It is governed by
   * risk and policy like any other code execution, not by script suppression.
   */
  readonly explicitScript: LifecycleVerdict
  /** The manager, once recognised (`npm`, `pip`, `cargo`, ...). */
  readonly manager?: string
  /** The verb the verdict was drawn from, when the command has one. */
  readonly verb?: string
  /** The flag that disabled the IMPLICIT scripts, when one was present. Never
   *  claims to have disabled `explicitScript`. */
  readonly suppressedBy?: string
  /** Why the verdicts are what they are — for the audit record, not for parsing. */
  readonly reason: string
}

/** Managers whose install path runs code from the packages it fetches. */
interface ManagerRule {
  /** Verbs that fetch/build dependencies and therefore run their code. */
  readonly thirdPartyVerbs: readonly string[]
  /** Verbs that run scripts written in THIS repo's manifest. */
  readonly projectVerbs?: readonly string[]
  /**
   * Verbs MODELLED as running no foreign code. This list exists so that "no"
   * is always a claim someone made deliberately: a verb that is merely absent
   * from every list falls through to `unknown`, never to `no`.
   */
  readonly inertVerbs?: readonly string[]
  /** True when the bare program with no verb installs (`yarn`). */
  readonly bareInstalls?: boolean
  /**
   * Flags that disable third-party scripts for this manager, each carrying HOW
   * WE KNOW. Only a `measured` suppressor may turn a `yes` into a `no`; an
   * `unmeasured` one yields `unknown`, because a suppression we have not proven
   * is a safety claim we have not earned. A flag MEASURED NOT TO WORK is not
   * listed here at all — see `falseSuppressors`.
   */
  readonly suppressors?: readonly Suppressor[]
  /**
   * Flags that LOOK like suppression and are not. Listed so the assessment can
   * say so explicitly instead of silently reporting `yes` and leaving a reader
   * to assume the flag was simply unrecognised.
   */
  readonly falseSuppressors?: readonly Suppressor[]
  /**
   * When the manager runs foreign code for EVERY invocation, not just for a
   * verb — a Gradle/Maven build file is itself a program.
   */
  readonly alwaysRunsBuildCode?: boolean
  readonly note?: string
}

/**
 * Evidence for one suppression flag. `measured` means it was run against a real
 * package manager on a fixture whose script demonstrably fires without it —
 * `note` records that measurement, including the version it held for.
 */
export interface Suppressor {
  readonly flag: string
  readonly proof: "measured" | "unmeasured"
  readonly note: string
}

const MEASURED = "2026-07-23 probe: a file: dependency with a postinstall that writes a marker"
const IGNORE_SCRIPTS = (version: string): Suppressor => ({
  flag: "--ignore-scripts",
  proof: "measured",
  note: `${MEASURED}; the marker did not appear (${version})`,
})
const JS: ManagerRule = {
  // Verbs that resolve, fetch or rebuild dependencies; each may fire
  // preinstall/install/postinstall/prepare of every package involved.
  thirdPartyVerbs: ["install", "i", "ci", "add", "update", "up", "upgrade", "rebuild", "link"],
  projectVerbs: ["run", "run-script", "test", "start", "exec"],
  note: "install hooks (preinstall/install/postinstall/prepare) of every fetched package",
}

/** pip's `--only-binary` reads like "never build from source", and for an
 *  index-resolved requirement it is. For a LOCAL path it is not: measured
 *  2026-07-23 against pip 26.0.1, `PIP_ONLY_BINARY=:all: pip install ./pkg`
 *  executed setup.py anyway. Listing it as a suppressor would be a safety claim
 *  the tool does not honour. */
const PIP_ONLY_BINARY: Suppressor = {
  flag: "--only-binary",
  proof: "measured",
  note: "2026-07-23 probe, pip 26.0.1: setup.py of a LOCAL path install ran anyway — this flag governs index-resolved requirements, not local builds",
}
const PIP = {
  thirdPartyVerbs: ["install", "download", "wheel"],
  falseSuppressors: [PIP_ONLY_BINARY],
  note: "an sdist executes setup.py at build time",
} as const

const MANAGERS: Readonly<Record<string, ManagerRule>> = {
  npm: { ...JS, suppressors: [IGNORE_SCRIPTS("npm 10.9.4")] },
  // pnpm 10+ refuses dependency build scripts by DEFAULT unless the package is
  // allow-listed, and the probe could not make one fire even when allow-listed
  // — so nothing about pnpm's flag was proven either way. Unproven is `unknown`.
  pnpm: { ...JS, suppressors: [{ flag: "--ignore-scripts", proof: "unmeasured", note: "pnpm 11.9.0 documents the flag; the 2026-07-23 probe could not get a baseline script to fire, so nothing was proven" }] },
  bun: { ...JS, suppressors: [IGNORE_SCRIPTS("bun 1.3.14, with trustedDependencies")] },
  // A bare `yarn` installs — that is yarn's default, and the reason a verb-only
  // table would miss the most common install command in a yarn repo.
  yarn: { ...JS, bareInstalls: true, suppressors: [IGNORE_SCRIPTS("yarn 1.22.22")] },
  pip: PIP,
  pip3: PIP,
  poetry: { thirdPartyVerbs: ["install", "add", "update", "lock", "sync"], note: "builds sdists, which execute their own build code" },
  pipenv: { thirdPartyVerbs: ["install", "sync", "update", "lock"], note: "builds sdists, which execute their own build code" },
  composer: {
    thirdPartyVerbs: ["install", "update", "require", "create-project"],
    projectVerbs: ["run-script", "run"],
    suppressors: [{ flag: "--no-scripts", proof: "unmeasured", note: "composer documents the flag; not measured here (composer is not installed on the measuring machine)" }],
    note: "composer scripts and package scripts",
  },
  // A crate's build.rs and its proc-macros run at COMPILE time, so building is
  // enough — installing is not required, and there is no flag that stops it.
  cargo: {
    thirdPartyVerbs: ["install", "build", "b", "run", "r", "test", "t", "bench", "check", "c", "clippy", "doc"],
    note: "build.rs and proc-macros execute at compile time; cargo has no ignore-scripts",
  },
  gem: { thirdPartyVerbs: ["install", "update", "build", "pristine"], note: "native extensions run extconf.rb at install time" },
  bundle: { thirdPartyVerbs: ["install", "update"], note: "native extensions run extconf.rb at install time" },
  bundler: { thirdPartyVerbs: ["install", "update"], note: "native extensions run extconf.rb at install time" },
  // The build FILE is a program, and plugins are third-party code. Every
  // invocation runs it, so there is no safe verb to carve out.
  gradle: { thirdPartyVerbs: [], alwaysRunsBuildCode: true, note: "build.gradle is executable code and plugins are third-party" },
  gradlew: { thirdPartyVerbs: [], alwaysRunsBuildCode: true, note: "build.gradle is executable code and plugins are third-party" },
  "./gradlew": { thirdPartyVerbs: [], alwaysRunsBuildCode: true, note: "build.gradle is executable code and plugins are third-party" },
  mvn: { thirdPartyVerbs: [], alwaysRunsBuildCode: true, note: "maven plugins are third-party code executed by the build" },
  maven: { thirdPartyVerbs: [], alwaysRunsBuildCode: true, note: "maven plugins are third-party code executed by the build" },
  // Go is the exception worth stating: the module system runs no install-time
  // hooks, and CL-11.6A measured that compiling runs no PROJECT code either —
  // `go build` and `go vet` fired no init/test/generate marker on either
  // platform. `go generate` is the exception to the exception: it runs whatever
  // a directive names, and directives can come from a dependency.
  //
  // But "runs no foreign code" is NOT the same as "inert", and CL-11-FINAL's
  // audit caught the difference the hard way: bare `go build` and
  // `go install` were AUTO-ALLOWED because this table called them inert. Any
  // verb that invokes the toolchain can be turned into arbitrary execution
  // without touching the command — 6A measured `GOFLAGS=-toolexec=<script> go
  // build` running that script, and `CC=<script>` running it for cgo. And
  // `go install` additionally writes an executable into GOBIN, outside the
  // workspace. So the toolchain verbs are `unknown` here, never `no`.
  //
  // Only the verbs that do not invoke the compiler stay inert.
  go: {
    thirdPartyVerbs: ["generate"],
    projectVerbs: ["run", "test"],
    inertVerbs: ["download", "mod", "fmt", "list", "version"],
    note: "modules have no install hooks; only `go generate` executes directives",
  },
}

/** Values that turn a boolean flag OFF. */
const FALSEY = new Set(["false", "0", "no", "off", ""])

/**
 * `--only-binary :all:`, `--only-binary=:all:`, `--ignore-scripts` — a flag
 * counts whether its value is attached or separate.
 *
 * An EXPLICITLY FALSE value is not the flag: `--ignore-scripts=false` asks for
 * the opposite of suppression, and measured 2026-07-23 it beats the environment
 * variable. Reading it as "the flag is present" would have reported a command
 * that runs every install script as one that runs none.
 */
const hasFlag = (argv: readonly string[], flag: string): boolean =>
  argv.some((a, i) => {
    if (a === flag) {
      const next = argv[i + 1]
      // `--ignore-scripts false` — a separate falsey value negates it too. A
      // value that is a real argument (`--only-binary :all:`) does not.
      return !(next !== undefined && FALSEY.has(next.toLowerCase()))
    }
    if (!a.startsWith(flag + "=")) return false
    return !FALSEY.has(a.slice(flag.length + 1).toLowerCase())
  })

const words = (argv: readonly string[]): string[] =>
  argv.filter((a) => !a.startsWith("-") && !/^\/[A-Za-z?]/.test(a)).map((a) => a.toLowerCase())

/**
 * Assess ONE resolved command. Pure and deterministic: program -> manager rule
 * -> verb -> verdict, with suppression applied last so the record can say both
 * that scripts WOULD have run and which flag stopped them.
 */
export function assessLifecycleScripts(command: NormalizedCommand): LifecycleAssessment {
  const program = command.program.toLowerCase()
  const rule = MANAGERS[program]
  if (!rule) {
    return {
      thirdPartyScripts: "unknown",
      implicitProjectScripts: "unknown",
      explicitScript: "unknown",
      reason: `${command.program} is not a package manager this classifier models — unknown, not "runs nothing"`,
    }
  }
  const verb = words(command.argv)[0]

  const suppressor = rule.suppressors?.find((f) => hasFlag(command.argv, f.flag))
  const falseSuppressor = rule.falseSuppressors?.find((f) => hasFlag(command.argv, f.flag))
  const withFalseSuppressor = (base: string) =>
    falseSuppressor ? `${base}. NOTE: ${falseSuppressor.flag} does NOT stop them — ${falseSuppressor.note}` : base

  /**
   * Build the verdict from the three axes. A suppressor is applied to the
   * IMPLICIT axes (third-party, project pre/post) ONLY:
   *   measured    -> a `yes` implicit axis becomes `no`;
   *   unmeasured  -> `unknown` (probably works is not a safety claim);
   *   none        -> unchanged.
   * The explicit axis is NEVER touched — measured 2026-07-23, `--ignore-scripts`
   * removes the wrappers but leaves the named script running.
   */
  const verdict = (thirdParty: LifecycleVerdict, implicitProject: LifecycleVerdict, explicit: LifecycleVerdict, base: string): LifecycleAssessment => {
    const proven = suppressor?.proof === "measured"
    const suppress = (v: LifecycleVerdict): LifecycleVerdict => (suppressor && v === "yes" ? (proven ? "no" : "unknown") : v)
    const third = suppress(thirdParty)
    const proj = suppress(implicitProject)
    const suppressedSomething = suppressor && (thirdParty === "yes" || implicitProject === "yes")
    const reason = !suppressedSomething
      ? withFalseSuppressor(base)
      : proven
        ? `${base}, but ${suppressor!.flag} disables the implicit ones — ${suppressor!.note}`
        : `${base}; ${suppressor!.flag} is claimed to disable the implicit ones but has not been verified here — ${suppressor!.note}`
    return {
      thirdPartyScripts: third,
      implicitProjectScripts: proj,
      explicitScript: explicit,
      manager: program,
      ...(verb ? { verb } : {}),
      ...(proven && suppressedSomething ? { suppressedBy: suppressor!.flag } : {}),
      reason,
    }
  }

  if (rule.alwaysRunsBuildCode) {
    // The build FILE is the explicit thing invoked, and plugins are third-party.
    return verdict("yes", "no", "yes", `every ${program} invocation runs the build: ${rule.note}`)
  }

  if (verb === undefined) {
    if (rule.bareInstalls) return verdict("yes", "yes", "no", `a bare \`${program}\` installs: ${rule.note}`)
    // `npm` alone prints help. Nothing is fetched and nothing is run.
    return { thirdPartyScripts: "no", implicitProjectScripts: "no", explicitScript: "no", manager: program, reason: `\`${program}\` with no verb does not install` }
  }

  if (rule.thirdPartyVerbs.includes(verb)) {
    // An install fetches code (third-party) and fires the project's own install
    // hooks (implicit project). No explicit named script.
    return verdict("yes", "yes", "no", `\`${program} ${verb}\` runs ${rule.note}`)
  }

  if (rule.inertVerbs?.includes(verb)) {
    return { thirdPartyScripts: "no", implicitProjectScripts: "no", explicitScript: "no", manager: program, verb, reason: `\`${program} ${verb}\` runs no foreign code: ${rule.note}` }
  }

  if (rule.projectVerbs?.includes(verb)) {
    // The named script is EXPLICIT execution; its `pre`/`post` wrappers are
    // implicit project scripts. Nothing is fetched (third-party = no).
    return verdict("no", "yes", "yes", `\`${program} ${verb}\` runs a named script from this project's manifest, wrapped in its \`pre\`/\`post\` hooks`)
  }

  // A manager we know, doing something we have not modelled (`npm view`,
  // `pip list`, `cargo tree`).
  return { thirdPartyScripts: "unknown", implicitProjectScripts: "unknown", explicitScript: "unknown", manager: program, verb, reason: `\`${program} ${verb}\` is not a verb this classifier models` }
}

/** Worst-wins across a compound command, PER VERDICT: a chain is only as safe
 *  as its worst member on each axis. */
export function assessLifecycleAll(commands: readonly NormalizedCommand[]): LifecycleAssessment {
  if (commands.length === 0) {
    return { thirdPartyScripts: "unknown", implicitProjectScripts: "unknown", explicitScript: "unknown", reason: "no resolved command to assess" }
  }
  const order: LifecycleVerdict[] = ["no", "unknown", "yes"]
  const worst = (a: LifecycleVerdict, b: LifecycleVerdict) => (order.indexOf(a) >= order.indexOf(b) ? a : b)
  let out = assessLifecycleScripts(commands[0]!)
  for (const c of commands.slice(1)) {
    const next = assessLifecycleScripts(c)
    const third = worst(out.thirdPartyScripts, next.thirdPartyScripts)
    const proj = worst(out.implicitProjectScripts, next.implicitProjectScripts)
    const explicit = worst(out.explicitScript, next.explicitScript)
    // Keep the assessment that OWNS the worst third-party verdict, so the
    // reason and the manager describe the command that most matters.
    const owner = next.thirdPartyScripts === third && out.thirdPartyScripts !== third ? next : out
    out = { ...owner, thirdPartyScripts: third, implicitProjectScripts: proj, explicitScript: explicit }
  }
  return out
}

/**
 * How third-party scripts can be suppressed WITHOUT rewriting the command —
 * which is the only enforcement the control plane will accept: editing a shell
 * line is textual surgery that breaks on chains (`rm -rf node_modules && npm
 * install`) and differs between POSIX and Windows, while an environment overlay
 * reaches every segment of a chain and cannot corrupt the command.
 *
 * MEASURED 2026-07-23 on this machine, with a `file:` dependency whose
 * `postinstall` writes a marker file (and, for pnpm/bun, allow-listed via
 * `pnpm.onlyBuiltDependencies` / `trustedDependencies` so the baseline really
 * fires). "Marker present" = the script ran.
 *
 *   npm  10.9.4   baseline RAN · npm_config_ignore_scripts=true -> no script  ✅
 *   yarn 1.22.22  baseline RAN · npm_config_ignore_scripts=true -> STILL RAN  ❌
 *   bun  1.3.14   baseline RAN · npm_config_ignore_scripts=true -> STILL RAN  ❌
 *   pnpm 11.9.0   baseline never fired even allow-listed -> nothing proven    ⚠️
 *
 * So the honest table has ONE entry. yarn and bun ignore the variable outright;
 * pnpm could not be measured. For every manager absent here the answer is not
 * "unprotected by accident" — it is that suppression cannot be enforced under
 * the no-rewrite rule, and the decision point must ASK rather than pretend.
 */
export interface EnvSuppression {
  readonly env: Readonly<Record<string, string>>
  readonly measuredAt: string
  readonly evidence: string
}

const ENV_SUPPRESSION: Readonly<Record<string, EnvSuppression>> = {
  npm: {
    env: { npm_config_ignore_scripts: "true" },
    measuredAt: "2026-07-23",
    evidence: "npm 10.9.4: a file: dependency's postinstall wrote its marker without the variable and did not write it with the variable (both lower- and upper-case forms)",
  },
}

/**
 * The environment overlay that would disable third-party scripts for this
 * command, or `undefined` when there is none we have PROVEN. `undefined` means
 * "cannot be enforced without rewriting the command", never "safe".
 */
export function envSuppressionFor(manager: string | undefined): EnvSuppression | undefined {
  return manager ? ENV_SUPPRESSION[manager.toLowerCase()] : undefined
}

// --------------------------------------------------------------- enforcement
/**
 * MAY the control plane claim that lifecycle scripts are suppressed for this
 * whole operation?
 *
 * The claim rests on an environment overlay, never on rewriting the command —
 * see CL-11-SUPPRESSION-MEASUREMENT.md for why. An overlay is strong (it reaches
 * every segment of a chain, measured) and it is also DEFEATABLE from inside the
 * command, which was measured too: with `npm_config_ignore_scripts=true` already
 * set, `npm install --ignore-scripts=false` ran the scripts anyway, as did an
 * inline `npm_config_ignore_scripts=false` and an `export` in a chain.
 *
 * So every blocker below is an observed defeat, not a hypothetical one, and a
 * blocked operation is not "unprotected" — it is one the decision point must ASK
 * about, because a protection the environment cannot deliver must not be
 * announced as if it could.
 */
export interface LifecycleEnforcement {
  /**
   * Some command here runs IMPLICIT lifecycle scripts (`yes` OR `unknown`) —
   * third-party install hooks, or the project's own pre/post. These are what a
   * suppression overlay can remove, so their presence is what makes the
   * constraint applicable. The EXPLICIT named script (`npm test`) is not counted
   * here: an overlay does not stop it, and pretending otherwise was the bug.
   */
  readonly implicitRequired: boolean
  /** Every command with implicit scripts is covered by a MEASURED overlay and
   *  nothing in the command can undo it. Only then may the constraint be
   *  claimed — and it claims to suppress the IMPLICIT scripts only. */
  readonly implicitEnforceable: boolean
  /**
   * The command explicitly invokes a named script (`npm test`, `npm run build`).
   * That is code execution the user asked for; the overlay does NOT make it
   * safe, and this flag exists so the decision point judges it by RISK rather
   * than treating a lifecycle constraint as if it had neutralised it.
   */
  readonly explicitCodeExecution: boolean
  /** The overlay to apply. Empty when nothing implicit is required or proven. */
  readonly envOverlay: Readonly<Record<string, string>>
  /** Machine-readable reasons the implicit-suppression claim cannot be made. */
  readonly blockers: readonly string[]
  /** The worst-wins assessment the verdicts were drawn from. */
  readonly assessment: LifecycleAssessment
}

/** Environment keys the overlay owns. A command that writes any of them is
 *  fighting the enforcement point, whatever value it writes. */
const protectedKeys = (): string[] => Object.values(ENV_SUPPRESSION).flatMap((s) => Object.keys(s.env).map((k) => k.toLowerCase()))

/** Programs that set environment variables rather than run a program. */
const ASSIGNMENT_PROGRAMS = new Set(["export", "set", "setx", "declare", "typeset"])
/** Interpreters that take a program as data. If one survives normalization we
 *  did not see what it will run, so nothing about it may be claimed. */
const OPAQUE_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "cmd", "cmd.exe", "powershell", "pwsh", "eval", "source"])



/**
 * @param operation a NORMALIZED operation (CL-04) with its resolved commands.
 * @param rawCommand the command text AS WRITTEN. Required, and not redundant:
 *        measured 2026-07-23, `set npm_config_ignore_scripts=false && npm
 *        install` under cmd normalizes to `npm install` with an EMPTY env — the
 *        assignment vanishes from the parse while remaining in force in the real
 *        shell. A structural check alone would have claimed enforcement here and
 *        been wrong.
 */
export function assessLifecycleEnforcement(
  operation: { readonly certainty: "parsed" | "uncertain"; readonly commands?: readonly NormalizedCommand[] },
  rawCommand: string,
): LifecycleEnforcement {
  const commands = operation.commands ?? []
  const assessment = assessLifecycleAll(commands)
  const blockers: string[] = []
  const overlay: Record<string, string> = {}

  // The command explicitly runs a named script somewhere. Reported, never
  // suppressed — the overlay does not touch it, and the decision point weighs it
  // as code execution on its own risk.
  const explicitCodeExecution = commands.some((c) => assessLifecycleScripts(c).explicitScript !== "no")

  // Only RECOGNISED managers with IMPLICIT scripts are asked about here. An
  // unmodelled program in a chain (`xargs`, `nix-env`) is not silently blessed —
  // it has no known capability either, which makes the whole operation
  // conservative and sends it to approval through the risk path. Demanding a
  // package-manager overlay from `rm` would misfile that escalation.
  // pip-family is EXCLUDED here: its build execution is a supply-chain/source
  // property (governed by the pip source layer + `--only-binary`), not an
  // env-overlay-suppressible lifecycle like npm's. Leaving it in would make every
  // pip install ask at the lifecycle gate before the pip source gate is reached.
  const PIP_FAMILY = new Set(["pip", "pip3", "python", "python3", "py"])
  const risky = commands.filter((c) => {
    const a = assessLifecycleScripts(c)
    if (PIP_FAMILY.has(c.program.toLowerCase())) return false
    return a.manager !== undefined && (a.thirdPartyScripts !== "no" || a.implicitProjectScripts !== "no")
  })
  const implicitRequired = risky.length > 0
  if (!implicitRequired) {
    return { implicitRequired: false, implicitEnforceable: false, explicitCodeExecution, envOverlay: {}, blockers: [], assessment }
  }

  // 1. Every command with implicit scripts must be covered by a MEASURED overlay.
  for (const c of risky) {
    const manager = assessLifecycleScripts(c).manager
    const suppression = envSuppressionFor(manager)
    if (!suppression) {
      blockers.push(`no_proven_suppression:${manager ?? c.program.toLowerCase()}`)
      continue
    }
    Object.assign(overlay, suppression.env)
  }

  // 2. A parse we do not trust cannot carry a claim about what will run.
  if (operation.certainty !== "parsed") blockers.push("uncertain_parse")

  // 3. Nothing in the command may write the keys the overlay owns — measured to
  //    win over the environment, whatever the value.
  const keys = protectedKeys()
  const writesProtectedKey = commands.some((c) => {
    if (Object.keys(c.env).some((k) => keys.includes(k.toLowerCase()))) return true
    const program = c.program.toLowerCase()
    if (ASSIGNMENT_PROGRAMS.has(program) && c.argv.some((a) => keys.includes(a.split("=")[0]!.toLowerCase()))) return true
    // PowerShell's `$env:key=value` arrives as the program itself.
    if (program.startsWith("$env:") && keys.includes(program.slice(5).split("=")[0]!.toLowerCase())) return true
    return false
  })
  if (writesProtectedKey) blockers.push("protected_key_set_by_command")

  // 4. The raw text, because the parse can lose an assignment (see @param).
  const rawAssignment = (key: string) => new RegExp(String.raw`(^|[^\w$])\$?(env:)?` + key + String.raw`\s*=`, "i")
  if (keys.some((k) => rawAssignment(k).test(rawCommand))) {
    blockers.push("protected_key_written_in_raw_command")
  }

  // 5. A flag that turns the suppressor OFF beats the environment (measured).
  //    `--ignore-scripts` on its own asks for the same thing the constraint
  //    does and is not a bypass.
  const negatesSuppressor = commands.some((c) =>
    c.argv.some((arg, i) => {
      const [flag, value] = arg.split("=", 2)
      const name = flag!.toLowerCase()
      if (name.startsWith("--no-")) return `--${name.slice(5)}` === "--ignore-scripts"
      if (name !== "--ignore-scripts" && name !== "--only-binary" && name !== "--no-scripts") return false
      if (value !== undefined) return FALSEY.has(value.toLowerCase())
      const next = c.argv[i + 1]
      return next !== undefined && FALSEY.has(next.toLowerCase())
    }),
  )
  if (negatesSuppressor) blockers.push("cli_flag_overrides_constraint")

  // 6. An interpreter that survived normalization runs code we never saw.
  if (commands.some((c) => OPAQUE_INTERPRETERS.has(c.program.toLowerCase()))) blockers.push("opaque_nested_shell")

  const implicitEnforceable = blockers.length === 0
  return { implicitRequired, implicitEnforceable, explicitCodeExecution, envOverlay: implicitEnforceable ? overlay : {}, blockers, assessment }
}
