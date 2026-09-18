/**
 * @abdo/schema — the pure, effect-free surface on the Rust-kernel tree.
 *
 * It owns the dependency-free token estimator (`tokens`) and golden-trace
 * harness (`golden-trace`, imported through the `./golden-trace` subpath).
 * Domain contracts are owned by the Rust kernel.
 */
export * from "./tokens"
