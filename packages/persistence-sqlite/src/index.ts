/**
 * @abdo/persistence-sqlite — durable adapter for AbdoCode.
 *
 * Implements the @abdo/event-store port on bun:sqlite and provides projections
 * rebuilt from the log. Single-node by design (V2.0); Postgres/multi-node are
 * deferred until the core is stable. See docs/adr/0002-event-store-is-source-of-truth.md.
 */
export { SqliteEventStore } from "./sqlite"
export { foldSession, SessionProjector, type SessionView } from "./projections"
export { SqliteLeaseManager, type AcquireResult, type LeaseRow, type LeaseOptions } from "./lease"
export {
  CheckpointStore,
  CHECKPOINT_EVENT,
  type RunCheckpoint,
  type CheckpointPhase,
} from "./checkpoints"
export { RunStateProjector } from "./projector"
export { withBusyRetry, withBusyRetrySync, isBusy, type RetryOptions, type SyncRetryOptions } from "./db-retry"
