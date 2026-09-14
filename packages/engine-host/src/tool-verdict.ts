/**
 * Explicit tool verdicts (queue item 1 — `plugins.toolVerdict`).
 *
 * A dispatcher that knows whether its tool succeeded says so beside the receipt
 * text it already produces. The text stays byte-identical for the model; the
 * verdict rides next to it for the host. A missing verdict is `undefined` and
 * is never coerced to success: consumers fall back to their legacy text
 * predicate AND count the fallback, so an unmigrated producer is visible.
 *
 * This module must not import `./text-agent-loop` (the loop imports it).
 */

/** One vocabulary. Every literal is copied from its owner and pinned by a runtime test. */
export type ToolVerdictReason =
  // ShellFailureClass verbatim — packages/builtin-tools/src/shell.ts
  | "command_not_found" | "process_spawn_failed" | "nonzero_exit" | "empty_failure_output"
  | "timeout" | "aborted" | "isolation_refused"
  // contracts classifyFailure codes — packages/contracts/src/failure.ts
  | "policy_denied" | "tool_not_permitted"
  // runner.ts / cli.ts unknown-tool refusals
  | "unknown_tool"
  // usage refusals (`الصيغة:`, «يحتاج …», «غير موجود») — USER_INPUT class
  | "invalid_input"
  // host rails in cli.ts that refused BEFORE any executor ran (policy class, not breakage)
  | "guard_refused"
  // kernel-tools (Rust EffectOutcome reused, no wire change)
  | "kernel_declined" | "kernel_unresolved"
  // cli.ts adapter settle / admission failures
  | "ledger_unsettled" | "admission_refused"
  // executor reported !ok with no finer machine code (adapter/external)
  | "tool_failed"

/** Exhaustive at compile time: adding a union member without listing it here fails typecheck. */
const REASON_TABLE: Readonly<Record<ToolVerdictReason, 0>> = {
  command_not_found: 0,
  process_spawn_failed: 0,
  nonzero_exit: 0,
  empty_failure_output: 0,
  timeout: 0,
  aborted: 0,
  isolation_refused: 0,
  policy_denied: 0,
  tool_not_permitted: 0,
  unknown_tool: 0,
  invalid_input: 0,
  guard_refused: 0,
  kernel_declined: 0,
  kernel_unresolved: 0,
  ledger_unsettled: 0,
  admission_refused: 0,
  tool_failed: 0,
}

/** Runtime view of the vocabulary, for the source-pin test. */
export const REASONS: readonly ToolVerdictReason[] = Object.freeze(Object.keys(REASON_TABLE) as ToolVerdictReason[])

export type ToolVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: ToolVerdictReason
      /** POLICY refusal (gate/guard/runner denied:true/kernel declined): loop-failure yes; wall/miner NO. */
      readonly denied: boolean
      /** Human detail (≤160 chars). Never matched on. */
      readonly detail?: string
    }

/** What a verdict-aware dispatcher returns. `output` is byte-identical to today's string. */
export interface DispatchResult {
  readonly output: string
  /** Absent = no explicit verdict offered → consumers fall back to their legacy regex AND count it. */
  readonly verdict?: ToolVerdict
  /** idempotencyKeyFor(...) when the operation is effectful. */
  readonly idempotencyKey?: string
  /**
   * The host changed the project even though the verdict is a failure (e.g. a
   * refused plan write that materialised a legal template). Declared by the
   * producer only; the loop moves its workspace generation on it so cached
   * reads of the mutated file are not replayed. Absent = no mutation claimed.
   */
  readonly mutated?: true
}

export interface ToolReceipt {
  readonly command: string
  readonly output: string
  readonly verdict?: ToolVerdict
  readonly mutated?: true
}

export const VERDICT_OK: ToolVerdict = Object.freeze({ ok: true })

/** Loop predicate: a denial IS non-completion (legacy, pinned). */
export const verdictFailed = (v: ToolVerdict): boolean => !v.ok

/**
 * احتياطُ الفشل حين لا حكمَ صريح — نصُّه بايتاً كما كان في `text-agent-loop`،
 * نُقل إلى هنا (الوحدة الورقة) ليقرأه `session-summary` بلا دورةِ استيراد.
 * الحلقةُ تُعيد تصديره باسمه، فمفردةُ الفشل واحدة لكلّ القُرّاء.
 *
 * Shared by model-selected and direct user tool paths: a refused/failed
 * execution must not become a successful task merely because dispatch ended.
 */
