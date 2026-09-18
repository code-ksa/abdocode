/**
 * Session run state machine — the explicit lifecycle every Abdo run follows.
 *
 * The UI derives status from this persisted state, NOT from the presence or
 * absence of a stream. That is the fix for the "stuck on Thinking" failure:
 * a dropped provider stream still lands the run in a terminal state here.
 */
/**
 * ⚠️ كان هذا `Schema.Literals` من Effect.
 *
 * وEffect لم تكن تُستعمل هنا إلّا لهذا السطر الواحد: قائمةُ نصوصٍ مع نوعها.
 * لا فكّ ترميزٍ ولا تشفير — قِيس: لا مستهلك واحد يمرّرها إلى `decode`. فكان
 * محورُ العقود كلّه (١٩ حزمةً تعتمده) مربوطاً بطبقة تشغيلٍ كاملة **مقابل
 * ميزةٍ لم تُستعمل**. هذا هو مَكرُ النواة القديمة في أوضح صوره: تدخل عبر
 * الاستعمال الأتفه ثمّ تصير شرطاً للبناء.
 *
 * البديل هنا لا يُضعِف شيئاً: نفس القائمة، ونفس النوع المشتقّ منها، **وتحقّقٌ
 * حقيقيّ عند الحدّ** — بل أكثر ممّا كان: `assertSessionState` ترفض بجملةٍ
 * تسمّي القيمة، وما كان يُستعمل قبلها إلّا كنوعٍ ساكن.
 */
export const SESSION_STATES = [
  "idle",
  "input_admitted",
  "preparing_context",
  "calling_model",
  "streaming",
  "awaiting_permission",
  "executing_tool",
  "verifying",
  "compacting",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const

export type SessionState = (typeof SESSION_STATES)[number]

/** هل هذه القيمة حالةٌ معروفة؟ حارسُ نوعٍ يعمل وقت التشغيل. */
export const isSessionState = (value: unknown): value is SessionState =>
  typeof value === "string" && (SESSION_STATES as readonly string[]).includes(value)

/** عند الحدّ: قيمةٌ غريبة تُرفض بجملةٍ تسمّيها، لا تمرّ صامتة. */
export function assertSessionState(value: unknown): SessionState {
  if (!isSessionState(value)) {
    throw new TypeError(`not a session state: ${JSON.stringify(value)}`)
  }
  return value
}

/** States from which no further work happens without a new input. */
export const TERMINAL_STATES = ["completed", "failed", "cancelled"] as const
export type TerminalState = (typeof TERMINAL_STATES)[number]

export const isTerminal = (state: SessionState): state is TerminalState =>
  (TERMINAL_STATES as readonly string[]).includes(state)

/**
 * Allowed transitions. The runtime rejects any move not listed here, so an
 * illegal jump (e.g. streaming -> completed without verifying) is a caught
 * programming error rather than silent corruption.
 */
export const TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  idle: ["input_admitted", "cancelled"],
  input_admitted: ["preparing_context", "cancelled", "failed"],
  preparing_context: ["calling_model", "compacting", "failed", "cancelled"],
  calling_model: ["streaming", "awaiting_permission", "failed", "cancelled", "paused"],
  /**
   * `calling_model` is reachable from `streaming` for one reason: a turn that
   * produced nothing to act on has to be asked again.
   *
   * FOUND BY REVIEW (2026-08-20), and it is the sharpest kind of regression —
   * a fix that made things worse than the bug. The truncation handling added
   * hours earlier emits its notice from `streaming` and loops, which lands on
   * `calling_model`; the table refused it, so EVERY turn the provider cut short
   * would have died of an illegal transition instead of being continued. It
   * shipped because the new branch had no test that ever entered it.
   *
   * The transition is legitimate in the domain, and adding it opens nothing:
   * `streaming -> completed` still bypasses no verification (that gate lives in
   * the runtime, not here), and every other target is unchanged.
   */
  streaming: ["calling_model", "executing_tool", "verifying", "awaiting_permission", "completed", "failed", "cancelled", "paused"],
  awaiting_permission: ["executing_tool", "cancelled", "failed", "paused"],
  executing_tool: ["verifying", "streaming", "calling_model", "failed", "cancelled", "paused"],
  verifying: ["calling_model", "completed", "failed", "cancelled", "paused"],
  compacting: ["preparing_context", "calling_model", "failed", "cancelled"],
  paused: ["preparing_context", "calling_model", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
}

export const canTransition = (from: SessionState, to: SessionState): boolean =>
  TRANSITIONS[from].includes(to)
