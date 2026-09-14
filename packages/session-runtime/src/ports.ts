import type { ControlRecord, PolicyEnforced } from "@abdo/control-contracts"
import type { AgentMode } from "@abdo/control-contracts/modes"
/**
 * Ports the runtime orchestrates. Real adapters (Anthropic/OpenAI/Ollama model
 * clients, the tool runtime, the context system) implement these in later
 * slices; tests supply fakes. The runtime depends only on these interfaces, so
 * the loop's control flow can be verified without a network or a real model.
 */

export interface ToolCall {
  readonly name: string
  readonly input: unknown
  /** Provider tool-call id — links the tool result back to the model's request. */
  readonly id?: string
  /** Present on side-effecting tools; guards double-execution on retry. */
  readonly idempotencyKey?: string
}

/**
 * `truncated` means the provider stopped the turn because it ran out of output
 * room (`finish_reason: "length"`), not because the model was finished.
 *
 * FOUND BY AUDIT (2026-08-20): the stream assembler recorded the finish reason
 * and `result()` never read it, so a sentence cut off mid-word arrived at the
 * runtime as `{ kind: "final" }` — indistinguishable from a considered answer.
 * The run then verified it, failed, and spent a repair attempt on a model that
 * had not actually said anything yet. "The model finished" and "the model was
 * cut off" are different facts, and a runtime that cannot tell them apart will
 * always blame the model for the ceiling.
 *
 * Optional, so every existing consumer keeps compiling and keeps its meaning.
 */
export type ModelTurn =
  | { readonly kind: "final"; readonly text: string; readonly truncated?: boolean }
  | { readonly kind: "tools"; readonly calls: readonly ToolCall[]; readonly truncated?: boolean }

export interface ModelInput {
  readonly sessionId: string
  /**
   * The run this turn belongs to. Spend is recorded by the client, so without
   * it a session's token cost could not be split across its runs — and an
   * unattributable cost is one no budget can ever enforce.
   */
  readonly runId: string
  readonly turn: number
  /**
   * "finalize": a tool-free closing turn — the completion protocol has verified
   * the work and only the final response is owed. The model client must send
   * no tools and instruct the model to answer without calling any.
   */
  readonly phase?: "finalize"
}

/** Result of the completion protocol's objective verification. */
export interface CompletionVerification {
  readonly ok: boolean
  readonly detail?: string
  /**
   * Whether an objective check actually EXECUTED. `ok:true, ran:false` means
   * "no objective verifier applies" — the runtime records that honestly as
   * verification UNAVAILABLE (never as passed) while still letting the run
   * complete. Omitted = true.
   */
  readonly ran?: boolean
}

/**
 * Runtime Completion Protocol policy (12I.6 fix 5). The RUNTIME owns the
 * protocol — no final answer is accepted after mutations until an objective
 * verification passes, and verification is never repeated for an unchanged
 * mutation epoch. The POLICY owns the domain knowledge: which tools mutate and
 * which objective check (typecheck/test/build) applies.
 */
export interface CompletionPolicy {
  /** Does this tool call mutate state? Be conservative: unknown/shell => true. */
  isMutating(tool: string, args: unknown): boolean
  /**
   * Run the objective verification for the current mutation epoch. Executed BY
   * THE RUNTIME (never a model tool call), so it cannot enter the tool loop.
   */
  verify(info: { readonly sessionId: string; readonly epoch: number }): Promise<CompletionVerification>
  /** Consecutive no-progress turns before forced finalization (default 3). */
  readonly maxNoProgressTurns?: number
  /** Verification attempts per mutation epoch before the run fails (default 3). */
  readonly maxVerificationAttempts?: number
}

/**
 * A costly tool call whose usefulness depends on a SEMANTIC state, not on the
 * project as a whole. `rm -rf node_modules && npm install` is the proven case:
 * it is only worth repeating when the DEPENDENCY state changed — editing
 * `tsconfig.json` or `jest.config.js` bumps the workspace generation (which
 * legitimately re-allows an identical command) but adds nothing to a reinstall.
 */
