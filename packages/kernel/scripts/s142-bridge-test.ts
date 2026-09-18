import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  acceptanceEvidence,
  runCargoGateByName,
  runCargoGateFamily,
  type CargoGate,
  type GateFamily,
} from "./bounded-gate"
import type { PreparedCargoContext } from "./contracts"
import { KernelHost, type HostReply } from "../src/host"
import { labelDigest, type Digest, type EffectRequest, type FilesystemHandle, type IntentId } from "../src/generated/contracts"

const BRIDGE_PARENT_GATE = "ABDO_BRIDGE_PARENT_GATE"
const BRIDGE_PARENT_GATES = [BRIDGE_PARENT_GATE] as const

export type S142BridgeGateName = "bridge"

const BRIDGE_GATE_TIMEOUT_MS = 5 * 60_000

const BRIDGE_GATES: readonly CargoGate[] = [
  {
    name: "bridge",
    parentEnvironment: BRIDGE_PARENT_GATE,
    packageName: "abdo-runtime",
    buildPackage: "abdo-kernel-bin",
    testTarget: "bridge_gate",
    testName: "the_bridge_carries_one_effect_and_recovers_a_kill_as_an_unknown_outcome",
    // The one place the feature is opened, and only for the gate that measures
    // it. A host built without it declines every dispatch, by name.
    features: "effectful-dispatch",
    timeoutMs: BRIDGE_GATE_TIMEOUT_MS,
  },
]

const BRIDGE_FAMILY: GateFamily = {
  label: "S142",
  parentEnvironments: BRIDGE_PARENT_GATES,
  gates: BRIDGE_GATES,
  validate: (name, output) => validateS142BridgeGateOutput(name as S142BridgeGateName, output),
}

export function runS142BridgeGates(preparedContext?: PreparedCargoContext) {
  return runCargoGateFamily(BRIDGE_FAMILY, preparedContext)
}

export async function runS142BridgeGate(
  name: S142BridgeGateName,
  preparedContext?: PreparedCargoContext,
) {
  return runCargoGateByName(BRIDGE_FAMILY, name, preparedContext)
}

function bridgeGateByName(name: S142BridgeGateName) {
  const gate = BRIDGE_GATES.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error("unknown S142 bridge gate")
  return gate
}

export function validateS142BridgeGateOutput(name: S142BridgeGateName, output: string) {
  const gate = bridgeGateByName(name)
  validateBridgeEvidence(acceptanceEvidence("S142", gate.testName, output), gate.timeoutMs)
}

const EVIDENCE_PATTERN =
  /^S142_BRIDGE phases=(\d+) verified=(\d+) outcome_matched=(\d+) malformations=(\d+) refusals=(\d+) killed_phases=(\d+) replayed_phases=(\d+) elapsed_ms=(\d+)$/

function validateBridgeEvidence(line: string, timeoutMs: number) {
  const match = EVIDENCE_PATTERN.exec(line)
  if (match === null) throw new Error("S142 Cargo output must contain exact bridge acceptance evidence")
  const field = (index: number) => Number(match[index])

  // Seven, in order. A bridge that returned an answer while the ledger held
  // five phases would have reported success for work nobody can audit.
  if (field(1) !== 7) throw new Error("S142 evidence does not show all seven phases in the ledger")
  if (field(2) !== 1) throw new Error("S142 evidence shows no effect reaching a verified outcome")
  if (field(3) !== 1) throw new Error("S142 evidence shows an outcome digest that is not the object's")

  const malformations = field(4)
  if (malformations < 4) {
    throw new Error("S142 evidence tried too few malformed frames for the refusals to mean anything")
  }
  if (field(5) !== malformations) throw new Error("S142 evidence shows the host answering a frame it should refuse")

  // Four phases before the kill and four after the replay: the committed
  // dispatch survived, and asking again did not add a second one.
  if (field(6) !== 4) throw new Error("S142 evidence does not show a dispatch committed before the kill")
  if (field(7) !== 4) throw new Error("S142 evidence shows a replay advancing the ledger it may only read")

  if (field(8) > timeoutMs) throw new Error("S142 bridge evidence exceeded its gate timeout")
}

/**
 * The half the Cargo gate cannot measure: the engine side.
 *
 * The acceptance asks for an effect that leaves TypeScript, crosses the bridge
 * and comes back, so it is driven from TypeScript. What the Rust gate proves
 * about the ledger, this proves about the client: that it refuses instead of
 * growing, and that a host which dies answers everything it left in flight.
 */
export interface BridgeClientEvidence {
  readonly verified: number
  readonly refusedByCapacity: number
  readonly namedRefusalsOnDeath: number
}

