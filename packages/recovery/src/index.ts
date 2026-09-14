/**
 * @abdo/recovery — crash recovery for AbdoCode.
 *
 * On startup the host runs the reconciler to find unfinished runs and decide
 * how to resume without duplicating side effects. See
 * docs/adr/0010-restart-resume.md.
 */
export { RecoveryReconciler } from "./reconciler"
export type { RecoveryDecision, UnfinishedRun, PendingTool } from "./reconciler"
export { RecoveryExecutor, RecoveryEventTypes } from "./executor"
export type { RecoveryResult, ToolRecoveryVerifier, VerifyResult, ExecutorOptions } from "./executor"
export { RecoveryVerificationError, UnknownToolOutcomeError } from "./errors"
