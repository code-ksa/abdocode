/**
 * S135 — the team kernel: tasks, mail, ownership, and bounded coordination.
 *
 * Multi-agent work fails in three specific ways, and each one is a rule here
 * rather than a hope:
 *
 * SHARED WRITABLE SPACE. Two agents editing one file produce a merge nobody
 * asked for, and the estate's own memory carries the incident — a second agent
 * in the same repo is why `git add -A` is banned. So writable scope has
 * exactly one owner at a time, ownership moves by explicit transfer, and the
 * board REFUSES a claim that would create a second writer. The acceptance line
 * "shared writable space = 0" is not a measurement of good behaviour; it is a
 * property the data structure cannot violate.
 *
 * CONTEXT COPYING. The cheap way to hand work between agents is to paste one
 * agent's conversation into the other's, and it is the expensive way to fail:
 * the successor inherits the predecessor's confusions verbatim, at full token
 * price. [DeepSeek-7] names the alternative and S134's epochs already live by
 * it — continuity comes from the record, not from a swollen transcript. So a
 * handoff here is STRUCTURED (claims with evidence, not prose), SIZE-BOUNDED
 * (a hard byte budget, enforced at build time, refused when exceeded), and
 * delivered EXACTLY ONCE logically — a second delivery of the same handoff is
 * refused by id, because a successor that ingests the same handoff twice
 * counts its predecessor's work double.
 *
 * COORDINATION EATING THE BUDGET. A team that spends its window talking about
 * the work is a slower single agent. Every message and handoff carries its
 * byte cost, the ledger folds them, and `overhead()` reports coordination as a
 * fraction of everything — the acceptance says ≤15%, and the number is
 * computed from the same records the mail moves through, not self-reported.
 *
 * WHAT THIS BUILDS ON, by name, because the costliest defect class in this
 * repository is the second implementation: tasks are the S132 planner's steps
 * (`Planner.Step` — same ids, same DAG, same readiness), not a second task
 * model; handoff claims cite proof ids in the S127 cognitive frame's ledger
 * rather than restating evidence; and the exactly-once rule is the same shape
 * the kernel's `UNIQUE (intent_id, phase_tag)` holds for effects — refusal by
 * identity, not a flag somebody remembers to check.
 */

import { Planner } from "./planner"

// ---------------------------------------------------------------------------
// Ownership — the zero-shared-space rule
// ---------------------------------------------------------------------------

export type AgentId = string

/**
 * One writable scope, one writer.
 *
 * A scope is a path prefix ("src/auth/", "packages/core/planner.ts"). Nested
 * claims are refused in BOTH directions: an agent claiming "src/auth/login.ts"
 * while another holds "src/auth/" would be a second writer wearing a narrower
 * glove, and the wide claim over a held file is the same thing upside down.
 */
export interface Ownership {
  readonly scope: string
  readonly owner: AgentId
}

const normalise = (scope: string): string => scope.replaceAll("\\", "/").replace(/\/+$/, "")

