import {
  acceptanceEvidence,
  runCargoGateByName,
  runCargoGateFamily,
  type CargoGate,
  type GateFamily,
} from "./bounded-gate"
import type { PreparedCargoContext } from "./contracts"

const POLICY_PARENT_GATE = "ABDO_POLICY_PARENT_GATE"
const POLICY_PARENT_GATES = [POLICY_PARENT_GATE] as const

export type S114PolicyGateName = "policy"

const POLICY_GATE_TIMEOUT_MS = 5 * 60_000

const POLICY_GATES: readonly CargoGate[] = [
  {
    name: "policy",
    parentEnvironment: POLICY_PARENT_GATE,
    packageName: "abdo-runtime",
    testTarget: "policy_gate",
    testName: "nothing_widens_its_own_authority_and_every_question_is_answered_in_the_ledger",
    timeoutMs: POLICY_GATE_TIMEOUT_MS,
  },
]

const POLICY_FAMILY: GateFamily = {
  label: "S114",
  parentEnvironments: POLICY_PARENT_GATES,
  gates: POLICY_GATES,
  validate: (name, output) => validateS114PolicyGateOutput(name as S114PolicyGateName, output),
}

export function runS114PolicyGates(preparedContext?: PreparedCargoContext) {
  return runCargoGateFamily(POLICY_FAMILY, preparedContext)
}

export async function runS114PolicyGate(
  name: S114PolicyGateName,
  preparedContext?: PreparedCargoContext,
) {
  return runCargoGateByName(POLICY_FAMILY, name, preparedContext)
}

function policyGateByName(name: S114PolicyGateName) {
  const gate = POLICY_GATES.find((entry) => entry.name === name)
  if (gate === undefined) throw new Error("unknown S114 policy gate")
  return gate
}

export function validateS114PolicyGateOutput(name: S114PolicyGateName, output: string) {
  const gate = policyGateByName(name)
  validatePolicyEvidence(acceptanceEvidence("S114", gate.testName, output), gate.timeoutMs)
}

const EVIDENCE_PATTERN =
  /^S114_POLICY effects=(\d+) allowed=(\d+) denied=(\d+) asked=(\d+) approved=(\d+) refused_no_decision=(\d+) refused_binding=(\d+) refused_expired=(\d+) refused_replay=(\d+) refused_no=(\d+) widened_expired=(\d+) widened_replayed=(\d+) widened_binding=(\d+) widening_attempts=(\d+) widened=(\d+) asked_in_ledger=(\d+) decided_in_ledger=(\d+) unanswered=(\d+) decided_without_asking=(\d+) authorized_reached=(\d+) authorized_without_clearance=(\d+) elapsed_ms=(\d+)$/

function validatePolicyEvidence(line: string, timeoutMs: number) {
  const match = EVIDENCE_PATTERN.exec(line)
  if (match === null) {
    throw new Error("S114 Cargo output must contain exact policy acceptance evidence")
  }
  const field = (index: number) => Number(match[index])

  const effects = field(1)
  const allowed = field(2)
  const denied = field(3)
  const asked = field(4)
  const approved = field(5)

  if (effects < 100) {
    throw new Error("S114 evidence swept too few effects to say anything about a policy")
  }
  // Every branch of the policy has to have been taken. A run that only ever
  // allowed things would report zero widenings and prove nothing about the
  // paths that matter.
  if (allowed < 1 || denied < 1 || approved < 1) {
    throw new Error("S114 evidence never reached one of allow, deny and approve")
  }
  if (asked < approved) {
    throw new Error("S114 evidence approved more than it asked about")
  }

  // Four ways for an operator to fail to approve, each of which must have
  // happened. Fusing them would let one early check satisfy the whole set.
  for (const [index, what] of [
    [6, "an operator who never answered"],
    [7, "an answer to a different question"],
    [8, "an answer that had already run out"],
    [10, "an operator who said no"],
  ] as const) {
    if (field(index) < 1) {
      throw new Error(`S114 evidence never encountered ${what}`)
    }
  }
  // `refused_replay` is deliberately not required here: in the honest half of
  // the sweep every effect carries its own arguments, so a replay cannot arise
  // and requiring one would force the fixture to fake it. The replay path is
  // proven below, where an approval really is presented twice.
  if (field(9) !== 0) {
    throw new Error("S114 honest sweep reported a replay, which its fixtures cannot produce")
  }

  const wideningAttempts = field(14)
  const widened = field(15)
  if (wideningAttempts < 4) {
    throw new Error("S114 evidence attempted too few widenings for zero to mean anything")
  }
  if (widened !== 0) {
    throw new Error("S114 evidence shows an approval being widened onto other work")
  }
  // And each attempt has to have been refused for its own reason, so three of
  // them cannot be stopped by one early check while the total still reads zero.
  for (const [index, what] of [
    [11, "an approval presented after it expired"],
    [12, "an approval presented a second time"],
    [13, "an approval carried to different work"],
  ] as const) {
    if (field(index) < 1) {
      throw new Error(`S114 evidence never refused ${what}`)
    }
  }
  const refusedWidenings = field(11) + field(12) + field(13)
  if (refusedWidenings !== wideningAttempts) {
    throw new Error("S114 evidence lost a widening attempt between the attempt and its refusal")
  }

  // The ledger is the record. A counter that disagrees with it is the counter
  // being wrong, and either direction is a defect: a dropped question, or an
  // answer nobody was asked for.
  if (field(16) !== asked) {
    throw new Error("S114 evidence and its ledger disagree about how many people were asked")
  }
  if (field(18) !== 0) {
    throw new Error("S114 evidence shows a question that was never answered")
  }
  if (field(19) !== allowed + denied) {
    throw new Error("S114 evidence shows an answer for work nobody was asked about")
  }
  // One decision per question asked, plus one for every allowance and every
  // denial, which are decisions nobody was asked for.
  if (field(17) !== allowed + denied + asked) {
    throw new Error("S114 evidence recorded a different number of decisions than it made")
  }

  // Only what policy cleared may reach authorisation, and it all must.
  if (field(20) !== allowed + approved) {
    throw new Error("S114 evidence authorized something other than exactly what policy cleared")
  }
  if (field(21) !== 0) {
    throw new Error("S114 evidence shows an effect authorized without a clearance")
  }

  if (field(22) > timeoutMs) {
    throw new Error("S114 policy evidence exceeded its gate timeout")
  }
}

if (import.meta.main) {
  const exitCode = await runS114PolicyGates()
  if (exitCode !== 0) process.exit(exitCode)
}