export interface ExpensiveStrategy {
  /** Stable family id, e.g. "dependency_reinstall". Different commands in the
   *  same family share one ledger entry (`npm i` and `rm -rf node_modules &&
   *  npm install` are the same strategy, so alternating them cannot loop). */
  readonly strategy: string
  /**
   * WHERE the strategy acts, when one strategy can legitimately run in several
   * places — a monorepo package root for an install. Part of the ledger key, so
   * installing in `packages/frontend` never blocks `packages/backend`. Omitted
   * (or "") = the workspace root.
   */
  readonly scope?: string
  /**
   * Hash of ONLY the state this strategy depends on (for a dependency install:
   * package manager + that package's dependency maps + the owning lockfile). An
   * unrelated edit MUST NOT change it — that is the whole point of the guard.
   */
  readonly semanticStateHash: string
  /** One-line correction shown with the tool's own result (e.g. "this project
   *  uses bun"). Delivered on the existing tool result — never an extra one. */
  readonly advisory?: string
  /** Extra guidance appended to the block message when the call is refused. */
  readonly guidance?: string
}

/**
 * Semantic Strategy Guard policy. Classification is domain knowledge (which
 * commands install packages, what the dependency state is), so it lives outside
 * the runtime; the runtime owns only the ledger and the refusal.
 *
 * Deliberately NARROW: it classifies a small set of expensive, semantically
 * stateful command families and returns `undefined` for everything else. This is
 * not a general shell ban.
 */
export interface StrategyPolicy {
  /**
   * Classify a call BEFORE it runs — so the hash reflects the state at this
   * moment (a `package.json` edited one turn ago is already visible).
   * `undefined` = ordinary call, guard does not apply.
   */
  classify(call: { readonly tool: string; readonly args: unknown }): Promise<ExpensiveStrategy | undefined> | ExpensiveStrategy | undefined
  /**
   * Explicit, auditable authorization to run a strategy the ledger would refuse
   * — for the legitimate real case "reinstall anyway, I know nothing changed"
   * (a corrupted `node_modules`, a half-finished install). Absent => a redundant
   * strategy is always refused, which is the default.
   *
   * A grant must be ONE-SHOT and driven by an explicit human act; wiring it to
   * an auto-approver would delete the guard. Every grant is logged
   * (`tool.strategy_override_granted`), so a bypass is never invisible.
   */
  /**
   * The semantic state AFTER a successful execution. A costly command usually
   * rewrites part of its own state — `npm install` regenerates
   * `package-lock.json` — and that self-inflicted change must NOT count as new
   * information, or the strategy re-opens itself on every run and the guard can
   * never fire. Measured 2026-07-23: a real install moved the lockfile from 35
   * to 603 bytes, so the very next reinstall saw a "new" state.
   *
   * Absent => only the pre-state is tracked (the weaker, self-re-opening rule).
   */
  observeState?(info: { readonly strategy: string; readonly scope: string }): Promise<string> | string
  authorizeRetry?(info: {
    /** Session the request belongs to — a grant is always session-bound. */
    readonly sessionId: string
    readonly runId: string
    readonly strategy: string
    readonly scope: string
    readonly semanticStateHash: string
    readonly reason: string
    readonly successes: number
    readonly failures: number
  }): Promise<{ granted: boolean; reason?: string }> | { granted: boolean; reason?: string }
}

/**
 * One strategy family at one identity — `strategy + scope + targetIdentity`
 * (a composed policy packs the target into `scope`, so one entry is exactly one
 * strategy acting on one thing in one place).
 *
 * It is a PROJECTION OF THE SESSION LOG over every run, not per-run memory:
 * folded from `tool.started`/`tool.executed` before each decision, so a resume,
 * a second run, or a second runtime all read the same history and none of them
 * can reset the guard by starting over. `tool.started` doubles as a durable
 * CLAIM — while one is unmatched by its `tool.executed`, no other run may launch
 * that strategy at that scope.
 *
 * The ledger is TRANSITION-aware, not value-aware. A set of "states already
 * seen" cannot express the difference between *staying* somewhere and *coming
 * back* to it, and that difference is the whole question: a fetch whose
 * destination is deleted arrives at the same "missing" hash it started from,
 * and that is a real external change which must re-allow the fetch. So the
 * entry remembers the last transition instead of every value ever visited.
 *
 * NOTE (design debt, deliberate): `scope` carries the target identity as a
 * STRING, so the composite key is a text join. That is collision-prone by
 * construction — a scope containing the separator can alias another entry. The
 * replacement is a structured, versioned key object, not a longer separator.
 */
