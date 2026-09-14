/**
 * @abdo/project-index — how Abdo finds code.
 *
 * A tiered retrieval ladder (exact path > exact symbol > full-text), not a
 * blind vector search: for code, naming beats similarity. Content-hashed so a
 * modified file is always re-indexed. See docs/adr/0007-project-index-ladder.md.
 */
export * from "./symbols"
export { ProjectIndex, TIER_ORDER } from "./project-index"
export type { RetrievalTier, FileEntry, SearchResult } from "./project-index"
