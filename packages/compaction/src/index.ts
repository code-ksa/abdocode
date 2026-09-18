/**
 * @abdo/compaction — auditable context budgeting + compaction.
 *
 * Compaction here is NOT "summarize the chat". It is documented, inspectable
 * budget management:
 *   1. a Context Manifest recording exactly what entered each provider request,
 *   2. a priority-ordered budget planner (tokens AND bytes AND messages),
 *      SEPARATE from the compactor, that never evicts protected content,
 *   3. a compactor producing an authoritative StructuredState + a human summary,
 *      with per-item provenance, incremental merge + periodic full rebase,
 *   4. safe tool-output pruning (protected/recent/summarizable/discardable/
 *      externalized to `tool-output://` artifacts).
 *
 * See docs/adr/0014-compaction.md.
 */
export * from "./budget"
export * from "./manifest"
export * from "./state"
export * from "./tool-output"
export * from "./compactor"
export * from "./spill"
