/**
 * @abdo/control-contracts — CL-01.
 *
 * ONE decision contract for every tool call, local or remote. The CL-00A
 * inventory found four decision makers with four different shapes behind a
 * single enforcement point (see docs/control-plane/execution-paths.md §8):
 * the policy runner, the strategy guard, the repeat guard, and the completion
 * verifier — which decided nothing at all. This package is the shared shape.
 *
 * Deliberately NOT here:
 *   - the policy LANGUAGE and rule matching  -> CL-02
 *   - durable grants and approval lifecycle  -> CL-03
 *   - real command normalization             -> CL-04
 *   - real risk classification               -> CL-05
 *
 * Those slot into the fields declared here without changing the contract, which
 * is the point of shipping the contract first. Pure types plus one hash helper:
 * no policy, no execution, no I/O.
 */
import { createHash } from "node:crypto"

/**
 * Bumped when a field changes meaning or a required field is added. Every
 * persisted decision carries it, so an old event log is always interpretable.
 */
export const CONTROL_CONTRACT_VERSION = 3 as const
export type ControlContractVersion = typeof CONTROL_CONTRACT_VERSION

// ---------------------------------------------------------------- the target

/**
 * WHERE the operation would take effect. Today only the local workspace is
 * constructible; `container` (CL-12) and `remote` (CL-13) extend this union
 * rather than replacing it, so the contract survives those sprints.
 */
export type ExecutionTarget = {
  readonly kind: "workspace"
  /** Absolute workspace root the operation is confined to. */
  readonly workspace: string
  /** Package root within the workspace, "" for the root itself. */
  readonly scope?: string
}

/** Stable, comparable identity of a target — what audit and grants key on. */
export function targetIdentity(target: ExecutionTarget): string {
  return `workspace:${target.workspace}${target.scope ? `#${target.scope}` : ""}`
}

// ------------------------------------------------------------- the operation

/** One resolved command inside a (possibly compound) invocation. */
export interface NormalizedCommand {
  /** The real program after wrappers are stripped (`npm`, not `cmd`). */
  readonly program: string
  readonly argv: readonly string[]
  /** Working directory relative to the call's cwd, accumulated from `cd`. */
  readonly cwd: string
  /** Inline `VAR=value` assignments that apply to this command. */
  readonly env: Readonly<Record<string, string>>
  readonly redirections: readonly { readonly kind: "in" | "out" | "append"; readonly target: string }[]
  readonly background: boolean
}

/**
 * What the call actually does, independent of its spelling.
 *
 * `certainty: "uncertain"` means the parser could not fully account for the
 * input — a substitution, an eval, an unsupported shell. It MUST NOT be treated
 * as safe: an unknown is a risk INPUT, not an absence of risk, and the decision
 * point escalates it. There is no path from "we could not parse this" to allow.
 */
export interface NormalizedOperation {
  readonly kind: "opaque" | "shell" | "file_read" | "file_write"
  readonly shell?: "bash" | "powershell" | "cmd"
  /** One-line description for audit. Never a secret. */
  readonly summary: string
  readonly certainty: "parsed" | "uncertain"
  readonly commands?: readonly NormalizedCommand[]
  /** Effective cwd of the invocation, relative to the tool's own cwd. */
  readonly cwd?: string
  /** Segments the parser could not account for — why `certainty` is uncertain. */
  readonly unknownDynamicSegments?: readonly string[]
  /** Machine-readable reasons, so a UI/audit need not parse prose. */
  readonly uncertainReasons?: readonly string[]
  /**
   * What the operation touches. `analysis` is REQUIRED and must be read first:
   * an empty `writes` under `analysis: "unknown"` means "we did not look", NOT
   * "it writes nothing". Presenting unfilled analysis as empty arrays is how a
   * destructive command comes to look inert. Full analysis is CL-05; until then
   * anything less than `complete` keeps the risk elevated.
   */
  readonly resources?: ResourceAnalysis
}

export interface ResourceAnalysis {
  readonly analysis: "unknown" | "partial" | "complete"
  readonly reads?: readonly string[]
  readonly writes?: readonly string[]
  readonly networkHints?: readonly string[]
}

