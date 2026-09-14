/**
 * S136 — the AbdoFlow runtime: a bounded, classified DAG of signed skills.
 *
 * The sprint's acceptance opens with three prohibitions — no generated JS, no
 * eval, no shell — and the owner refused Code Mode by name because it IS
 * generated JS. So the central design decision is that a flow is DATA all the
 * way down: a step names a registered skill by id and pinned version, and
 * there is no field anywhere in these types that could carry code. The
 * prohibition is not a scanner looking for `eval(`; it is a vocabulary in
 * which the sentence cannot be said. Manifests are validated CLOSED — an
 * unknown field is refused, not ignored — because an ignored field is where a
 * payload waits for the day something starts reading it.
 *
 * WHAT IT BUILDS ON, by name: the DAG is validated by the S132 planner —
 * same `validate`, same cycle reporting by path, no second graph checker. Step
 * effects use the kernel's own EffectClass vocabulary (`read`/`mutate`/
 * `reach`/`spend`), because a second taxonomy of "what does this touch" would
 * drift from the one the ledger enforces. Capabilities are the
 * control-contracts `Capability` strings. And the re-run discipline is the
 * kernel's crash story wearing flow clothes: a completed receipt is skipped, a
 * mutating step with an UNKNOWN prior outcome is refused and handed to
 * reconciliation — never re-run on hope, because "the adapter may have run" is
 * a fact about flows exactly as it is about effects.
 *
 * SIGNATURES ARE A PORT. This runtime does no cryptography and holds no keys:
 * `Voucher` is an interface the host implements against the kernel's sealing,
 * and what is checked here is that a skill's digest was vouched for by a
 * signer this flow trusts. A second signature scheme implemented here in TS
 * would be the weaker copy that gets attacked.
 *
 * CAPABILITIES ARE AN ENVELOPE, FIXED AT CREATION. Every skill declares what
 * it touches; the flow declares its envelope; a skill outside the envelope is
 * refused AT BUILD TIME, before anything runs. Widening the envelope is
 * creating a different flow — there is deliberately no API to grow it in
 * place, for the same reason the budget table's ceiling cannot be raised.
 */

import { Planner } from "./planner"

// ---------------------------------------------------------------------------
// Skills — signed, versioned, expiring, and closed
// ---------------------------------------------------------------------------

/** The kernel's effect vocabulary, mirrored by name rather than reinvented. */
export type StepEffect = "read" | "mutate" | "reach" | "spend"

export interface SkillManifest {
  readonly id: string
  /** Exact version. Flows pin; there are no ranges to float on. */
  readonly version: string
  /** Content digest, computed by whoever registered the skill. */
  readonly digest: string
  /** control-contracts capability strings. What this skill may touch. */
  readonly capabilities: readonly string[]
  readonly effect: StepEffect
  /** Epoch ms. An expired skill is a skill nobody re-reviewed in time. */
  readonly expiresAt: number
}

const MANIFEST_FIELDS = new Set(["id", "version", "digest", "capabilities", "effect", "expiresAt"])
const EFFECTS: readonly StepEffect[] = ["read", "mutate", "reach", "spend"]

export type ManifestVerdict =
  | { readonly ok: true; readonly manifest: SkillManifest }
  | { readonly ok: false; readonly why: string }

/**
 * Validate a manifest, CLOSED.
 *
 * An unknown field is refused rather than ignored. The lessons corpus already
 * paid for this rule once (an unknown front-matter key is a misspelled known
 * one), and here the stakes are higher: an ignored field is exactly where a
 * `script` or `command` payload would sit, harmless until some later consumer
 * starts honouring it. The refusal is what keeps "no generated code" a
 * property of the data rather than a review comment.
 */
