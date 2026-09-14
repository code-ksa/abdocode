/**
 * The Builder → Verifier loop (Sprint 27).
 *
 * The contract says what a verifier may receive; this is what hands it over,
 * and what happens when the answer is no.
 *
 * The packet is assembled from world facts that were passed in — a diff, the
 * checks that ran, the receipts. Nothing here reads a `message.*` event, and
 * there is no parameter through which a builder's account of its own work
 * could arrive. That is the blindness: not a filter applied to the builder's
 * words, but an exchange those words have no route into.
 *
 * Feedback travels the OTHER way freely. A rejection that will not say what is
 * wrong just produces the same diff again, so unmet criteria and the verifier's
 * reasons go back to the builder in full. The asymmetry is deliberate:
 * justification must not flow toward the judge, and criticism must flow toward
 * the worker.
 */
import {
  VerificationEventTypes,
  applyJudgement,
  currentVerdict,
  mechanicalVerdict,
  passIsEarned,
  type AcceptanceCriterion,
  type CheckOutcome,
  type DiffSummary,
  type EvidencePacket,
  type VerificationRecord,
} from "@abdo/contracts/verification"
import type { EventStore } from "@abdo/event-store"

/** How much check output travels with the packet. */
const OUTPUT_TAIL = 4000

export interface PacketSources {
  readonly packetId: string
  readonly sprintId: string
  readonly taskId?: string
  readonly builderRunId: string
  readonly acceptance: readonly AcceptanceCriterion[]
  readonly diff: DiffSummary
  readonly checks: readonly CheckOutcome[]
  readonly receipts?: readonly string[]
}

/**
 * Assemble the packet.
 *
 * Every field is copied explicitly. A spread would carry whatever a caller
 * happened to attach, which is exactly the leak this sprint exists to close —
 * an extra property nobody declared is how "just a small note from the builder"
 * arrives.
 */
export function buildEvidencePacket(sources: PacketSources, now: () => number = Date.now): EvidencePacket {
  return {
    packetId: sources.packetId,
    sprintId: sources.sprintId,
    ...(sources.taskId !== undefined ? { taskId: sources.taskId } : {}),
    builderRunId: sources.builderRunId,
    acceptance: sources.acceptance.map((c) => ({ id: c.id, text: c.text, checks: [...c.checks] })),
    diff: {
      files: sources.diff.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed, status: f.status })),
      ...(sources.diff.patch !== undefined ? { patch: sources.diff.patch } : {}),
    },
    checks: sources.checks.map((c) => ({
      checkId: c.checkId,
      command: c.command,
      exitCode: c.exitCode,
      passed: c.passed,
      ...(c.output !== undefined ? { output: c.output.slice(-OUTPUT_TAIL) } : {}),
    })),
    receipts: [...(sources.receipts ?? [])],
    builtAt: now(),
  }
}

/**
 * Which of `phrases` appears anywhere in the packet.
 *
 * An audit, not a filter. The honest limit is worth stating: a builder can
 * write "this definitely works" into a source comment and the diff will carry
 * it, because the diff is what the builder actually did and censoring it would
 * be worse. What the rule prevents is that sentence COUNTING as evidence — a
 * criterion is met by a check, never by prose, wherever the prose sits.
 */
export function narrativeLeak(packet: EvidencePacket, phrases: readonly string[]): string[] {
  const haystack = JSON.stringify(packet).toLowerCase()
  return phrases.filter((p) => p.trim().length > 0 && haystack.includes(p.toLowerCase()))
}

export interface VerificationLedgerOptions {
  readonly store: EventStore
  /** Verdicts live on the mission, because the sprint they judge does. */
  readonly missionId: string
}

export class VerificationLedger {
  constructor(private readonly options: VerificationLedgerOptions) {}

  private append(type: string, data: Record<string, unknown>): Promise<unknown> {
    return this.options.store.append({
      aggregateKind: "mission",
      aggregateId: this.options.missionId,
      type,
      data: { missionId: this.options.missionId, ...data },
    })
  }

  async recordPacket(packet: EvidencePacket): Promise<void> {
    // the packet's SHAPE, not its contents — a patch belongs in the exchange,
    // not duplicated into the permanent log of every sprint
    await this.append(VerificationEventTypes.PacketBuilt, {
      packetId: packet.packetId,
      sprintId: packet.sprintId,
      builderRunId: packet.builderRunId,
      criteria: packet.acceptance.map((c) => c.id),
      files: packet.diff.files.map((f) => f.path),
      checks: packet.checks.map((c) => ({ checkId: c.checkId, passed: c.passed, exitCode: c.exitCode })),
      receipts: packet.receipts,
    })
  }

  async recordVerdict(verdict: {
    sprintId: string
    packetId: string
    builderRunId: string
    verifierRunId: string
    decision: "verified" | "rejected" | "inconclusive"
    unmet: readonly string[]
    reasons: readonly string[]
  }): Promise<void> {
    await this.append(VerificationEventTypes.Verdict, { ...verdict, unmet: [...verdict.unmet], reasons: [...verdict.reasons] })
  }

  async refuse(detail: { sprintId: string; packetId: string; runId: string; reason: string }): Promise<void> {
    await this.append(VerificationEventTypes.Refused, detail)
  }

  async escalate(detail: { sprintId: string; rounds: number; reason: string; unmet: readonly string[] }): Promise<void> {
    await this.append(VerificationEventTypes.Escalated, { ...detail, unmet: [...detail.unmet] })
  }

  async verdicts(sprintId: string): Promise<VerificationRecord | undefined> {
    return currentVerdict(await this.options.store.read("mission", this.options.missionId), sprintId)
  }
}

