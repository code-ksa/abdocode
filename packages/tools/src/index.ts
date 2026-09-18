/**
 * @abdo/tools — the safe tool runtime.
 *
 * Registry + policy engine + dangerous-command guard + approval gate + secret
 * redaction + dry-run + rollback. The model proposes tool calls; this decides
 * and enforces. See docs/adr/0005-safe-tool-runtime.md.
 */
export * from "./registry"
export { validateInput, type JsonSchema, type ModelToolSchema } from "./registry"
export * from "./policy"
export * from "./danger"
export * from "./catalogue"
export * as ProductTools from "./catalogue"
export * from "./secrets"
export { PolicyToolRunner, createEnforcedToolRunner } from "./runner"
export { BuiltinPolicyDecisionPoint, capabilityOf, assessCall, RULE } from "./pdp"
export type { ToolCall, ToolOutcome, RollbackReport, Approver, ApprovalRequest, RunnerOptions, AuditEntry, SupplyChainVerdict } from "./runner"
// Re-exported so a consumer of the enforcement point can name what it decides
// about without taking a second dependency on the contract package.
export {
  CONTROL_CONTRACT_VERSION,
  type Constraint,
  type ControlDecision,
  type ControlRecord,
  type ControlRequest,
  type PolicyDecisionPoint,
} from "@abdo/control-contracts"

export {
  probeIsolation,
  planIsolatedSpawn,
  denyAllArgv,
  isolationEnv,
  defaultSpawner,
  DENY_ALL_PROFILE,
  ISOLATION_VERSION,
  ISOLATION_STRIPPED_ENV,
  type NetworkMode,
  type IsolationSupport,
  type ExecutionIsolationProfile,
  type IsolationCapabilityReport,
  type IsolatedSpawnRequest,
  type IsolatedSpawnPlan,
  type CanaryResult,
  type Spawner,
} from "./isolation"

export {
  launchControlledProcess,
  drainStream,
  killProcessTree,
  resolveIsolationPrimitive,
  profileHash,
  IsolationEventTypes,
  INHERIT_PROFILE,
  UNMEASURED_CAPABILITY,
  LAUNCHER_VERSION,
  LAUNCHER_HASH,
  TRUSTED_PRIMITIVE_DIRS,
  type ControlledLaunchRequest,
  type ControlledLaunchResult,
  type ControlledExecutionGrant,
  type IsolationEvent,
  type IsolationEventType,
  type IsolationEventSink,
  type LauncherHooks,
} from "./launcher"