export interface StrategyLedgerEntry {
  readonly strategy: string
  readonly scope: string
  /**
   * How many times the WORLD moved this strategy's state out from under it.
   * Bumped whenever the observed state differs from the last one this entry
   * saw — so a hash that RETURNS to an earlier value opens a new epoch rather
   * than colliding with its own history. Only repetition INSIDE one epoch is
   * blocked.
   */
  stateEpoch: number
  /** The state seen at the last evaluation of this strategy. `undefined` before
   *  the first one. Compared against to detect an external change. */
  lastObservedStateHash?: string
  /**
   * The state the last SUCCESSFUL execution left behind, IN THIS EPOCH — the
   * post-install lockfile, the downloaded artifact. Arriving there is the
   * strategy's own doing, never new information. Cleared when the epoch turns:
   * a state produced two epochs ago says nothing about today.
   */
  lastPostStateHash?: string
  /** Per `epoch + state`: how the strategy has fared there. Keyed on the epoch
   *  too, so a new epoch starts the success/failure counts fresh. */
  readonly states: Map<string, { successes: number; failures: number; lastResultHash?: string }>
  /**
   * An abandoned execution whose EFFECT could not be determined (its run died
   * and nothing here can see whether it wrote). The claim is released — an
   * orphan must never hold the strategy for ever — but the attempt after it is
   * refused with `abandoned_execution_unknown_effect`, because retrying blindly
   * after a POSSIBLE side effect is precisely what the V2 rules forbid. Unlike a
   * live claim this reason IS overridable by an explicit human authorization.
   * Cleared when the epoch turns or when any execution completes here.
   */
  abandonedUnknown?: { toolExecutionId: string; state: string; epoch: number }
}

/**
 * Is the run that holds a claim still alive? Answered by whoever owns run
 * leases (the host), because the runtime has no view of processes.
 *
 * `"unknown"` is a first-class answer and must not be read as `"dead"`: taking
 * over a strategy from a run that is merely unobservable is how one install
 * becomes two. An unknown owner keeps the claim until the staleness backstop
 * (`strategyClaimTtlMs`) expires — the port makes that resolution PRECISE, it
 * is not what prevents the deadlock.
 */
export interface RunLiveness {
  status(runId: string): Promise<"live" | "dead" | "unknown"> | "live" | "dead" | "unknown"
}

/** How an abandoned execution's effect on the world was classified. */
export type AbandonedEffect = "applied" | "not_applied" | "unknown"

/**
 * Provider-neutral streaming events. The runtime never sees SSE or an OpenAI /
 * MiniMax wire shape — a provider adapter translates its wire format into these.
 */
export type ProviderStreamError = { readonly message: string; readonly retryable?: boolean }

export type ModelStreamEvent =
  | { readonly type: "response.started"; readonly requestId?: string }
  | { readonly type: "text.delta"; readonly text: string }
  | { readonly type: "reasoning.delta"; readonly text: string }
  | { readonly type: "tool_call.started"; readonly providerToolCallId: string; readonly name?: string; readonly index?: number }
  | { readonly type: "tool_call.arguments.delta"; readonly providerToolCallId: string; readonly delta: string }
  | { readonly type: "tool_call.completed"; readonly providerToolCallId: string }
  | { readonly type: "usage"; readonly inputTokens?: number; readonly outputTokens?: number }
  | { readonly type: "response.completed"; readonly finishReason: string }
  | { readonly type: "response.failed"; readonly error: ProviderStreamError }

/** Receives streamed events as they arrive (runtime persistence + display). */
export interface StreamSink {
  onEvent(event: ModelStreamEvent): void | Promise<void>
}

export interface ModelClient {
  /**
   * One provider turn. Rejects to signal a provider/transport failure.
   * `signal` aborts on timeout OR run cancellation — an honoring client must
   * cancel the real request so a hung/late response cannot leak.
   */
  call(input: ModelInput, options?: { signal?: AbortSignal }): Promise<ModelTurn>
  /**
   * Optional streaming turn. Emits provider-neutral events to `sink` as they
   * arrive and resolves to the SAME ModelTurn `call` would return, so the loop
   * is identical downstream. A client without this uses `call` (non-streaming).
   */
  stream?(input: ModelInput, options: { signal?: AbortSignal; sink: StreamSink }): Promise<ModelTurn>
}

