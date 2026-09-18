import {
  acceptanceEvidence,
  runCargoGateByName,
  runCargoGateFamily,
  type CargoGate,
  type GateFamily,
} from "./bounded-gate"
import type { PreparedCargoContext } from "./contracts"

const SESSION_PARENT_GATE = "ABDO_RUNTIME_SESSION_PARENT_GATE"
const SESSION_PARENT_GATES = [SESSION_PARENT_GATE] as const

export type S109SessionGateName = "steps"

const SESSION_GATE_TIMEOUT_MS = 5 * 60_000

const SESSION_GATES: readonly CargoGate[] = [
  {
    name: "steps",
    parentEnvironment: SESSION_PARENT_GATE,
    packageName: "abdo-runtime",
    testTarget: "session_steps",
    testName: "sessions_step_deterministically_with_one_writer_each",
    features: "test-hooks",
    timeoutMs: SESSION_GATE_TIMEOUT_MS,
  },
]

const SESSION_FAMILY: GateFamily = {
  label: "S109",
  parentEnvironments: SESSION_PARENT_GATES,
  gates: SESSION_GATES,
  validate: (name, output) => validateS109SessionGateOutput(name as S109SessionGateName, output),
}

export function runS109SessionGates(preparedContext?: PreparedCargoContext) {
  return runCargoGateFamily(SESSION_FAMILY, preparedContext)
}

export async function runS109SessionGate(
  name: S109SessionGateName,
  preparedContext?: PreparedCargoContext,
) {
  return runCargoGateByName(SESSION_FAMILY, name, preparedContext)
}

function sessionGateByName(name: S109SessionGateName) {
  const gate = SESSION_GATES.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error("unknown S109 session gate")
  return gate
}

export function validateS109SessionGateOutput(name: S109SessionGateName, output: string) {
  const gate = sessionGateByName(name)
  validateSessionEvidence(acceptanceEvidence("S109", gate.testName, output), gate.timeoutMs)
}

function validateSessionEvidence(line: string, timeoutMs: number) {
  const pattern =
    /^S109_SESSION_STEPS sessions=(\d+) turns=(\d+) steps=(\d+) rounds=(\d+) snapshots=(\d+) distinct_fingerprints=(\d+) staged_changes=(\d+) double_writers=(\d+) config_applied_mid_step=(\d+) fingerprint=([0-9a-f]{64}) elapsed_ms=(\d+)$/
  if (!pattern.test(line)) {
    throw new Error("S109 Cargo output must contain exact session acceptance evidence")
  }
  const match = pattern.exec(line)!
  const sessions = Number(match[1])
  const turns = Number(match[2])
  const steps = Number(match[3])
  const rounds = Number(match[4])
  const snapshots = Number(match[5])
  const distinct = Number(match[6])
  const stagedChanges = Number(match[7])

  if (sessions < 2 || turns < sessions || steps < turns) {
    throw new Error("S109 evidence does not describe many sessions taking many steps")
  }
  // Rounds are what distinguish a retry from a new step. A run with none never
  // tested the rule that a retry keeps the configuration it started with.
  if (rounds < 1) {
    throw new Error("S109 evidence never exercised a retry round")
  }
  // Every snapshot must be unique. Two steps sharing a fingerprint would mean
  // the snapshot does not actually identify the step it describes.
  if (snapshots < 1 || distinct !== snapshots) {
    throw new Error("S109 evidence reports two steps with the same snapshot fingerprint")
  }
  // Staging that never changed anything would make the boundary rule vacuous.
  if (stagedChanges < 1) {
    throw new Error("S109 evidence never staged a configuration that differed")
  }
  if (Number(match[8]) !== 0) {
    throw new Error("S109 evidence reports a session with two writers")
  }
  if (Number(match[9]) !== 0) {
    throw new Error("S109 evidence reports a configuration applied inside a live step")
  }
  if (Number(match[11]) > timeoutMs) {
    throw new Error("S109 session evidence exceeded its gate timeout")
  }
}

if (import.meta.main) {
  const exitCode = await runS109SessionGates()
  if (exitCode !== 0) process.exit(exitCode)
}
