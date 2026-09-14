import {
  acceptanceEvidence,
  runCargoGateByName,
  runCargoGateFamily,
  type CargoGate,
  type GateFamily,
} from "./bounded-gate"
import type { PreparedCargoContext } from "./contracts"

const RECONCILE_PARENT_GATE = "ABDO_RUNTIME_RECONCILE_PARENT_GATE"
const RECONCILE_PARENT_GATES = [RECONCILE_PARENT_GATE] as const

export type S108ReconcileGateName = "sweep"

const SWEEP_GATE_TIMEOUT_MS = 5 * 60_000

const RECONCILE_GATES: readonly CargoGate[] = [
  {
    name: "sweep",
    parentEnvironment: RECONCILE_PARENT_GATE,
    packageName: "abdo-runtime",
    testTarget: "reconcile_sweep",
    testName: "a_mixed_population_reconciles_once_and_never_dispatches",
    features: "test-hooks",
    timeoutMs: SWEEP_GATE_TIMEOUT_MS,
  },
]

const RECONCILE_FAMILY: GateFamily = {
  label: "S108",
  parentEnvironments: RECONCILE_PARENT_GATES,
  gates: RECONCILE_GATES,
  validate: (name, output) => validateS108ReconcileGateOutput(name as S108ReconcileGateName, output),
}

export function runS108ReconcileGates(preparedContext?: PreparedCargoContext) {
  return runCargoGateFamily(RECONCILE_FAMILY, preparedContext)
}

export async function runS108ReconcileGate(
  name: S108ReconcileGateName,
  preparedContext?: PreparedCargoContext,
) {
  return runCargoGateByName(RECONCILE_FAMILY, name, preparedContext)
}

function reconcileGateByName(name: S108ReconcileGateName) {
  const gate = RECONCILE_GATES.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error("unknown S108 reconcile gate")
  return gate
}

export function validateS108ReconcileGateOutput(name: S108ReconcileGateName, output: string) {
  const gate = reconcileGateByName(name)
  validateSweepEvidence(acceptanceEvidence("S108", gate.testName, output), gate.timeoutMs)
}

function validateSweepEvidence(line: string, timeoutMs: number) {
  const pattern =
    /^S108_RECONCILE_SWEEP effects=(\d+) unconfirmed=(\d+) examined=(\d+) evidenced=(\d+) compensated=(\d+) escalated=(\d+) outstanding=(\d+) dispatches_during_sweep=(\d+) idempotent=(\d+) elapsed_ms=(\d+)$/
  if (!pattern.test(line)) {
    throw new Error("S108 Cargo output must contain exact reconciliation acceptance evidence")
  }
  const match = pattern.exec(line)!
  const effects = Number(match[1])
  const unconfirmed = Number(match[2])
  const examined = Number(match[3])
  const evidenced = Number(match[4])
  const compensated = Number(match[5])
  const escalated = Number(match[6])
  const outstanding = Number(match[7])

  if (effects < 100 || unconfirmed < 1 || examined < unconfirmed) {
    throw new Error("S108 evidence does not describe a population with unconfirmed effects in it")
  }
  // All three conclusions must appear. A sweep that only ever escalated, or
  // only ever found evidence, would leave two of the three branches unmeasured
  // while still reporting a clean run.
  if (evidenced < 1 || compensated < 1 || escalated < 1) {
    throw new Error("S108 evidence must exercise evidence, compensation and escalation")
  }
  if (evidenced + compensated + escalated > examined) {
    throw new Error("S108 evidence reports more conclusions than effects examined")
  }
  // The two headline guarantees, stated as numbers rather than adjectives.
  if (Number(match[8]) !== 0) {
    throw new Error("S108 reconciliation dispatched; blind retry must be zero")
  }
  if (Number(match[9]) !== 1) {
    throw new Error("S108 reconciliation did not prove itself idempotent")
  }
  // Every escalation is still outstanding afterwards: an unconfirmed action
  // that stopped being reported is an unconfirmed action nobody is watching.
  if (outstanding < escalated) {
    throw new Error("S108 evidence lost track of an escalated effect")
  }
  if (Number(match[10]) > timeoutMs) {
    throw new Error("S108 reconciliation evidence exceeded its gate timeout")
  }
}

if (import.meta.main) {
  const exitCode = await runS108ReconcileGates()
  if (exitCode !== 0) process.exit(exitCode)
}
