/**
 * Compactor — turns evicted history into a dual summary (StructuredState +
 * human text), guarding against the classic failure of summary-of-summary drift.
 *
 * Two modes:
 *  - incremental: merge a fresh partial summary into the prior state (cheap).
 *  - rebase: rebuild the whole state from real history, ignoring accumulated
 *    summaries — run periodically (every N compactions), on an objective change,
 *    on a detected conflict, or when the human summary grows too large.
 *
 * The model only proposes; a malformed state JSON is REJECTED and retried once,
 * then either fails loudly (`onError: "throw"`) or falls back to a mechanical,
 * model-free summary so the run stays alive. StructuredState is authoritative;
 * the human text is a view.
 */
import { EMPTY_STATE, mergeState, parseStructuredState, type StructuredState } from "./state"

export type CompactionKind = "incremental" | "rebase"

export class CompactionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CompactionError"
  }
}

export interface HistoryItem {
  readonly eventId?: string
  readonly role: string
  readonly text: string
}

export interface SummarizeInput {
  readonly historyText: string
  readonly priorState: StructuredState
  readonly mode: CompactionKind
  /** Present on a retry after a rejected reply. */
  readonly retryNote?: string
}

export interface SummarizeOutput {
  /** JSON encoding a StructuredState (validated by the compactor). */
  readonly stateJson: string
  readonly humanSummary: string
}

/** The model-backed summarizer. Injected so tests use a deterministic fake. */
export interface Summarizer {
  summarize(input: SummarizeInput): Promise<SummarizeOutput>
}

export interface CompactorOptions {
  readonly summarizer: Summarizer
  /** Full rebase every N compactions (default 5). */
  readonly rebaseEvery?: number
  /** Rebase when the prior human summary exceeds this many chars (default 8000). */
  readonly rebaseSummaryChars?: number
  /** On unrecoverable failure: fail the run, or degrade to a mechanical summary. */
  readonly onError?: "throw" | "fallback"
}

export interface CompactParams {
  readonly history: readonly HistoryItem[]
  readonly priorState?: StructuredState
  readonly priorSummary?: string
  /** How many compactions have already happened this session. */
  readonly compactionCount: number
  readonly objectiveChanged?: boolean
  readonly conflict?: boolean
  readonly force?: CompactionKind
}

export interface CompactionResult {
  readonly kind: CompactionKind
  readonly state: StructuredState
  readonly humanSummary: string
  readonly provenance: { readonly sourceEventIds: readonly string[] }
  readonly usedFallback: boolean
}

export class Compactor {
  private readonly summarizer: Summarizer
  private readonly rebaseEvery: number
  private readonly rebaseSummaryChars: number
  private readonly onError: "throw" | "fallback"

  constructor(options: CompactorOptions) {
    this.summarizer = options.summarizer
    this.rebaseEvery = options.rebaseEvery ?? 5
    this.rebaseSummaryChars = options.rebaseSummaryChars ?? 8000
    this.onError = options.onError ?? "fallback"
  }

  decideKind(params: CompactParams): CompactionKind {
    if (params.force) return params.force
    if (params.objectiveChanged || params.conflict) return "rebase"
    if (params.compactionCount > 0 && params.compactionCount % this.rebaseEvery === 0) return "rebase"
    if ((params.priorSummary?.length ?? 0) > this.rebaseSummaryChars) return "rebase"
    return "incremental"
  }

  async compact(params: CompactParams): Promise<CompactionResult> {
    const kind = this.decideKind(params)
    const prior = params.priorState ?? EMPTY_STATE
    const historyText = params.history.map((h) => `${h.role}: ${h.text}`).join("\n")
    const sourceEventIds = params.history.map((h) => h.eventId).filter((id): id is string => typeof id === "string")

    let parsedState: StructuredState | null = null
    let humanSummary = ""
    let lastError = "no attempt"

    for (let attempt = 0; attempt < 2 && parsedState === null; attempt++) {
      let out: SummarizeOutput
      try {
        out = await this.summarizer.summarize({
          historyText,
          priorState: prior,
          mode: kind,
          retryNote: attempt > 0 ? `Your previous reply was rejected (${lastError}). Return ONLY valid StructuredState JSON.` : undefined,
        })
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        break // summarizer itself failed — no point retrying the same call
      }
      const parsed = parseStructuredState(out.stateJson)
      if (parsed.ok) {
        parsedState = parsed.state
        humanSummary = out.humanSummary
      } else {
        lastError = parsed.error
      }
    }

    if (parsedState === null) {
      if (this.onError === "throw") throw new CompactionError(`compaction failed after retry: ${lastError}`)
      // Fallback: mechanical, model-free. Keep the authoritative prior state intact
      // (never invent), and give a truncated recent tail as the human view.
      return {
        kind,
        state: prior,
        humanSummary: mechanicalSummary(params.history),
        provenance: { sourceEventIds },
        usedFallback: true,
      }
    }

    const state = kind === "rebase" ? parsedState : mergeState(prior, parsedState)
    return { kind, state, humanSummary, provenance: { sourceEventIds }, usedFallback: false }
  }
}

function mechanicalSummary(history: readonly HistoryItem[], maxChars = 1200): string {
  const tail = history.slice(-6).map((h) => `${h.role}: ${h.text}`).join("\n")
  return `[mechanical fallback summary — model summarizer unavailable]\n${tail}`.slice(0, maxChars)
}
