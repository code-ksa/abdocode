/**
 * Assistant-message projection — the formal answer to "what happened to the
 * streamed text after a crash / supersede".
 *
 * Rules:
 *  - the AUTHORITATIVE assistant text is `message.appended` (status `completed`),
 *  - partial streamed text (delta batches with no completing message) is kept for
 *    display and audit but is NEVER a final message — status `interrupted`
 *    (crash / cancel) or `failed`,
 *  - a superseded attempt's partial is `interrupted`, not merged into the winner,
 *  - only the currently in-flight request may be `streaming`.
 *
 * Built purely from the event log, so a restarted process reconstructs the exact
 * same picture.
 */
import { EventTypes } from "./runtime"

export type AssistantStatus = "streaming" | "completed" | "interrupted" | "failed"

export interface AssistantMessageProjection {
  readonly requestId: string
  readonly attempt: number
  readonly status: AssistantStatus
  /** Batch text for a partial; the authoritative message text once completed. */
  readonly text: string
  /** True only when this is a real final assistant message. */
  readonly final: boolean
}

interface Group {
  requestId: string
  attempt: number
  text: string
  status: AssistantStatus
}

export function projectAssistantMessages(
  events: readonly { readonly type: string; readonly data: unknown }[],
  opts: { activeRequestId?: string } = {},
): AssistantMessageProjection[] {
  const groups: Group[] = []
  const byRequest = new Map<string, Group>()
  const current = (): Group | undefined => groups[groups.length - 1]

  for (const e of events) {
    const d = e.data as Record<string, unknown>
    if (e.type === EventTypes.ModelRequestStarted) {
      const g: Group = { requestId: String(d.requestId), attempt: Number(d.attempt ?? 1), text: "", status: "streaming" }
      groups.push(g)
      byRequest.set(g.requestId, g)
    } else if (e.type === EventTypes.MessageDeltaBatch) {
      const g = byRequest.get(String(d.requestId)) ?? current()
      if (g && typeof d.text === "string") g.text += d.text
    } else if (e.type === EventTypes.MessageAppended) {
      const g = current()
      if (g && d.role === "assistant" && typeof d.text === "string") {
        g.status = "completed"
        g.text = d.text // authoritative replaces the partial
      }
    } else if (e.type === EventTypes.RunFailed) {
      const g = current()
      if (g && g.status === "streaming") g.status = "failed"
    } else if (e.type === EventTypes.RunCancelled) {
      const g = current()
      if (g && g.status === "streaming") g.status = "interrupted"
    }
  }

  // Any group still "streaming" at the end is either the live one or a crash/
  // superseded partial (interrupted). A partial is NEVER final.
  for (const g of groups) {
    if (g.status === "streaming" && g.requestId !== opts.activeRequestId) g.status = "interrupted"
  }

  return groups.map((g) => ({ requestId: g.requestId, attempt: g.attempt, status: g.status, text: g.text, final: g.status === "completed" }))
}
