/**
 * The human gateway (Sprint 87), merge coordination (Sprint 91) and the event
 * bus (Sprint 92).
 *
 * The gateway's requirement is the interesting one: an approval request reaches
 * a phone, the reply resumes the task, AND THE WAITING COSTS NO BUDGET. That
 * last clause rules out the obvious implementation. An agent that polls while
 * it waits burns tokens doing nothing, and a human who takes four hours to
 * answer costs more than the work. So waiting is not a state the agent occupies
 * — it is a state the RUN occupies, in the log, with no process attached.
 *
 * No channel is hardcoded. Telegram, Discord, Slack and mail are the same shape
 * to this file: something that can deliver a message and later hand back a
 * reply. A gateway with a channel baked in is one that gets a second
 * implementation for the second channel, and the second one is always the one
 * without the audit trail.
 */

export type ChannelName = string

export interface OutboundMessage {
  readonly requestId: string
  readonly title: string
  readonly body: string
  /** The exact choices. Free text is not an approval. */
  readonly options: readonly string[]
  readonly expiresAt?: number
}

/** A channel. Nothing here knows what any of them are. */
export interface Channel {
  readonly name: ChannelName
  send(message: OutboundMessage): Promise<{ delivered: boolean; why?: string }>
}

export type ApprovalState = "pending" | "approved" | "rejected" | "expired" | "undeliverable"

export interface ApprovalRequest {
  readonly requestId: string
  readonly runId: string
  readonly question: string
  readonly options: readonly string[]
  readonly createdAt: number
  readonly expiresAt?: number
  readonly state: ApprovalState
  readonly answer?: string
  readonly answeredBy?: string
  readonly channel?: ChannelName
}

export interface Reply {
  readonly requestId: string
  readonly answer: string
  readonly by: string
  readonly at: number
}

/**
 * Ask a human, over whichever channels are configured.
 *
 * Every channel is tried and the failures are KEPT. A request that could not be
 * delivered is `undeliverable`, which is not the same as unanswered: one means
 * nobody was asked and the other means nobody has answered yet, and an agent
 * that cannot tell them apart waits for ever for a message that was never sent.
 */
export async function ask(
  channels: readonly Channel[],
  request: { requestId: string; runId: string; question: string; options: readonly string[]; at: number; expiresAt?: number },
): Promise<{ pending: ApprovalRequest; deliveries: { channel: ChannelName; delivered: boolean; why?: string }[] }> {
  const message: OutboundMessage = {
    requestId: request.requestId,
    title: request.question,
    body: request.question,
    options: request.options,
    ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
  }

  const deliveries: { channel: ChannelName; delivered: boolean; why?: string }[] = []
  for (const channel of channels) {
    try {
      const result = await channel.send(message)
      deliveries.push({ channel: channel.name, ...result })
    } catch (e) {
      deliveries.push({ channel: channel.name, delivered: false, why: e instanceof Error ? e.message : String(e) })
    }
  }

  const first = deliveries.find((d) => d.delivered)
  return {
    pending: {
      requestId: request.requestId,
      runId: request.runId,
      question: request.question,
      options: request.options,
      createdAt: request.at,
      ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
      state: first === undefined ? "undeliverable" : "pending",
      ...(first !== undefined ? { channel: first.channel } : {}),
    },
    deliveries,
  }
}

/**
 * Apply a reply.
 *
 * Only one of the declared options counts. Free text is not an approval — "ok
 * but be careful" is a sentence a model will read as a yes, and the whole point
 * of asking a human is that the answer is unambiguous.
 *
 * A reply to an expired request is refused rather than applied late: the run
 * has moved on, and an approval arriving after the decision was made is not an
 * approval of the decision.
 */
export function applyReply(request: ApprovalRequest, reply: Reply, now: number): { request: ApprovalRequest; why: string } {
  if (request.state !== "pending")
    return { request, why: `this request is ${request.state}; a reply changes nothing now` }

  if (request.expiresAt !== undefined && now > request.expiresAt)
    return {
      request: { ...request, state: "expired" },
      why: "the request expired before the reply arrived — an approval that lands after the decision is not an approval of it",
    }

  if (!request.options.includes(reply.answer))
    return {
      request,
      why: `"${reply.answer}" is not one of ${request.options.join(", ")} — free text is not an approval, because a model reads "ok but be careful" as a yes`,
    }

  const approved = reply.answer.toLowerCase() !== "no" && reply.answer.toLowerCase() !== "reject"
  return {
    request: { ...request, state: approved ? "approved" : "rejected", answer: reply.answer, answeredBy: reply.by },
    why: `${reply.by} answered "${reply.answer}"`,
  }
}

export interface WaitCost {
  readonly waitedMs: number
  readonly tokensSpent: number
  readonly modelCalls: number
}