const OBJECT_HANDLE = "b1".repeat(32)
const SEALING_KEY = "5a".repeat(32)

export async function verifyBridgeClient(
  context: PreparedCargoContext,
): Promise<BridgeClientEvidence> {
  const executable = join(
    context.targetDirectory,
    "release",
    process.platform === "win32" ? "abdo-kernel.exe" : "abdo-kernel",
  )
  const directory = mkdtempSync(join(context.root, "bridge-client-"))
  const object = join(directory, "object.txt")
  writeFileSync(object, "the engine asked for this")

  const verified = await carryOneEffect(executable, directory, object)
  const { refusedByCapacity, namedRefusalsOnDeath } = await refuseAndDie(executable, directory, object)
  return { verified, refusedByCapacity, namedRefusalsOnDeath }
}

async function carryOneEffect(executable: string, directory: string, object: string) {
  const host = new KernelHost({
    executable,
    journal: join(directory, "effects.sqlite"),
    bindings: [`${OBJECT_HANDLE}=${object}`],
    sealingKey: SEALING_KEY,
    capacity: 1,
  })
  host.start()
  let reply: HostReply
  try {
    reply = await host.send(readRequest(1))
  } finally {
    await host.close()
  }
  if (reply.kind !== "outcome") {
    throw new Error(`S142 the engine side did not receive an outcome: ${describe(reply)}`)
  }
  if (reply.outcome.tag !== "Verified") {
    throw new Error(`S142 the engine side received ${reply.outcome.tag} rather than a verified read`)
  }
  const outcome = reply.outcome.value
  if (outcome.intent_id !== readRequest(1).intent_id) {
    throw new Error("S142 the outcome named an effect the engine did not ask for")
  }
  if (!sameBytes(outcome.outcome_digest, outcome.postcondition_digest)) {
    throw new Error("S142 the settled outcome and the checked postcondition disagree")
  }
  return 1
}

async function refuseAndDie(executable: string, directory: string, object: string) {
  // A host that stops after committing never answers, so the queue stays full
  // and the client has to refuse rather than grow. Killing it afterwards is
  // what makes the pending call's answer observable: a client that resolved
  // nothing here would leave a caller waiting on a process that is gone.
  const host = new KernelHost({
    executable,
    journal: join(directory, "halted.sqlite"),
    bindings: [`${OBJECT_HANDLE}=${object}`],
    sealingKey: SEALING_KEY,
    capacity: 1,
    stopAfterCommit: true,
  })
  host.start()
  const pending = host.send(readRequest(2))
  const refused = await host.send(readRequest(3))
  if (refused.kind !== "backpressure") {
    throw new Error(`S142 a full client did not refuse: ${describe(refused)}`)
  }
  if (refused.capacity !== 1) throw new Error("S142 the refusal did not say how full the client was")
  if (host.highWater !== 1) throw new Error("S142 the client grew past the capacity it reported")

  await host.kill("the gate killed the host")
  const answered = await pending
  if (answered.kind !== "unreachable") {
    throw new Error(`S142 a call in flight when the host died was answered with ${describe(answered)}`)
  }
  if (answered.reason.length === 0) throw new Error("S142 the host's death was reported without a reason")

  const afterwards = await host.send(readRequest(4))
  if (afterwards.kind !== "unreachable") {
    throw new Error("S142 the client accepted an effect after its host was gone")
  }
  return { refusedByCapacity: 1, namedRefusalsOnDeath: 2 }
}

function readRequest(seed: number): EffectRequest {
  // A fixed clock reading is not needed here: the rule the contract enforces is
  // that a request expires after it was made, and both halves come from the
  // same reading so that stays true however long the gate takes.
  const now = BigInt(Date.now())
  return {
    intent_id: identifier<IntentId>(seed * 16 + 1),
    proposal_id: identifier(seed * 16 + 2),
    cause_event_id: identifier(seed * 16 + 3),
    scope: { tag: "Workspace", value: {} },
    target: { tag: "Filesystem", value: { object: handle(OBJECT_HANDLE) } },
    operation_digest: labelDigest("read-bound-object"),
    args_digest: labelDigest("no-arguments"),
    requested_at_ms: now,
    expires_at_ms: now + 60_000n,
  } as EffectRequest
}

function identifier<T extends bigint>(value: number): T {
  return BigInt(value) as T
}

function handle(hex: string): FilesystemHandle {
  const bytes = new Uint8Array(32)
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes as FilesystemHandle
}

function sameBytes(left: Digest, right: Digest) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function describe(reply: HostReply) {
  return reply.kind === "unreachable" ? `${reply.kind}: ${reply.reason}` : reply.kind
}
