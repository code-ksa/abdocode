/**
 * @abdo/memory — structured, provenance-backed memory.
 *
 * Facts are the source of truth for what Abdo "knows"; the summary is a
 * rebuildable projection of them. A fact is only trusted (verified) with a
 * documented source, and is never deleted — only superseded. See
 * docs/adr/0006-structured-memory-provenance.md.
 */
export * from "./types"
export { FactStore, ProvenanceError, CredentialLeakError } from "./store"
export { buildSummary, type MemorySummary, type SummaryItem } from "./summary"
export * from "./dna"
export * from "./layers"
export * from "./experience"
export * from "./validity"
export * from "./recall"
export { SqliteFactStore } from "./sqlite-store"
export * from "./strategy"
