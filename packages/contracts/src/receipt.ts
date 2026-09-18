/**
 * Evidence receipts (Sprint 16) — nothing may be called done without one.
 *
 * The facts were already in the log, but spread across two events and half a
 * dozen optional fields, so "prove this happened" meant knowing which events to
 * join and which fields to trust. A claim backed by evidence nobody can
 * assemble is, in practice, an unbacked claim.
 *
 * A `Receipt` is that join, made once: one per tool execution, carrying the
 * operation's identity, the digest of what it was given, when it started and
 * ended, how it exited, what state it changed, what can be cited as proof, and
 * what was redacted before anyone saw it.
 *
 * The last field is the one that is easy to leave out and expensive to miss: a
 * receipt that does not say it was censored reads exactly like a receipt that
 * had nothing to hide.
 */
import type { DomainEvent } from "./event"
import { RunEventTypes, TEXT_EVENTS } from "./run"

export type ReceiptExit = "ok" | "failed" | "unfinished"

export interface ReceiptStateChange {
  readonly path?: string
  readonly beforeHash?: string | null
  readonly afterHash?: string
  /** Began changing the world. */
  readonly started: boolean
  /** The change fully landed. started && !committed is a partial failure. */
  readonly committed: boolean
  readonly rolledBack?: boolean
}

export interface ReceiptRedactions {
  readonly count: number
  readonly kinds: readonly string[]
}

export interface Receipt {
  /** The execution's identity — stable across start, finish and replay. */
  readonly operationId: string
  readonly runId: string
  readonly tool: string
  /** Digest of the inputs, never the inputs: arguments can carry secrets. */
  readonly inputsDigest?: string
  readonly startedAt: number
  readonly finishedAt?: number
  readonly durationMs?: number
  readonly exit: ReceiptExit
  readonly error?: string
  /** Sprint 15's verdict, when the execution failed. */
  readonly failure?: { readonly class: string; readonly disposition: string; readonly code: string }
  readonly stateChange?: ReceiptStateChange
  /** Citable proof: hashes and the control decision that authorised the call. */
  readonly evidence: {
    readonly resultHash?: string
    readonly postStateHash?: string
    readonly decisionId?: string
    /** Log positions of the start and finish events — the audit trail. */
    readonly sequences: readonly number[]
  }
  readonly redactions?: ReceiptRedactions
}

/** A receipt is complete when the execution it describes actually finished. */
export const isComplete = (receipt: Receipt): boolean => receipt.exit !== "unfinished"

interface Draft {
  operationId: string
  runId: string
  tool: string
  inputsDigest?: string
  startedAt: number
  finishedAt?: number
  exit: ReceiptExit
  error?: string
  failure?: { class: string; disposition: string; code: string }
  stateChange?: ReceiptStateChange
  resultHash?: string
  postStateHash?: string
  decisionId?: string
  sequences: number[]
  redactions?: ReceiptRedactions
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)

/**
 * Build every receipt in a log, keyed by operation id.
 *
 * An execution that started and never reported still gets a receipt, marked
 * `unfinished`. That is deliberate: the dangerous case is the one that leaves
 * NO trace, and a missing receipt is exactly what `unbackedClaims` looks for.
 */
