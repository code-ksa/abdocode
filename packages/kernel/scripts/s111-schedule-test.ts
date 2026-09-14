import {
  acceptanceEvidence,
  runCargoGateByName,
  runCargoGateFamily,
  type CargoGate,
  type GateFamily,
} from "./bounded-gate"
import type { PreparedCargoContext } from "./contracts"

const SCHEDULE_PARENT_GATE = "ABDO_RUNTIME_SCHEDULE_PARENT_GATE"
const SCHEDULE_PARENT_GATES = [SCHEDULE_PARENT_GATE] as const

export type S111ScheduleGateName = "decisions"

const SCHEDULE_GATE_TIMEOUT_MS = 5 * 60_000
const REQUIRED_DECISIONS = 100_000

const SCHEDULE_GATES: readonly CargoGate[] = [
  {
    name: "decisions",
    parentEnvironment: SCHEDULE_PARENT_GATE,
    packageName: "abdo-runtime",
    testTarget: "schedule_100k",
    testName: "a_hundred_thousand_decisions_never_overlap_a_write",
    features: "test-hooks",
    timeoutMs: SCHEDULE_GATE_TIMEOUT_MS,
  },
]

const SCHEDULE_FAMILY: GateFamily = {
  label: "S111",
  parentEnvironments: SCHEDULE_PARENT_GATES,
  gates: SCHEDULE_GATES,
  validate: (name, output) => validateS111ScheduleGateOutput(name as S111ScheduleGateName, output),
}

export function runS111ScheduleGates(preparedContext?: PreparedCargoContext) {
  return runCargoGateFamily(SCHEDULE_FAMILY, preparedContext)
}

export async function runS111ScheduleGate(
  name: S111ScheduleGateName,
  preparedContext?: PreparedCargoContext,
) {
  return runCargoGateByName(SCHEDULE_FAMILY, name, preparedContext)
}

function scheduleGateByName(name: S111ScheduleGateName) {
  const gate = SCHEDULE_GATES.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error("unknown S111 schedule gate")
  return gate
}

export function validateS111ScheduleGateOutput(name: S111ScheduleGateName, output: string) {
  const gate = scheduleGateByName(name)
  validateScheduleEvidence(acceptanceEvidence("S111", gate.testName, output), gate.timeoutMs)
}

function validateScheduleEvidence(line: string, timeoutMs: number) {
  const pattern =
    /^S111_SCHEDULE demands=(\d+) admitted=(\d+) batches=(\d+) widest=(\d+) parallel_batches=(\d+) mean_width=([0-9.]+) checked_pairs=(\d+) conflicting_pairs=(\d+) serialized=(\d+) lanes=(\d+) slowest_first_service=(\d+) fingerprint=([0-9a-f]{64}) elapsed_ms=(\d+)$/
  if (!pattern.test(line)) {
    throw new Error("S111 Cargo output must contain exact scheduling acceptance evidence")
  }
  const match = pattern.exec(line)!
  const demands = Number(match[1])
  const admitted = Number(match[2])
  const widest = Number(match[4])
  const parallelBatches = Number(match[5])
  const checkedPairs = Number(match[7])
  const conflicting = Number(match[8])
  const serialized = Number(match[9])
  const lanes = Number(match[10])
  const slowestFirstService = Number(match[11])

  if (demands < REQUIRED_DECISIONS || admitted !== demands) {
    throw new Error(`S111 evidence must schedule exactly ${REQUIRED_DECISIONS} demands, losing none`)
  }
  // Zero conflicts is only meaningful if pairs were actually compared. A run
  // that checked nothing would report zero just as happily.
  if (checkedPairs < demands) {
    throw new Error("S111 evidence checked too few pairs for zero conflicts to mean anything")
  }
  if (conflicting !== 0) {
    throw new Error("S111 evidence reports conflicting work scheduled together")
  }
  // Both halves of the acceptance: the independent must parallelize and the
  // conflicting must serialize. A scheduler that ran everything one at a time
  // would report zero conflicts too.
  if (parallelBatches < 1 || widest < 2) {
    throw new Error("S111 evidence shows nothing ever ran in parallel")
  }
  if (serialized < 1) {
    throw new Error("S111 evidence never deferred anything, so no conflict was exercised")
  }
  // Fairness: every lane served, and none waiting longer than one full round.
  if (lanes < 2 || slowestFirstService > lanes) {
    throw new Error("S111 evidence shows a lane starved behind the others")
  }
  if (Number(match[13]) > timeoutMs) {
    throw new Error("S111 scheduling evidence exceeded its gate timeout")
  }
}

if (import.meta.main) {
  const exitCode = await runS111ScheduleGates()
  if (exitCode !== 0) process.exit(exitCode)
}