export function validateManifest(raw: Record<string, unknown>): ManifestVerdict {
  for (const key of Object.keys(raw)) {
    if (!MANIFEST_FIELDS.has(key)) {
      return {
        ok: false,
        why: `unknown manifest field "${key}" — refused, not ignored: an ignored field is where a payload waits`,
      }
    }
  }
  const { id, version, digest, capabilities, effect, expiresAt } = raw as Partial<SkillManifest>
  if (typeof id !== "string" || id.length === 0) return { ok: false, why: "a skill needs an id" }
  if (typeof version !== "string" || version.length === 0) return { ok: false, why: `${id}: a skill needs an exact version` }
  if (typeof digest !== "string" || digest.length === 0) return { ok: false, why: `${id}: a skill needs a content digest` }
  if (!Array.isArray(capabilities) || capabilities.some((entry) => typeof entry !== "string"))
    return { ok: false, why: `${id}: capabilities must be a list of capability strings` }
  if (!EFFECTS.includes(effect as StepEffect))
    return { ok: false, why: `${id}: effect must be one of ${EFFECTS.join(", ")} — the kernel's vocabulary, not a new one` }
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0)
    return { ok: false, why: `${id}: a skill without an expiry is a skill nobody has to re-review` }
  return { ok: true, manifest: { id, version, digest, capabilities: capabilities as string[], effect: effect as StepEffect, expiresAt } }
}

/**
 * Whoever can say "this digest was signed by this signer".
 *
 * A port, not an implementation: the host answers it against the kernel's
 * sealing key. This file holding key material or hash logic would be a second,
 * weaker signature scheme — the one that gets attacked.
 */
export interface Voucher {
  vouched(digest: string, signer: string): boolean
}

// ---------------------------------------------------------------------------
// The flow — data, bounded, enveloped
// ---------------------------------------------------------------------------

export interface FlowStep {
  readonly id: string
  /** Which skill, exactly. */
  readonly skillId: string
  readonly skillVersion: string
  readonly dependsOn: readonly string[]
}

export interface Flow {
  readonly id: string
  readonly steps: readonly FlowStep[]
  /** The capability envelope, fixed at creation. There is no API to widen it. */
  readonly envelope: readonly string[]
  /** Signers this flow trusts. */
  readonly signers: readonly string[]
}

/** Above this many steps a "flow" is a programme, and programmes get reviewed differently. */
export const STEP_LIMIT = 64

export type BuildVerdict =
  | { readonly ok: true; readonly flow: Flow; readonly order: readonly string[] }
  | { readonly ok: false; readonly why: string }

/**
 * Build a flow: bound it, validate its DAG through the planner, check every
 * skill against the registry, the envelope, its expiry and its signature —
 * all BEFORE anything runs. A flow that cannot be built cannot be half-run.
 */
export function build(
  input: Flow,
  registry: ReadonlyMap<string, SkillManifest>,
  voucher: Voucher,
  now: number,
): BuildVerdict {
  if (input.steps.length === 0) return { ok: false, why: "a flow with no steps runs nothing and proves nothing" }
  if (input.steps.length > STEP_LIMIT)
    return { ok: false, why: `${input.steps.length} steps against a limit of ${STEP_LIMIT} — a flow this size is a programme, and programmes get reviewed differently` }

  // The DAG question already has one answer in this package. S132's validator
  // reports a cycle by its path, and a second graph checker here would be the
  // second implementation this repository keeps paying for.
  const validated = Planner.validate(
    input.steps.map((step) => ({ id: step.id, action: `${step.skillId}@${step.skillVersion}`, dependsOn: step.dependsOn })),
  )
  if (!validated.ok) return { ok: false, why: validated.why }

  const envelope = new Set(input.envelope)
  for (const step of input.steps) {
    const key = `${step.skillId}@${step.skillVersion}`
    const manifest = registry.get(key)
    if (manifest === undefined)
      return { ok: false, why: `step ${step.id} names ${key}, which no registry holds — a flow does not carry code, it names it` }
    if (manifest.expiresAt <= now)
      return { ok: false, why: `step ${step.id}: ${key} expired — an expired skill is one nobody re-reviewed in time, and running it anyway is how reviews stop mattering` }
    const outside = manifest.capabilities.filter((capability) => !envelope.has(capability))
    if (outside.length > 0)
      return {
        ok: false,
        why: `step ${step.id}: ${key} needs ${outside.join(", ")}, outside this flow's envelope — widening the envelope is creating a different flow, on purpose`,
      }
    if (!input.signers.some((signer) => voucher.vouched(manifest.digest, signer)))
      return { ok: false, why: `step ${step.id}: ${key} carries no signature from a signer this flow trusts` }
  }

  // Deterministic order: the ready set, drained. Same-plan-same-order is what
  // makes receipts from a previous run addressable at all.
  const order: string[] = []
  let plan: readonly Planner.Step[] = input.steps.map((step) => ({
    id: step.id,
    action: step.skillId,
    dependsOn: step.dependsOn,
    state: "pending" as const,
  }))
  while (order.length < plan.length) {
    const ready = Planner.ready(plan)
    if (ready.length === 0) return { ok: false, why: "the plan stalled with steps remaining — validate should have caught this" }
    const next = ready[0]!
    order.push(next.id)
    plan = plan.map((step) => (step.id === next.id ? { ...step, state: "done" } : step))
  }

  return { ok: true, flow: input, order }
}