export function foldReceipts(events: readonly DomainEvent[], runId?: string): Map<string, Receipt> {
  const drafts = new Map<string, Draft>()

  for (const event of events) {
    if (TEXT_EVENTS.includes(event.type)) continue
    const data = (event.data ?? {}) as Record<string, unknown>
    const eventRunId = str(data.runId)
    if (runId !== undefined && eventRunId !== runId) continue
    const operationId = str(data.toolExecutionId)
    if (operationId === undefined) continue
    const seq = Number(event.sequence)
    const at = event.occurredAt

    switch (event.type) {
      case RunEventTypes.ToolStarted: {
        const existing = drafts.get(operationId)
        const draft: Draft = existing ?? {
          operationId,
          runId: eventRunId ?? "",
          tool: str(data.tool) ?? "unknown",
          startedAt: at,
          exit: "unfinished",
          sequences: [],
        }
        draft.startedAt = at
        draft.tool = str(data.tool) ?? draft.tool
        const argsHash = str(data.argsHash)
        if (argsHash !== undefined) draft.inputsDigest = argsHash
        draft.sequences.push(seq)
        drafts.set(operationId, draft)
        break
      }

      case RunEventTypes.ToolExecuted: {
        const draft: Draft = drafts.get(operationId) ?? {
          operationId,
          runId: eventRunId ?? "",
          tool: str(data.tool) ?? "unknown",
          startedAt: at,
          exit: "unfinished",
          sequences: [],
        }
        const ok = data.ok === true
        draft.finishedAt = at
        draft.exit = ok ? "ok" : "failed"
        draft.tool = str(data.tool) ?? draft.tool
        if (!ok) draft.error = str(data.error)
        const failure = data.failure as { class?: unknown; disposition?: unknown; code?: unknown } | undefined
        if (failure && typeof failure.class === "string" && typeof failure.disposition === "string") {
          draft.failure = {
            class: failure.class,
            disposition: failure.disposition,
            code: typeof failure.code === "string" ? failure.code : "",
          }
        }
        const mutation = data.mutation as
          | { path?: unknown; beforeHash?: unknown; afterHash?: unknown; mutationStarted?: unknown; mutationCommitted?: unknown }
          | undefined
        if (mutation !== undefined) {
          draft.stateChange = {
            ...(typeof mutation.path === "string" ? { path: mutation.path } : {}),
            ...(mutation.beforeHash === null || typeof mutation.beforeHash === "string"
              ? { beforeHash: mutation.beforeHash as string | null }
              : {}),
            ...(typeof mutation.afterHash === "string" ? { afterHash: mutation.afterHash } : {}),
            started: mutation.mutationStarted === true,
            committed: mutation.mutationCommitted === true,
          }
        }
        draft.resultHash = str(data.resultHash) ?? draft.resultHash
        draft.postStateHash = str(data.postSemanticStateHash) ?? draft.postStateHash
        const control = data.control as { decisionId?: unknown } | undefined
        if (typeof control?.decisionId === "string") draft.decisionId = control.decisionId
        const redactions = data.redactions as { count?: unknown; kinds?: unknown } | undefined
        if (redactions && typeof redactions.count === "number" && redactions.count > 0) {
          draft.redactions = {
            count: redactions.count,
            kinds: Array.isArray(redactions.kinds) ? redactions.kinds.filter((k): k is string => typeof k === "string") : [],
          }
        }
        draft.sequences.push(seq)
        drafts.set(operationId, draft)
        break
      }

      case RunEventTypes.ToolRollbackCompleted: {
        const draft = drafts.get(operationId)
        if (draft?.stateChange !== undefined) {
          draft.stateChange = { ...draft.stateChange, rolledBack: true, committed: false }
          draft.sequences.push(seq)
        }
        break
      }
    }
  }

  const out = new Map<string, Receipt>()
  for (const [id, d] of drafts) {
    out.set(id, {
      operationId: d.operationId,
      runId: d.runId,
      tool: d.tool,
      ...(d.inputsDigest !== undefined ? { inputsDigest: d.inputsDigest } : {}),
      startedAt: d.startedAt,
      ...(d.finishedAt !== undefined ? { finishedAt: d.finishedAt, durationMs: Math.max(0, d.finishedAt - d.startedAt) } : {}),
      exit: d.exit,
      ...(d.error !== undefined ? { error: d.error } : {}),
      ...(d.failure !== undefined ? { failure: d.failure } : {}),
      ...(d.stateChange !== undefined ? { stateChange: d.stateChange } : {}),
      evidence: {
        ...(d.resultHash !== undefined ? { resultHash: d.resultHash } : {}),
        ...(d.postStateHash !== undefined ? { postStateHash: d.postStateHash } : {}),
        ...(d.decisionId !== undefined ? { decisionId: d.decisionId } : {}),
        sequences: d.sequences,
      },
      ...(d.redactions !== undefined ? { redactions: d.redactions } : {}),
    })
  }
  return out
}

export type UnbackedClaimKind =
  /** The run claimed completion while an execution never reported. */
  | "unfinished_operation"
  /** A committed change with no receipt to prove it. */
  | "unreceipted_mutation"

export interface UnbackedClaim {
  readonly kind: UnbackedClaimKind
  readonly operationId?: string
  readonly detail: string
}

/**
 * Everything a run claims that no receipt supports.
 *
 * This is Sprint 16's gate expressed as a function: a completed run with a
 * non-empty result here has said "done" about work it cannot prove. Callers
 * treat it as fatal; it is written as a list rather than a boolean so the
 * failure names exactly which operation is missing its evidence.
 */
export function unbackedClaims(events: readonly DomainEvent[], runId: string, attempt?: number): UnbackedClaim[] {
  const receipts = [...foldReceipts(events, runId).values()]
  const problems: UnbackedClaim[] = []

  // An execution orphaned by an EARLIER attempt is a crash artifact, already
  // adjudicated by recovery and the strategy ledger. Holding it against the
  // attempt that is finishing now would make every resumed run unable to
  // complete — the guard must catch a live lie, not an old scar.
  //
  // Two independent signals, because the log may predate either: the `attempt`
  // an event carries, and failing that, its POSITION relative to the last
  // `run.resumed`. Anything that started before this attempt began belongs to
  // the one that died.
  let resumedAt = -1
  for (const event of events) {
    if (event.type !== RunEventTypes.Resumed) continue
    if (str(((event.data ?? {}) as Record<string, unknown>).runId) !== runId) continue
    resumedAt = Math.max(resumedAt, Number(event.sequence))
  }
  const ofThisAttempt = (operationId: string): boolean => {
    for (const event of events) {
      if (event.type !== RunEventTypes.ToolStarted) continue
      const data = (event.data ?? {}) as Record<string, unknown>
      if (str(data.toolExecutionId) !== operationId) continue
      const a = data.attempt
      if (attempt !== undefined && typeof a === "number") return a === attempt
      return Number(event.sequence) > resumedAt
    }
    return true
  }

  for (const receipt of receipts) {
    if (!isComplete(receipt) && ofThisAttempt(receipt.operationId)) {
      problems.push({
        kind: "unfinished_operation",
        operationId: receipt.operationId,
        detail: `${receipt.tool} started and never reported`,
      })
    }
  }

  // A mutation event in the log whose execution has no receipt at all: the
  // world changed and nothing can say by what.
  const receiptIds = new Set(receipts.map((r) => r.operationId))
  for (const event of events) {
    if (event.type !== RunEventTypes.ToolExecuted) continue
    const data = (event.data ?? {}) as Record<string, unknown>
    if (str(data.runId) !== runId) continue
    const mutation = data.mutation as { mutationCommitted?: unknown } | undefined
    if (mutation?.mutationCommitted !== true) continue
    const operationId = str(data.toolExecutionId)
    if (operationId === undefined || !receiptIds.has(operationId)) {
      problems.push({
        kind: "unreceipted_mutation",
        ...(operationId !== undefined ? { operationId } : {}),
        detail: "a committed mutation with no receipt",
      })
    }
  }

  return problems
}
