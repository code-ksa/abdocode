import {
  acceptanceEvidence,
  runCargoGateByName,
  runCargoGateFamily,
  type CargoGate,
  type GateFamily,
} from "./bounded-gate"
import type { PreparedCargoContext } from "./contracts"

const CONTROL_PARENT_GATE = "ABDO_RUNTIME_CONTROL_PARENT_GATE"
const CONTROL_PARENT_GATES = [CONTROL_PARENT_GATE] as const

export type S110ControlGateName = "throughput"

const CONTROL_GATE_TIMEOUT_MS = 5 * 60_000
/// The sprint floor. The measured rate is reported so a regression is visible
/// long before it drops through this.
const REQUIRED_PER_SECOND = 500
const CANCEL_P95_CEILING_US = 100_000

const CONTROL_GATES: readonly CargoGate[] = [
  {
    name: "throughput",
    parentEnvironment: CONTROL_PARENT_GATE,
    packageName: "abdo-runtime",
    testTarget: "control_throughput",
    testName: "routing_loses_nothing_and_cancellation_stays_inside_its_budget",
    features: "test-hooks",
    timeoutMs: CONTROL_GATE_TIMEOUT_MS,
  },
]

const CONTROL_FAMILY: GateFamily = {
  label: "S110",
  parentEnvironments: CONTROL_PARENT_GATES,
  gates: CONTROL_GATES,
  validate: (name, output) => validateS110ControlGateOutput(name as S110ControlGateName, output),
}

export function runS110ControlGates(preparedContext?: PreparedCargoContext) {
  return runCargoGateFamily(CONTROL_FAMILY, preparedContext)
}

export async function runS110ControlGate(
  name: S110ControlGateName,
  preparedContext?: PreparedCargoContext,
) {
  return runCargoGateByName(CONTROL_FAMILY, name, preparedContext)
}

function controlGateByName(name: S110ControlGateName) {
  const gate = CONTROL_GATES.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error("unknown S110 control gate")
  return gate
}

export function validateS110ControlGateOutput(name: S110ControlGateName, output: string) {
  const gate = controlGateByName(name)
  validateControlEvidence(acceptanceEvidence("S110", gate.testName, output), gate.timeoutMs)
}

function validateControlEvidence(line: string, timeoutMs: number) {
  const pattern =
    /^S110_CONTROL offered=(\d+) accepted=(\d+) refused=(\d+) displaced=(\d+) lost=(\d+) per_second=(\d+) sessions=(\d+) capacity=(\d+) high_water=(\d+) cancel_trees=(\d+) cancel_nodes=(\d+) cancel_p95_us=(\d+) cancel_max_us=(\d+) elapsed_ms=(\d+)$/
  if (!pattern.test(line)) {
    throw new Error("S110 Cargo output must contain exact control-plane acceptance evidence")
  }
  const match = pattern.exec(line)!
  const offered = Number(match[1])
  const accepted = Number(match[2])
  const refused = Number(match[3])
  const capacity = Number(match[8])
  const highWater = Number(match[9])
  const cancelTrees = Number(match[10])
  const cancelNodes = Number(match[11])

  if (offered < 1_000 || accepted + refused !== offered) {
    throw new Error("S110 evidence does not account for every offered message")
  }
  // A run that never refused anything never met its own bound, and would pass
  // just as happily with an unbounded queue.
  if (refused < 1) {
    throw new Error("S110 evidence never exercised backpressure")
  }
  if (Number(match[5]) !== 0) {
    throw new Error("S110 evidence reports lost messages")
  }
  if (Number(match[6]) < REQUIRED_PER_SECOND) {
    throw new Error(`S110 routing fell below ${REQUIRED_PER_SECOND} events per second`)
  }
  // Bounded memory, stated as the worst moment rather than the moment somebody
  // happened to look.
  if (highWater > capacity || capacity < 1) {
    throw new Error("S110 evidence reports a mailbox deeper than its capacity")
  }
  if (cancelTrees < 1 || cancelNodes <= cancelTrees) {
    throw new Error("S110 cancellation evidence never descended past a tree root")
  }
  if (Number(match[12]) > CANCEL_P95_CEILING_US) {
    throw new Error(`S110 cancellation p95 exceeded ${CANCEL_P95_CEILING_US} microseconds`)
  }
  if (Number(match[14]) > timeoutMs) {
    throw new Error("S110 control evidence exceeded its gate timeout")
  }
}

if (import.meta.main) {
  const exitCode = await runS110ControlGates()
  if (exitCode !== 0) process.exit(exitCode)
}
