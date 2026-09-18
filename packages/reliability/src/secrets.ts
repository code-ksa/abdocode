/**
 * Universal redaction (Sprint 53) and the secret broker (Sprint 54).
 *
 * Sprint 16 redacted tool output and counted what it removed. This finishes the
 * job in the only way that actually works: redaction at EVERY output path, and
 * — more importantly — a design where the value was never in the process in the
 * first place.
 *
 * The two halves are not alternatives. Redaction is the net, and a net is what
 * you want when something goes wrong. The broker is the reason nothing usually
 * does: a secret travels as a REFERENCE (`env://DATABASE_URL`, `vault://prod/db`)
 * through prompts, logs, plans, receipts and checkpoints, and is resolved only
 * at the moment of execution, into the child process's environment, where it
 * exists for the life of one command and is never a string this process held.
 *
 * A revoked reference stops working immediately, because resolution happens at
 * use rather than at plan time. That property is the whole reason to prefer a
 * reference over a value even when nothing has leaked.
 */

export interface SecretPattern {
  readonly name: string
  readonly re: RegExp
}

/**
 * What to redact.
 *
 * Structural patterns rather than a list of known secrets: a redactor that only
 * removes values it was told about is a redactor that misses the one nobody
 * registered. The named-assignment pattern is the one that catches most real
 * leaks, because secrets nearly always appear next to their own name.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "url_credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@]+)@/gi },
  { name: "named_assignment", re: /\b([A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|SECRET|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*("?)([^\s"']{4,})\2/gi },
  { name: "bearer", re: /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{12,})/gi },
  { name: "aws_key", re: /\b(AKIA[0-9A-Z]{16})\b/g },
  { name: "private_key_block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "github_token", re: /\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g },
  { name: "openai_key", re: /\b(sk-[A-Za-z0-9-]{16,})\b/g },
]

export interface Redaction {
  readonly kind: string
  readonly count: number
}

export interface RedactionResult {
  readonly text: string
  readonly redactions: readonly Redaction[]
  readonly total: number
}

const MASK = "[redacted]"

/** The encodings a value reaches an output through without being itself. */
function encodingsOf(value: string): string[] {
  const bytes = new TextEncoder().encode(value)
  const base64 = btoa(String.fromCharCode(...bytes))
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
  return [
    base64,
    base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), // base64url
    hex,
    hex.toUpperCase(),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1), // escaped form
  ].filter((e) => e !== value)
}

/**
 * Redact, and REPORT.
 *
 * The counting is not decoration — it is the difference between a censored
 * output and a clean one. Without it, a receipt that had three secrets stripped
 * reads exactly like a receipt that never had any, and the fact worth knowing
 * (that this command is handling credentials) disappears with the value.
 *
 * The kinds are reported; the values never are, not even hashed. A hash of a
 * short secret is a secret.
 */
export function redact(text: string, extraValues: readonly string[] = []): RedactionResult {
  const counts = new Map<string, number>()
  let out = text

  // literal known values first: they are the ones we are certain about
  for (const value of extraValues) {
    if (value.length < 4) continue
    const before = out
    out = out.split(value).join(MASK)
    if (out !== before) counts.set("known_value", (counts.get("known_value") ?? 0) + 1)
  }

  // RED TEAM S59 FINDING. Base64-ing a secret walked it straight past every
  // structural pattern AND past the literal match, because none of them are
  // looking at an encoding. For a value we KNOW, the encodings are cheap to
  // compute and there is no reason to leave the hole open.
  //
  // The honest limit, stated rather than papered over: this closes the
  // encodings an agent reaches for by reflex. It does not close compression,
  // chunking, or a value the redactor was never told about. Redaction is the
  // net; the reason the net rarely has to catch anything is Sprint 54, where
  // the value is never in the process at all.
  for (const value of extraValues) {
    if (value.length < 4) continue
    for (const encoded of encodingsOf(value)) {
      if (encoded.length < 8 || !out.includes(encoded)) continue
      out = out.split(encoded).join(MASK)
      counts.set("encoded_value", (counts.get("encoded_value") ?? 0) + 1)
    }
  }

  for (const { name, re } of SECRET_PATTERNS) {
    const pattern = new RegExp(re.source, re.flags)
    out = out.replace(pattern, (match, ...groups) => {
      counts.set(name, (counts.get(name) ?? 0) + 1)
      // keep the SHAPE where it is informative and the value where it is not
      if (name === "url_credentials") return `${groups[0]}:${MASK}@`
      if (name === "named_assignment") return `${groups[0]}=${MASK}`
      if (name === "bearer") return `${groups[0]} ${MASK}`
      return MASK
    })
  }

  const redactions = [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => a.kind.localeCompare(b.kind))
  return { text: out, redactions, total: redactions.reduce((sum, r) => sum + r.count, 0) }
}

