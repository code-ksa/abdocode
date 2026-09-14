/**
 * Global idempotency (Sprint 17) — re-sending an operation must not repeat its
 * side effect.
 *
 * `ToolCall.idempotencyKey` has existed since the first slice, and its comment
 * promised it "guards double-execution on retry". It did not. The key was
 * written onto `tool.started` and `tool.executed` and never read before
 * dispatch, so a resent operation executed a second time and the log recorded
 * both — a promise the type made and the runtime did not keep.
 *
 * The ledger here is that promise, enforced: an operation identified by a key
 * executes AT MOST ONCE per session log, and a repeat returns what the first
 * one produced instead of touching the world again.
 *
 * Which operations need it is not a matter of taste. These are the ones whose
 * second execution is a second real event in the world:
 */
import type { DomainEvent } from "./event"
import { RunEventTypes } from "./run"

export type OperationKind =
  /** Writing/editing a file. */
  | "file_edit"
  /** Running a command that changes something. */
  | "command"
  /** A schema or data migration. */
  | "migration"
  /** Shipping a release. */
  | "deploy"
  /** Anything that changes a page's state: a click, a form submit, an upload. */
  | "browser"
  /** Sending: email, webhook, any outbound API call with an effect. */
  | "network_send"
  /** Something effectful that fits none of the above — still keyed, never exempt. */
  | "other"

export const OPERATION_KINDS: readonly OperationKind[] = [
  "file_edit",
  "command",
  "migration",
  "deploy",
  "browser",
  "network_send",
  "other",
]

/**
 * Derive a key from what the operation IS.
 *
 * Same kind, same target, same payload digest => same key => one execution.
 * The payload is passed as a digest rather than as content: a key is written to
 * the log, and an operation's payload may be exactly the thing that must not be.
 */
export function idempotencyKeyFor(input: {
  readonly kind: OperationKind
  /** What is acted on: a path, a host, a queue, a URL. */
  readonly target: string
  /** Digest of the payload/arguments — the caller hashes, this never sees it. */
  readonly payloadDigest?: string
  /** Optional scope so the same operation in two projects is two operations. */
  readonly scope?: string
}): string {
  return [
    "idem",
    input.kind,
    input.scope ?? "",
    input.target,
    input.payloadDigest ?? "",
  ].join(":")
}

export type LedgerOutcome = "ok" | "failed" | "in_flight"

/** What the log says about one keyed operation. */
export interface IdempotencyEntry {
  readonly key: string
  readonly operationId: string
  readonly runId: string
  readonly tool: string
  readonly outcome: LedgerOutcome
  /** The recorded result of the first execution — replayed instead of re-running. */
  readonly output?: unknown
  readonly error?: string
  readonly startedAt: number
  readonly finishedAt?: number
  readonly sequence: number
}

/**
 * Fold the log into "what has each key already done".
 *
 * The FIRST execution of a key wins for ever. A later one is a repeat by
 * definition, and letting a repeat overwrite the entry would erase the very
 * record that makes the repeat detectable.
 */
export function foldIdempotency(events: readonly DomainEvent[]): Map<string, IdempotencyEntry> {
  const byKey = new Map<string, IdempotencyEntry>()
  const keyOfOperation = new Map<string, string>()

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>
    const key = typeof data.idempotencyKey === "string" ? data.idempotencyKey : undefined
    const operationId = typeof data.toolExecutionId === "string" ? data.toolExecutionId : undefined
    if (operationId === undefined) continue
    const seq = Number(event.sequence)

    if (event.type === RunEventTypes.ToolStarted) {
      if (key === undefined) continue
      keyOfOperation.set(operationId, key)
      if (byKey.has(key)) continue // the first execution owns the entry
      byKey.set(key, {
        key,
        operationId,
        runId: typeof data.runId === "string" ? data.runId : "",
        tool: typeof data.tool === "string" ? data.tool : "unknown",
        outcome: "in_flight",
        startedAt: event.occurredAt,
        sequence: seq,
      })
      continue
    }

    if (event.type === RunEventTypes.ToolExecuted) {
      const k = key ?? keyOfOperation.get(operationId)
      if (k === undefined) continue
      const entry = byKey.get(k)
      // Only the execution that OWNS the entry may complete it.
      if (entry === undefined || entry.operationId !== operationId) continue
      const ok = data.ok === true
      byKey.set(k, {
        ...entry,
        outcome: ok ? "ok" : "failed",
        ...(ok ? { output: data.output } : { error: typeof data.error === "string" ? data.error : "failed" }),
        finishedAt: event.occurredAt,
      })
    }
  }

  return byKey
}

export type IdempotencyVerdict =
  /** Never seen: execute it. */
  | { readonly decision: "execute" }
  /** Already done: replay the recorded result, touch nothing. */
  | { readonly decision: "replay"; readonly entry: IdempotencyEntry }
  /**
   * Started and never reported. The world may or may not have changed, so this
   * is neither a safe replay nor a safe re-run — it is the crash case, and it
   * belongs to recovery's verifier, not to a blind decision here.
   */
  | { readonly decision: "verify_first"; readonly entry: IdempotencyEntry }

/**
 * What to do with an operation carrying `key`, given the log.
 *
 * A FAILED prior execution returns `execute`: a failure that changed nothing is
 * the one repeat that is safe and useful, and refusing it would turn a
 * transient error into a permanent one.
 */
export function checkIdempotency(
  events: readonly DomainEvent[],
  key: string,
  currentOperationId?: string,
): IdempotencyVerdict {
  const entry = foldIdempotency(events).get(key)
  if (entry === undefined) return { decision: "execute" }
  // The operation asking IS the one that owns the entry (a resumed dispatch of
  // the same execution): not a repeat.
  if (currentOperationId !== undefined && entry.operationId === currentOperationId) return { decision: "execute" }
  if (entry.outcome === "ok") return { decision: "replay", entry }
  if (entry.outcome === "in_flight") return { decision: "verify_first", entry }
  return { decision: "execute" }
}
