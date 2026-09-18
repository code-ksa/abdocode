/**
 * R9 local transport contracts.
 *
 * This package owns bytes and validation only. It deliberately imports no
 * HTTP, socket, listener, discovery, or network API. A host may carry these
 * frames over a local IPC primitive, but the contract cannot open one.
 */

export * from "./shell-protocol"

export const TRANSPORT_CONTRACT_VERSION = 1 as const
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024

const MAX_ID_CHARS = 128
const MAX_TEXT_CHARS = 256 * 1024
const MAX_REASON_CHARS = 2 * 1024

interface RequestBase {
  readonly version: typeof TRANSPORT_CONTRACT_VERSION
  readonly requestId: string
  readonly sessionId: string
}

export interface SubmitRequest extends RequestBase {
  readonly kind: "submit"
  readonly input: string
}

export interface SteerRequest extends RequestBase {
  readonly kind: "steer"
  readonly instruction: string
}

export interface InterruptRequest extends RequestBase {
  readonly kind: "interrupt"
  readonly reason?: string
}

export interface EventsRequest extends RequestBase {
  readonly kind: "events"
  /** Resume strictly after this durable event sequence. */
  readonly afterSequence?: number
}

export type TransportRequest = SubmitRequest | SteerRequest | InterruptRequest | EventsRequest
export type TransportRequestKind = TransportRequest["kind"]

export type TransportErrorCode =
  | "invalid_frame"
  | "invalid_field"
  | "invalid_kind"
  | "oversize_frame"
  | "trailing_bytes"
  | "unknown_field"
  | "unsupported_version"

export interface TransportValidationIssue {
  readonly code: TransportErrorCode
  readonly path: string
  readonly message: string
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TransportValidationIssue }

export class TransportContractError extends Error {
  readonly code: TransportErrorCode
  readonly path: string

  constructor(issue: TransportValidationIssue) {
    super(issue.message)
    this.name = "TransportContractError"
    this.code = issue.code
    this.path = issue.path
  }
}

const fail = (code: TransportErrorCode, path: string, message: string): ValidationResult<never> => ({
  ok: false,
  error: { code, path, message },
})

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const allowedKeys = {
  submit: new Set(["version", "kind", "requestId", "sessionId", "input"]),
  steer: new Set(["version", "kind", "requestId", "sessionId", "instruction"]),
  interrupt: new Set(["version", "kind", "requestId", "sessionId", "reason"]),
  events: new Set(["version", "kind", "requestId", "sessionId", "afterSequence"]),
} satisfies Record<TransportRequestKind, ReadonlySet<string>>

const boundedString = (
  value: unknown,
  path: string,
  maximum: number,
  allowEmpty = false,
): ValidationResult<string> => {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum) {
    return fail("invalid_field", path, `${path} must be a string between ${allowEmpty ? 0 : 1} and ${maximum} characters`)
  }
  return { ok: true, value }
}

/**
 * Validate untrusted decoded data. Every accepted key is listed above; a new
 * sender field therefore fails closed until this validator is intentionally
 * versioned and updated.
 */
