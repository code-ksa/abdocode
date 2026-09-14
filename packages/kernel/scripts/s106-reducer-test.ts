import {
  acceptanceEvidence,
  runCargoGateByName,
  runCargoGateFamily,
  type CargoGate,
  type GateFamily,
} from "./bounded-gate"
import type { PreparedCargoContext } from "./contracts"

const DETERMINISM_PARENT_GATE = "ABDO_REDUCER_DETERMINISM_PARENT_GATE"
const TRANSITIONS_PARENT_GATE = "ABDO_REDUCER_TRANSITIONS_1M_PARENT_GATE"
const REDUCER_PARENT_GATES = [DETERMINISM_PARENT_GATE, TRANSITIONS_PARENT_GATE] as const

export type S106ReducerGateName = "determinism" | "transitions1m"

const DETERMINISM_GATE_TIMEOUT_MS = 5 * 60_000
const TRANSITIONS_GATE_TIMEOUT_MS = 11 * 60_000

const REDUCER_GATES: readonly CargoGate[] = [
  {
    name: "determinism",
    parentEnvironment: DETERMINISM_PARENT_GATE,
    packageName: "abdo-kernel",
    testTarget: "determinism_1k",
    testName: "folding_one_trace_one_thousand_times_yields_one_fingerprint",
    timeoutMs: DETERMINISM_GATE_TIMEOUT_MS,
  },
  {
    name: "transitions1m",
    parentEnvironment: TRANSITIONS_PARENT_GATE,
    packageName: "abdo-kernel",
    testTarget: "transitions_1m",
    testName: "one_million_transitions_commit_no_illegitimate_effect",
    timeoutMs: TRANSITIONS_GATE_TIMEOUT_MS,
  },
]

const REDUCER_FAMILY: GateFamily = {
  label: "S106",
  parentEnvironments: REDUCER_PARENT_GATES,
  gates: REDUCER_GATES,
  validate: (name, output) => validateS106ReducerGateOutput(name as S106ReducerGateName, output),
}

export function runS106ReducerGates(preparedContext?: PreparedCargoContext) {
  return runCargoGateFamily(REDUCER_FAMILY, preparedContext)
}

export async function runS106ReducerGate(
  name: S106ReducerGateName,
  preparedContext?: PreparedCargoContext,
) {
  return runCargoGateByName(REDUCER_FAMILY, name, preparedContext)
}

function reducerGateByName(name: S106ReducerGateName) {
  const gate = REDUCER_GATES.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error("unknown S106 reducer gate")
  return gate
}

export function validateS106ReducerGateOutput(name: S106ReducerGateName, output: string) {
  const gate = reducerGateByName(name)
  const evidence = acceptanceEvidence("S106", gate.testName, output)
  if (name === "determinism") validateDeterminismEvidence(evidence, gate.timeoutMs)
  else validateTransitionsEvidence(evidence, gate.timeoutMs)
}

function validateDeterminismEvidence(line: string, timeoutMs: number) {
  const pattern =
    /^S106_DETERMINISM replays=(\d+) events=(\d+) proposals=(\d+) effects=(\d+) fingerprint=([0-9a-f]{64}) elapsed_ms=(\d+)$/
  if (!pattern.test(line)) {
    throw new Error("S106 Cargo output must contain exact determinism acceptance evidence")
  }
  const match = pattern.exec(line)!
  if (
    Number(match[1]) !== 1_000 ||
    Number(match[2]) < 1 ||
    Number(match[3]) < 1 ||
    Number(match[4]) < 1 ||
    Number(match[6]) > timeoutMs
  ) {
    throw new Error("S106 determinism evidence does not prove 1,000 replays of a non-empty trace")
  }
}

function validateTransitionsEvidence(line: string, timeoutMs: number) {
  const pattern =
    /^S106_TRANSITIONS_1M transitions=(\d+) accepted=(\d+) rejected=(\d+) effects=(\d+) proposals=(\d+) fingerprint=([0-9a-f]{64}) elapsed_ms=(\d+)$/
  if (!pattern.test(line)) {
    throw new Error("S106 Cargo output must contain exact transition acceptance evidence")
  }
  const match = pattern.exec(line)!
  const transitions = Number(match[1])
  const accepted = Number(match[2])
  const rejected = Number(match[3])
  const effects = Number(match[4])
  if (transitions !== 1_000_000 || accepted + rejected !== transitions) {
    throw new Error("S106 transition evidence does not account for exactly 1,000,000 attempted transitions")
  }
  // A run that never refused anything would prove the reducer can count, not
  // that it can refuse; a run that never committed would prove nothing at all.
  if (rejected < 1 || accepted < 1 || effects < 1) {
    throw new Error("S106 transition evidence must exercise acceptance, refusal and commitment")
  }
  if (effects > accepted) {
    throw new Error("S106 transition evidence reports more effects than accepted transitions")
  }
  if (Number(match[7]) > timeoutMs) {
    throw new Error("S106 transition evidence exceeded its gate timeout")
  }
}

if (import.meta.main) {
  const exitCode = await runS106ReducerGates()
  if (exitCode !== 0) process.exit(exitCode)
}
