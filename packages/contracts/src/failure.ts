/**
 * Failure taxonomy (Sprint 15) — every failure says what KIND it is and what to
 * do about it.
 *
 * Before this, failure handling was a scattered boolean: one private predicate
 * in the runtime decided whether a model error was worth retrying, tool
 * failures were fed back to the model as text, and everything that reached the
 * terminal path was recorded as `provider_error` with a message string. So the
 * log could tell you a run failed, but not whether it was worth trying again,
 * fixable by the agent, or hopeless without a human — and the answer was
 * re-derived, differently, at each call site.
 *
 * A failure here has two parts. The CLASS is what went wrong. The DISPOSITION
 * is what may be done next, and it is the part that must never be ambiguous:
 *
 *   retry  — the same operation again, unchanged. Only for failures that left
 *            NOTHING behind; retrying something that may have half-applied is
 *            the duplicate side effect the strategy ledger exists to prevent.
 *   repair — the agent can act to make the next attempt different: fix the
 *            arguments, shrink the request, correct the code the test caught.
 *   stop   — nothing the agent can do alone. A human, a credential or a permit
 *            is required, and pretending otherwise burns budget on a wall.
 */

export type FailureClass =
  /** Malformed arguments, unparsable output, schema violation. */
  | "SYNTAX"
  /** The message never made it: connection dropped, 5xx, stream stalled. */
  | "TRANSPORT"
  /** Credentials missing, invalid, or refused. */
  | "AUTH"
  /** Refused by policy, permission or an approval gate. */
  | "POLICY"
  /** Momentary contention: rate limit, lock, busy. Same call, later, works. */
  | "TRANSIENT"
  /** A limit was hit: disk, memory, quota, context window. */
  | "RESOURCE"
  /** State that is wrong rather than absent: corruption, digest mismatch. */
  | "DATA"
  /** The work itself is wrong — a test, typecheck or verification said no. */
  | "TEST"
  /** The request cannot be acted on as given. */
  | "USER_INPUT"
  /** Terminal by nature: cancelled, poisoned, or genuinely unknown after a side effect. */
  | "UNRECOVERABLE"

export type FailureDisposition = "retry" | "repair" | "stop"

/**
 * The disposition each class carries. This table IS the sprint's gate: every
 * class has exactly one, so no failure can reach a caller without an answer.
 */
export const DISPOSITION_OF: Readonly<Record<FailureClass, FailureDisposition>> = {
  SYNTAX: "repair",
  TRANSPORT: "retry",
  AUTH: "stop",
  POLICY: "stop",
  TRANSIENT: "retry",
  RESOURCE: "repair",
  DATA: "repair",
  TEST: "repair",
  USER_INPUT: "stop",
  UNRECOVERABLE: "stop",
}

export const ALL_FAILURE_CLASSES: readonly FailureClass[] = Object.keys(DISPOSITION_OF) as FailureClass[]

/**
 * Where the failure happened. It changes the answer for an UNRECOGNISED error,
 * and only for that: before the model call nothing has been done, so an unknown
 * transport-shaped error is worth one more try; after a tool has begun, an
 * unknown error may have left the world changed, and a blind retry is exactly
 * the duplicate side effect that is hardest to undo.
 */
export type FailurePhase = "model" | "tool" | "store" | "verification" | "input"

export interface FailureVerdict {
  readonly failureClass: FailureClass
  readonly disposition: FailureDisposition
  /** Short, stable reason code — safe to match on, unlike a message. */
  readonly code: string
  /** Human detail. Never matched on; may contain provider text. */
  readonly detail?: string
}

const verdict = (failureClass: FailureClass, code: string, detail?: string): FailureVerdict => ({
  failureClass,
  disposition: DISPOSITION_OF[failureClass],
  code,
  ...(detail !== undefined ? { detail } : {}),
})