/**
 * Semantic capability families (CL-05). WHAT an operation does, not which tool
 * spelled it. `unknown` is a real answer and is treated conservatively — it is
 * never a synonym for "harmless".
 *
 * Docker/SSH/Kubernetes/cloud families are CLASSIFIED here so those commands are
 * not silently `unknown`. Classification is not support: there is no adapter,
 * no target contract and no execution path for them (CL-12/CL-13).
 */
export type Capability =
  | "filesystem.read"
  | "filesystem.write"
  | "filesystem.delete"
  | "filesystem.permission"
  | "package.install"
  | "package.update"
  | "package.remove"
  | "package.script"
  | "process.start"
  | "process.kill"
  | "network.request"
  | "network.listen"
  | "git.read"
  | "git.commit"
  | "git.push"
  | "git.force"
  | "git.reset"
  | "docker.inspect"
  | "docker.build"
  | "docker.run"
  | "docker.exec"
  | "docker.remove"
  | "docker.prune"
  | "ssh.connect"
  | "ssh.exec"
  | "ssh.copy"
  | "ssh.tunnel"
  | "database.read"
  | "database.write"
  | "database.schema"
  | "database.drop"
  | "kubernetes.read"
  | "kubernetes.apply"
  | "kubernetes.delete"
  | "kubernetes.exec"
  | "cloud.read"
  | "cloud.deploy"
  | "cloud.delete"
  | "cloud.iam"
  | "system.read"
  | "system.service"
  | "system.restart"
  | "system.disable"
  | "secret.read"
  | "secret.use"
  | "secret.write"
  | "artifact.publish"
  | "code.execute"
  | "unknown"

export type RiskLevel = "read" | "low" | "medium" | "high" | "critical"

/**
 * The dimensions a level is DERIVED from (CL-05). Recorded so an audit can see
 * why something scored as it did, and so a UI can explain it without prose.
 * `unknown` on any dimension is itself a risk input.
 */
export interface RiskDimensions {
  readonly reversibility: "reversible" | "compensable" | "irreversible" | "unknown"
  readonly blastRadius: "file" | "package" | "workspace" | "machine" | "external" | "unknown"
  readonly environment: "local" | "dev" | "staging" | "production" | "unknown"
  readonly credentialScope: "none" | "reads_secret" | "uses_secret" | "writes_secret" | "unknown"
  readonly dataSensitivity: "none" | "project" | "credential" | "unknown"
  readonly persistence: "ephemeral" | "workspace" | "system" | "unknown"
  readonly externalSideEffects: "none" | "yes" | "unknown"
  readonly estimatedCost: "none" | "low" | "high" | "unknown"
  readonly privilegeEscalation: "no" | "yes" | "unknown"
  readonly parserCertainty: "parsed" | "uncertain"
}

export interface RiskAssessment {
  readonly level: RiskLevel
  /** Present from CL-05 onward. The level is derived from these. */
  readonly dimensions?: RiskDimensions
  /** Capabilities found in the operation, for audit and policy matching. */
  readonly capabilities?: readonly Capability[]
  /** A dangerous-command rule matched (rm -rf, DROP DATABASE, ...). */
  readonly dangerous: boolean
  /** Which rule matched, when one did. */
  readonly rule?: string
  /**
   * `conservative_default` means the classifier could not analyse the input and
   * assumed the worst. Never silently treated as `classified`.
   */
  readonly certainty: "classified" | "conservative_default"
}

// --------------------------------------------------------------- the request

/** Who is asking. A subagent inherits, never expands, its parent's identity. */
export interface ControlActor {
  readonly agent: string
  readonly model: string
  readonly provider: string
}