/** Apply the redactor to every output path a value can leave by. */
export interface OutputPaths {
  readonly stdout: string
  readonly stderr: string
  readonly toolResult: string
  readonly errorMessage: string
  readonly logLine: string
  readonly checkpoint: string
}

export function redactAll(paths: OutputPaths, extraValues: readonly string[] = []): {
  paths: OutputPaths
  total: number
  byPath: Record<keyof OutputPaths, number>
} {
  const entries = Object.entries(paths) as [keyof OutputPaths, string][]
  const cleaned: Record<string, string> = {}
  const byPath = {} as Record<keyof OutputPaths, number>
  let total = 0
  for (const [key, value] of entries) {
    const result = redact(value, extraValues)
    cleaned[key] = result.text
    byPath[key] = result.total
    total += result.total
  }
  return { paths: cleaned as unknown as OutputPaths, total, byPath }
}

// --------------------------------------------------------------------------
// Sprint 54 — the secret broker
// --------------------------------------------------------------------------

export interface SecretRef {
  readonly scheme: "env" | "vault"
  readonly key: string
  readonly raw: string
}

const REF = /^(env|vault):\/\/(.+)$/

export const parseSecretRef = (raw: string): SecretRef | undefined => {
  const match = REF.exec(raw.trim())
  return match === null ? undefined : { scheme: match[1] as "env" | "vault", key: match[2]!, raw: raw.trim() }
}

export const isSecretRef = (raw: string): boolean => REF.test(raw.trim())

export interface SecretSource {
  /** Resolve at USE time. Returns undefined when revoked or absent. */
  resolve(ref: SecretRef): Promise<string | undefined>
}

export type Resolution =
  | { readonly kind: "resolved"; readonly env: Readonly<Record<string, string>>; readonly refs: readonly string[] }
  | { readonly kind: "unavailable"; readonly ref: string; readonly why: string }

/**
 * Resolve references into a child process's environment.
 *
 * The value is produced here, handed to the child, and not returned to the
 * caller — there is no field in `Resolution` that carries it. A function that
 * returned the secret would be a function whose result ends up in a log the
 * first time somebody debugs something.
 *
 * A reference that resolves to nothing is UNAVAILABLE and stops the command. It
 * must not become an empty environment variable, because a service reading an
 * empty password usually falls back to something worse than failing.
 */
export async function resolveForExecution(
  source: SecretSource,
  bindings: Readonly<Record<string, string>>,
): Promise<Resolution> {
  const env: Record<string, string> = {}
  const refs: string[] = []

  for (const [name, raw] of Object.entries(bindings)) {
    const ref = parseSecretRef(raw)
    if (ref === undefined) {
      env[name] = raw
      continue
    }
    const value = await source.resolve(ref)
    if (value === undefined || value.length === 0)
      return {
        kind: "unavailable",
        ref: ref.raw,
        why: `${ref.raw} resolved to nothing — it may have been revoked. An empty value is not a safe default: a service reading an empty password usually falls back to something worse than failing.`,
      }
    env[name] = value
    refs.push(ref.raw)
  }

  return { kind: "resolved", env, refs }
}

/**
 * What may be recorded about a command that used secrets.
 *
 * References and names; never values. Used for the log, the receipt, the
 * checkpoint and the prompt — all four of which have leaked a credential in
 * some system at some point, always because somebody recorded the resolved
 * environment "just for debugging".
 */
export function loggableEnv(bindings: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, raw] of Object.entries(bindings)) {
    out[name] = isSecretRef(raw) ? raw : raw.length > 64 ? `${raw.slice(0, 64)}…` : raw
  }
  return out
}
