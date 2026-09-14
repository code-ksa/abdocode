import { encodeTransportFrame, TRANSPORT_CONTRACT_VERSION, type TransportRequest } from "@abdo/transport-contracts"
export class LocalAgentClient {
  readonly sessionId: string
  #nextId = 1
  #afterSequence = 0
  constructor(sessionId: string) { if (!sessionId) throw new Error("client_session_required"); this.sessionId = sessionId }
  submit(input: string): Uint8Array { return this.#encode({ kind: "submit", input }) }
  interrupt(reason?: string): Uint8Array { return this.#encode(reason === undefined ? { kind: "interrupt" } : { kind: "interrupt", reason }) }
  resume(afterSequence = this.#afterSequence): Uint8Array { return this.#encode({ kind: "events", afterSequence }) }
  observe(sequence: number): void { if (!Number.isSafeInteger(sequence) || sequence < this.#afterSequence) throw new Error("client_sequence_regression"); this.#afterSequence = sequence }
  #encode(body: { kind: "submit"; input: string } | { kind: "interrupt"; reason?: string } | { kind: "events"; afterSequence: number }): Uint8Array {
    const requestId = `${this.sessionId}:${this.#nextId++}`
    return encodeTransportFrame({ version: TRANSPORT_CONTRACT_VERSION, requestId, sessionId: this.sessionId, ...body } satisfies TransportRequest)
  }
}
