/**
 * Secret redaction — nothing sensitive leaks into tool output, logs, or the
 * compaction summary. We redact both known values (passed by reference from the
 * credential store) and common secret shapes by pattern.
 */

export const REDACTION = "«redacted»"

/** Each pattern is NAMED so a receipt can say what kind of secret was removed
 *  without ever repeating the secret itself (Sprint 16). */
const PATTERNS: readonly { readonly kind: string; readonly re: RegExp }[] = [
  { kind: "openai_key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "aws_access_key_id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  { kind: "bearer_header", re: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi },
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
]

/**
 * What was removed, never what it was (Sprint 16).
 *
 * A redaction that leaves no trace is indistinguishable from output that was
 * simply clean, so a reader cannot tell whether a receipt is complete or
 * quietly censored. The COUNT and the KINDS are safe to record; the values are
 * the one thing that must never appear.
 */
export interface RedactionRecord {
  readonly count: number
  readonly kinds: readonly string[]
}

export const NO_REDACTIONS: RedactionRecord = { count: 0, kinds: [] }

const mergeRedactions = (a: RedactionRecord, b: RedactionRecord): RedactionRecord => ({
  count: a.count + b.count,
  kinds: [...new Set([...a.kinds, ...b.kinds])],
})

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Redact known secret values then common secret patterns from `text`. */
export function redact(text: string, knownSecrets: readonly string[] = []): string {
  return redactCounted(text, knownSecrets).text
}

/** Redact, and say how much of what was taken out. */
export function redactCounted(
  text: string,
  knownSecrets: readonly string[] = [],
): { text: string; redactions: RedactionRecord } {
  let out = text
  let count = 0
  const kinds: string[] = []
  for (const secret of knownSecrets) {
    if (secret.length < 4) continue
    const occurrences = out.split(secret).length - 1
    if (occurrences > 0) {
      count += occurrences
      if (!kinds.includes("known_value")) kinds.push("known_value")
      out = out.replaceAll(secret, REDACTION)
    }
  }
  for (const { kind, re } of PATTERNS) {
    const matches = out.match(re)
    if (matches && matches.length > 0) {
      count += matches.length
      if (!kinds.includes(kind)) kinds.push(kind)
      out = out.replace(re, REDACTION)
    }
  }
  return { text: out, redactions: { count, kinds } }
}

/** Deep-redact any string inside a value (for structured tool output). */
export function redactValue<T>(value: T, knownSecrets: readonly string[] = []): T {
  return redactValueCounted(value, knownSecrets).value
}

/** Deep-redact, and account for everything removed anywhere in the structure. */
export function redactValueCounted<T>(
  value: T,
  knownSecrets: readonly string[] = [],
): { value: T; redactions: RedactionRecord } {
  if (typeof value === "string") {
    const r = redactCounted(value, knownSecrets)
    return { value: r.text as unknown as T, redactions: r.redactions }
  }
  if (Array.isArray(value)) {
    let redactions = NO_REDACTIONS
    const out = value.map((v) => {
      const r = redactValueCounted(v, knownSecrets)
      redactions = mergeRedactions(redactions, r.redactions)
      return r.value
    })
    return { value: out as unknown as T, redactions }
  }
  if (value && typeof value === "object") {
    let redactions = NO_REDACTIONS
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const r = redactValueCounted(v, knownSecrets)
      redactions = mergeRedactions(redactions, r.redactions)
      out[k] = r.value
    }
    return { value: out as T, redactions }
  }
  return { value, redactions: NO_REDACTIONS }
}

/** True if any known secret or secret pattern is present (for summary guards). */
export function containsSecret(text: string, knownSecrets: readonly string[] = []): boolean {
  return redact(text, knownSecrets) !== text
}
