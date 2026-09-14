/** Epoch budget for one long objective.
 *
 * A checkpointed run is not a failure, but a ceiling that is too low turns
 * every qualification into `round-limit` at exactly the same number and hides
 * whether the model could have finished. The budget is therefore configurable,
 * while still bounded so a runaway loop cannot spend without end.
 *
 * The default is deliberately unchanged: an absent, unparsable, or
 * out-of-range setting is refused rather than widening the bound silently. */
export const DEFAULT_AGENT_EPOCHS = 16
export const MAX_CONFIGURABLE_AGENT_EPOCHS = 200

export function agentEpochBudget(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_AGENT_EPOCHS
  const trimmed = raw.trim()
  if (!/^\d+$/u.test(trimmed)) return DEFAULT_AGENT_EPOCHS
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CONFIGURABLE_AGENT_EPOCHS) return DEFAULT_AGENT_EPOCHS
  return parsed
}