/** Per-invocation compensation data mirrored from @abdo/tools (structural). */
export interface ToolMutationReceipt {
  readonly executionId: string
  readonly path?: string
  readonly beforeHash: string | null
  readonly afterHash?: string
  readonly backupPath?: string
  readonly existedBefore?: boolean
  readonly mutationStarted: boolean
  readonly mutationCommitted: boolean
}

export interface ToolRollbackReport {
  readonly status: "completed" | "failed"
  readonly reason: string
  readonly receipt: ToolMutationReceipt
  readonly error?: string
}

/** What was stripped from an outcome before anyone saw it (Sprint 16). */
export interface ToolRedactionRecord {
  readonly count: number
  readonly kinds: readonly string[]
}

export type ToolOutcome =
  | {
      readonly ok: true
      readonly output: unknown
      readonly mutation?: ToolMutationReceipt
      readonly resultFingerprint?: string
      readonly control?: ControlRecord
      readonly redactions?: ToolRedactionRecord
    }
  | {
      readonly ok: false
      readonly error: string
      /**
       * TRUE when a POLICY refused the call, rather than the tool failing.
       *
       * Found by the first live run: four consecutive denials tripped the
       * consecutive-tool-FAILURE budget and killed the run. "You may not" and
       * "it broke" are different facts, and conflating them makes every gate a
       * run-killer -- which is the strongest possible pressure to switch the
       * gates off.
       */
      readonly denied?: true
      readonly redactions?: ToolRedactionRecord
      /** Structured failure detail — a failure must carry information, not just a string. */
      readonly output?: unknown
      readonly mutation?: ToolMutationReceipt
      readonly rollback?: ToolRollbackReport
      /** Stable hash of the result (volatile fields excluded) for identical-failure detection. */
      readonly resultFingerprint?: string
      /** CL-01: the control decision that produced this outcome. Persisted by
       *  the runtime so every execution is explainable from the log alone. */
      readonly control?: ControlRecord
    }

/**
 * CL-01: the runtime accepts ONLY a runner that has been through the Policy
 * Enforcement Point. CL-00A §4.2 showed this was a convention, not a rule — a
 * future host could wire a raw runner and delete every policy check silently.
 * It is now a compile error. Test fakes and the shadow no-op go through
 * `unenforcedToolRunner(runner, reason)`, which is greppable and needs a reason.
 */
/**
 * What the runtime needs of an isolation event, and nothing more.
 *
 * The runtime does exactly one thing with these: `emit(event.type, {...event})`.
 * It never reads another field, so the port asks for `type` and treats the rest
 * as opaque payload. Keeping it this narrow is what lets the enforcement point
 * emit a PRECISE event type — one with no index signature, so no field can carry
 * an environment value — while still satisfying this port.
 */
export interface ForwardedIsolationEvent {
  readonly type: string
}

export type EnforcedToolRunner = ToolRunner & PolicyEnforced

