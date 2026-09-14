import {
  acceptanceEvidence,
  runCargoGateByName,
  runCargoGateFamily,
  type CargoGate,
  type GateFamily,
} from "./bounded-gate"
import type { PreparedCargoContext } from "./contracts"

const DISCLOSURE_PARENT_GATE = "ABDO_DISCLOSURE_PARENT_GATE"
const DISCLOSURE_PARENT_GATES = [DISCLOSURE_PARENT_GATE] as const

export type S116DisclosureGateName = "disclosure"

const DISCLOSURE_GATE_TIMEOUT_MS = 5 * 60_000

/** The plan's numbers, in parts per thousand. */
const REQUIRED_SAVING_PERMILLE = 600
const REQUIRED_HIT_PERMILLE = 990

const DISCLOSURE_GATES: readonly CargoGate[] = [
  {
    name: "disclosure",
    parentEnvironment: DISCLOSURE_PARENT_GATE,
    packageName: "abdo-runtime",
    testTarget: "disclosure_gate",
    testName: "a_snapshot_holds_still_while_a_step_sees_a_fraction_of_the_catalog",
    timeoutMs: DISCLOSURE_GATE_TIMEOUT_MS,
  },
]

const DISCLOSURE_FAMILY: GateFamily = {
  label: "S116",
  parentEnvironments: DISCLOSURE_PARENT_GATES,
  gates: DISCLOSURE_GATES,
  validate: (name, output) =>
    validateS116DisclosureGateOutput(name as S116DisclosureGateName, output),
}

export function runS116DisclosureGates(preparedContext?: PreparedCargoContext) {
  return runCargoGateFamily(DISCLOSURE_FAMILY, preparedContext)
}

export async function runS116DisclosureGate(
  name: S116DisclosureGateName,
  preparedContext?: PreparedCargoContext,
) {
  return runCargoGateByName(DISCLOSURE_FAMILY, name, preparedContext)
}

function disclosureGateByName(name: S116DisclosureGateName) {
  const gate = DISCLOSURE_GATES.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error("unknown S116 disclosure gate")
  return gate
}

export function validateS116DisclosureGateOutput(name: S116DisclosureGateName, output: string) {
  const gate = disclosureGateByName(name)
  validateDisclosureEvidence(acceptanceEvidence("S116", gate.testName, output), gate.timeoutMs)
}

const EVIDENCE_PATTERN =
  /^S116_DISCLOSURE tools=(\d+) snapshot=(\d+) arrivals=(\d+) late_visible=(\d+) unchanged=(\d+) full_chars=(\d+) brief_chars=(\d+) step_chars=(\d+) saved_permille=(\d+) budget=(\d+) ceiling=(\d+) beyond_ceiling=(\d+) median_rank=(\d+) p99_rank=(\d+) hit_permille_at_eight=(\d+) hits=(\d+) misses=(\d+) hit_permille=(\d+) considered=(\d+) elapsed_ms=(\d+)$/

function validateDisclosureEvidence(line: string, timeoutMs: number) {
  const match = EVIDENCE_PATTERN.exec(line)
  if (match === null) {
    throw new Error("S116 Cargo output must contain exact disclosure acceptance evidence")
  }
  const field = (index: number) => Number(match[index])

  const tools = field(1)
  if (tools < 10_000) {
    throw new Error("S116 evidence swept too small a catalog to say anything about disclosure")
  }
  if (field(2) !== tools) {
    throw new Error("S116 evidence snapshotted a different catalog than it built")
  }

  // The snapshot held still, and the number only means something because the
  // live catalog moved while the step was running.
  if (field(3) < 1) {
    throw new Error("S116 evidence never moved the catalog, so a still snapshot proves nothing")
  }
  if (field(4) !== 0) {
    throw new Error("S116 evidence shows a tool registered mid-step becoming visible to it")
  }
  // An update changed nothing about what an old run resolves.
  if (field(5) !== tools) {
    throw new Error("S116 evidence shows an update changing what an existing run sees")
  }

  const fullChars = field(6)
  const stepChars = field(8)
  if (stepChars >= fullChars) {
    throw new Error("S116 evidence shows a step costing as much as disclosing everything")
  }
  const saved = field(9)
  if (saved < REQUIRED_SAVING_PERMILLE) {
    throw new Error(
      `S116 disclosure saved ${saved} per thousand characters, under the ${REQUIRED_SAVING_PERMILLE} required`,
    )
  }

  const budget = field(10)
  const ceiling = field(11)
  if (field(12) !== 0) {
    throw new Error("S116 evidence lost tools past its own search ceiling")
  }
  if (budget >= ceiling) {
    throw new Error("S116 evidence needed its whole ceiling, so the budget was not found but hit")
  }
  if (budget < 2) {
    throw new Error("S116 evidence reached its hit rate with one schema, so the queries were exact")
  }

  // Does the ranking earn the budget, or is the budget covering for it? If the
  // search were no better than an arbitrary order, the median rank would sit
  // near the middle of the budget rather than near its start.
  const medianRank = field(13)
  if (medianRank * 4 >= budget) {
    throw new Error(
      `S116 median rank ${medianRank} against a budget of ${budget}: the ranking is not concentrating results`,
    )
  }
  if (field(14) < medianRank) {
    throw new Error("S116 evidence reports a p99 rank below its own median")
  }
  // The curve, not one point on it. A run where a small budget already sufficed
  // would mean the approximate queries were not approximate.
  if (field(15) >= 1_000) {
    throw new Error("S116 evidence reached a perfect hit rate at eight schemas")
  }

  const hits = field(16)
  const misses = field(17)
  if (hits + misses !== tools) {
    throw new Error("S116 evidence lost a query between its hits and its misses")
  }
  if (misses < 1) {
    throw new Error("S116 evidence never missed, so the hit rate measures a map lookup")
  }
  const hitRate = field(18)
  if (hitRate < REQUIRED_HIT_PERMILLE) {
    throw new Error(
      `S116 search found the wanted tool ${hitRate} times per thousand, under the ${REQUIRED_HIT_PERMILLE} required`,
    )
  }

  if (field(20) > timeoutMs) {
    throw new Error("S116 disclosure evidence exceeded its gate timeout")
  }
}

if (import.meta.main) {
  const exitCode = await runS116DisclosureGates()
  if (exitCode !== 0) process.exit(exitCode)
}
