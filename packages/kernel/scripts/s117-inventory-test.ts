import {
  acceptanceEvidence,
  runCargoGateByName,
  runCargoGateFamily,
  type CargoGate,
  type GateFamily,
} from "./bounded-gate"
import type { PreparedCargoContext } from "./contracts"
import { verifyInventory } from "./inventory"

const WORKER_PARENT_GATE = "ABDO_WORKER_PARENT_GATE"
const WORKER_PARENT_GATES = [WORKER_PARENT_GATE] as const

export type S117WorkerGateName = "worker"

const WORKER_GATE_TIMEOUT_MS = 5 * 60_000

const WORKER_GATES: readonly CargoGate[] = [
  {
    name: "worker",
    parentEnvironment: WORKER_PARENT_GATE,
    packageName: "abdo-tool-worker",
    testTarget: "worker_gate",
    testName: "worker_uses_the_canonical_catalog_and_fails_closed",
    timeoutMs: WORKER_GATE_TIMEOUT_MS,
  },
]

const WORKER_FAMILY: GateFamily = {
  label: "S117",
  parentEnvironments: WORKER_PARENT_GATES,
  gates: WORKER_GATES,
  validate: (name, output) => validateS117WorkerGateOutput(name as S117WorkerGateName, output),
}

export function runS117WorkerGates(preparedContext?: PreparedCargoContext) {
  return runCargoGateFamily(WORKER_FAMILY, preparedContext)
}

export async function runS117WorkerGate(
  name: S117WorkerGateName,
  preparedContext?: PreparedCargoContext,
) {
  return runCargoGateByName(WORKER_FAMILY, name, preparedContext)
}

function workerGateByName(name: S117WorkerGateName) {
  const gate = WORKER_GATES.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error("unknown S117 worker gate")
  return gate
}

export function validateS117WorkerGateOutput(name: S117WorkerGateName, output: string) {
  const gate = workerGateByName(name)
  validateWorkerEvidence(acceptanceEvidence("S117", gate.testName, output), gate.timeoutMs)
}

const EVIDENCE_PATTERN =
  /^S117_WORKER specs=(\d+) admitted=(\d+) classes=(\d+) partial=(\d+) unavailable=(\d+) unknown_refused=(\d+) irreversible_refused=(\d+) malformations=(\d+) elapsed_ms=(\d+)$/

function validateWorkerEvidence(line: string, timeoutMs: number) {
  const match = EVIDENCE_PATTERN.exec(line)
  if (match === null) {
    throw new Error("S117 Cargo output must contain exact worker acceptance evidence")
  }
  const field = (index: number) => Number(match[index])

  const specs = field(1)
  const admitted = field(2)
  if (specs < 100) throw new Error("S117 evidence sent the worker too few specs")
  if (admitted < 1 || admitted >= specs) throw new Error("S117 evidence did not separate admitted work from refusals")
  if (field(3) !== 5) throw new Error("S117 evidence never sent one of the effect classes")
  if (field(4) !== admitted || field(5) !== 0) throw new Error("S117 evidence did not report the exact partial application boundary")
  if (field(6) !== 1) throw new Error("S117 worker did not refuse an unknown handler")
  if (field(7) !== specs - admitted) throw new Error("S117 worker admitted irreversible work without isolation")
  if (field(8) < 2) throw new Error("S117 worker did not reject both malformed and oversized frames")
  if (field(9) > timeoutMs) throw new Error("S117 worker evidence exceeded its gate timeout")
}

/**
 * The inventory half, which runs before the Cargo gate.
 *
 * The converged inventory proves that the former parallel surfaces are gone:
 * every shipped built-in appears once, and every listed built-in is assembled.
 */
export async function verifyToolInventory() {
  const report = await verifyInventory()
  if (report.surfaces !== 1) throw new Error("S117 inventory must cover exactly one owned surface")
  if (report.capabilities !== 6 || report.implementations !== 6 || report.shippedIds !== 6) {
    throw new Error("S117 inventory and the owned registry do not contain the same six built-ins")
  }
  if (report.duplicated !== 0) throw new Error("S117 inventory found a parallel tool implementation")
  return report
}

if (import.meta.main) {
  const exitCode = await runS117WorkerGates()
  if (exitCode !== 0) process.exit(exitCode)
}
