import {
  acceptanceEvidence,
  runCargoGateByName,
  runCargoGateFamily,
  type CargoGate,
  type GateFamily,
} from "./bounded-gate"
import type { PreparedCargoContext } from "./contracts"

const CRASH_PARENT_GATE = "ABDO_RUNTIME_CRASH_BOUNDARIES_PARENT_GATE"
const SUPERVISOR_PARENT_GATES = [CRASH_PARENT_GATE] as const

export type S107SupervisorGateName = "crashBoundaries" | "noBlindRetry"

const CRASH_GATE_TIMEOUT_MS = 5 * 60_000
const RETRY_GATE_TIMEOUT_MS = 5 * 60_000

const SUPERVISOR_GATES: readonly CargoGate[] = [
  {
    name: "crashBoundaries",
    parentEnvironment: CRASH_PARENT_GATE,
    packageName: "abdo-runtime",
    testTarget: "crash_boundaries",
    testName: "a_crash_at_every_boundary_never_dispatches_twice",
    features: "test-hooks",
    timeoutMs: CRASH_GATE_TIMEOUT_MS,
  },
  {
    name: "noBlindRetry",
    parentEnvironment: CRASH_PARENT_GATE,
    packageName: "abdo-runtime",
    testTarget: "no_blind_retry",
    testName: "an_unknown_outcome_can_never_be_turned_back_into_a_dispatch",
    features: "test-hooks",
    timeoutMs: RETRY_GATE_TIMEOUT_MS,
  },
]

const SUPERVISOR_FAMILY: GateFamily = {
  label: "S107",
  parentEnvironments: SUPERVISOR_PARENT_GATES,
  gates: SUPERVISOR_GATES,
  validate: (name, output) =>
    validateS107SupervisorGateOutput(name as S107SupervisorGateName, output),
}

export function runS107SupervisorGates(preparedContext?: PreparedCargoContext) {
  return runCargoGateFamily(SUPERVISOR_FAMILY, preparedContext)
}

export async function runS107SupervisorGate(
  name: S107SupervisorGateName,
  preparedContext?: PreparedCargoContext,
) {
  return runCargoGateByName(SUPERVISOR_FAMILY, name, preparedContext)
}

function supervisorGateByName(name: S107SupervisorGateName) {
  const gate = SUPERVISOR_GATES.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error("unknown S107 supervisor gate")
  return gate
}

export function validateS107SupervisorGateOutput(name: S107SupervisorGateName, output: string) {
  const gate = supervisorGateByName(name)
  const evidence = acceptanceEvidence("S107", gate.testName, output)
  if (name === "crashBoundaries") validateCrashBoundaryEvidence(evidence, gate.timeoutMs)
  else validateNoBlindRetryEvidence(evidence, gate.timeoutMs)
}

function validateCrashBoundaryEvidence(line: string, timeoutMs: number) {
  const pattern =
    /^S107_CRASH_BOUNDARIES boundaries=(\d+) distinct_states=(\d+) resumable=(\d+) unknown=(\d+) awaiting=(\d+) max_dispatches=(\d+) elapsed_ms=(\d+)$/
  if (!pattern.test(line)) {
    throw new Error("S107 Cargo output must contain exact crash-boundary acceptance evidence")
  }
  const match = pattern.exec(line)!
  const boundaries = Number(match[1])
  const distinctStates = Number(match[2])
  const resumable = Number(match[3])
  const unknown = Number(match[4])
  const awaiting = Number(match[5])
  if (boundaries < 7 || resumable + unknown + awaiting !== boundaries) {
    throw new Error("S107 crash evidence does not account for every declared boundary")
  }
  // Counting boundaries is not the same as covering them. Two names for one
  // observable situation would let the gate report seven while testing five,
  // which is what it did before the adapter call was split from its record.
  if (distinctStates !== boundaries) {
    throw new Error("S107 declared boundaries are not all distinguishable, so coverage is overstated")
  }
  // A run that never reached the unknown case never crossed the durable
  // dispatch barrier, and so proved nothing about the only boundary that
  // matters.
  if (unknown < 1 || resumable < 1 || awaiting < 1) {
    throw new Error("S107 crash evidence must exercise resume, unknown outcome and settlement")
  }
  if (Number(match[6]) !== 1) {
    throw new Error("S107 crash evidence must bound the adapter at exactly one invocation")
  }
  if (Number(match[7]) > timeoutMs) throw new Error("S107 crash evidence exceeded its gate timeout")
}

function validateNoBlindRetryEvidence(line: string, timeoutMs: number) {
  const pattern = /^S107_NO_BLIND_RETRY dispatches=(\d+) refusals=(\d+) phases=(\d+) elapsed_ms=(\d+)$/
  if (!pattern.test(line)) {
    throw new Error("S107 Cargo output must contain exact no-blind-retry acceptance evidence")
  }
  const match = pattern.exec(line)!
  if (Number(match[1]) !== 1) {
    throw new Error("S107 retry evidence must prove the adapter ran exactly once")
  }
  if (Number(match[2]) < 1) {
    throw new Error("S107 retry evidence must record at least one refused route back to dispatch")
  }
  if (Number(match[3]) < 1) {
    throw new Error("S107 retry evidence must show a durable phase ledger")
  }
  if (Number(match[4]) > timeoutMs) throw new Error("S107 retry evidence exceeded its gate timeout")
}

if (import.meta.main) {
  const exitCode = await runS107SupervisorGates()
  if (exitCode !== 0) process.exit(exitCode)
}
