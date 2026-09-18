import {
  acceptanceEvidence,
  runCargoGateByName,
  runCargoGateFamily,
  type CargoGate,
  type GateFamily,
} from "./bounded-gate"
import type { PreparedCargoContext } from "./contracts"

const BROKER_PARENT_GATE = "ABDO_BROKER_PARENT_GATE"
const BROKER_PARENT_GATES = [BROKER_PARENT_GATE] as const

export type S115BrokerGateName = "broker"

const BROKER_GATE_TIMEOUT_MS = 5 * 60_000

/** The plan's number: a tool lookup must stay under 100µs at p99. */
const P99_LOOKUP_BUDGET_NS = 100_000

const BROKER_GATES: readonly CargoGate[] = [
  {
    name: "broker",
    parentEnvironment: BROKER_PARENT_GATE,
    packageName: "abdo-runtime",
    testTarget: "broker_gate",
    testName: "ten_thousand_tools_resolve_fast_and_every_one_attests_what_was_enforced",
    timeoutMs: BROKER_GATE_TIMEOUT_MS,
  },
]

const BROKER_FAMILY: GateFamily = {
  label: "S115",
  parentEnvironments: BROKER_PARENT_GATES,
  gates: BROKER_GATES,
  validate: (name, output) => validateS115BrokerGateOutput(name as S115BrokerGateName, output),
}

export function runS115BrokerGates(preparedContext?: PreparedCargoContext) {
  return runCargoGateFamily(BROKER_FAMILY, preparedContext)
}

export async function runS115BrokerGate(
  name: S115BrokerGateName,
  preparedContext?: PreparedCargoContext,
) {
  return runCargoGateByName(BROKER_FAMILY, name, preparedContext)
}

function brokerGateByName(name: S115BrokerGateName) {
  const gate = BROKER_GATES.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error("unknown S115 broker gate")
  return gate
}

export function validateS115BrokerGateOutput(name: S115BrokerGateName, output: string) {
  const gate = brokerGateByName(name)
  validateBrokerEvidence(acceptanceEvidence("S115", gate.testName, output), gate.timeoutMs)
}

const EVIDENCE_PATTERN =
  /^S115_BROKER tools=(\d+) registered=(\d+) catalog=(\d+) world_changing=(\d+) with_recovery=(\d+) full=(\d+) partial=(\d+) unavailable=(\d+) unconfined_registered=(\d+) refused_no_handler=(\d+) refused_duplicate=(\d+) refused_unenforceable=(\d+) p99_lookup_ns=(\d+) max_lookup_ns=(\d+) elapsed_ms=(\d+)$/

function validateBrokerEvidence(line: string, timeoutMs: number) {
  const match = EVIDENCE_PATTERN.exec(line)
  if (match === null) {
    throw new Error("S115 Cargo output must contain exact broker acceptance evidence")
  }
  const field = (index: number) => Number(match[index])

  const tools = field(1)
  const registered = field(2)
  if (tools < 10_000) {
    throw new Error("S115 evidence resolved fewer than the ten thousand tools the plan requires")
  }
  if (registered !== tools || field(3) !== tools) {
    throw new Error("S115 evidence lost a tool between registration and the catalog")
  }

  // Every world-changing class carries a recovery except the irreversible one,
  // which carries evidence instead because there is nothing to compensate. So
  // the recovered population is the world-changing one minus the irreversible
  // fifth, and both have to be non-trivial for either number to mean anything.
  const worldChanging = field(4)
  const withRecovery = field(5)
  if (worldChanging < 1 || withRecovery < 1 || withRecovery >= worldChanging) {
    throw new Error("S115 evidence does not separate recoverable work from irreversible work")
  }

  // Three verdicts, all three reached. A run in which the host answered the
  // same way every time would prove nothing that a boolean could not.
  for (const [index, what] of [
    [6, "fully enforced"],
    [7, "partially enforced"],
    [8, "not enforceable"],
  ] as const) {
    if (field(index) < 1) {
      throw new Error(`S115 evidence never reported a tool as ${what}`)
    }
  }
  if (field(6) + field(7) + field(8) !== registered) {
    throw new Error("S115 evidence registered a tool without attesting what was enforced for it")
  }

  // Refusals, and the offers that make them mean something.
  for (const [index, what] of [
    [9, "a tool admitted on a host that could confine nothing"],
    [10, "a schema offered with no handler"],
    [11, "a tool id offered twice"],
    [12, "irreversible work offered to a host that could not confine it"],
  ] as const) {
    if (field(index) < 1) {
      throw new Error(`S115 evidence never encountered ${what}`)
    }
  }

  const p99 = field(13)
  if (p99 > P99_LOOKUP_BUDGET_NS) {
    throw new Error(`S115 tool lookup p99 was ${p99}ns, over the ${P99_LOOKUP_BUDGET_NS}ns budget`)
  }
  // The maximum is reported and compared too. A p99 inside budget with a wild
  // maximum is a catalog with a cliff in it, and the caller who lands on the
  // cliff does not care that the other 99% were fast.
  if (field(14) < p99) {
    throw new Error("S115 evidence reports a maximum below its own p99")
  }

  if (field(15) > timeoutMs) {
    throw new Error("S115 broker evidence exceeded its gate timeout")
  }
}

if (import.meta.main) {
  const exitCode = await runS115BrokerGates()
  if (exitCode !== 0) process.exit(exitCode)
}
