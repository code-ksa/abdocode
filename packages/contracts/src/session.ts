/** Session aggregates: the durable record + inputs + runs. */
import type { AgentID, ProjectID, RunID, SessionID } from "./id"
import type { SessionState } from "./state"

/**
 * ⚠️ كانت هذه الملفّات مبنيّة على `Schema.Struct` من النواة القديمة — وهي
 * بنياتُ بيانات، لا مُدخلاتٌ تُفكّ من الشبكة. قِيس: لا مستهلك يمرّرها إلى
 * `decode`. فالواجهةُ الأصليّة تعطي نفس النوع بلا تبعيّةٍ وقت التشغيل، والحدُّ
 * الذي يحتاج تحقّقاً يناديه صراحةً (`assertDomainEvent`, `assertSessionState`).
 */

/** A conversation/workspace scope. Pointer only — no message bodies here. */
export interface Session {
  readonly id: SessionID
  readonly projectId: ProjectID
  readonly title?: string
  readonly directory: string
  readonly agentId?: AgentID
  readonly model?: string
  readonly state: SessionState
  readonly archived: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * A user input is ADMITTED first (accepted, durable) and PROMOTED later (fed to
 * the model). Separating the two means an input is never lost if the process
 * dies between "received" and "sent".
 */
export interface SessionInput {
  readonly id: string
  readonly sessionId: SessionID
  readonly text: string
  readonly admittedAt: number
  readonly promotedAt?: number
}

/** How a run stopped when it left a non-completed terminal/paused state. */
export const RUN_STOP_REASONS = [
  "completed",
  // Work verified + no pending tools, but the final answer never arrived
  // (finalization stream broke). NEVER counted as normal completion.
  "completed_degraded",
  "cancelled",
  "provider_error",
  "stream_interrupted",
  "tool_failed",
  // A POLICY refused the call, repeatedly. Kept apart from `tool_failed`
  // because "you may not" and "it broke" send a reader to different places:
  // one is a permission conversation, the other is a bug. Found by the first
  // live run, where four denials were reported as a tool failure.
  "policy_denied",
  // The agent kept LOOKING and never CHANGED anything. Found by a live run
  // that made 91 tool calls -- 84 of them reads -- across 80 turns and left the
  // tree untouched. Reading a new file always counted as "progress", so the
  // existing no-progress guard (which detects a REPEATED call) never fired.
  "exploration_exhausted",
  // The completion protocol's objective verifier failed maxVerificationAttempts
  // times for the same mutation epoch.
  "verification_exhausted",
  "turn_budget",
  "tool_budget",
  "wall_clock_budget",
  "heartbeat_timeout",
  "context_overflow",
  "request_too_large",
] as const
export type RunStopReason = (typeof RUN_STOP_REASONS)[number]

export const isRunStopReason = (v: unknown): v is RunStopReason =>
  typeof v === "string" && (RUN_STOP_REASONS as readonly string[]).includes(v)

/**
 * One execution of the agent loop. Carries the liveness fields a watchdog uses
 * to move an abandoned run to `failed` instead of leaving it "running" forever.
 */
export interface SessionRun {
  readonly id: RunID
  readonly sessionId: SessionID
  readonly state: SessionState
  readonly stopReason?: RunStopReason
  readonly startedAt: number
  readonly finishedAt?: number
  readonly heartbeatAt?: number
  readonly leaseExpiresAt?: number
  readonly lastProgressAt?: number
}
