/**
 * Policy engine — decides what happens to a proposed tool call. The model only
 * *proposes*; this decides. High/critical risk, an explicit approval flag, or a
 * dangerous command all route through the approval gate.
 */
import type { ToolPolicy } from "./registry"

export type Decision = "allow" | "ask" | "deny"

export interface PolicyContext {
  /** A dangerous shell/SQL command was detected in the input. */
  readonly dangerous: boolean
}

export interface PolicyVerdict {
  readonly decision: Decision
  readonly reason: string
}

export function decide(policy: ToolPolicy, ctx: PolicyContext): PolicyVerdict {
  if (ctx.dangerous) {
    return { decision: "ask", reason: "dangerous command requires approval" }
  }
  if (policy.risk === "critical") {
    return { decision: "ask", reason: "critical-risk tool requires approval" }
  }
  if (policy.requiresApproval) {
    return { decision: "ask", reason: "tool marked requiresApproval" }
  }
  if (policy.risk === "high") {
    return { decision: "ask", reason: "high-risk tool requires approval" }
  }
  return { decision: "allow", reason: `${policy.risk}-risk tool auto-allowed` }
}
