/**
 * ContextManifest — the auditable record of EXACTLY what went into a provider
 * request. Built before every real model call and appended to the event log so
 * context/compaction bugs are diagnosable ("what did the model actually see?")
 * instead of guessed.
 *
 * It stores METADATA ONLY: source key, content hash, included bytes, estimated
 * tokens, priority, and the reason it was included or excluded. It never stores
 * message bodies, tool-result payloads, or secrets — only their hashes.
 */
import { estimateTokens, byteLength } from "@abdo/context"
import type { EventStore } from "@abdo/event-store"
import type { EntryKind } from "./budget"

export interface ManifestEntry {
  readonly key: string
  readonly kind: EntryKind
  readonly contentHash: string
  readonly includedBytes: number
  readonly estimatedTokens: number
  readonly priority: number
  readonly included: boolean
  /** Why it was included, or why it was excluded. */
  readonly reason: string
}

export interface ContextManifest {
  readonly requestId: string
  readonly sessionId: string
  readonly runId: string
  readonly attemptId: string
  readonly contextEpochId: string
  readonly entries: readonly ManifestEntry[]
  readonly estimatedInputTokens: number
  readonly reservedOutputTokens: number
  readonly serializedBytes: number
  readonly providerId: string
  readonly modelId: string
  readonly createdAt: string
}

export const MANIFEST_EVENT = "model.request.manifest"

/** Build a manifest entry from text — text is hashed/measured then discarded. */
export function manifestEntry(
  key: string,
  kind: EntryKind,
  text: string,
  meta: { priority: number; included: boolean; reason: string },
): ManifestEntry {
  return {
    key,
    kind,
    contentHash: fnv1a(text),
    includedBytes: meta.included ? byteLength(text) : 0,
    estimatedTokens: meta.included ? estimateTokens(text) : 0,
    priority: meta.priority,
    included: meta.included,
    reason: meta.reason,
  }
}

export interface ManifestIds {
  readonly requestId: string
  readonly sessionId: string
  readonly runId: string
  readonly attemptId: string
  readonly contextEpochId: string
  readonly providerId: string
  readonly modelId: string
}

export function buildManifest(ids: ManifestIds, entries: readonly ManifestEntry[], reservedOutputTokens: number): ContextManifest {
  const included = entries.filter((e) => e.included)
  return {
    ...ids,
    entries,
    estimatedInputTokens: included.reduce((n, e) => n + e.estimatedTokens, 0),
    reservedOutputTokens,
    serializedBytes: included.reduce((n, e) => n + e.includedBytes, 0),
    createdAt: new Date().toISOString(),
  }
}

/**
 * Persist the manifest to the event log (metadata only — safe to store). The
 * manifest is nested under `manifest` so its own `runId`/`requestId` fields are
 * NOT top-level event data — the runtime's request-identity check keys off
 * top-level runId/requestId and must not see the manifest's copies.
 */
export async function appendManifest(store: EventStore, manifest: ContextManifest): Promise<void> {
  await store.append({
    aggregateKind: "session",
    aggregateId: manifest.sessionId,
    type: MANIFEST_EVENT,
    data: { manifest } as unknown as Record<string, unknown>,
  })
}

/** Read back the manifests recorded for a session (for `abdo2` inspection). */
export async function readManifests(store: EventStore, sessionId: string): Promise<ContextManifest[]> {
  const events = await store.read("session", sessionId)
  return events.filter((e) => e.type === MANIFEST_EVENT).map((e) => (e.data as { manifest: ContextManifest }).manifest)
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}
