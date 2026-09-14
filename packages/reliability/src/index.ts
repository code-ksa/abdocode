/**
 * @abdo/reliability — the tools, and what they refuse.
 *
 * Ten sprints of the same discipline applied to the ten places an agent
 * actually breaks things: a query built by concatenation, a write killed
 * halfway, a git command with no verified way back, an install with the wrong
 * manager, a secret in a log, a secret in a prompt, a process that outlived its
 * run, a container that was never ours, a search that quietly truncated.
 */
export * from "./data"
export * from "./supply"
export * from "./secrets"
export * from "./runtime"
