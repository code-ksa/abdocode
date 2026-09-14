/**
 * Owned engine composition root.
 *
 * This package assembles existing ports and adapters. It deliberately contains
 * no network client, filesystem tool, process launcher, or kernel call. Those
 * capabilities can enter only through injected model and tool definitions;
 * every tool definition is wrapped by the policy-enforcement factory before
 * the session runtime can receive it.
 */
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import {
  SessionRuntime,
  type ModelClient,
  type RunOptions,
  type RunResult,
  type RuntimeDeps,
} from "@abdo/session-runtime"
import {
  ToolRegistry,
  createEnforcedToolRunner,
  type ModelToolSchema,
  type RunnerOptions,
  type ToolDefinition,
} from "@abdo/tools"

export interface EngineHostOptions extends Omit<RuntimeDeps, "store" | "model" | "tools"> {
  /** SQLite filename, or `:memory:` for an ephemeral host. */
  readonly database?: string
  readonly model: ModelClient
  /** Runtime-owned implementations; none are discovered or imported here. */
  readonly toolDefinitions: readonly ToolDefinition[]
  /** Policy, approval, identity, and isolation inputs for the enforcement point. */
  readonly runner?: RunnerOptions
}

export type ReplayedEvent = Awaited<ReturnType<SqliteEventStore["read"]>>[number]

export class EngineHost {
  readonly #store: SqliteEventStore
  readonly #registry: ToolRegistry
  readonly #runtime: SessionRuntime
  #closed = false
  #activeOperations = 0

  constructor(options: EngineHostOptions) {
    this.#registry = new ToolRegistry()
    const names = new Set<string>()
    for (const definition of options.toolDefinitions) {
      if (names.has(definition.name)) throw new Error(`engine_host_duplicate_tool: ${definition.name}`)
      names.add(definition.name)
      this.#registry.register(definition)
    }

    this.#store = new SqliteEventStore(options.database ?? ":memory:")
    try {
      const tools = createEnforcedToolRunner(this.#registry, options.runner)
      this.#runtime = new SessionRuntime({
        store: this.#store,
        model: options.model,
        tools,
        reconciler: options.reconciler,
        budgets: options.budgets,
        modelTimeoutMs: options.modelTimeoutMs,
        streamTimeouts: options.streamTimeouts,
        maxStreamRetries: options.maxStreamRetries,
        deltaFlushBytes: options.deltaFlushBytes,
        completion: options.completion,
        strategy: options.strategy,
        liveness: options.liveness,
        publisher: options.publisher,
        now: options.now,
      })
    } catch (error) {
      this.#store.close()
      throw error
    }
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Provider-neutral tool definitions after the host has admitted them. */
  toolSchemas(): readonly ModelToolSchema[] {
    this.#assertOpen()
    return Object.freeze(this.#registry.toModelSchemas().map((schema) => Object.freeze(schema)))
  }

  admit(sessionId: string, text: string): Promise<string> {
    return this.#operate(() => this.#runtime.admit(sessionId, text))
  }

  run(sessionId: string, options: RunOptions = {}): Promise<RunResult> {
    return this.#operate(() => this.#runtime.run(sessionId, options))
  }

  /** Replay one session's durable source-of-truth events in sequence order. */
  replay(sessionId: string, fromSequence = 0): Promise<readonly ReplayedEvent[]> {
    if (!Number.isInteger(fromSequence) || fromSequence < 0) {
      return Promise.reject(new Error("engine_host_invalid_replay_sequence"))
    }
    return this.#operate(async () => Object.freeze(await this.#store.read("session", sessionId, fromSequence)))
  }

  /**
   * Close the owned SQLite adapter. Idempotent after success, but refuses to
   * race a live admit/run/replay operation.
   */
  close(): void {
    if (this.#closed) return
    if (this.#activeOperations !== 0) throw new Error("engine_host_busy")
    this.#store.close()
    this.#closed = true
  }

  [Symbol.dispose](): void {
    this.close()
  }

  async #operate<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen()
    this.#activeOperations++
    try {
      return await operation()
    } finally {
      this.#activeOperations--
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("engine_host_closed")
  }
}

export const createEngineHost = (options: EngineHostOptions): EngineHost => new EngineHost(options)

export {
  ServeEventTypes,
  ServeJournal,
  openServeJournal,
  type ServeAdmission,
  type ServeJournalOptions,
  type ServeJournalSnapshot,
  type ServeOutputEvent,
  type ServeTurnRecord,
} from "./serve-journal"

export {
  runTextAgentLoop,
  toolReceiptFailed,
  compactReadTrail,
  compactTrail,
  isReadDigest,
  isExecDigest,
  isTrailDigest,
  isWriteDigest,
  writeDigest,
  verdictLineOf,
  MAX_TEXT_AGENT_ROUNDS,
  SUMMARY_WITH_COMMAND,
  type ReadTrailEntry,
  type TrailEntry,
  type TextAgentLoopOptions,
  type TextAgentLoopResult,
  type TextAgentMessage,
  type NativeAgentCall,
  type NativeAgentReply,
} from "./text-agent-loop"

export {
  SUMMARY_HEAD,
  SUMMARY_SECTIONS,
  SUMMARY_LABELS,
  SUMMARY_MAX_LINES,
  SUMMARY_SECTION_CAP,
  SUMMARY_MAX_CHARS,
  SUMMARY_EPOCH_CAP,
  SUMMARY_INSTRUCTION,
  SUMMARY_MEASURED_HEADING,
  SUMMARY_NOTE_HEADING,
  EMPTY_SESSION_SUMMARY,
  EMPTY_SUMMARY_DRAFT,
  splitSummary,
  verifySummary,
  mergeSessionSummary,
  parseStoredSummary,
  renderSessionSummary,
  summaryEventLine,
  type SummarySection,
  type SummaryDraft,
  type SummarySplit,
  type SummaryClaim,
  type DroppedClaim,
  type SummaryVerdict,
  type SessionSummary,
  type SummaryLine,
  type SummaryRedactor,
  type ClaimStatus,
  type ActClass,
} from "./session-summary"

export {
  INTENT_PREFIX,
  INTENT_MAX_CHARS,
  sanitizeIntent,
  splitIntent,
  stripMeasure,
  type IntentSplit,
} from "./intent-line"

export {
  REASONS,
  ToolVerdictLedger,
  VERDICT_OK,
  resolveDispatch,
  verdictFailed,
  verdictIsBreakage,
  type DispatchResult,
  type ToolReceipt,
  type ToolVerdict,
  type ToolVerdictReason,
  type ToolVerdictSnapshot,
} from "./tool-verdict"

/** Engine cannot import contracts directly; the key builder rides through this barrel. */
export { idempotencyKeyFor, type OperationKind } from "@abdo/contracts/idempotency"

export type { ModelClient, ModelTurn, RunOptions, RunResult } from "@abdo/session-runtime"
export type { RunnerOptions, ToolDefinition } from "@abdo/tools"