export function validateTransportRequest(value: unknown): ValidationResult<TransportRequest> {
  if (!isPlainRecord(value)) return fail("invalid_frame", "$", "transport request must be a plain object")

  if (value.version !== TRANSPORT_CONTRACT_VERSION) {
    return fail("unsupported_version", "$.version", `only transport contract version ${TRANSPORT_CONTRACT_VERSION} is supported`)
  }

  if (value.kind !== "submit" && value.kind !== "steer" && value.kind !== "interrupt" && value.kind !== "events") {
    return fail("invalid_kind", "$.kind", "unknown transport request kind")
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys[value.kind].has(key)) return fail("unknown_field", `$.${key}`, `field ${key} is not allowed for ${value.kind}`)
  }

  const requestId = boundedString(value.requestId, "$.requestId", MAX_ID_CHARS)
  if (!requestId.ok) return requestId
  const sessionId = boundedString(value.sessionId, "$.sessionId", MAX_ID_CHARS)
  if (!sessionId.ok) return sessionId

  const base = {
    version: TRANSPORT_CONTRACT_VERSION,
    requestId: requestId.value,
    sessionId: sessionId.value,
  } as const

  if (value.kind === "submit") {
    const input = boundedString(value.input, "$.input", MAX_TEXT_CHARS, true)
    return input.ok ? { ok: true, value: { ...base, kind: "submit", input: input.value } } : input
  }

  if (value.kind === "steer") {
    const instruction = boundedString(value.instruction, "$.instruction", MAX_TEXT_CHARS)
    return instruction.ok ? { ok: true, value: { ...base, kind: "steer", instruction: instruction.value } } : instruction
  }

  if (value.kind === "interrupt") {
    if (value.reason === undefined) return { ok: true, value: { ...base, kind: "interrupt" } }
    const reason = boundedString(value.reason, "$.reason", MAX_REASON_CHARS)
    return reason.ok ? { ok: true, value: { ...base, kind: "interrupt", reason: reason.value } } : reason
  }

  if (value.afterSequence === undefined) return { ok: true, value: { ...base, kind: "events" } }
  if (!Number.isSafeInteger(value.afterSequence) || (value.afterSequence as number) < 0) {
    return fail("invalid_field", "$.afterSequence", "afterSequence must be a non-negative safe integer")
  }
  return { ok: true, value: { ...base, kind: "events", afterSequence: value.afterSequence as number } }
}

const assertMaximum = (maximum: number) => {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 0xffff_ffff) {
    throw new RangeError("maximum frame bytes must be an integer between 1 and 4294967295")
  }
}

const oversize = (length: number, maximum: number) => new TransportContractError({
  code: "oversize_frame",
  path: "$frame",
  message: `declared frame length ${length} exceeds maximum ${maximum}`,
})

/** Encode one validated JSON request with an unsigned 32-bit big-endian length prefix. */
export function encodeTransportFrame(value: unknown, maximum = DEFAULT_MAX_FRAME_BYTES): Uint8Array {
  assertMaximum(maximum)
  const validation = validateTransportRequest(value)
  if (!validation.ok) throw new TransportContractError(validation.error)

  const payload = new TextEncoder().encode(JSON.stringify(validation.value))
  if (payload.byteLength > maximum) throw oversize(payload.byteLength, maximum)

  const frame = new Uint8Array(4 + payload.byteLength)
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false)
  frame.set(payload, 4)
  return frame
}

/** Decode exactly one complete frame. Trailing bytes are rejected, not ignored. */
export function decodeTransportFrame(frame: Uint8Array, maximum = DEFAULT_MAX_FRAME_BYTES): TransportRequest {
  assertMaximum(maximum)
  if (frame.byteLength < 4) {
    throw new TransportContractError({ code: "invalid_frame", path: "$frame", message: "frame is missing its 4-byte length prefix" })
  }

  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false)
  if (length > maximum) throw oversize(length, maximum)
  if (length === 0 || frame.byteLength < 4 + length) {
    throw new TransportContractError({ code: "invalid_frame", path: "$frame", message: "frame payload is incomplete" })
  }
  if (frame.byteLength !== 4 + length) {
    throw new TransportContractError({ code: "trailing_bytes", path: "$frame", message: "frame contains trailing bytes" })
  }

  let parsed: unknown
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(4))
    parsed = JSON.parse(text)
  } catch {
    throw new TransportContractError({ code: "invalid_frame", path: "$frame", message: "frame payload must be valid UTF-8 JSON" })
  }

  const validation = validateTransportRequest(parsed)
  if (!validation.ok) throw new TransportContractError(validation.error)
  return validation.value
}

/**
 * Incremental decoder for a local byte stream. Its pending allocation is
 * capped at one maximum-size frame; oversized declarations fail immediately,
 * before the body is buffered.
 */
