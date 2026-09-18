/**
 * Tool execution record — every tool call is a first-class, replayable event.
 *
 * Rebuilt on the Rust-kernel contracts (2026-08-27): the Effect-`Schema`
 * version this replaces lived on the old core. The shapes are preserved
 * verbatim as plain kernel types — the only consumer, `@abdo/tools`, imports
 * `ToolPolicy` as a type, so no runtime validator is needed here.
 */
import type { IdempotencyKey, MessageID, SessionID, ToolExecutionID } from "./id"

export const TOOL_STATUSES = [
  "pending",
  "awaiting_permission",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const
export type ToolStatus = (typeof TOOL_STATUSES)[number]

/** Risk drives the permission gate; a critical tool never auto-runs. */
export const TOOL_RISKS = ["read", "low", "medium", "high", "critical"] as const
export type ToolRisk = (typeof TOOL_RISKS)[number]

export const SECRETS_ACCESS_LEVELS = ["none", "references", "runtime"] as const
export type SecretsAccess = (typeof SECRETS_ACCESS_LEVELS)[number]

/** Static policy the runtime consults before dispatching a tool. */
export interface ToolPolicy {
  readonly risk: ToolRisk
  readonly idempotent: boolean
  readonly reversible: boolean
  readonly requiresApproval: boolean
  readonly supportsDryRun: boolean
  readonly timeoutMs: number
  readonly secretsAccess: SecretsAccess
}

export interface ToolExecution {
  readonly id: ToolExecutionID
  readonly sessionId: SessionID
  readonly messageId: MessageID
  readonly name: string
  readonly input: unknown
  readonly status: ToolStatus
  /** Present only on idempotent tools; guards against re-running side effects on retry. */
  readonly idempotencyKey?: IdempotencyKey
  readonly output?: unknown
  readonly error?: string
  readonly startedAt?: number
  readonly finishedAt?: number
}
