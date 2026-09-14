/**
 * Artifact spill and structured extraction (Sprint 31).
 *
 * A ten-megabyte build log is the most common way a context window dies, and
 * the usual answers are both bad. Truncating the head loses the error. Keeping
 * the tail loses what caused it. Summarising it with a model costs more tokens
 * than the log would have.
 *
 * So the log never enters the context at all. It is written to an artifact and
 * read in BOUNDED CHUNKS by code, which extracts the few hundred bytes that
 * actually decide the next step: the exit status, the error lines, the failing
 * test names, the first and last frames. The model receives that digest and a
 * reference; if it needs more, it asks for a range and gets exactly that range.
 *
 * The extraction is deliberately mechanical. A model reading the log to decide
 * what matters in the log has already paid the cost the spill exists to avoid.
 */

/** Lines that decide something, in the order they are worth reading. */
const SIGNAL_PATTERNS: readonly { readonly kind: string; readonly re: RegExp }[] = [
  { kind: "error", re: /^\s*(?:error|ERROR|FATAL|fatal)[: ]/ },
  { kind: "exception", re: /^\s*(?:[A-Za-z_.]*(?:Error|Exception))\b.*/ },
  { kind: "test_failure", re: /^\s*(?:FAIL|✗|✖|not ok|\(fail\))\b/ },
  { kind: "assertion", re: /^\s*(?:AssertionError|expect\(.*\)|Expected:|Received:)/ },
  { kind: "typescript", re: /^\S+\(\d+,\d+\): error TS\d+:/ },
  { kind: "compiler", re: /^\s*(?:warning|note): / },
  { kind: "stack", re: /^\s+at\s+\S+/ },
  { kind: "exit", re: /\b(?:exit(?:ed)? (?:code|status|with)|command failed with)\b/i },
]

export interface SignalLine {
  readonly kind: string
  readonly line: number
  readonly text: string
}

export interface SpillDigest {
  readonly ref: string
  readonly totalBytes: number
  readonly totalLines: number
  /** The lines that decide something, capped and de-duplicated. */
  readonly signals: readonly SignalLine[]
  readonly head: readonly string[]
  readonly tail: readonly string[]
  /** True when signal extraction hit its cap — there may be more. */
  readonly truncatedSignals: boolean
  /** Bytes the digest itself costs, so the saving is a number not a claim. */
  readonly digestBytes: number
}

export interface ExtractOptions {
  /** How many signal lines to keep. Default 40. */
  readonly maxSignals?: number
  /** Lines of head and of tail. Default 10 each. */
  readonly context?: number
  /** Longest single line kept; longer ones are cut. Default 400 chars. */
  readonly maxLineChars?: number
}

/** A source of bytes that is read in pieces, never all at once. */
export interface ChunkSource {
  readonly ref: string
  readonly bytes: number
  /** Sequential chunks. The extractor never asks for the whole thing. */
  chunks(): AsyncIterable<string>
}

const cut = (line: string, max: number): string => (line.length <= max ? line : `${line.slice(0, max)}…[+${line.length - max}]`)

/**
 * Read a large output in chunks and keep only what decides the next step.
 *
 * Memory is bounded by `maxSignals` + `context` lines, NOT by the input: the
 * whole point is that a ten-megabyte log costs the same as a ten-kilobyte one.
 * The tail is a ring buffer for that reason.
 */
export async function extractDigest(source: ChunkSource, options: ExtractOptions = {}): Promise<SpillDigest> {
  const maxSignals = options.maxSignals ?? 40
  const context = options.context ?? 10
  const maxLineChars = options.maxLineChars ?? 400

  const head: string[] = []
  const tail: string[] = []
  const signals: SignalLine[] = []
  const seen = new Set<string>()
  let totalLines = 0
  let truncatedSignals = false
  let carry = ""

  const takeLine = (raw: string): void => {
    totalLines++
    const line = cut(raw.replace(/\r$/, ""), maxLineChars)
    if (head.length < context) head.push(line)
    tail.push(line)
    if (tail.length > context) tail.shift()

    if (line.trim().length === 0) return
    for (const { kind, re } of SIGNAL_PATTERNS) {
      if (!re.test(line)) continue
      if (signals.length >= maxSignals) {
        truncatedSignals = true
        return
      }
      // the same error repeated 4,000 times is one fact
      const key = `${kind}:${line.trim()}`
      if (seen.has(key)) return
      seen.add(key)
      signals.push({ kind, line: totalLines, text: line.trim() })
      return
    }
  }

  for await (const chunk of source.chunks()) {
    const text = carry + chunk
    const parts = text.split("\n")
    carry = parts.pop() ?? ""
    for (const part of parts) takeLine(part)
  }
  if (carry.length > 0) takeLine(carry)

  const digest: SpillDigest = {
    ref: source.ref,
    totalBytes: source.bytes,
    totalLines,
    signals,
    head,
    tail,
    truncatedSignals,
    digestBytes: 0,
  }
  return { ...digest, digestBytes: JSON.stringify({ ...digest, digestBytes: 0 }).length }
}

/**
 * What the model actually sees in place of the output.
 *
 * It names the reference and says the output is retrievable, because a digest
 * that reads like the whole truth invites conclusions the digest cannot
 * support — and an agent that does not know more exists will not ask for it.
 */
export function renderDigest(digest: SpillDigest): string {
  const lines: string[] = []
  lines.push(
    `[output spilled to ${digest.ref} — ${digest.totalBytes} bytes, ${digest.totalLines} lines. ` +
      `Ask for a line range from this ref to read more.]`,
  )
  if (digest.signals.length > 0) {
    lines.push(`signals (${digest.signals.length}${digest.truncatedSignals ? "+, capped" : ""}):`)
    for (const s of digest.signals) lines.push(`  ${String(s.line).padStart(6)} ${s.kind.padEnd(12)} ${s.text}`)
  } else {
    lines.push("signals: none matched — nothing in this output looks like an error")
  }
  lines.push(`head:\n${digest.head.map((l) => `  ${l}`).join("\n")}`)
  lines.push(`tail:\n${digest.tail.map((l) => `  ${l}`).join("\n")}`)
  return lines.join("\n")
}

/**
 * Fetch an exact line range from a spilled artifact.
 *
 * Bounded by construction: a caller that asks for a million lines gets `limit`
 * of them and is told so. An unbounded retrieval would re-open the hole the
 * spill just closed.
 */
export async function readRange(
  source: ChunkSource,
  from: number,
  to: number,
  limit = 500,
): Promise<{ lines: string[]; from: number; to: number; clamped: boolean }> {
  const start = Math.max(1, Math.floor(from))
  const requested = Math.max(start, Math.floor(to))
  const end = Math.min(requested, start + limit - 1)
  const lines: string[] = []
  let n = 0
  let carry = ""

  const push = (raw: string): void => {
    n++
    if (n >= start && n <= end) lines.push(raw.replace(/\r$/, ""))
  }

  for await (const chunk of source.chunks()) {
    const text = carry + chunk
    const parts = text.split("\n")
    carry = parts.pop() ?? ""
    for (const part of parts) push(part)
    if (n > end) break
  }
  if (carry.length > 0 && n <= end) push(carry)

  return { lines, from: start, to: end, clamped: end < requested }
}
