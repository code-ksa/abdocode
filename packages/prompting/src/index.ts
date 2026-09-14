/**
 * @abdo/prompting — the model performance layer.
 *
 * The plan used to touch this only with a swap proof at the very end, which
 * had it backwards: the model is the dominant variable in agent quality, and
 * this is the layer a small local model lives or dies on. Four refusals, one
 * per sprint: no instruction change without a measurement, no tool narrowing
 * that costs completion, no repaired output that looks clean, and no prompt
 * truncated to fit a window.
 */
export * from "./instructions"
export * from "./surface"
export * from "./structured"
export * from "./local"
export * from "./harness-profile"
export * from "./harness/index"
