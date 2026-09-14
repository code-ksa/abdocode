import type { ToolVerdict } from "@abdo/engine-host"
import { exitZero } from "./failure-tiering"

/** A successful process with no tests is not a verified test suite. */
export function projectTestPassed(output: string, verdict?: ToolVerdict): boolean {
  if (!exitZero(output, verdict)) return false
  if (/no tests? (?:found|collected)|\b[1-9]\d*\s+(?:failed|fail)\b|# fail [1-9]/iu.test(output)) return false
  return /(?:\b[1-9]\d*\s+(?:passed|pass)\b|# pass [1-9]\d*\b)/iu.test(output)
}

/** Project facts are schema-projected, not JSON cut off behind a long goal. */
export function recallExecutionFact(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value).slice(0, 500)
  const fact = value as Record<string, unknown>
  const receipts = Array.isArray(fact.receipts) ? fact.receipts.slice(-4).map((raw) => {
    const receipt = raw as { command?: unknown; output?: unknown }
    return { command: String(receipt.command ?? "").split("\n", 1)[0].slice(0, 180), output: String(receipt.output ?? "").slice(0, 900) }
  }) : undefined
  return JSON.stringify({ goal: String(fact.goal ?? "").slice(0, 700), status: fact.status,
    stopReason: fact.stopReason, receipts,
    ...(receipts === undefined ? { detail: JSON.stringify(value).slice(0, 700) } : {}),
  })
}
