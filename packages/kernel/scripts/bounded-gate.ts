import { closeSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import {
  cargoWorkspaceCommand,
  withIsolatedCargoAsync,
  type PreparedCargoContext,
} from "./contracts"

/**
 * The one implementation of "run a bounded Cargo acceptance gate and prove its
 * process tree was reaped".
 *
 * Every sprint from S105 onward needs exactly this. Copying it per sprint would
 * produce one more live implementation of the same node each time, which is the
 * duplication the K10 gate exists to forbid — and it would mean a defect fixed
 * in one copy silently survives in nine others.
 */

export const PROCESS_REAP_TIMEOUT_MS = 10_000
export const MAX_GATE_OUTPUT_BYTES = 8 * 1024 * 1024

export interface CargoGate {
  /** Short gate name, used for the log file and error messages. */
  readonly name: string
  /** Environment marker this gate, and only this gate, may see. */
  readonly parentEnvironment: string
  /** Cargo package the test target lives in. */
  readonly packageName: string
  /** `tests/<target>.rs`. */
  readonly testTarget: string
  /** Exact `#[test]` function name. */
  readonly testName: string
  /** Feature required to compile the gate, when it needs one. */
  readonly features?: string
  /** Binary package that must be built in the same isolated target first. */
  readonly buildPackage?: string
  readonly timeoutMs: number
}

export interface GateFamily {
  /** Prefix used in every error message, e.g. `S106`. */
  readonly label: string
  /** Every marker in the family, so siblings can be proven absent. */
  readonly parentEnvironments: readonly string[]
  readonly gates: readonly CargoGate[]
  /** Checks the gate produced its exact quantitative acceptance evidence. */
  readonly validate: (name: string, output: string) => void
}

/** Run every gate in a family, in order, stopping at the first failure. */
export function runCargoGateFamily(family: GateFamily, preparedContext?: PreparedCargoContext) {
  return withIsolatedCargoAsync(async (context) => {
    for (const gate of family.gates) {
      const exitCode = await runCargoGate(family, gate, context)
      if (exitCode !== 0) return exitCode
    }
    return 0
  }, preparedContext)
}

/** Run exactly one named gate from a family. */
export function runCargoGateByName(
  family: GateFamily,
  name: string,
  preparedContext?: PreparedCargoContext,
) {
  const gate = family.gates.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error(`${family.label} has no gate named ${name}`)
  return withIsolatedCargoAsync((context) => runCargoGate(family, gate, context), preparedContext)
}

function runCargoGate(family: GateFamily, gate: CargoGate, preparedContext: PreparedCargoContext) {
  return withIsolatedCargoAsync(async ({ root, cwd, environment }) => {
    const gateEnvironment: Record<string, string> = { ...environment }
    for (const marker of family.parentEnvironments) delete gateEnvironment[marker]
    gateEnvironment[gate.parentEnvironment] = createParentGate()
    const activeMarkers = family.parentEnvironments.filter(
      (marker) => gateEnvironment[marker] !== undefined,
    )
    if (activeMarkers.length !== 1 || activeMarkers[0] !== gate.parentEnvironment) {
      throw new Error(`${family.label} gate parent markers must be mutually exclusive`)
    }
    const featureArguments = gate.features === undefined ? [] : ["--features", gate.features]
    if (gate.buildPackage !== undefined) {
      const buildCommand = cargoWorkspaceCommand(
        "build",
        "--locked",
        "--offline",
        "--release",
        "--package",
        gate.buildPackage,
        ...featureArguments,
      )
      const build = await runBoundedCargoGate(family, gate, buildCommand, root, cwd, gateEnvironment, "build")
      emitGateOutput(build.stdout, build.stderr)
      reportFailedGate(family, gate, "build", buildCommand, build)
      if (build.exitCode !== 0) return build.exitCode
    }
    const command = cargoWorkspaceCommand(
      "test",
      "--locked",
      "--offline",
      "--release",
      "--package",
      gate.packageName,
      ...featureArguments,
      "--test",
      gate.testTarget,
      gate.testName,
      "--",
      "--ignored",
      "--exact",
      "--nocapture",
      "--test-threads=1",
    )
    const result = await runBoundedCargoGate(family, gate, command, root, cwd, gateEnvironment, "test")
    emitGateOutput(result.stdout, result.stderr)
    reportFailedGate(family, gate, "test", command, result)
    if (result.exitCode !== 0) return result.exitCode
    family.validate(gate.name, `${result.stdout}\n${result.stderr}`)
    return 0
  }, preparedContext)
}

interface GateProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

interface GateSubprocess {
  readonly pid: number
  readonly exitCode: number | null
  readonly exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
}

/**
 * Wait for a spawned gate to exit, bounded by `budgetMs`, and return its status
 * or `null` when the budget expires first.
 *
 * This must await. `Bun.spawn` publishes `exitCode` from the event loop, so a
 * synchronous `Date.now()` poll around `Bun.sleepSync` blocks the very loop that
 * would report the exit: the child finishes, the parent never observes it, and
 * every gate burns its whole timeout before killing a process that is already
 * dead. That defect made the S105 gate unpassable by construction.
 */
async function awaitExitWithin(child: GateSubprocess, budgetMs: number) {
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<null>((resolve) => {
    expiryTimer = setTimeout(() => resolve(null), budgetMs)
  })
  try {
    return await Promise.race([child.exited, expiry])
  } finally {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
  }
}

async function runBoundedCargoGate(
  family: GateFamily,
  gate: CargoGate,
  command: readonly string[],
  root: string,
  cwd: string,
  environment: Readonly<Record<string, string>>,
  stage: "build" | "test",
): Promise<GateProcessResult> {
  const stdoutPath = join(root, `${family.label.toLowerCase()}-${gate.name}-${stage}.stdout.log`)
  const stderrPath = join(root, `${family.label.toLowerCase()}-${gate.name}-${stage}.stderr.log`)
  const stdoutDescriptor = openSync(stdoutPath, "wx")
  let stderrDescriptor: number | undefined
  let child: GateSubprocess | undefined
  let failure: Error | undefined
  let exitCode: number | undefined
  try {
    stderrDescriptor = openSync(stderrPath, "wx")
    child = Bun.spawn([...command], {
      cwd,
      env: environment,
      stdin: "ignore",
      stdout: stdoutDescriptor,
      stderr: stderrDescriptor,
      detached: process.platform !== "win32",
    })
    const observed = await awaitExitWithin(child, gate.timeoutMs)
    if (observed === null) {
      await terminateAndReapProcessTree(child, environment)
      failure = new Error(
        `${family.label} ${gate.name} Cargo gate exceeded its ${gate.timeoutMs}ms outer timeout`,
      )
    } else {
      exitCode = observed
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
    if (child !== undefined && child.exitCode === null) {
      try {
        await terminateAndReapProcessTree(child, environment)
      } catch (cleanupError) {
        failure = new Error(
          `${failure.message}; process-tree cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`,
        )
      }
    }
  } finally {
    closeSync(stdoutDescriptor)
    if (stderrDescriptor !== undefined) closeSync(stderrDescriptor)
  }
  const stdout = readBoundedGateOutput(stdoutPath)
  const stderr = readBoundedGateOutput(stderrPath)
  if (failure !== undefined) {
    emitGateOutput(stdout, stderr)
    throw failure
  }
  if (exitCode === undefined) throw new Error(`${family.label} ${gate.name} Cargo gate exited without a status`)
  return { exitCode, stdout, stderr }
}

async function terminateAndReapProcessTree(
  child: GateSubprocess,
  environment: Readonly<Record<string, string>>,
) {
  let treeKillFailure: Error | undefined
  if (process.platform === "win32") {
    const taskkill = trustedTaskkillExecutable(environment)
    const result = Bun.spawnSync([taskkill, "/PID", child.pid.toString(), "/T", "/F"], {
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: PROCESS_REAP_TIMEOUT_MS,
    })
    if (result.exitCode !== 0 && child.exitCode === null) {
      child.kill("SIGKILL")
      treeKillFailure = new Error(`taskkill could not prove process-tree termination (${result.exitCode})`)
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      if (child.exitCode === null) child.kill("SIGKILL")
    }
  }
  const reaped = await awaitExitWithin(child, PROCESS_REAP_TIMEOUT_MS)
  if (reaped === null) throw new Error(`Cargo process tree ${child.pid} was not reaped`)
  if (treeKillFailure !== undefined) throw treeKillFailure
}

function trustedTaskkillExecutable(environment: Readonly<Record<string, string>>) {
  const systemRoot = Object.entries(environment).find(([name]) => name.toUpperCase() === "SYSTEMROOT")?.[1]
  if (systemRoot === undefined) throw new Error("sanitized Windows environment has no SystemRoot")
  const canonicalSystem32 = realpathSync(join(systemRoot, "System32"))
  const requestedPath = join(canonicalSystem32, "taskkill.exe")
  const requestedIdentity = lstatSync(requestedPath)
  if (!requestedIdentity.isFile() || requestedIdentity.isSymbolicLink()) {
    throw new Error("taskkill must be a regular non-symlink system executable")
  }
  const executablePath = realpathSync(requestedPath)
  const executableIdentity = lstatSync(executablePath)
  if (
    !executableIdentity.isFile() ||
    executableIdentity.isSymbolicLink() ||
    basename(executablePath).toLowerCase() !== "taskkill.exe" ||
    dirname(executablePath).toLowerCase() !== canonicalSystem32.toLowerCase()
  ) {
    throw new Error("canonical taskkill identity escaped System32")
  }
  return executablePath
}

function readBoundedGateOutput(path: string) {
  const size = statSync(path).size
  if (size > MAX_GATE_OUTPUT_BYTES) throw new Error(`Cargo gate output exceeded ${MAX_GATE_OUTPUT_BYTES} bytes`)
  return readFileSync(path, "utf8")
}

/**
 * Name a failing gate before the harness relays its bare exit code.
 *
 * A gate that fails with nothing but a number is unfixable by whoever meets it
 * next. This runner captures the child's streams into files and replays them,
 * so a child that died before writing a byte used to reach the operator as an
 * exit code and literally nothing else. The stage, the gate, the captured byte
 * counts and the exact command are the minimum that makes a failure readable,
 * and the empty-capture case has to say so in words: silence is the one state
 * the replayed output cannot report on its own.
 */
function reportFailedGate(
  family: GateFamily,
  gate: CargoGate,
  stage: "build" | "test",
  command: readonly string[],
  result: GateProcessResult,
) {
  if (result.exitCode === 0) return
  const captured =
    result.stdout.length === 0 && result.stderr.length === 0
      ? "the child produced no output at all"
      : `captured stdout ${result.stdout.length} bytes and stderr ${result.stderr.length} bytes`
  console.error(
    `${family.label} gate ${gate.name} failed at the ${stage} stage with exit code ${result.exitCode}: ${captured}; command: ${command.join(" ")}`,
  )
}

function emitGateOutput(stdout: string, stderr: string) {
  if (stdout.length > 0) console.log(stdout.trimEnd())
  if (stderr.length > 0) console.error(stderr.trimEnd())
}

/**
 * Require exactly one Cargo summary line of a kind, matching exactly.
 *
 * "Exactly one" matters as much as the match: a gate that ran two tests, or
 * printed two result lines, is not the gate that was specified.
 */
export function requireOnlyCargoSummaryLine(
  label: string,
  lines: readonly string[],
  summary: RegExp,
  expected: string | RegExp,
  name: string,
) {
  const matches = lines.filter((line) => summary.test(line))
  const accepted =
    matches.length === 1 &&
    (typeof expected === "string" ? matches[0] === expected : expected.test(matches[0]!))
  if (!accepted) throw new Error(`${label} Cargo output must contain exactly one accepted ${name} line`)
  return matches[0]!
}

/** Return the acceptance-evidence text printed by the one named test. */
export function requireNamedTestEvidence(label: string, lines: readonly string[], testName: string) {
  const prefix = `test ${testName} ... `
  const testLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith("test ") && !line.startsWith("test result:"))
  const matches = testLines.filter(({ line }) => line.startsWith(prefix))
  if (testLines.length !== 1 || matches.length !== 1) {
    throw new Error(`${label} Cargo output must contain exactly one named test evidence line`)
  }
  const match = matches[0]!
  const nextNonempty = lines.slice(match.index + 1).find((line) => line.length > 0)
  if (nextNonempty !== "ok" || lines.filter((line) => line === "ok").length !== 1) {
    throw new Error(`${label} Cargo output must contain the named test pass immediately after its acceptance evidence`)
  }
  return match.line.slice(prefix.length)
}

/** Split a gate output into trimmed lines and check the two Cargo summaries. */
export function acceptanceEvidence(label: string, testName: string, output: string) {
  const lines = output.replaceAll("\r\n", "\n").split("\n").map((line) => line.trim())
  requireOnlyCargoSummaryLine(label, lines, /^running \d+ tests?$/, "running 1 test", "test-count")
  const evidence = requireNamedTestEvidence(label, lines, testName)
  requireOnlyCargoSummaryLine(
    label,
    lines,
    /^test result:/,
    /^test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in .+$/,
    "test-result",
  )
  return evidence
}

export function createParentGate() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