/** HTTP status → class, for providers that speak in status codes. */
function fromStatus(status: number): FailureClass | undefined {
  if (status === 401 || status === 403) return "AUTH"
  if (status === 400 || status === 422) return "SYNTAX"
  if (status === 404) return "USER_INPUT"
  if (status === 408) return "TRANSPORT"
  if (status === 409) return "TRANSIENT"
  if (status === 413) return "RESOURCE"
  if (status === 429) return "TRANSIENT"
  if (status >= 500) return "TRANSPORT"
  return undefined
}

/** OS/runtime error codes that mean something specific regardless of wording. */
function fromCode(code: string): FailureClass | undefined {
  switch (code) {
    case "ENOSPC":
    case "EDQUOT":
    case "ENOMEM":
    case "EMFILE":
    case "ENFILE":
      return "RESOURCE"
    case "ECONNRESET":
    case "ECONNREFUSED":
    case "ETIMEDOUT":
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "EPIPE":
    case "ENETUNREACH":
      return "TRANSPORT"
    case "EACCES":
    case "EPERM":
      return "POLICY"
    case "ENOENT":
      return "USER_INPUT"
    case "EBUSY":
    case "EAGAIN":
    case "SQLITE_BUSY":
    case "SQLITE_LOCKED":
      return "TRANSIENT"
    case "SQLITE_CORRUPT":
    case "SQLITE_NOTADB":
      return "DATA"
    default:
      return undefined
  }
}

/**
 * Classify anything that can be thrown, caught or reported.
 *
 * Recognition is by SHAPE, in order of how much each signal is worth: the
 * typed tag a domain error carries, then an explicit code, then an HTTP status,
 * then the phase-specific default. Message text is used only as a last resort
 * and only for patterns that are unambiguous — matching on wording is how a
 * provider's copy edit silently changes a retry policy.
 */
