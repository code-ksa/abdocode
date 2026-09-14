import {
  acceptanceEvidence,
  runCargoGateByName,
  runCargoGateFamily,
  type CargoGate,
  type GateFamily,
} from "./bounded-gate"
import type { PreparedCargoContext } from "./contracts"

const AUTHORITY_PARENT_GATE = "ABDO_AUTHORITY_PARENT_GATE"
const AUTHORITY_PARENT_GATES = [AUTHORITY_PARENT_GATE] as const

export type S113AuthorityGateName = "capabilities"

const AUTHORITY_GATE_TIMEOUT_MS = 5 * 60_000

const AUTHORITY_GATES: readonly CargoGate[] = [
  {
    name: "capabilities",
    parentEnvironment: AUTHORITY_PARENT_GATE,
    packageName: "abdo-authority",
    testTarget: "authority_sweep",
    testName: "no_capability_crosses_a_scope_and_no_receipt_outlives_its_boot",
    timeoutMs: AUTHORITY_GATE_TIMEOUT_MS,
  },
]

const AUTHORITY_FAMILY: GateFamily = {
  label: "S113",
  parentEnvironments: AUTHORITY_PARENT_GATES,
  gates: AUTHORITY_GATES,
  validate: (name, output) =>
    validateS113AuthorityGateOutput(name as S113AuthorityGateName, output),
}

export function runS113AuthorityGates(preparedContext?: PreparedCargoContext) {
  return runCargoGateFamily(AUTHORITY_FAMILY, preparedContext)
}

export async function runS113AuthorityGate(
  name: S113AuthorityGateName,
  preparedContext?: PreparedCargoContext,
) {
  return runCargoGateByName(AUTHORITY_FAMILY, name, preparedContext)
}

function authorityGateByName(name: S113AuthorityGateName) {
  const gate = AUTHORITY_GATES.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error("unknown S113 authority gate")
  return gate
}

export function validateS113AuthorityGateOutput(name: S113AuthorityGateName, output: string) {
  const gate = authorityGateByName(name)
  validateAuthorityEvidence(acceptanceEvidence("S113", gate.testName, output), gate.timeoutMs)
}

function validateAuthorityEvidence(line: string, timeoutMs: number) {
  const pattern =
    /^S113_AUTHORITY scopes=(\d+) capabilities=(\d+) own_use=(\d+) cross_attempts=(\d+) cross_honoured=(\d+) receipts=(\d+) boot_refusals=(\d+) pid_refusals=(\d+) seal_refusals=(\d+) tamper_refusals=(\d+) survived_revocation=(\d+) generation=(\d+) elapsed_ms=(\d+)$/
  if (!pattern.test(line)) {
    throw new Error("S113 Cargo output must contain exact authority acceptance evidence")
  }
  const match = pattern.exec(line)!
  const capabilities = Number(match[2])
  const ownUse = Number(match[3])
  const crossAttempts = Number(match[4])
  const receipts = Number(match[6])

  if (capabilities < 100 || ownUse !== capabilities) {
    throw new Error("S113 evidence does not show every capability working for its own scope")
  }
  // Zero crossings only means something if crossings were attempted, and a run
  // with one scope cannot attempt any.
  if (Number(match[1]) < 2 || crossAttempts < capabilities) {
    throw new Error("S113 evidence attempted too few crossings for zero to mean anything")
  }
  if (Number(match[5]) !== 0) {
    throw new Error("S113 evidence reports a capability crossing a scope boundary")
  }
  // Four separate ways to be a different authority, each refused for every
  // receipt. A run where one of them passed would leave that door open.
  if (receipts < 1) throw new Error("S113 evidence issued no receipts")
  for (const [index, what] of [
    [7, "a restart"],
    [8, "a recycled PID"],
    [9, "another authority's key"],
    [10, "an altered receipt"],
  ] as const) {
    if (Number(match[index]) !== receipts) {
      throw new Error(`S113 evidence shows ${what} being accepted`)
    }
  }
  if (Number(match[11]) !== 0) {
    throw new Error("S113 evidence shows something surviving revocation")
  }
  if (Number(match[12]) < 2) {
    throw new Error("S113 evidence never advanced a generation, so revocation went untested")
  }
  if (Number(match[13]) > timeoutMs) {
    throw new Error("S113 authority evidence exceeded its gate timeout")
  }
}

if (import.meta.main) {
  const exitCode = await runS113AuthorityGates()
  if (exitCode !== 0) process.exit(exitCode)
}