export interface ToolRunner {
  /**
   * `signal` aborts the tool if the run is cancelled/times out — an honoring
   * runner must kill the child process TREE, not just the parent. `executionId`
   * ties the execution to its tool.started event for crash recovery.
   * `onRollbackStart` fires BEFORE a guarded rollback so it can be logged
   * durably (a rollback must never be invisible in the event log).
   */
  run(
    call: ToolCall,
    options?: {
      signal?: AbortSignal
      executionId?: string
      /**
       * Called with EVERY control decision (allow/ask/deny) BEFORE anything is
       * executed. The runtime persists it, so a crash mid-tool can never lose
       * the decision that authorised the tool. An enforcement point that throws
       * here must FAIL CLOSED and execute nothing.
       */
      onDecision?: (record: ControlRecord) => Promise<void> | void
      onRollbackStart?: (receipt: ToolMutationReceipt) => Promise<void> | void
      /**
       * CL-16A2-B: the isolation record for a process the enforcement point is
       * about to start. Awaited BEFORE the spawn, so the proof always precedes
       * the effect. Throwing here must refuse the launch, not warn about it.
       *
       * Typed as the MINIMUM the runtime actually uses so it takes no dependency
       * on @abdo/tools: it reads `type` and forwards the rest verbatim.
       *
       * The index signature this used to carry (`[k: string]: unknown`) was a
       * real defect, not a stylistic one. It made the port WIDER than the event
       * any enforcement point emits, and because function parameters are
       * contravariant that made `PolicyToolRunner` UNASSIGNABLE to its own port:
       * `@abdo/tools`' `IsolationEvent` has no index signature — deliberately, so
       * that no field can ever carry an environment VALUE — so it could not
       * satisfy a sink promising to accept arbitrary properties. Seven
       * `@abdo/host` type errors came from that single mismatch, and the
       * temptation was to widen `IsolationEvent`; that would have destroyed the
       * secret discipline the narrower type exists to enforce. The port is
       * narrowed instead.
       */
      onIsolation?: (event: ForwardedIsolationEvent) => Promise<void> | void
      /**
       * Sprint 25: the run's mode ceiling. Set by the runtime, never by the
       * model — it is not part of the call.
       */
      mode?: AgentMode
      /** Sprint 26: plan context from the runtime — never from the model. */
      plan?: { approvedPlanId?: string; filesChangedSoFar: number }
    },
  ): Promise<ToolOutcome>
  /**
   * A PURE, side-effect-free preview of the constraints this call would be
   * allowed under — kinds and env key NAMES only, never values. The runtime
   * records it on `tool.started`, so a crash between start and completion still
   * shows which constraints the execution began under (the durable decision on
   * its own proves what was decided, not that the overlay bound this attempt).
   *
   * Deterministic: `decide()` ignores execution identity, so this preview and
   * the authoritative decision inside `run()` agree. Optional — a plain runner
   * without enforcement omits it, and `tool.started` simply carries nothing.
   */
  describeEnforcement?(call: ToolCall): readonly EnforcedConstraintSummary[]
}

/** Durable, value-free constraint summary recorded on tool events. */
export interface EnforcedConstraintSummary {
  readonly kind: string
  readonly envKeys?: readonly string[]
}

export interface ContextReconciler {
  /** Build/refresh the system context before the model is called. */
  reconcile(sessionId: string): Promise<void>
}

/** Budgets bound a run so it pauses (saving state) instead of running forever. */
export interface Budgets {
  readonly maxTurns: number
  readonly maxToolCalls: number
  /**
   * How many consecutive POLICY DENIALS before the run stops.
   *
   * Higher than the failure ceiling on purpose: a denial leaves the world
   * untouched, so the cost of one more is a model call, while the cost of
   * stopping too early is an agent that gives up on work it could have done
   * another way.
   */
  readonly maxConsecutiveDenials: number
  /**
   * Consecutive turns that called tools and changed NOTHING.
   *
   * At this many the model is told what it has been doing; at twice this many
   * the run stops. Looking is not working, and an agent that does not know it
   * is looping cannot stop looping.
   */
  readonly maxReadOnlyTurns: number
  readonly wallClockMs: number
  /** Consecutive tool failures before the run gives up (tool errors otherwise
   * feed back to the model so it can correct). */
  readonly maxConsecutiveToolFailures: number
  /**
   * How long a strategy claim (`tool.started` with no `tool.executed`) may stand
   * before it is treated as ABANDONED and resolved.
   *
   * This is a BACKSTOP, not the mechanism: a wired `RunLiveness` says precisely
   * when the owning run died, and that is what normally releases a claim. The
   * timer exists so that a host with no liveness signal still cannot deadlock a
   * strategy for ever. It is deliberately long — a real `npm install` on a cold
   * cache runs for many minutes, and stealing a claim from a live install is the
   * duplicate side effect the guard exists to prevent.
   */
  readonly strategyClaimTtlMs: number
}

export const DEFAULT_BUDGETS: Budgets = {
  maxTurns: 16,
  maxToolCalls: 64,
  wallClockMs: 120_000,
  maxConsecutiveToolFailures: 5,
  // a denial changes nothing in the world, so one more costs a model call;
  // stopping too early costs work the agent could have done another way
  maxConsecutiveDenials: 12,
  maxReadOnlyTurns: 8,
  strategyClaimTtlMs: 30 * 60_000,
}
