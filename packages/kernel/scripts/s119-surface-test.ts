import {
  acceptanceEvidence,
  runCargoGateByName,
  runCargoGateFamily,
  type CargoGate,
  type GateFamily,
} from "./bounded-gate"
import type { PreparedCargoContext } from "./contracts"

const SURFACE_PARENT_GATE = "ABDO_SURFACE_PARENT_GATE"
const SURFACE_PARENT_GATES = [SURFACE_PARENT_GATE] as const

export type S119SurfaceGateName = "surfaces"

const SURFACE_GATE_TIMEOUT_MS = 5 * 60_000

const SURFACE_GATES: readonly CargoGate[] = [
  {
    name: "surfaces",
    parentEnvironment: SURFACE_PARENT_GATE,
    packageName: "abdo-runtime",
    testTarget: "surface_gate",
    testName: "a_surface_that_moved_admits_nothing_that_was_decided_before_it_did",
    timeoutMs: SURFACE_GATE_TIMEOUT_MS,
  },
]

const SURFACE_FAMILY: GateFamily = {
  label: "S119",
  parentEnvironments: SURFACE_PARENT_GATES,
  gates: SURFACE_GATES,
  validate: (name, output) => validateS119SurfaceGateOutput(name as S119SurfaceGateName, output),
}

export function runS119SurfaceGates(preparedContext?: PreparedCargoContext) {
  return runCargoGateFamily(SURFACE_FAMILY, preparedContext)
}

export async function runS119SurfaceGate(
  name: S119SurfaceGateName,
  preparedContext?: PreparedCargoContext,
) {
  return runCargoGateByName(SURFACE_FAMILY, name, preparedContext)
}

function surfaceGateByName(name: S119SurfaceGateName) {
  const gate = SURFACE_GATES.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error("unknown S119 surface gate")
  return gate
}

export function validateS119SurfaceGateOutput(name: S119SurfaceGateName, output: string) {
  const gate = surfaceGateByName(name)
  validateSurfaceEvidence(acceptanceEvidence("S119", gate.testName, output), gate.timeoutMs)
}

const EVIDENCE_PATTERN =
  /^S119_SURFACE surfaces=(\d+) fresh_admitted=(\d+) stale_attempts=(\d+) stale_admitted=(\d+) navigated=(\d+) reframed=(\d+) scrolled=(\d+) unknown=(\d+) wrong_kind=(\d+) recovered=(\d+) admitted=(\d+) refused=(\d+) elapsed_ms=(\d+)$/

function validateSurfaceEvidence(line: string, timeoutMs: number) {
  const match = EVIDENCE_PATTERN.exec(line)
  if (match === null) {
    throw new Error("S119 Cargo output must contain exact surface acceptance evidence")
  }
  const field = (index: number) => Number(match[index])

  const surfaces = field(1)
  if (surfaces < 100) throw new Error("S119 evidence swept too few surfaces")
  // Everything current must be admitted, or every later refusal is suspect: a
  // registry that refuses everything reports a perfect zero.
  if (field(2) !== surfaces) throw new Error("S119 evidence refused an action that was current")

  const attempts = field(3)
  if (attempts < surfaces) {
    throw new Error("S119 evidence attempted too little staleness for zero to mean anything")
  }
  if (field(4) !== 0) throw new Error("S119 evidence shows a stale action running")

  // Each of the three generations moved on its own, so no comparison can stand
  // in for another while the total still reads zero.
  for (const [index, what] of [
    [5, "a navigation"],
    [6, "a window generation"],
    [7, "a view generation"],
    [8, "a withdrawn surface"],
    [9, "an action for the other kind of surface"],
  ] as const) {
    if (field(index) < 1) throw new Error(`S119 evidence never refused ${what}`)
  }
  if (field(5) + field(6) + field(7) + field(8) + field(9) !== attempts) {
    throw new Error("S119 evidence lost a stale attempt between the attempt and its refusal")
  }

  // Staleness is not a death sentence. A caller that caught up runs, and
  // without this the gate would be satisfied by a registry that refused all.
  if (field(10) < 1) throw new Error("S119 evidence shows no caller ever catching up")
  if (field(12) !== attempts) throw new Error("S119 the registry counted a different number of refusals")

  if (field(13) > timeoutMs) throw new Error("S119 surface evidence exceeded its gate timeout")
}

if (import.meta.main) {
  const exitCode = await runS119SurfaceGates()
  if (exitCode !== 0) process.exit(exitCode)
}