/** What comes back to the builder after a rejection — and nothing else. */
export interface BuilderFeedback {
  readonly round: number
  readonly unmet: readonly { readonly id: string; readonly text: string }[]
  readonly reasons: readonly string[]
}

export interface BuilderRound {
  readonly runId: string
  readonly diff: DiffSummary
  readonly checks: readonly CheckOutcome[]
  readonly receipts?: readonly string[]
}

export interface VerifierJudgement {
  readonly runId: string
  readonly decision: "verified" | "rejected"
  readonly unmet?: readonly string[]
  readonly reasons?: readonly string[]
}

export interface VerificationLoopOptions {
  readonly ledger: VerificationLedger
  readonly sprintId: string
  readonly taskId?: string
  readonly acceptance: readonly AcceptanceCriterion[]
  /** Rounds before the loop stops and asks for a human. Default 3. */
  readonly maxRounds?: number
  readonly build: (feedback?: BuilderFeedback) => Promise<BuilderRound>
  readonly judge: (packet: EvidencePacket) => Promise<VerifierJudgement>
  readonly now?: () => number
}

export interface VerificationLoopResult {
  readonly outcome: "verified" | "escalated"
  readonly rounds: number
  readonly verdict?: VerificationRecord
  readonly reason?: string
  /** The feedback each round sent back, for anyone reading the loop later. */
  readonly history: readonly { readonly round: number; readonly decision: string; readonly unmet: readonly string[] }[]
}

/**
 * Failure signature — what makes two rounds "the same failure".
 *
 * Unmet criteria plus the checks that failed. Reasons are excluded on purpose:
 * a model rewords itself constantly, and a signature that changes when the
 * prose changes would never detect a loop.
 */
const signatureOf = (unmet: readonly string[], checks: readonly CheckOutcome[]): string =>
  JSON.stringify([[...unmet].sort(), checks.filter((c) => !c.passed).map((c) => c.checkId).sort()])

/**
 * Run builder and verifier until the evidence earns a pass, or a human is
 * needed.
 *
 * Escalation happens for two reasons, and the second one matters more: rounds
 * exhausted, or the SAME failure twice in a row. Re-running an identical
 * failure is a loop rather than an attempt, and burning the remaining budget on
 * it only delays the moment somebody notices.
 */
export async function runVerificationLoop(options: VerificationLoopOptions): Promise<VerificationLoopResult> {
  const maxRounds = options.maxRounds ?? 3
  const now = options.now ?? Date.now
  const history: { round: number; decision: string; unmet: readonly string[] }[] = []
  let feedback: BuilderFeedback | undefined
  let lastSignature: string | undefined

  for (let round = 1; round <= maxRounds; round++) {
    const built = await options.build(feedback)
    const packet = buildEvidencePacket(
      {
        packetId: `pkt_${options.sprintId}_${round}`,
        sprintId: options.sprintId,
        ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
        builderRunId: built.runId,
        acceptance: options.acceptance,
        diff: built.diff,
        checks: built.checks,
        ...(built.receipts !== undefined ? { receipts: built.receipts } : {}),
      },
      now,
    )
    await options.ledger.recordPacket(packet)

    const judgement = await options.judge(packet)

    // The one thing a verifier cannot be: the builder. Refused rather than
    // discounted — a self-verdict that still counted a little would be worse
    // than one that counted fully, because nobody would look at it.
    if (judgement.runId === built.runId) {
      await options.ledger.refuse({
        sprintId: options.sprintId,
        packetId: packet.packetId,
        runId: judgement.runId,
        reason: "the run that built the work cannot be the run that verifies it",
      })
      await options.ledger.escalate({
        sprintId: options.sprintId,
        rounds: round,
        reason: "no independent verifier was available",
        unmet: options.acceptance.map((c) => c.id),
      })
      return {
        outcome: "escalated",
        rounds: round,
        reason: "the run that built the work cannot be the run that verifies it",
        history,
      }
    }

    const floor = mechanicalVerdict(packet)
    const final = applyJudgement(floor, judgement)
    await options.ledger.recordVerdict({
      sprintId: options.sprintId,
      packetId: packet.packetId,
      builderRunId: built.runId,
      verifierRunId: judgement.runId,
      decision: final.decision,
      unmet: final.unmet,
      reasons: final.reasons,
    })
    history.push({ round, decision: final.decision, unmet: final.unmet })

    if (final.decision === "verified") {
      return { outcome: "verified", rounds: round, verdict: await options.ledger.verdicts(options.sprintId), history }
    }

    const signature = signatureOf(final.unmet, built.checks)
    if (signature === lastSignature) {
      const reason = `round ${round} failed exactly as round ${round - 1} did — retrying an identical failure is a loop, not an attempt`
      await options.ledger.escalate({ sprintId: options.sprintId, rounds: round, reason, unmet: final.unmet })
      return { outcome: "escalated", rounds: round, reason, verdict: await options.ledger.verdicts(options.sprintId), history }
    }
    lastSignature = signature

    const byId = new Map(options.acceptance.map((c) => [c.id, c]))
    feedback = {
      round: round + 1,
      unmet: final.unmet.map((id) => ({ id, text: byId.get(id)?.text ?? id })),
      reasons: final.reasons,
    }
  }

  const last = await options.ledger.verdicts(options.sprintId)
  const reason = `${maxRounds} rounds did not earn a pass`
  await options.ledger.escalate({
    sprintId: options.sprintId,
    rounds: maxRounds,
    reason,
    unmet: last?.unmet ?? options.acceptance.map((c) => c.id),
  })
  return { outcome: "escalated", rounds: maxRounds, reason, ...(last !== undefined ? { verdict: last } : {}), history }
}

export { passIsEarned }
