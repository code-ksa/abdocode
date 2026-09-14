/**
 * @abdo/benchmark — the REAL V1<->V2 comparative harness.
 *
 * Real isolation (git worktree per trial), full per-run instrumentation,
 * OBJECTIVE verification (typecheck/tests/expected+forbidden diff/content),
 * order-swap, three reports, an explicit success gate, and a failure list with
 * repro. It drives real runtimes through the RuntimeAdapter port; it does NOT
 * fabricate numbers. Live V1<->V2 numbers require a provider key AND a wired V1
 * adapter — see RESULTS.md.
 */
export * from "./metrics"
export * from "./adapter"
export * from "./tasks"
export * from "./suite-gen"
export * from "./confirmatory"
export { STRATEGY_PROBE_TASKS } from "./strategy-probes"
export * from "./isolation"
export * from "./verify"
export * from "./runner"
export * from "./report"
export * from "./suite-v1"
export * from "./scorecard"
export * from "./comparison"
