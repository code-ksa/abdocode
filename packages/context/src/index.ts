/**
 * @abdo/context — the V2 context system.
 *
 * Keyed sources -> baseline/snapshot/delta epochs stored in the event log,
 * plus a budget manager that blocks oversized requests (tokens AND bytes) and
 * execution modes so simple tasks stay cheap. See docs/adr/0004-context-epoch-and-budget.md.
 */
export * from "./sources"
export * from "./snapshot"
export * from "./budget"
export { ContextCompiler } from "./compiler"
export * from "./modes"
// NOTE (rust-main): ./instructions + ./instruction-scope were a compatibility
// facade that loaded @abdo/core/instruction-context (a REPLACED Effect-core
// module) at runtime via `await import(...)`. That surface cannot be honored on
// the Rust-kernel tree — its only consumer (@abdo/host) is itself replaced — so
// the two modules are dropped here. Instruction discovery/compilation returns
// when it is rebuilt kernel-native for a branch consumer that needs it.
export { EventSourcedReconciler, ContextEventTypes } from "./reconciler"