export const toolReceiptFailed = (command: string, output: string): boolean =>
  /^(?:رُفض|✕|⛔|الصيغة\s*:)|(?:فشل|unknown_tool|غير موجود)/u.test(output) ||
  (/^run\b/u.test(command) && /(?:انتهت مهلة|\btimeout\s*:|\btimed out\b|\baborted\b|انتهى الأمر برمز\s*[1-9]\d*\b|exit(?:ed)?(?: with)?(?: code)?\s*[1-9]\d*\b)/iu.test(output)) ||
  /(?:\bvulnerabilit(?:y|ies)\b[^\n]{0,100}\b(?:high|critical)\b|\b(?:high|critical)\b[^\n]{0,100}\bvulnerabil)/iu.test(output)

/** Wall/miner predicate: only breakage counts; a policy refusal is not a broken tool. */
export const verdictIsBreakage = (v: ToolVerdict): boolean => !v.ok && !v.denied

/** THE normalization point. A string or a result without `verdict` yields verdict undefined — never ok. */
export const resolveDispatch = (
  r: string | DispatchResult,
): { output: string; verdict: ToolVerdict | undefined; idempotencyKey: string | undefined; mutated: true | undefined } =>
  typeof r === "string"
    ? { output: r, verdict: undefined, idempotencyKey: undefined, mutated: undefined }
    : { output: r.output, verdict: r.verdict, idempotencyKey: r.idempotencyKey, mutated: r.mutated }

export interface ToolVerdictSnapshot {
  readonly total: number
  readonly explicit: number
  readonly inferred: number
  readonly inferredTools: readonly string[]
  readonly denied: number
  readonly failed: number
  readonly byReason: Readonly<Record<string, number>>
  readonly unmapped: number
}

const firstWord = (command: string): string => command.split(/\s+/u, 1)[0] ?? ""

/** Per-epoch coverage: denominator = ALL results; zero → "—" never 1.0. */
export class ToolVerdictLedger {
  #total = 0
  #explicit = 0
  #inferred = 0
  #inferredTools = new Set<string>()
  #denied = 0
  #failed = 0
  #byReason = new Map<string, number>()
  #unmapped = 0

  observe(command: string, verdict: ToolVerdict | undefined, unmapped?: boolean): void {
    this.#total += 1
    if (verdict === undefined) {
      this.#inferred += 1
      this.#inferredTools.add(firstWord(command))
      return
    }
    this.#explicit += 1
    if (!verdict.ok) {
      if (verdict.denied) this.#denied += 1
      else this.#failed += 1
      this.#byReason.set(verdict.reason, (this.#byReason.get(verdict.reason) ?? 0) + 1)
    }
    if (unmapped === true) this.#unmapped += 1
  }

  snapshot(): ToolVerdictSnapshot {
    return Object.freeze({
      total: this.#total,
      explicit: this.#explicit,
      inferred: this.#inferred,
      inferredTools: Object.freeze([...this.#inferredTools]),
      denied: this.#denied,
      failed: this.#failed,
      byReason: Object.freeze(Object.fromEntries(this.#byReason)),
      unmapped: this.#unmapped,
    })
  }

  /** Per epoch. */
  reset(): void {
    this.#total = 0
    this.#explicit = 0
    this.#inferred = 0
    this.#inferredTools = new Set<string>()
    this.#denied = 0
    this.#failed = 0
    this.#byReason = new Map<string, number>()
    this.#unmapped = 0
  }

  line(epoch: number): string {
    const s = this.snapshot()
    if (s.total === 0) return `📐 أحكام الأدوات ح${epoch}: —`
    const reasons = Object.entries(s.byReason).map(([reason, count]) => `${reason}×${count}`).join(",")
    return `📐 أحكام الأدوات ح${epoch}: صريح=${s.explicit}/${s.total} · مستنتَج=${s.inferred}` +
      `${s.inferredTools.length > 0 ? ` (أدوات: ${s.inferredTools.join(",")})` : ""}` +
      ` · رفض سياسة=${s.denied} · فشل=${s.failed} · أسباب=${reasons.length > 0 ? reasons : "—"} · غير ممطوط=${s.unmapped}`
  }
}
