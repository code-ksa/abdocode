export type BrowserLane = "api" | "dom" | "accessibility" | "vision"
export interface BrowserAttempt { readonly lane: BrowserLane; readonly outcome: "success" | "unsupported" | "failed" }
const ORDER: readonly BrowserLane[] = ["api", "dom", "accessibility", "vision"]

export function nextBrowserLane(attempts: readonly BrowserAttempt[]): BrowserLane | undefined {
  for (let index = 0; index < attempts.length; index += 1) {
    if (attempts[index]!.lane !== ORDER[index]) throw new Error("browser_ladder_order_violation")
    if (attempts[index]!.outcome === "success") return undefined
  }
  return ORDER[attempts.length]
}

export function requireBrowserVerification(attempts: readonly BrowserAttempt[]): void {
  if (!attempts.some((attempt) => attempt.outcome === "success")) throw new Error("browser_action_unverified")
}
