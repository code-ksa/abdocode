/**
 * @abdo/migration-v1 — the deletable legacy bridge.
 *
 * Reads a legacy abdo store READ-ONLY and imports it into the abdo event
 * log. This is the ONLY sanctioned way abdo touches V1 data (ADR 0000). Once V2
 * is adopted this package can be removed without affecting the core.
 * See docs/adr/0008-v1-importer.md.
 */
export * from "./types"
export { SqliteV1Source } from "./sqlite-source"
export { Importer, V1EventTypes, type ImportOptions } from "./importer"