export interface ControlRequest {
  readonly version: ControlContractVersion
  readonly sessionId: string
  readonly runId: string
  readonly attemptId: number
  readonly requestId: string
  readonly toolExecutionId: string
  readonly actor: ControlActor
  readonly tool: string
  readonly capability: Capability
  readonly target: ExecutionTarget
  readonly normalizedOperation: NormalizedOperation
  readonly risk: RiskAssessment
  /** Stable hash of the call arguments — never the arguments themselves. */
  readonly argsHash: string
  /** References only (`env://KEY`, `vault://...`), never a secret value. */
  readonly secretRefs: readonly string[]
  /** How this request came to exist: model tool call, runtime verification, recovery. */
  readonly provenance: readonly string[]
  /**
   * CL-11: whether this operation runs package-manager lifecycle scripts, and
   * whether that can be CONSTRAINED without rewriting the command. Assembled by
   * the caller (which holds both the parse and the raw text — the raw text
   * matters, because a `set VAR=false &&` prefix can vanish from the parse while
   * remaining in force in the shell) and consumed by the decision point.
   *
   * Absent means the caller did not assess it — which the decision point must
   * not read as "no scripts". Present-and-`required:false` is the claim that
   * nothing runs.
   */
  readonly lifecycle?: {
    /** IMPLICIT scripts (install hooks / project pre-post) are present and want
     *  suppressing. The EXPLICIT named script is not counted here. */
    readonly implicitRequired: boolean
    /** A measured overlay covers every implicit-script command and nothing can
     *  undo it — the only condition under which the constraint may be claimed. */
    readonly implicitEnforceable: boolean
    /** The command explicitly runs a named script; the overlay does NOT stop it,
     *  so it is judged by risk, not by suppression. */
    readonly explicitCodeExecution: boolean
    readonly envOverlay: Readonly<Record<string, string>>
    readonly blockers: readonly string[]
    readonly detail: string
  }
  /**
   * CL-11 supply-chain view of a package install, command-derived. Present only
   * for install commands. `deterministic` is the `npm ci` form (reproduces the
   * lockfile, fails if missing/mismatched); `blockers` names why an install is
   * NOT the clean deterministic default-source subset (resolves/mutates,
   * custom registry, git/url/tarball source). A non-empty `blockers` is what
   * turns an install into `ask` rather than a scripts-suppressed auto-allow.
   */
  readonly installSource?: {
    readonly isInstall: boolean
    readonly deterministic: boolean
    readonly offline: boolean
    readonly blockers: readonly string[]
  }
  /**
   * CL-11 supply-chain verdict for the WORKSPACE this install would run in —
   * facts a command-only view cannot see: a custom registry or auth/proxy in
   * `.npmrc` (package/root/user scope), untrusted `resolved` hosts or missing
   * `integrity` in the lockfile, npm config inherited from the environment.
   *
   * Supplied by a host-side verifier (the next slice). ABSENT is `unknown`, and
   * FAIL-CLOSED: a deterministic `npm ci` auto-allows ONLY when this is
   * `verified`. `unknown` asks; `unsafe` is refused with its own reason (a
   * per-reason `deny` is reserved for the verifier that can justify it). This
   * exists so `npm ci` does not sit on the allow path before those facts are
   * checked.
   */
  readonly workspaceSupplyChain?: {
    readonly status: "verified" | "unknown" | "unsafe"
    /** Why unsafe/unknown — machine-readable, secret-free, for audit/policy. */
    readonly reasons?: readonly string[]
    /** ONE combined, ecosystem-agnostic evidence hash the decision is BOUND to
     *  (see decisionHash). 3B/4C re-check it just before execution; any change
     *  makes the decision stale. npm and pip both reduce their files+config to
     *  this single value. */
    readonly evidenceHash?: string
    /** Which verifier produced the verdict — for an EXPLAINABLE audit. */
    readonly verifierKind?: string
    /** The real install target (pip site-packages / --target), when known. */
    readonly installTarget?: string
    /** Versions of the policy/verifier that produced the verdict — a verdict from
     *  an older one must not be trusted, so they enter the hash too. */
    readonly policyVersion?: number
    readonly verifierVersion?: number
  }
}

// -------------------------------------------------------------- the decision

/**
 * Structured reason codes. A decision must be explainable without parsing
 * prose, so the UI, the audit log and a test can all agree on WHY.
 */