const overlaps = (a: string, b: string): boolean => {
  const left = normalise(a)
  const right = normalise(b)
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

export type Claim =
  | { readonly ok: true; readonly ownership: Ownership }
  | { readonly ok: false; readonly why: string; readonly holder: AgentId }

/**
 * Claim a writable scope.
 *
 * Refusal names the holder, because "claim refused" sends an agent to retry
 * and "held by reviewer-2 as packages/core/" sends it to coordinate or wait.
 */
export const claim = (held: readonly Ownership[], scope: string, agent: AgentId): Claim => {
  const conflicting = held.find((entry) => overlaps(entry.scope, scope))
  if (conflicting !== undefined && conflicting.owner !== agent) {
    return {
      ok: false,
      holder: conflicting.owner,
      why: `${scope} overlaps ${conflicting.scope}, held by ${conflicting.owner} — a second writer is how merges nobody asked for happen`,
    }
  }
  return { ok: true, ownership: { scope: normalise(scope), owner: agent } }
}

/**
 * Release everything an agent holds. An epoch that ends releases its scopes;
 * holding a lock from beyond the grave is how the next epoch starves.
 */
export const release = (held: readonly Ownership[], agent: AgentId): readonly Ownership[] =>
  held.filter((entry) => entry.owner !== agent)

// ---------------------------------------------------------------------------
// Mail — typed, bounded, and priced
// ---------------------------------------------------------------------------

export type MessageKind = "request" | "answer" | "notice"

export interface Message {
  readonly id: string
  readonly from: AgentId
  readonly to: AgentId
  readonly kind: MessageKind
  readonly subject: string
  readonly body: string
  /** What this message cost, counted where it is created and never trusted from the sender. */
  readonly bytes: number
}

/**
 * The byte ceiling for one message.
 *
 * Small on purpose. A message that needs more than this is either a handoff —
 * which has its own structure and its own budget — or an agent trying to paste
 * its context into a colleague, which is the exact failure this file exists to
 * make expensive.
 */
export const MESSAGE_LIMIT = 4_096

export type Posted =
  | { readonly ok: true; readonly message: Message }
  | { readonly ok: false; readonly why: string }

const measure = (...parts: readonly string[]): number =>
  parts.reduce((total, part) => total + new TextEncoder().encode(part).length, 0)

export const post = (
  id: string,
  from: AgentId,
  to: AgentId,
  kind: MessageKind,
  subject: string,
  body: string,
): Posted => {
  const bytes = measure(subject, body)
  if (bytes > MESSAGE_LIMIT) {
    return {
      ok: false,
      why:
        `${bytes} bytes against a ${MESSAGE_LIMIT}-byte limit — ` +
        `a message this size is a context paste or an unstructured handoff, and both are refused by design`,
    }
  }
  return { ok: true, message: { id, from, to, kind, subject, body, bytes } }
}

// ---------------------------------------------------------------------------
// Handoff — structured, bounded, exactly once
// ---------------------------------------------------------------------------

/**
 * One claim inside a handoff: an assertion with its evidence NAMED, not
 * restated. The proof lives in the predecessor's frame ledger (S127); copying
 * its content here would be the context paste again, one field at a time.
 */
export interface HandoffClaim {
  readonly statement: string
  /** Proof ids in the cognitive frame's ledger. Empty means unproven, and says so. */
  readonly proofIds: readonly string[]
}

export interface Handoff {
  readonly id: string
  readonly from: AgentId
  readonly to: AgentId
  /** The planner step this hands over. The successor resumes a STEP, not a transcript. */
  readonly stepId: string
  readonly goal: string
  readonly done: readonly HandoffClaim[]
  readonly remaining: readonly string[]
  /** Dead ends, so the successor does not walk them again. The one thing worth carrying. */
  readonly warnings: readonly string[]
  readonly bytes: number
}

/**
 * The handoff budget.
 *
 * Large enough for a real handover — goal, a dozen claims, warnings — and two
 * orders of magnitude below a transcript. The number is a ceiling on how much
 * of the predecessor's head the successor is allowed to inherit; everything
 * else must come from the record, which is where S134's epochs already get it.
 */
export const HANDOFF_LIMIT = 16_384

export type BuiltHandoff =
  | { readonly ok: true; readonly handoff: Handoff }
  | { readonly ok: false; readonly why: string }

export const buildHandoff = (input: Omit<Handoff, "bytes">): BuiltHandoff => {
  const bytes = measure(
    input.goal,
    ...input.done.flatMap((entry) => [entry.statement, ...entry.proofIds]),
    ...input.remaining,
    ...input.warnings,
  )
  if (bytes > HANDOFF_LIMIT) {
    return {
      ok: false,
      why:
        `${bytes} bytes against a ${HANDOFF_LIMIT}-byte limit — a handoff is a baton, not a memoir; ` +
        `move the detail into proofs and cite their ids`,
    }
  }
  return { ok: true, handoff: { ...input, bytes } }
}

// ---------------------------------------------------------------------------
// The board — one ledger, folded, never edited
// ---------------------------------------------------------------------------

export type BoardEvent =
  | { readonly kind: "claimed"; readonly ownership: Ownership }
  | { readonly kind: "released"; readonly agent: AgentId }
  | { readonly kind: "posted"; readonly message: Message }
  | { readonly kind: "handed"; readonly handoff: Handoff }
  | { readonly kind: "accepted"; readonly handoffId: string; readonly by: AgentId }
  | { readonly kind: "stepped"; readonly stepId: string; readonly state: Planner.StepState }

export interface Board {
  readonly plan: readonly Planner.Step[]
  readonly held: readonly Ownership[]
  readonly mail: readonly Message[]
  readonly handoffs: readonly Handoff[]
  /** Handoff ids that were accepted. The exactly-once rule lives here. */
  readonly accepted: ReadonlySet<string>
  readonly log: readonly BoardEvent[]
}

export const board = (plan: readonly Planner.Step[]): Board => ({
  plan,
  held: [],
  mail: [],
  handoffs: [],
  accepted: new Set(),
  log: [],
})

export type Applied =
  | { readonly ok: true; readonly board: Board }
  | { readonly ok: false; readonly why: string }

const refuse = (why: string): Applied => ({ ok: false, why })

/**
 * Fold one event into the board.
 *
 * The same discipline as the cognitive frame and the effect ledger: the board
 * is a fold over events, refusals are values, and there is no API that edits
 * state in place — an edited board is a board whose history cannot be replayed,
 * and replay is how a successor epoch learns what happened without a transcript.
 */
export const apply = (current: Board, event: BoardEvent): Applied => {
  switch (event.kind) {
    case "claimed": {
      const verdict = claim(current.held, event.ownership.scope, event.ownership.owner)
      if (!verdict.ok) return refuse(verdict.why)
      return {
        ok: true,
        board: {
          ...current,
          held: [...current.held, verdict.ownership],
          log: [...current.log, event],
        },
      }
    }
    case "released":
      return {
        ok: true,
        board: { ...current, held: release(current.held, event.agent), log: [...current.log, event] },
      }
    case "posted": {
      if (current.mail.some((entry) => entry.id === event.message.id))
        return refuse(`message ${event.message.id} was already posted — ids are identities, not labels`)
      return {
        ok: true,
        board: { ...current, mail: [...current.mail, event.message], log: [...current.log, event] },
      }
    }
    case "handed": {
      if (current.handoffs.some((entry) => entry.id === event.handoff.id))
        return refuse(`handoff ${event.handoff.id} was already made`)
      if (!current.plan.some((step) => step.id === event.handoff.stepId))
        return refuse(
          `handoff ${event.handoff.id} hands over step ${event.handoff.stepId}, which no plan mentions — ` +
            `a baton for a race nobody is running`,
        )
      return {
        ok: true,
        board: { ...current, handoffs: [...current.handoffs, event.handoff], log: [...current.log, event] },
      }
    }
    case "accepted": {
      const handoff = current.handoffs.find((entry) => entry.id === event.handoffId)
      if (handoff === undefined) return refuse(`handoff ${event.handoffId} does not exist`)
      if (handoff.to !== event.by)
        return refuse(
          `handoff ${event.handoffId} is addressed to ${handoff.to}, and ${event.by} tried to take it — ` +
            `a baton grabbed by a bystander is a fork, not a handover`,
        )
      // The exactly-once rule. Same shape as the effect ledger's
      // UNIQUE(intent_id, phase_tag): refused by identity, never by a flag
      // somebody remembers to check.
      if (current.accepted.has(event.handoffId))
        return refuse(
          `handoff ${event.handoffId} was already accepted — ` +
            `a successor that ingests the same handoff twice counts its predecessor's work double`,
        )
      return {
        ok: true,
        board: {
          ...current,
          accepted: new Set([...current.accepted, event.handoffId]),
          log: [...current.log, event],
        },
      }
    }
    case "stepped": {
      const step = current.plan.find((entry) => entry.id === event.stepId)
      if (step === undefined) return refuse(`step ${event.stepId} is not in the plan`)
      return {
        ok: true,
        board: {
          ...current,
          plan: current.plan.map((entry) =>
            entry.id === event.stepId ? { ...entry, state: event.state } : entry,
          ),
          log: [...current.log, event],
        },
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The overhead — coordination as a fraction, computed, never self-reported
// ---------------------------------------------------------------------------

export interface Overhead {
  readonly coordinationBytes: number
  readonly workBytes: number
  readonly fraction: number
}

/**
 * How much of everything was coordination.
 *
 * `workBytes` is supplied by the caller — the size of artifacts produced, tool
 * output consumed, whatever the team's actual product measures in. The
 * coordination side is computed from the board's own records, because a team
 * asked to report its own overhead reports a flattering one.
 *
 * The acceptance line is ≤15%. This function does not enforce it — a budget
 * enforced here would be a second copy of whatever supervision enforces it —
 * it makes the number impossible to not have.
 */
export const overhead = (current: Board, workBytes: number): Overhead => {
  const coordinationBytes =
    current.mail.reduce((total, entry) => total + entry.bytes, 0) +
    current.handoffs.reduce((total, entry) => total + entry.bytes, 0)
  const total = coordinationBytes + workBytes
  return {
    coordinationBytes,
    workBytes,
    fraction: total === 0 ? 0 : coordinationBytes / total,
  }
}

export * as Team from "./team"