/**
 * What waiting cost.
 *
 * The gate is a number: tokens spent while pending must be ZERO. A run parked
 * on a human is a row in the log with nothing attached, and this function
 * exists so that claim is checked rather than believed — the first time
 * somebody adds a "just poll every 30 seconds until they answer" this fails.
 */
export function waitCost(request: ApprovalRequest, until: number, tokensSpentWhilePending: number, modelCalls: number): WaitCost {
  return { waitedMs: Math.max(0, until - request.createdAt), tokensSpent: tokensSpentWhilePending, modelCalls }
}

// --------------------------------------------------------------------------
// Sprint 91 — merge coordination
// --------------------------------------------------------------------------

export interface MergeCandidate {
  readonly workspaceId: string
  readonly changed: readonly string[]
  /** Gate results measured ON THIS BRANCH, before the merge. */
  readonly gatesGreenAlone: boolean
}

export type MergeDecision =
  | { readonly kind: "merge"; readonly order: readonly string[]; readonly why: string }
  | { readonly kind: "refuse"; readonly why: string }

/**
 * Decide a merge, and demand the gates on the MERGED result.
 *
 * The rule that makes this worth a sprint: green on each branch separately says
 * nothing about green together. Two changes that each pass can combine into a
 * type error, a duplicated route, or a migration that runs twice — and the
 * usual process merges them because both were approved.
 *
 * So `merge` is only the first half. `confirmMerged` is the half that decides,
 * and it takes the gate result measured AFTER combining. A caller that never
 * calls it never gets a merge that counts.
 */
export function planMerge(candidates: readonly MergeCandidate[]): MergeDecision {
  const notGreen = candidates.filter((c) => !c.gatesGreenAlone)
  if (notGreen.length > 0)
    return { kind: "refuse", why: `${notGreen.map((c) => c.workspaceId).join(", ")} did not pass their own gates` }

  const owners = new Map<string, string[]>()
  for (const candidate of candidates)
    for (const path of candidate.changed) owners.set(path, [...(owners.get(path) ?? []), candidate.workspaceId])
  const conflicts = [...owners.entries()].filter(([, ws]) => ws.length > 1)
  if (conflicts.length > 0)
    return { kind: "refuse", why: `${conflicts.map(([p, ws]) => `${p} (${ws.join(", ")})`).join("; ")} changed by more than one branch` }

  return {
    kind: "merge",
    order: candidates.map((c) => c.workspaceId).sort(),
    why: `${candidates.length} branch(es), disjoint paths, each green alone — now the merged result has to be green too`,
  }
}

export function confirmMerged(decision: MergeDecision, mergedGatesGreen: boolean): { committed: boolean; why: string } {
  if (decision.kind !== "merge") return { committed: false, why: decision.why }
  return mergedGatesGreen
    ? { committed: true, why: `merged result is green across ${decision.order.length} branch(es)` }
    : {
        committed: false,
        why: "each branch was green alone and the MERGED result is not — two changes that each pass can combine into a type error, a duplicated route, or a migration that runs twice",
      }
}

// --------------------------------------------------------------------------
// Sprint 92 — hooks
// --------------------------------------------------------------------------

export type Phase = "before_plan" | "after_plan" | "before_tool" | "after_tool" | "before_verify" | "after_verify"

export interface Hook {
  readonly name: string
  readonly phase: Phase
  run(event: { readonly phase: Phase; readonly runId: string; readonly detail?: unknown }): Promise<void>
}

export interface HookOutcome {
  readonly hook: string
  readonly ok: boolean
  readonly error?: string
  readonly ms: number
}

/**
 * Run the hooks for a phase.
 *
 * A hook that throws is RECORDED and does not take the run with it. Hooks are
 * user code at a choke point: a notification that fails must not be able to
 * kill a deployment, and equally must not be able to disappear — because a hook
 * that silently never fires is a monitoring system everyone believes in.
 *
 * The event is emitted whatever the hooks do. A hook cannot suppress the record
 * of the phase it observed.
 */
export async function runHooks(
  hooks: readonly Hook[],
  event: { phase: Phase; runId: string; detail?: unknown },
  now: () => number = Date.now,
): Promise<{ outcomes: HookOutcome[]; eventEmitted: true }> {
  const outcomes: HookOutcome[] = []
  for (const hook of hooks.filter((h) => h.phase === event.phase)) {
    const started = now()
    try {
      await hook.run(event)
      outcomes.push({ hook: hook.name, ok: true, ms: now() - started })
    } catch (e) {
      outcomes.push({ hook: hook.name, ok: false, error: e instanceof Error ? e.message : String(e), ms: now() - started })
    }
  }
  return { outcomes, eventEmitted: true }
}
