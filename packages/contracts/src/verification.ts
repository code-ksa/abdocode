/**
 * Builder and Verifier (Sprint 27) — two personas, and only one of them may
 * declare the work done.
 *
 * Every sprint so far has been about the same failure: a claim standing in for
 * evidence. This is that failure at the level of judgement. An agent that has
 * just spent an hour building something is the worst available judge of
 * whether it works, and it is the one with the most persuasive account of why
 * it does. So the account is removed from the exchange entirely.
 *
 * The verifier receives an EVIDENCE PACKET: acceptance criteria written before
 * the work, the diff the work actually produced, the checks that actually ran,
 * and the receipts. There is no field in it for the builder's reasoning —
 * you cannot leak what there is nowhere to put — and the packet is built from
 * world facts only, never from a single `message.*` event.
 *
 * Two rules make the separation load-bearing rather than decorative:
 *
 *   1. A criterion is met only if a CHECK demonstrates it. A criterion nothing
 *      checked is `inconclusive`, and inconclusive is not a pass.
 *   2. Judgement may REFUSE, never BLESS. The verifier's model can reject work
 *      the mechanical floor found clean; it cannot promote an inconclusive or
 *      failed packet to verified. That asymmetry is the whole point: the thing
 *      that can be talked into a yes is only allowed to say no.
 */
import type { DomainEvent } from "./event"

export const VerificationEventTypes = {
  PacketBuilt: "verification.packet_built",
  Verdict: "verification.verdict",
  Escalated: "verification.escalated",
  /** A verdict was refused because the persona had no standing to give it. */
  Refused: "verification.refused",
} as const

/** What the check actually did, as the world reported it. */
export interface CheckOutcome {
  /** Stable id a criterion can point at. */
  readonly checkId: string
  /** The command as run, for a human reading the packet later. */
  readonly command: string
  readonly exitCode: number | null
  readonly passed: boolean
  /** Tail of the output. Truncated by the packet builder, never by the model. */
  readonly output?: string
}

export interface DiffFile {
  readonly path: string
  readonly added: number
  readonly removed: number
  readonly status: "added" | "modified" | "deleted" | "renamed"
}

export interface DiffSummary {
  readonly files: readonly DiffFile[]
  /** The unified diff itself, when one is available. */
  readonly patch?: string
}

/**
 * A criterion, and the checks that are supposed to demonstrate it.
 *
 * The mapping is declared WITH the criterion — before the work — so a builder
 * cannot decide after the fact which of its passing checks proves which
 * requirement.
 */
export interface AcceptanceCriterion {
  readonly id: string
  readonly text: string
  /** checkIds expected to demonstrate this. Empty = nothing demonstrates it. */
  readonly checks: readonly string[]
}

/**
 * Everything the verifier gets, and the only thing it gets.
 *
 * `builderRunId` is an identifier, not an account: it is here so independence
 * can be checked, and an id carries no argument.
 */
export interface EvidencePacket {
  readonly packetId: string
  readonly sprintId: string
  readonly taskId?: string
  readonly builderRunId: string
  readonly acceptance: readonly AcceptanceCriterion[]
  readonly diff: DiffSummary
  readonly checks: readonly CheckOutcome[]
  /** Operation ids / log sequences that back the above. */
  readonly receipts: readonly string[]
  readonly builtAt: number
}

export type VerificationDecision = "verified" | "rejected" | "inconclusive"

export interface VerificationVerdict {
  readonly decision: VerificationDecision
  /** Criterion ids not demonstrated. */
  readonly unmet: readonly string[]
  /** Why, in the verifier's words — this travels BACK to the builder, not in. */
  readonly reasons: readonly string[]
  readonly verifierRunId: string
  readonly packetId: string
  readonly at: number
}

/**
 * The mechanical floor: what the evidence supports before anyone judges it.
 *
 * Computed from the packet alone and deliberately unable to consult anything
 * persuasive. A criterion with no checks is not "probably fine"; it is a
 * criterion nobody demonstrated.
 */