export class LocalFrameDecoder {
  readonly maximum: number
  #pending = new Uint8Array(0)

  constructor(maximum = DEFAULT_MAX_FRAME_BYTES) {
    assertMaximum(maximum)
    this.maximum = maximum
  }

  get pendingBytes(): number {
    return this.#pending.byteLength
  }

  reset(): void {
    this.#pending = new Uint8Array(0)
  }

  push(chunk: Uint8Array): TransportRequest[] {
    if (!(chunk instanceof Uint8Array)) {
      throw new TransportContractError({ code: "invalid_frame", path: "$frame", message: "frame chunk must be Uint8Array" })
    }
    if (this.#pending.byteLength + chunk.byteLength > this.maximum + 4) {
      throw oversize(this.#pending.byteLength + chunk.byteLength - 4, this.maximum)
    }

    const joined = new Uint8Array(this.#pending.byteLength + chunk.byteLength)
    joined.set(this.#pending)
    joined.set(chunk, this.#pending.byteLength)
    this.#pending = joined

    const decoded: TransportRequest[] = []
    while (this.#pending.byteLength >= 4) {
      const length = new DataView(this.#pending.buffer, this.#pending.byteOffset, this.#pending.byteLength).getUint32(0, false)
      if (length > this.maximum) throw oversize(length, this.maximum)
      const total = 4 + length
      if (this.#pending.byteLength < total) break
      decoded.push(decodeTransportFrame(this.#pending.slice(0, total), this.maximum))
      this.#pending = this.#pending.slice(total)
    }
    return decoded
  }
}

/** Encode a shell-protocol JSON value for a local byte carrier. */
export function encodeLocalJsonFrame(value: unknown, maximum = DEFAULT_MAX_FRAME_BYTES): Uint8Array {
  assertMaximum(maximum)
  const payload = new TextEncoder().encode(JSON.stringify(value))
  if (payload.byteLength === 0 || payload.byteLength > maximum) throw oversize(payload.byteLength, maximum)
  const frame = new Uint8Array(4 + payload.byteLength)
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false)
  frame.set(payload, 4)
  return frame
}

/** Incremental, bounded decoder for arbitrary shell-protocol JSON values. */
export class LocalJsonFrameDecoder {
  readonly maximum: number
  #pending = new Uint8Array(0)

  constructor(maximum = DEFAULT_MAX_FRAME_BYTES) {
    assertMaximum(maximum)
    this.maximum = maximum
  }

  get pendingBytes(): number { return this.#pending.byteLength }

  push(chunk: Uint8Array): unknown[] {
    if (!(chunk instanceof Uint8Array)) {
      throw new TransportContractError({ code: "invalid_frame", path: "$frame", message: "frame chunk must be Uint8Array" })
    }
    if (this.#pending.byteLength + chunk.byteLength > this.maximum + 4) {
      throw oversize(this.#pending.byteLength + chunk.byteLength - 4, this.maximum)
    }
    const joined = new Uint8Array(this.#pending.byteLength + chunk.byteLength)
    joined.set(this.#pending)
    joined.set(chunk, this.#pending.byteLength)
    this.#pending = joined
    const decoded: unknown[] = []
    while (this.#pending.byteLength >= 4) {
      const length = new DataView(this.#pending.buffer, this.#pending.byteOffset, this.#pending.byteLength).getUint32(0, false)
      if (length === 0) throw new TransportContractError({ code: "invalid_frame", path: "$frame", message: "empty frames are forbidden" })
      if (length > this.maximum) throw oversize(length, this.maximum)
      const total = 4 + length
      if (this.#pending.byteLength < total) break
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(this.#pending.subarray(4, total))
        decoded.push(JSON.parse(text))
      } catch {
        throw new TransportContractError({ code: "invalid_frame", path: "$frame", message: "frame payload must be valid UTF-8 JSON" })
      }
      this.#pending = this.#pending.slice(total)
    }
    return decoded
  }
}
