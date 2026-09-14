/**
 * Request budget manager — checks a request against a provider envelope BEFORE
 * sending, on both tokens AND bytes (and message/tool counts).
 *
 * abdo sometimes overflowed because it only estimated tokens, while a proxy
 * rejected on raw byte size. Here every limit is checked, and the failure is a
 * typed RequestTooLargeError naming which limit was hit.
 */
import { RequestTooLargeError } from "@abdo/contracts/error"

export interface ProviderEnvelope {
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
  readonly maxRequestBytes?: number
  readonly maxMessages?: number
  /** Fraction (0..1) of headroom kept free, e.g. 0.1 = use at most 90%. */
  readonly safetyMargin: number
}

export interface RequestMessage {
  readonly role: string
  readonly text: string
}

export interface RequestToolDef {
  readonly name: string
  readonly schema: string
}

export interface RequestShape {
  readonly messages: readonly RequestMessage[]
  readonly tools: readonly RequestToolDef[]
}

// THE token estimator lives in @abdo/schema -- the lightest shared package,
// reachable from the browser UI as well as the engine. It was here, and a
// second copy in the window manager used a different divisor, so the same text
// was sized two ways in one binary. One definition, re-exported where it was.
import { estimateTokens, CHARS_PER_TOKEN } from "@abdo/schema"

export { estimateTokens, CHARS_PER_TOKEN }

export const byteLength = (text: string): number => Buffer.byteLength(text, "utf8")

export interface RequestMetrics {
  readonly inputTokens: number
  readonly bytes: number
  readonly messageCount: number
}

export function measure(shape: RequestShape): RequestMetrics {
  let tokens = 0
  let bytes = 0
  for (const m of shape.messages) {
    tokens += estimateTokens(m.text)
    bytes += byteLength(m.text)
  }
  for (const t of shape.tools) {
    tokens += estimateTokens(t.schema)
    bytes += byteLength(t.schema) + byteLength(t.name)
  }
  return { inputTokens: tokens, bytes, messageCount: shape.messages.length }
}

export type FitResult =
  | { readonly ok: true; readonly metrics: RequestMetrics }
  | { readonly ok: false; readonly reason: "tokens" | "bytes" | "messages"; readonly limit: number; readonly actual: number }

export function fits(shape: RequestShape, envelope: ProviderEnvelope): FitResult {
  const metrics = measure(shape)
  const tokenLimit = Math.floor(envelope.maxInputTokens * (1 - envelope.safetyMargin))
  if (metrics.inputTokens > tokenLimit) {
    return { ok: false, reason: "tokens", limit: tokenLimit, actual: metrics.inputTokens }
  }
  if (envelope.maxRequestBytes !== undefined) {
    const byteLimit = Math.floor(envelope.maxRequestBytes * (1 - envelope.safetyMargin))
    if (metrics.bytes > byteLimit) {
      return { ok: false, reason: "bytes", limit: byteLimit, actual: metrics.bytes }
    }
  }
  if (envelope.maxMessages !== undefined && metrics.messageCount > envelope.maxMessages) {
    return { ok: false, reason: "messages", limit: envelope.maxMessages, actual: metrics.messageCount }
  }
  return { ok: true, metrics }
}

/** Throw a typed error if the request does not fit. */
export function assertFits(shape: RequestShape, envelope: ProviderEnvelope): RequestMetrics {
  const result = fits(shape, envelope)
  if (!result.ok) {
    throw new RequestTooLargeError({ reason: result.reason, limit: result.limit, actual: result.actual })
  }
  return result.metrics
}