export type ReasonCode =
  /** Sprint 25: the run's MODE excludes an operation of this kind. */
  | "mode_excludes_operation"
  /** Sprint 26: a mutation with no approved plan and no fast path. */
  | "plan_required"
  | "auto_allowed_low_risk"
  | "dangerous_command_requires_approval"
  | "critical_risk_requires_approval"
  | "unparsed_operation_requires_approval"
  | "unanalyzed_resources_requires_approval"
  | "high_risk_requires_approval"
  | "tool_marked_requires_approval"
  | "approval_granted"
  | "approval_denied"
  | "no_approver_available"
  | "unknown_tool"
  | "invalid_tool_arguments"
  | "lifecycle_scripts_not_suppressible"
  | "install_source_not_verified"
  | "install_supply_chain_unsafe"
  | "stale_supply_chain_evidence"
  | "disk_budget_exceeded"
  | "redundant_expensive_strategy"
  | "repeated_identical_tool_result"
  | "runtime_verification_constant_command"

/**
 * Constraints an `allow` may attach. Enforced by the PEP, not by the tool.
 *
 * `suppressImplicitLifecycleScripts` (CL-11) removes the package-manager scripts
 * that fire WITHOUT being named — a fetched package's install hooks, and the
 * project's own `pre`/`post` wrappers. It does NOT stop a script the command
 * explicitly invokes (`npm test`): measured 2026-07-23,
 * `npm_config_ignore_scripts=true` leaves the named script running. The name
 * says "implicit" for exactly that reason — a constraint must not claim more
 * than the environment delivers.
 *
 * It is enforced as an ENVIRONMENT OVERLAY, never by rewriting the command:
 * measured, an overlay covers every segment of a chain, while editing a shell
 * line breaks on chains and differs across POSIX and Windows. `env` carries what
 * the PEP applies. It lives on the IN-MEMORY decision only; the durable record
 * keeps key NAMES, never values (see `EnforcedConstraint`).
 *
 * A constraint the enforcement point cannot apply is FAIL-CLOSED: nothing runs.
 * An allow whose constraint is silently dropped would be the worst of both — the
 * audit trail claiming a protection that never existed.
 */
export type Constraint =
  | { readonly kind: "readOnly" | "timeoutMs" | "expiresAt"; readonly value: boolean | number }
  | { readonly kind: "suppressImplicitLifecycleScripts"; readonly value: true; readonly env: Readonly<Record<string, string>> }

/**
 * The DURABLE form of a constraint: its kind and the NAMES of the environment
 * keys it set — never their values. An overlay could one day carry a token; a
 * record that stores names only can never leak one. This is what goes on
 * `control.decided`, `tool.started` and `tool.executed`.
 */
export interface EnforcedConstraint {
  readonly kind: Constraint["kind"]
  /** Names of the env keys the overlay set. Present only for env-bearing kinds. */
  readonly envKeys?: readonly string[]
}

/** Summarise in-memory constraints to their durable, value-free form. */
export function summarizeConstraints(constraints: readonly Constraint[]): EnforcedConstraint[] {
  return constraints.map((c) =>
    "env" in c ? { kind: c.kind, envKeys: Object.keys(c.env).sort() } : { kind: c.kind },
  )
}

export type ControlAction = "allow" | "ask" | "deny"

export type ControlDecision =
  | {
      readonly version: ControlContractVersion
      readonly action: "allow"
      readonly ruleId: string
      readonly reasonCode: ReasonCode
      readonly constraints: readonly Constraint[]
      /** Set when the allow was unlocked by a grant (CL-03). */
      readonly grantId?: string
    }
  | {
      readonly version: ControlContractVersion
      readonly action: "ask"
      readonly ruleId: string
      readonly reasonCode: ReasonCode
      readonly approvalRequestId: string
    }
  | {
      readonly version: ControlContractVersion
      readonly action: "deny"
      readonly ruleId: string
      readonly reasonCode: ReasonCode
    }

/**
 * The Policy DECISION Point. It answers; it never executes. Splitting this from
 * enforcement is what stops a tool from deciding its own fate.
 */
export interface PolicyDecisionPoint {
  decide(request: ControlRequest): ControlDecision | Promise<ControlDecision>
}

