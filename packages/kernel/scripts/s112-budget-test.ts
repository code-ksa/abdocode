import {
  acceptanceEvidence,
  runCargoGateByName,
  runCargoGateFamily,
  type CargoGate,
  type GateFamily,
} from "./bounded-gate"
import type { PreparedCargoContext } from "./contracts"

const BUDGET_PARENT_GATE = "ABDO_RUNTIME_BUDGET_PARENT_GATE"
const BUDGET_PARENT_GATES = [BUDGET_PARENT_GATE] as const

export type S112BudgetGateName = "fencing"

const BUDGET_GATE_TIMEOUT_MS = 5 * 60_000

const BUDGET_GATES: readonly CargoGate[] = [
  {
    name: "fencing",
    parentEnvironment: BUDGET_PARENT_GATE,
    packageName: "abdo-runtime",
    testTarget: "budget_fencing",
    testName: "stale_holders_never_mutate_and_budgets_stop_before_dispatch",
    features: "test-hooks",
    timeoutMs: BUDGET_GATE_TIMEOUT_MS,
  },
]

const BUDGET_FAMILY: GateFamily = {
  label: "S112",
  parentEnvironments: BUDGET_PARENT_GATES,
  gates: BUDGET_GATES,
  validate: (name, output) => validateS112BudgetGateOutput(name as S112BudgetGateName, output),
}

export function runS112BudgetGates(preparedContext?: PreparedCargoContext) {
  return runCargoGateFamily(BUDGET_FAMILY, preparedContext)
}

export async function runS112BudgetGate(
  name: S112BudgetGateName,
  preparedContext?: PreparedCargoContext,
) {
  return runCargoGateByName(BUDGET_FAMILY, name, preparedContext)
}

function budgetGateByName(name: S112BudgetGateName) {
  const gate = BUDGET_GATES.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error("unknown S112 budget gate")
  return gate
}

export function validateS112BudgetGateOutput(name: S112BudgetGateName, output: string) {
  const gate = budgetGateByName(name)
  validateFencingEvidence(acceptanceEvidence("S112", gate.testName, output), gate.timeoutMs)
}

function validateFencingEvidence(line: string, timeoutMs: number) {
  const pattern =
    /^S112_BUDGET_FENCING scopes=(\d+) rounds=(\d+) revocations=(\d+) stale_attempts=(\d+) stale_mutations=(\d+) cleared=(\d+) action_refusals=(\d+) token_refusals=(\d+) charged_actions=(\d+) charged_tokens=(\d+) elapsed_ms=(\d+)$/
  if (!pattern.test(line)) {
    throw new Error("S112 Cargo output must contain exact budget and fencing acceptance evidence")
  }
  const match = pattern.exec(line)!
  const revocations = Number(match[3])
  const staleAttempts = Number(match[4])
  const staleMutations = Number(match[5])
  const cleared = Number(match[6])
  const actionRefusals = Number(match[7])
  const tokenRefusals = Number(match[8])
  const chargedActions = Number(match[9])

  // Zero stale mutations only means something if stale holders tried. A run
  // that revoked nothing would report zero and prove nothing.
  if (revocations < 1 || staleAttempts < 1) {
    throw new Error("S112 evidence never fenced anybody out, so zero stale mutations is vacuous")
  }
  if (staleMutations !== 0) {
    throw new Error("S112 evidence reports a fenced-out holder mutating state")
  }
  // Both refusal paths, not whichever happened to bind first.
  if (actionRefusals < 1 || tokenRefusals < 1) {
    throw new Error("S112 evidence left one budget dimension's refusal path untested")
  }
  // Exact accounting: charges and cleared dispatches must agree.
  if (cleared < 1 || chargedActions !== cleared) {
    throw new Error("S112 evidence shows charges and cleared dispatches disagreeing")
  }
  if (Number(match[11]) > timeoutMs) {
    throw new Error("S112 budget evidence exceeded its gate timeout")
  }
}

if (import.meta.main) {
  const exitCode = await runS112BudgetGates()
  if (exitCode !== 0) process.exit(exitCode)
}