export function mechanicalVerdict(packet: EvidencePacket): {
  decision: VerificationDecision
  unmet: string[]
  reasons: string[]
} {
  const byId = new Map(packet.checks.map((c) => [c.checkId, c]))
  const unmet: string[] = []
  const reasons: string[] = []
  let anyUndemonstrated = false

  if (packet.acceptance.length === 0) {
    return {
      decision: "inconclusive",
      unmet: [],
      reasons: ["the sprint declared no acceptance criteria — there is nothing to verify against"],
    }
  }

  for (const criterion of packet.acceptance) {
    const checks = criterion.checks.map((id) => byId.get(id)).filter((c): c is CheckOutcome => c !== undefined)
    if (criterion.checks.length === 0 || checks.length === 0) {
      unmet.push(criterion.id)
      anyUndemonstrated = true
      reasons.push(`${criterion.id}: no check demonstrates this`)
      continue
    }
    const failed = checks.filter((c) => !c.passed)
    if (failed.length > 0) {
      unmet.push(criterion.id)
      reasons.push(`${criterion.id}: ${failed.map((c) => `${c.command} exited ${c.exitCode}`).join("; ")}`)
    }
  }

  if (unmet.length === 0) return { decision: "verified", unmet, reasons }
  // A failing check is a REJECTION; a missing one is only ignorance, and the
  // two deserve different answers — fix it, versus go and measure it.
  return { decision: anyUndemonstrated ? "inconclusive" : "rejected", unmet, reasons }
}

/**
 * Fold the verifier's judgement onto the floor.
 *
 * Downgrades only. `judgement` may reject a mechanically clean packet — that is
 * the reason a verifier persona exists at all, since a green check suite does
 * not mean the diff did what was asked. It may not raise anything.
 */
export function applyJudgement(
  floor: { decision: VerificationDecision; unmet: string[]; reasons: string[] },
  judgement: { decision: "verified" | "rejected"; unmet?: readonly string[]; reasons?: readonly string[] },
): { decision: VerificationDecision; unmet: string[]; reasons: string[] } {
  if (judgement.decision === "rejected") {
    return {
      decision: "rejected",
      unmet: [...new Set([...floor.unmet, ...(judgement.unmet ?? [])])],
      reasons: [...floor.reasons, ...(judgement.reasons ?? [])],
    }
  }
  // "verified" from the judge grants nothing the evidence did not already earn.
  return floor
}

export interface VerificationRecord {
  readonly sprintId: string
  readonly packetId: string
  readonly builderRunId: string
  readonly verifierRunId: string
  readonly decision: VerificationDecision
  readonly unmet: readonly string[]
  readonly reasons: readonly string[]
  readonly at: number
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
const isDecision = (v: unknown): v is VerificationDecision =>
  v === "verified" || v === "rejected" || v === "inconclusive"

/** Every verdict in a log, in log order. */
export function foldVerifications(events: readonly DomainEvent[]): VerificationRecord[] {
  const out: VerificationRecord[] = []
  for (const event of events) {
    if (event.type !== VerificationEventTypes.Verdict) continue
    const data = (event.data ?? {}) as Record<string, unknown>
    const sprintId = str(data.sprintId)
    const decision = data.decision
    if (sprintId === undefined || !isDecision(decision)) continue
    out.push({
      sprintId,
      packetId: str(data.packetId) ?? "",
      builderRunId: str(data.builderRunId) ?? "",
      verifierRunId: str(data.verifierRunId) ?? "",
      decision,
      unmet: strings(data.unmet),
      reasons: strings(data.reasons),
      at: event.occurredAt,
    })
  }
  return out
}

/**
 * The verdict that currently stands for a sprint — the LAST one in log order.
 *
 * Log order, not timestamp: two verdicts in the same millisecond tie on the
 * clock, and the sprint would then be closed by whichever one the sort happened
 * to leave first. (The trap S26 hit with plan approvals.)
 */
export function currentVerdict(events: readonly DomainEvent[], sprintId: string): VerificationRecord | undefined {
  const all = foldVerifications(events).filter((v) => v.sprintId === sprintId)
  return all[all.length - 1]
}

/** The builder judging itself. Recorded as a fact rather than hidden. */
export const isSelfVerified = (record: VerificationRecord): boolean =>
  record.builderRunId.length > 0 && record.builderRunId === record.verifierRunId

/**
 * May this sprint be called PASSED?
 *
 * Both halves of the gate in one place: the evidence has to say verified, and
 * somebody other than the builder has to be the one saying it.
 */
export function passIsEarned(record: VerificationRecord | undefined): { ok: boolean; why: string } {
  if (record === undefined) return { ok: false, why: "no verification verdict has been recorded for this sprint" }
  if (record.decision === "inconclusive")
    return { ok: false, why: `the evidence is inconclusive: ${record.reasons.join("; ") || "criteria undemonstrated"}` }
  if (record.decision === "rejected")
    return { ok: false, why: `the verifier rejected it: ${record.reasons.join("; ") || "unmet criteria"}` }
  if (isSelfVerified(record))
    return {
      ok: false,
      why: `run ${record.builderRunId} verified its own work — a builder's verdict on itself is not a verification`,
    }
  return { ok: true, why: `verified by run ${record.verifierRunId} against packet ${record.packetId}` }
}