// ---------------------------------------------------------------------------
// Re-run — receipts skip, unknown mutations refuse
// ---------------------------------------------------------------------------

export type ReceiptState = "done" | "unknown"

export interface Receipt {
  readonly stepId: string
  /** The digest of the skill that ran. A receipt from a different version is not a receipt. */
  readonly skillDigest: string
  readonly state: ReceiptState
}

export type StepDisposition =
  | { readonly kind: "skip"; readonly stepId: string; readonly why: string }
  | { readonly kind: "run"; readonly stepId: string }
  | { readonly kind: "refuse"; readonly stepId: string; readonly why: string }

export interface Rerun {
  readonly dispositions: readonly StepDisposition[]
  readonly runs: number
  readonly skips: number
  readonly refusals: number
}

/**
 * What a re-run may do, step by step.
 *
 * The rules, in order of what they protect:
 *
 *   done + same digest      -> SKIP. The receipt is the proof; re-running a
 *                              completed mutation is the double-write the
 *                              acceptance calls an unsafe re-run.
 *   done + different digest -> RUN, and every step downstream runs too. A
 *                              receipt from another version of the skill is a
 *                              receipt for different work.
 *   unknown + mutate/spend  -> REFUSE. The kernel's rule exactly: "the adapter
 *                              may have run" is not an invitation to run it
 *                              again, it is a hand-off to reconciliation.
 *   unknown + read/reach    -> RUN. Reading twice is the cheap kind of unknown.
 *   no receipt              -> RUN.
 *
 * Downstream invalidation is transitive: a step that runs invalidates every
 * dependant's receipt, because their receipts describe outputs of inputs that
 * no longer stand.
 */
export function rerun(
  flow: Flow,
  order: readonly string[],
  registry: ReadonlyMap<string, SkillManifest>,
  receipts: readonly Receipt[],
): Rerun {
  const byStep = new Map(receipts.map((receipt) => [receipt.stepId, receipt]))
  const steps = new Map(flow.steps.map((step) => [step.id, step]))
  const invalidated = new Set<string>()
  const dispositions: StepDisposition[] = []

  for (const stepId of order) {
    const step = steps.get(stepId)!
    const manifest = registry.get(`${step.skillId}@${step.skillVersion}`)!
    const receipt = byStep.get(stepId)
    const upstreamInvalid = step.dependsOn.some((dependency) => invalidated.has(dependency))

    if (receipt === undefined || upstreamInvalid || receipt.skillDigest !== manifest.digest) {
      dispositions.push({ kind: "run", stepId })
      invalidated.add(stepId)
      continue
    }
    if (receipt.state === "done") {
      dispositions.push({ kind: "skip", stepId, why: "a completed receipt with the same digest is the proof; running again is the double-write" })
      continue
    }
    // unknown
    if (manifest.effect === "mutate" || manifest.effect === "spend") {
      dispositions.push({
        kind: "refuse",
        stepId,
        why: `${step.skillId} may already have run and ${manifest.effect}s — the kernel's rule holds here too: hand it to reconciliation, never re-run on hope`,
      })
      invalidated.add(stepId)
      continue
    }
    dispositions.push({ kind: "run", stepId })
    invalidated.add(stepId)
  }

  return {
    dispositions,
    runs: dispositions.filter((entry) => entry.kind === "run").length,
    skips: dispositions.filter((entry) => entry.kind === "skip").length,
    refusals: dispositions.filter((entry) => entry.kind === "refuse").length,
  }
}

export * as Flow from "./flow"