export function classifyFailure(error: unknown, phase: FailurePhase = "model"): FailureVerdict {
  if (error === undefined || error === null) {
    return verdict("UNRECOVERABLE", "unknown_empty_error")
  }

  const e = error as {
    _tag?: string
    name?: string
    code?: unknown
    status?: unknown
    statusCode?: unknown
    kind?: unknown
    retryable?: unknown
    message?: unknown
    timeoutMs?: unknown
    denied?: unknown
  }
  const message = typeof e.message === "string" ? e.message : String(error)

  // 0. A policy denial, carried as the typed discriminator the runner sets for
  // exactly this purpose. It outranks even the tag: a gate that refused BEFORE
  // anything ran is the one failure whose side-effect question is already
  // answered, and the live CRM run showed what losing this field costs — a
  // plan-gate refusal recorded as UNRECOVERABLE with a code claiming a possible
  // side effect, which is wrong on both counts and is what an operator reads.
  if (e.denied === true) {
    return verdict("POLICY", "policy_denied", message)
  }

  // 1. domain errors — the strongest signal there is
  const tag = typeof e._tag === "string" ? e._tag : e.name
  switch (tag) {
    case "Abdo.RunCancelledError":
      return verdict("UNRECOVERABLE", "cancelled", "the run was cancelled")
    case "Abdo.LateResponseError":
      return verdict("UNRECOVERABLE", "superseded", "a newer attempt replaced this one")
    case "Abdo.ToolNotPermittedError":
      return verdict("POLICY", "tool_not_permitted", message)
    case "Abdo.RequestTooLargeError":
      // Repairable on purpose: compaction can make the next attempt fit.
      return verdict("RESOURCE", "request_too_large", message)
    case "Abdo.DatabaseBusyError":
      return verdict("TRANSIENT", "database_busy", message)
    case "Abdo.SequenceConflictError":
      return verdict("TRANSIENT", "sequence_conflict", message)
    case "Abdo.IdempotencyReplayError":
      // Not a failure at all: the work is already committed.
      return verdict("DATA", "idempotency_replay", message)
    case "Abdo.IllegalTransitionError":
      return verdict("DATA", "illegal_transition", message)
    case "Abdo.SessionNotFoundError":
    case "Abdo.RunNotFoundError":
      return verdict("USER_INPUT", "not_found", message)
    case "Abdo.ProviderTimeoutError": {
      // A stalled stream aborted before anything came back — safe to retry.
      // The TOTAL budget is a decision, not a hiccup: retrying it just spends
      // the same wall clock again.
      const kind = typeof e.kind === "string" ? e.kind : "total"
      // A timeout carries its budget in FIELDS, not in `message`, so `message`
      // is empty and the log recorded an UNRECOVERABLE stop that said nothing
      // about why it stopped. Found in a live run: `"error": ""` next to
      // `model_timeout_total`, which tells a reader the class of the fault and
      // withholds the one number that would let them act on it. A fault that is
      // classified but not described is the silence this program forbids, just
      // wearing a code.
      // `message` above falls back to `String(error)`, which for an error whose
      // detail lives in fields is the literal text "[object Object]" — a
      // non-empty string that passes an emptiness check and tells a reader
      // nothing. So the real message is taken from the field or not at all.
      const ms = typeof e.timeoutMs === "number" ? e.timeoutMs : undefined
      const said = typeof e.message === "string" ? e.message : ""
      const described =
        said !== ""
          ? said
          : ms !== undefined
            ? `the model did not finish within ${ms}ms (${kind})`
            : `the model timed out (${kind})`
      return kind === "first_byte" || kind === "idle_chunk"
        ? verdict("TRANSPORT", `stream_${kind}`, described)
        : verdict("UNRECOVERABLE", "model_timeout_total", described)
    }
    case "Abdo.ProviderAbortedError":
      return verdict("UNRECOVERABLE", "provider_aborted", message)
  }

  // 2. an explicit provider verdict beats our guessing
  if (e.retryable === false) return verdict("UNRECOVERABLE", "provider_declared_final", message)

  // 3. codes, then statuses
  const code = typeof e.code === "string" ? e.code : undefined
  if (code !== undefined) {
    const byCode = fromCode(code)
    if (byCode !== undefined) return verdict(byCode, `code_${code.toLowerCase()}`, message)
  }
  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined
  if (status !== undefined) {
    const byStatus = fromStatus(status)
    if (byStatus !== undefined) return verdict(byStatus, `http_${status}`, message)
  }

  // 4. unambiguous wording, kept deliberately narrow
  if (/\bJSON(\.parse)?\b.*(unexpected|invalid)|unexpected token .* in JSON/i.test(message)) {
    return verdict("SYNTAX", "unparsable_json", message)
  }
  if (/\b(rate.?limit|too many requests)\b/i.test(message)) return verdict("TRANSIENT", "rate_limited", message)
  if (/\b(unauthori[sz]ed|invalid api key|authentication failed)\b/i.test(message)) {
    return verdict("AUTH", "unauthorized", message)
  }

  // 5. the phase decides what an unrecognised error means
  switch (phase) {
    case "model":
      // Nothing has been done yet, so one more attempt costs a call and risks
      // nothing. This preserves the runtime's long-standing behaviour, now
      // stated as a rule rather than buried in a predicate.
      return verdict("TRANSPORT", "unrecognised_before_side_effect", message)
    case "store":
      return verdict("TRANSIENT", "unrecognised_store_error", message)
    case "verification":
      return verdict("TEST", "verification_failed", message)
    case "input":
      return verdict("USER_INPUT", "unrecognised_input_error", message)
    case "tool":
    default:
      // A tool may have changed the world before failing. Unknown plus possible
      // side effect is the one combination that must never auto-retry.
      return verdict("UNRECOVERABLE", "unrecognised_after_possible_side_effect", message)
  }
}

/** Convenience for the runtime's hot path. */
export const isRetryable = (error: unknown, phase: FailurePhase = "model"): boolean =>
  classifyFailure(error, phase).disposition === "retry"
