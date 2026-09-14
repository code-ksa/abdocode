import {
  acceptanceEvidence,
  runCargoGateByName,
  runCargoGateFamily,
  type CargoGate,
  type GateFamily,
} from "./bounded-gate"
import type { PreparedCargoContext } from "./contracts"

const SECRET_PARENT_GATE = "ABDO_SECRET_PARENT_GATE"
const SECRET_PARENT_GATES = [SECRET_PARENT_GATE] as const

export type S118SecretGateName = "secrets"

const SECRET_GATE_TIMEOUT_MS = 5 * 60_000

const SECRET_GATES: readonly CargoGate[] = [
  {
    name: "secrets",
    parentEnvironment: SECRET_PARENT_GATE,
    packageName: "abdo-runtime",
    testTarget: "secret_gate",
    testName: "no_decoy_secret_survives_a_full_lifecycle_and_revocation_is_one_number",
    timeoutMs: SECRET_GATE_TIMEOUT_MS,
  },
]

const SECRET_FAMILY: GateFamily = {
  label: "S118",
  parentEnvironments: SECRET_PARENT_GATES,
  gates: SECRET_GATES,
  validate: (name, output) => validateS118SecretGateOutput(name as S118SecretGateName, output),
}

export function runS118SecretGates(preparedContext?: PreparedCargoContext) {
  return runCargoGateFamily(SECRET_FAMILY, preparedContext)
}

export async function runS118SecretGate(
  name: S118SecretGateName,
  preparedContext?: PreparedCargoContext,
) {
  return runCargoGateByName(SECRET_FAMILY, name, preparedContext)
}

function secretGateByName(name: S118SecretGateName) {
  const gate = SECRET_GATES.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error("unknown S118 secret gate")
  return gate
}

export function validateS118SecretGateOutput(name: S118SecretGateName, output: string) {
  const gate = secretGateByName(name)
  validateSecretEvidence(acceptanceEvidence("S118", gate.testName, output), gate.timeoutMs)
}

const EVIDENCE_PATTERN =
  /^S118_SECRETS canaries=(\d+) planted_found=(\d+) journal_bytes=(\d+) effects=(\d+) cleared=(\d+) issued=(\d+) admitted=(\d+) evidence=(\d+) found=(\d+) handles_found=(\d+) generation_before=(\d+) generation_after=(\d+) survived=(\d+) revoked_refusals=(\d+) wrong_consumer=(\d+) wrong_scope=(\d+) expired=(\d+) unknown=(\d+) elapsed_ms=(\d+)$/

function validateSecretEvidence(line: string, timeoutMs: number) {
  const match = EVIDENCE_PATTERN.exec(line)
  if (match === null) {
    throw new Error("S118 Cargo output must contain exact secret acceptance evidence")
  }
  const field = (index: number) => Number(match[index])

  const canaries = field(1)
  if (canaries < 16) throw new Error("S118 evidence planted too few decoys to say anything")

  // The single most important check in this file. A sweep that cannot find a
  // canary it knows is there reports every absence for free, and a broken
  // detector looks exactly like a clean run.
  if (field(2) !== 1) {
    throw new Error("S118 the sweep failed to find a deliberately planted decoy, so its zeroes mean nothing")
  }
  if (field(3) < 4_096) {
    throw new Error("S118 evidence swept a journal too small to have held a lifecycle")
  }

  // And the journal has to have been busy. Sweeping an empty file finds nothing
  // whatever the kernel does with secrets.
  const effects = field(4)
  const cleared = field(5)
  if (effects < 50) throw new Error("S118 evidence ran too few effects past the swept journal")
  if (cleared < Math.floor(effects / 3)) {
    throw new Error("S118 evidence cleared almost nothing, so the swept journal is nearly empty")
  }

  const issued = field(6)
  if (issued !== canaries) throw new Error("S118 evidence issued a different number of leases than decoys")
  if (field(7) !== issued) throw new Error("S118 evidence shows a lease refusing its own consumer")
  if (field(8) !== issued) throw new Error("S118 evidence recorded fewer evidence digests than uses")

  // Neither the decoys nor the handles reached the disk.
  if (field(9) !== 0) throw new Error("S118 evidence shows a decoy secret in the journal")
  if (field(10) !== 0) throw new Error("S118 evidence shows a secret handle in the journal")

  // Revocation is one number going up, and it takes everything with it.
  if (field(12) !== field(11) + 1) throw new Error("S118 revocation is not a single increment")
  if (field(13) !== 0) throw new Error("S118 evidence shows a lease surviving revocation")
  if (field(14) !== issued) throw new Error("S118 evidence shows a lease refused for the wrong reason after revocation")

  // Four ways a lease may not be used, each reached by name so one early check
  // cannot stand in for the rest.
  for (const [index, what] of [
    [15, "the wrong consumer"],
    [16, "the wrong scope"],
    [17, "an expired lease"],
    [18, "a handle that was never issued"],
  ] as const) {
    if (field(index) !== 1) throw new Error(`S118 evidence never refused ${what}`)
  }

  if (field(19) > timeoutMs) throw new Error("S118 secret evidence exceeded its gate timeout")
}

if (import.meta.main) {
  const exitCode = await runS118SecretGates()
  if (exitCode !== 0) process.exit(exitCode)
}
