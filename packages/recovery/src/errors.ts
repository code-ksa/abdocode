/** Typed recovery failures — callers match on the class, never on message text. */

export class RecoveryVerificationError extends Error {
  constructor(
    readonly runId: string,
    readonly detail: string,
  ) {
    super(`recovery verification failed for ${runId}: ${detail}`)
    this.name = "RecoveryVerificationError"
  }
}

/** A tool's post-crash state could not be determined — stop, do not risk a re-run. */
export class UnknownToolOutcomeError extends Error {
  constructor(
    readonly runId: string,
    readonly toolExecutionId: string,
    readonly reason: string,
  ) {
    super(`unknown outcome for tool ${toolExecutionId} in ${runId}: ${reason}`)
    this.name = "UnknownToolOutcomeError"
  }
}
