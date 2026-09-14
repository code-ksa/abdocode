import { validateTransportRequest, type TransportRequest } from "@abdo/transport-contracts"
export interface SessionCursor { readonly sessionId: string; readonly acceptedRequestIds: readonly string[]; readonly interrupted: boolean; readonly afterSequence: number }

export function reduceAgentRequest(state: SessionCursor, untrusted: unknown): SessionCursor {
  const parsed = validateTransportRequest(untrusted)
  if (!parsed.ok) throw new Error(`agent_request_refused:${parsed.error.code}`)
  const request: TransportRequest = parsed.value
  if (request.sessionId !== state.sessionId) throw new Error("agent_session_mismatch")
  if (state.acceptedRequestIds.includes(request.requestId)) return state
  const acceptedRequestIds = Object.freeze([...state.acceptedRequestIds, request.requestId])
  if (request.kind === "interrupt") return Object.freeze({ ...state, acceptedRequestIds, interrupted: true })
  if (request.kind === "events") return Object.freeze({ ...state, acceptedRequestIds, afterSequence: request.afterSequence ?? 0 })
  return Object.freeze({ ...state, acceptedRequestIds })
}
