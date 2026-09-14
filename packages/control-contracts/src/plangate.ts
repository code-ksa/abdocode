/**
 * The plan gate (Sprint 26) — nothing changes until something is written down.
 *
 * The rule is simple to state and easy to get wrong in one direction: a gate
 * that fires on everything is a gate people route around, and a gate with a
 * generous exception is not a gate. So there are exactly two ways past it.
 *
 *   1. an APPROVED plan covering this scope, or
 *   2. the fast path — for work small enough that writing a plan would cost
 *      more than the change, and only when nothing protected is involved.
 *
 * The fast path's conditions are declared here and MEASURED, never judged: a
 * bounded number of files already touched, a risk profile of nothing worse than
 * a local write, and none of the protected capabilities. Whenever it is used it
 * says so, with the numbers it used — an exception nobody can audit is an
 * exception that becomes the rule.
 */
import type { Capability } from "./index"
import type { RiskClass } from "./riskclass"

/**
 * Capabilities that always need a plan, whatever their size.
 *
 * These are the four the owner named — migrations, deploys, databases and
 * secrets — expanded to the capability vocabulary, plus the remote and service
 * families, because "restart the service on the server" is not a small change
 * however few files it touches.
 */
export const PROTECTED_CAPABILITIES: readonly Capability[] = [
  "database.write",
  "database.schema",
  "database.drop",
  "cloud.deploy",
  "cloud.delete",
  "cloud.iam",
  "artifact.publish",
  "secret.read",
  "secret.use",
  "secret.write",
  "kubernetes.apply",
  "kubernetes.delete",
  "kubernetes.exec",
  "ssh.exec",
  "ssh.copy",
  "ssh.tunnel",
  "system.service",
  "system.restart",
  "system.disable",
  "git.push",
  "git.force",
  "git.reset",
]

/** Text that means "migration" even when the capability vocabulary cannot say so. */
const MIGRATION_TEXT = /\b(migrat\w*|prisma\s+migrate|alembic|liquibase|flyway|db:push|schema\s*(push|sync))\b/i

export interface FastPathLimits {
  /** How many files the task may already have changed. */
  readonly maxFilesChanged: number
}

export const DEFAULT_FAST_PATH: FastPathLimits = { maxFilesChanged: 3 }

export interface PlanGateInput {
  /** Does this operation change anything at all? A read never needs a plan. */
  readonly mutates: boolean
  readonly classes: readonly RiskClass[]
  readonly capabilities: readonly Capability[]
  /** Normalised command/operation summary, for the migration signal. */
  readonly summary?: string
  /** Files the task has already changed — from the run's own progress. */
  readonly filesChangedSoFar: number
  /** The id of an approved plan covering this scope, when one exists. */
  readonly approvedPlanId?: string
}

/**
 * `ask` is not a softer `deny`, and the difference was measured.
 *
 * FOUND BY THE LIVE CRM RUN (2026-08-24): a run touched its third file — one of
 * them a scratch file it had already deleted — and every mutation after that
 * was denied for the rest of the run. The reason given was "needs a plan", and
 * there is no tool with which an agent can produce one: `approvedPlanId` comes
 * from the caller, before the run starts. So the gate asked for something the
 * agent could not supply, four times, and the run died on the clock with a
 * two-line route never written.
 *
 * A gate that cannot be passed is the failure this codebase has already paid
 * for once, in S105. The size limit means "this is no longer a small change",
 * and the right answer to that is a person looking at it — which is the
 * approval path that already exists. What still denies outright is a PROTECTED
 * aspect: production writes, destructive work, credentials and migrations need
 * a plan, and one human waving through one edit is not a plan.
 */
export type PlanGateDecision = "allow" | "allow_fast_path" | "ask" | "deny"

export interface PlanGateVerdict {
  readonly decision: PlanGateDecision
  readonly reason: string
  /** Which protected thing forced a plan, when one did. */
  readonly protectedBy?: readonly string[]
  readonly planId?: string
}

/** What is protected about this operation, if anything. */
export function protectedAspects(input: PlanGateInput): string[] {
  const found: string[] = []
  for (const capability of input.capabilities) {
    if (PROTECTED_CAPABILITIES.includes(capability)) found.push(capability)
  }
  if (input.summary !== undefined && MIGRATION_TEXT.test(input.summary)) found.push("migration")
  for (const risky of ["production_write", "destructive", "financial", "credential_use"] as RiskClass[]) {
    if (input.classes.includes(risky)) found.push(risky)
  }
  return [...new Set(found)]
}

export function evaluatePlanGate(input: PlanGateInput, limits: FastPathLimits = DEFAULT_FAST_PATH): PlanGateVerdict {
  if (!input.mutates) return { decision: "allow", reason: "reads change nothing, so they need no plan" }

  if (input.approvedPlanId !== undefined) {
    return { decision: "allow", reason: `covered by approved plan ${input.approvedPlanId}`, planId: input.approvedPlanId }
  }

  const protectedBy = protectedAspects(input)
  if (protectedBy.length > 0) {
    return {
      decision: "deny",
      // The refusal states the adaptation, not just the rule. "An approved
      // plan is required" reads, to an agent, as an instruction to write one —
      // and a plan cannot be minted from inside a run: `approvedPlanId` comes
      // from the caller, before the run starts. The correct response to this
      // refusal is to stop pursuing the operation and carry it in the handover
      // as the blocker, so the person who CAN approve a plan sees exactly what
      // was needed. A failure text that does not say so costs a guess per turn.
      reason:
        `this touches ${protectedBy.join(", ")} — refused whatever the size of the change, and no approval ` +
        `available inside this run can unlock it: an approved plan comes from the operator before a run starts. ` +
        `Do not retry this operation; record what you needed it for as your blocker and continue with what ` +
        `remains possible`,
      protectedBy,
    }
  }

  if (input.filesChangedSoFar >= limits.maxFilesChanged) {
    return {
      decision: "ask",
      reason:
        `the fast path allows ${limits.maxFilesChanged} changed file(s) and this task has already changed ` +
        `${input.filesChangedSoFar} — past that it is not a small change, so a person decides this one`,
    }
  }

  return {
    decision: "allow_fast_path",
    reason:
      `fast path: nothing protected, ${input.filesChangedSoFar}/${limits.maxFilesChanged} files changed, ` +
      `classes ${input.classes.join(", ") || "read"}`,
  }
}
