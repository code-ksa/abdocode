/**
 * @abdo/session-runtime — the agent loop over the event store.
 *
 * Depends only on the EventStore port and abstract model/tool/context ports, so
 * the loop's guarantees (terminal event on every path, legal transitions,
 * budgets, cancellation, durable two-phase input) are verified with fakes.
 * See docs/adr/0003-runtime-always-lands-terminal.md.
 */
export { SessionRuntime, EventTypes } from "./runtime"
export type { RunResult, RunOptions, RuntimeDeps, ContinueOptions, PersistedEvent } from "./runtime"
export type { SessionState } from "@abdo/contracts/state"
export * from "./ports"
export { StreamAssembler, StreamFailure, BufferedDeltaSink, replayStreamText, type DeltaWriter } from "./stream"
export { StreamHub, BoundedSubscriber, classifyEvent, type DeliveryClass, type SubscriberOptions, type OfferResult, type QueuedEvent, type HubOptions } from "./hub"
export { projectAssistantMessages, type AssistantMessageProjection, type AssistantStatus } from "./projection"
export { SliceExecutor, type Slice, type SliceOutcome, type SliceContext, type SliceMutationResult } from "./slices"
export { MissionLedger, type MissionLedgerOptions, type TransitionResult } from "./missions"
export { PlanLedger, type PlanLedgerOptions } from "./plans"
export {
  buildEvidencePacket,
  narrativeLeak,
  passIsEarned,
  runVerificationLoop,
  VerificationLedger,
  type BuilderFeedback,
  type BuilderRound,
  type PacketSources,
  type VerificationLedgerOptions,
  type VerificationLoopOptions,
  type VerificationLoopResult,
  type VerifierJudgement,
} from "./verification"
export {
  parseChanged,
  planIntegration,
  WorkspaceManager,
  type AcquiredWorkspace,
  type WorkspaceExec,
  type WorkspaceExecResult,
  type WorkspaceManagerOptions,
} from "./workspaces"
export {
  laneUtilisation,
  runWorkQueue,
  workSignature,
  type ScheduleOptions,
  type ScheduleReport,
  type WorkItem,
  type WorkOutcome,
} from "./scheduler"
export {
  activateWorkers,
  assignTasks,
  describeFleet,
  integrateFleetWork,
  MAX_WORKERS,
  OrchestratorEventTypes,
  retireWorkers,
  ROLE_MODE,
  ROLE_ORDER,
  soloFleet,
  type ActivationRequest,
  type ActivationResult,
  type ActivationSource,
  type AgentRole,
  type AgentSlot,
  type Assignment,
  type AssignmentPlan,
  type Fleet,
  type TaskSpec,
} from "./orchestrator"