/**
 * Stable hash of (request, decision) over the fields that make the decision what
 * it is. Deliberately EXCLUDES volatile identity (requestId, toolExecutionId,
 * attemptId) so the same call under the same policy hashes the same across runs
 * — that is what makes a decision comparable in an audit.
 *
 * NOT AN IDEMPOTENCY KEY, AND NOT A GRANT KEY. Because it ignores execution
 * identity, two DIFFERENT executions of the same call hash identically — using
 * it to dedupe side effects would collapse them, and using it to key a grant
 * would let one approval silently authorise a later, separate execution. Side
 * effects are keyed by `idempotencyKey`; grants are keyed by session/run/target
 * (CL-03).
 */
export function decisionHash(request: ControlRequest, decision: ControlDecision): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: decision.version,
        tool: request.tool,
        capability: request.capability,
        target: targetIdentity(request.target),
        argsHash: request.argsHash,
        operation: { kind: request.normalizedOperation.kind, certainty: request.normalizedOperation.certainty },
        risk: { level: request.risk.level, dangerous: request.risk.dangerous, rule: request.risk.rule ?? null, certainty: request.risk.certainty },
        action: decision.action,
        ruleId: decision.ruleId,
        reasonCode: decision.reasonCode,
        // Two allows that enforce DIFFERENT constraints are not the same
        // decision. Leaving these out would let a constrained and an
        // unconstrained allow of the same command hash identically, which is
        // exactly the comparison an audit is trying to make. Hashed by kind +
        // env key NAMES (not values), matching what is durably recorded.
        constraints:
          decision.action === "allow"
            ? summarizeConstraints(decision.constraints).sort((a, b) => a.kind.localeCompare(b.kind))
            : [],
        // CL-11 3B: the decision is bound to the evidence it was made on. Two
        // decisions over different manifest/lockfile/config, or from different
        // policy/verifier versions, are NOT the same decision — the hash must
        // move so a stale one can never pass for a fresh one.
        supplyChain: request.workspaceSupplyChain
          ? {
              status: request.workspaceSupplyChain.status,
              evidenceHash: request.workspaceSupplyChain.evidenceHash ?? null,
              policyVersion: request.workspaceSupplyChain.policyVersion ?? null,
              verifierVersion: request.workspaceSupplyChain.verifierVersion ?? null,
            }
          : null,
      }),
    )
    .digest("hex")
}

/**
 * Where a decision sits in its own lifecycle.
 *
 * `pending` is the initial `ask` — recorded BEFORE a human is consulted, so a
 * crash during approval leaves evidence rather than a gap. `final` is what was
 * actually enforced. They are separate records, and the final one names the
 * pending one it replaces, so nobody has to guess which is which.
 */
export type DecisionPhase = "pending" | "final"

/** What gets persisted alongside a tool event: the decision, provably. */
export interface ControlRecord {
  readonly version: ControlContractVersion
  readonly action: ControlAction
  readonly phase: DecisionPhase
  /**
   * Identity of THIS decision record. Derived from execution identity + phase,
   * so replaying the same logical decision produces the same id — that is what
   * makes the event idempotent on retry/resume. (Distinct from `decisionHash`,
   * which deliberately ignores execution identity and is for comparison only.)
   */
  readonly decisionId: string
  /** The `pending` record this `final` one replaces, when an approval occurred. */
  readonly supersedesDecisionId?: string
  /** Present on an `ask`, and carried onto the decision that resolved it. */
  readonly approvalRequestId?: string
  readonly ruleId: string
  readonly reasonCode: ReasonCode
  readonly capability: Capability
  readonly target: string
  readonly decisionHash: string
  readonly grantId?: string
  /** What the enforcement point will apply — kinds and env key NAMES, never
   *  values. Present on an `allow` that carries constraints, so the durable
   *  record states the protection rather than implying it. */
  readonly constraints?: readonly EnforcedConstraint[]
  /**
   * CL-11 supply-chain summary — present when the request carried a workspace
   * verdict. Kept ALONGSIDE the evidenceHash so the decision is EXPLAINABLE, not
   * merely comparable: which verifier, its version, the status, the reason codes
   * that drove it, and the install target it was bound to. Secret-free.
   */
  readonly supplyChain?: {
    readonly status: "verified" | "unknown" | "unsafe"
    readonly verifierKind?: string
    readonly verifierVersion?: number
    readonly policyVersion?: number
    readonly evidenceHash?: string
    readonly installTarget?: string
    readonly reasons?: readonly string[]
  }
}

/**
 * Stable id for a decision record. Keyed on the EXECUTION (toolExecutionId) plus
 * the phase, so the same logical decision always yields the same id and can be
 * appended idempotently — while two different executions of the same call get
 * different ids.
 */
export function decisionId(request: ControlRequest, phase: DecisionPhase): string {
  return "dec_" + createHash("sha256").update(`${request.sessionId}|${request.toolExecutionId}|${phase}`).digest("hex").slice(0, 32)
}

export function controlRecord(
  request: ControlRequest,
  decision: ControlDecision,
  options: { readonly phase?: DecisionPhase; readonly supersedes?: string; readonly approvalRequestId?: string } = {},
): ControlRecord {
  // An `ask` is by definition not final; anything else defaults to final.
  const phase: DecisionPhase = options.phase ?? (decision.action === "ask" ? "pending" : "final")
  return {
    version: decision.version,
    action: decision.action,
    phase,
    decisionId: decisionId(request, phase),
    ...(options.supersedes ? { supersedesDecisionId: options.supersedes } : {}),
    ...(decision.action === "ask"
      ? { approvalRequestId: decision.approvalRequestId }
      : options.approvalRequestId
        ? { approvalRequestId: options.approvalRequestId }
        : {}),
    ruleId: decision.ruleId,
    reasonCode: decision.reasonCode,
    capability: request.capability,
    target: targetIdentity(request.target),
    decisionHash: decisionHash(request, decision),
    ...(decision.action === "allow" && decision.grantId ? { grantId: decision.grantId } : {}),
    ...(decision.action === "allow" && decision.constraints.length > 0 ? { constraints: summarizeConstraints(decision.constraints) } : {}),
    ...(request.workspaceSupplyChain
      ? {
          supplyChain: {
            status: request.workspaceSupplyChain.status,
            ...(request.workspaceSupplyChain.verifierKind ? { verifierKind: request.workspaceSupplyChain.verifierKind } : {}),
            ...(request.workspaceSupplyChain.verifierVersion !== undefined ? { verifierVersion: request.workspaceSupplyChain.verifierVersion } : {}),
            ...(request.workspaceSupplyChain.policyVersion !== undefined ? { policyVersion: request.workspaceSupplyChain.policyVersion } : {}),
            ...(request.workspaceSupplyChain.evidenceHash ? { evidenceHash: request.workspaceSupplyChain.evidenceHash } : {}),
            ...(request.workspaceSupplyChain.installTarget ? { installTarget: request.workspaceSupplyChain.installTarget } : {}),
            ...(request.workspaceSupplyChain.reasons ? { reasons: request.workspaceSupplyChain.reasons } : {}),
          },
        }
      : {}),
  }
}

// ------------------------------------------------- the enforcement obligation

/**
 * The brand key. A real runtime symbol, so the mark cannot be produced by
 * writing a matching property name — you must import it from this package.
 */
export const POLICY_ENFORCED = Symbol("abdo.control.policyEnforced")

/**
 * A tool runner that has been through the Policy Enforcement Point.
 *
 * CL-00A §4.2: `RuntimeDeps.tools` accepted ANY `ToolRunner`, so a future host
 * could wire a raw runner and silently delete every policy check. CI caught new
 * ones; this makes it a compile error. The brand is unforgeable outside this
 * package — `PolicyToolRunner` declares it, and anything else must go through
 * `unenforcedToolRunner()`, whose name is deliberately hard to justify in review.
 */
export interface PolicyEnforced {
  readonly [POLICY_ENFORCED]: true
}

/**
 * Escape hatch for test fakes and for the shadow-mode stub (which executes
 * nothing at all). Every call site is a grep away and must carry a reason.
 */
export function unenforcedToolRunner<T extends object>(runner: T, reason: string): T & PolicyEnforced {
  if (!reason) throw new Error("unenforcedToolRunner requires a reason")
  // Marks in place, so a test fake's own counters keep working.
  return Object.assign(runner, { [POLICY_ENFORCED]: true as const })
}
