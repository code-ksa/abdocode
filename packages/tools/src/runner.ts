/**
 * PolicyToolRunner — the safe execution path for tool calls.
 *
 * Inspect -> classify danger -> policy decision -> (approval gate) -> optional
 * dry-run -> execute with a timeout -> redact secrets -> guarded rollback.
 * Structurally satisfies @abdo/session-runtime's ToolRunner port, so the loop
 * dispatches through it. A critical or dangerous call NEVER runs without an
 * explicit approval.
 *
 * ROLLBACK RULE (per-invocation compensation): rollback runs ONLY when the
 * failed call's own MutationReceipt says `mutationStarted: true`. Validation
 * failures, precondition failures ("find text not present"), denied paths and
 * receipt-less exceptions changed nothing — rolling back there restored a
 * PREVIOUS call's backup and silently destroyed completed work (the 2026-07-23
 * multi-11 incident). `ok: false` alone never triggers compensation.
 *
 * Idempotency of side effects is enforced one layer up: the runtime appends a
 * `tool.executed` event carrying the call's idempotencyKey, and the event store
 * dedupes it, so a retried side-effecting tool is not re-run.
 */
import {
  CONTROL_CONTRACT_VERSION,
  controlRecord,
  summarizeConstraints,
  type Constraint,
  type ControlDecision,
  type ControlRecord,
  type ControlRequest,
  type EnforcedConstraint,
  type PolicyDecisionPoint,
  type PolicyEnforced,
  POLICY_ENFORCED,
} from "@abdo/control-contracts"
import { createHash, randomUUID } from "node:crypto"
import { redact, redactCounted, redactValue, redactValueCounted, NO_REDACTIONS, type RedactionRecord } from "./secrets"
import { evaluatePolicy, classifyRisk } from "@abdo/control-contracts/riskclass"
import { evaluateMode, narrowestModeFor, type AgentMode } from "@abdo/control-contracts/modes"
import { evaluatePlanGate } from "@abdo/control-contracts/plangate"
import { type Decision } from "./policy"
import { assessCall, BuiltinPolicyDecisionPoint, RULE } from "./pdp"
import { validateInput, type MutationReceipt, type ToolRegistry } from "./registry"
import { INHERIT_PROFILE, UNMEASURED_CAPABILITY, type ControlledExecutionGrant, type IsolationEventSink } from "./launcher"
import type { ExecutionIsolationProfile, IsolationCapabilityReport } from "./isolation"

export interface ToolCall {
  readonly name: string
  readonly input: unknown
  readonly idempotencyKey?: string
}

/** What actually happened when the runner compensated a failed mutation. */
export interface RollbackReport {
  readonly status: "completed" | "failed"
  readonly reason: string
  readonly receipt: MutationReceipt
  readonly error?: string
}

export type ToolOutcome =
  | {
      readonly ok: true
      readonly output: unknown
      readonly mutation?: MutationReceipt
      readonly resultFingerprint?: string
      readonly control?: ControlRecord
      /** What was removed from this outcome before anyone saw it (Sprint 16). */
      readonly redactions?: RedactionRecord
    }
  | {
      readonly ok: false
      readonly error: string
      /**
       * TRUE when a POLICY refused this call, as opposed to the tool failing.
       *
       * Found by the first live run (stage A, 2026-08-19): four consecutive
       * denials tripped the consecutive-tool-FAILURE budget and killed the
       * run. But "you may not" and "it broke" are different facts — a denial
       * is information the model should adapt to, and treating it as a
       * breakage makes every gate a run-killer, which is the strongest
       * possible pressure to switch the gates off.
       *
       * A discriminator rather than a prefix on `error`, because sniffing an
       * error string is how a rule quietly stops matching after somebody
       * rewords a message.
       */
      readonly denied?: true
      readonly output?: unknown
      readonly mutation?: MutationReceipt
      readonly rollback?: RollbackReport
      readonly resultFingerprint?: string
      /** The decision that produced this outcome — persisted by the runtime. */
      readonly control?: ControlRecord
      readonly redactions?: RedactionRecord
    }

export interface ApprovalRequest {
  readonly tool: string
  readonly input: unknown
  readonly risk: string
  readonly rule?: string
  readonly reason: string
}

export interface Approver {
  approve(request: ApprovalRequest): Promise<boolean>
}

export interface AuditEntry {
  readonly tool: string
  readonly decision: Decision | "denied"
  readonly ok?: boolean
  readonly rule?: string
  /** CL-01: every audited decision carries its rule, reason code and hash. */
  readonly control?: ControlRecord
}

/** The slice of a grant ledger the enforcement point needs. */
export interface GrantReservation {
  reserve(request: ControlRequest): Promise<{ reserved: boolean; grantId?: string }>
}

export interface RunnerOptions {
  readonly approver?: Approver
  readonly secrets?: readonly string[]
  /** Run the tool's dry-run probe before the real execution, when supported. */
  readonly dryRunFirst?: boolean
  readonly audit?: (entry: AuditEntry) => void
  /**
   * The decision point. Defaults to the builtin one; CL-02's policy language
   * will supply a richer implementation WITHOUT touching this enforcement code —
   * which is the whole reason the two are separate.
   */
  readonly pdp?: PolicyDecisionPoint
  /**
   * CL-03: durable grants. Consulted when the PDP says `ask`. A reservation is
   * ATOMIC and happens BEFORE anything executes, so two concurrent runs can
   * never spend the same use. No grant service, or no matching grant, simply
   * means the human is asked — never an implicit allow.
   */
  readonly grants?: GrantReservation
  /**
   * CL-11 3B. The HOST supplies a supply-chain verdict for the workspace an
   * install would run in — read from the filesystem, NEVER from the model's tool
   * arguments. Called at decision time to fill `workspaceSupplyChain`, and AGAIN
   * just before execution: if the evidence hashes moved, or the workspace is no
   * longer verified, the decision is stale and nothing runs (TOCTOU).
   */
  readonly supplyChainVerifier?: (dir: string, command?: string) => SupplyChainVerdict
  /**
   * CL-11 3B. A free-space PRECHECK for installs — honestly a start gate, not a
   * budget. Returns whether there is room to start; it does NOT bound growth.
   */
  readonly diskBudget?: (dir: string) => { allowed: boolean; reason?: string }
  /**
   * CL-11 3C. A disk-growth budget for installs. `measure(dir)` returns the
   * current byte size of ONE path — the install target the caller points it at.
   * The PEP samples it during execution and KILLS the tool's process tree (via
   * its abort signal) once growth exceeds `maxGrowthBytes`.
   *
   * SCOPE, stated so it is not overclaimed: this bounds the MEASURED PATH only.
   * It does NOT see a package manager's cache or a temp dir OUTSIDE that path
   * (npm's global cache, `$TMPDIR`), and it does not claim any network download
   * size. It is a growth ceiling on one directory, not a comprehensive disk
   * budget — measure the paths you actually want bounded.
   */
  readonly installDiskGrowthBudget?: { maxGrowthBytes: number; measure: (dir: string) => number; sampleMs?: number }
  /**
   * CL-16A2-B. The isolation profile this call must run under, chosen by the
   * CONTROL PLANE from the request — never from tool arguments, and never by the
   * model. Returning undefined means "impose none", which is `inherit`.
   *
   * A profile it returns is ENFORCED OR REFUSED: if the platform cannot deliver
   * it, `launchControlledProcess` fails before the spawn. There is no path here
   * that downgrades a requested `deny_all` to an ordinary process.
   */
  readonly isolationPolicy?: (request: ControlRequest) => ExecutionIsolationProfile | undefined
  /**
   * What this machine can actually enforce. Measured once by the host
   * (`probeIsolation`) and passed in, because probing creates real namespaces
   * and must not happen per call.
   */
  readonly isolationCapability?: IsolationCapabilityReport
  /** Identity for the ControlRequest. Absent fields become "unknown". */
  readonly identity?: {
    readonly sessionId?: string
    readonly runId?: string
    readonly agent?: string
    readonly model?: string
    readonly provider?: string
    readonly workspace?: string
  }
}

/**
 * The host verifier's output shape (structural, so @abdo/tools takes no
 * dependency on @abdo/host). Mirrors WorkspaceSupplyChainVerdict.
 */
export interface SupplyChainVerdict {
  readonly status: "verified" | "unknown" | "unsafe"
  readonly reasonCodes?: readonly string[]
  /** ONE combined, ecosystem-agnostic evidence hash. TOCTOU and decisionHash
   *  bind to this, so npm and pip (and later ecosystems) share one machinery. */
  readonly evidenceHash: string
  /** Which verifier produced this — kept in the audit so the decision is
   *  EXPLAINABLE, not merely comparable ("npm" | "pip" | ...). */
  readonly verifierKind?: string
  /** The real install target (pip site-packages / --target dir). The disk-growth
   *  budget measures THIS, not the project folder. */
  readonly installTarget?: string
  readonly policyVersion: number
  readonly verifierVersion: number
}

/** Map the verifier's verdict onto the request field (evidence + versions). */
function toRequestVerdict(v: SupplyChainVerdict): NonNullable<ControlRequest["workspaceSupplyChain"]> {
  return {
    status: v.status,
    ...(v.reasonCodes ? { reasons: v.reasonCodes } : {}),
    evidenceHash: v.evidenceHash,
    ...(v.verifierKind ? { verifierKind: v.verifierKind } : {}),
    ...(v.installTarget ? { installTarget: v.installTarget } : {}),
    policyVersion: v.policyVersion,
    verifierVersion: v.verifierVersion,
  }
}

/** The environment a decision's constraints require, or undefined when none do. */
function envOverlayOf(constraints: readonly Constraint[]): Record<string, string> | undefined {
  const merged: Record<string, string> = {}
  for (const c of constraints) if (c.kind === "suppressImplicitLifecycleScripts") Object.assign(merged, c.env)
  return Object.keys(merged).length > 0 ? merged : undefined
}

/** The raw shell command text of a call, when it has one (for the verifier to
 *  dispatch npm vs pip and read the right files). */
function commandTextOf(call: ToolCall): string | undefined {
  const c = (call.input as { command?: unknown } | null)?.command
  return typeof c === "string" ? c : undefined
}

/** Stable hash of the call arguments — the request never carries them raw. */
function hashInput(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex")
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tool timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer!)
  }
}

/**
 * The Policy ENFORCEMENT Point. It asks the PDP, then enforces the answer — it
 * never decides. Carrying the `PolicyEnforced` brand is what lets it be wired
 * into `SessionRuntime`; an unbranded runner is a compile error (CL-00A §4.2).
 */
export class PolicyToolRunner {
  private readonly pdp: PolicyDecisionPoint

  constructor(
    private readonly registry: ToolRegistry,
    private readonly options: RunnerOptions = {},
  ) {
    this.pdp = options.pdp ?? new BuiltinPolicyDecisionPoint(() => "apr_" + randomUUID())
  }

  /** Assemble the one request shape every decision maker consumes. */
  private buildRequest(call: ToolCall, tool: { policy: import("./registry").ToolPolicy }, executionId: string | undefined): ControlRequest {
    const id = this.options.identity ?? {}
    const { operation, risk, capability, lifecycle, installSource } = assessCall(call.name, tool.policy, call.input)
    return {
      version: CONTROL_CONTRACT_VERSION,
      sessionId: id.sessionId ?? "unknown",
      runId: id.runId ?? "unknown",
      attemptId: 1,
      requestId: executionId ?? "unknown",
      toolExecutionId: executionId ?? "unknown",
      actor: { agent: id.agent ?? "abdo", model: id.model ?? "unknown", provider: id.provider ?? "unknown" },
      tool: call.name,
      capability,
      target: { kind: "workspace", workspace: id.workspace ?? "." },
      normalizedOperation: operation,
      risk,
      argsHash: hashInput(call.input),
      secretRefs: [],
      provenance: ["model_tool_call"],
      ...(lifecycle ? { lifecycle } : {}),
      ...(installSource ? { installSource } : {}),
    }
  }

  /**
   * The directory an install runs in — the workspace root joined to the install
   * command's accumulated cwd (a `cd packages/api && npm ci` verifies packages/
   * api, not the root). Read-only path assembly; the verifier does the IO.
   */
  private installDir(_call: ToolCall, request: ControlRequest): string {
    const root = this.options.identity?.workspace ?? "."
    const installCmd = (request.normalizedOperation.commands ?? []).find((c) => {
      const p = c.program.toLowerCase()
      return (p === "npm" || p === "pnpm" || p === "yarn" || p === "bun") && (c.argv.includes("ci") || c.argv.includes("install") || c.argv.includes("i"))
    })
    const rel = installCmd?.cwd
    if (!rel || rel === "." || rel === "") return root
    return `${root.replace(/[/\\]$/, "")}/${rel.replace(/^[/\\]+/, "")}`
  }

  /**
   * Pure preview of the constraints this call would run under — kinds and env
   * key NAMES, never values. Used to annotate `tool.started` so a crash between
   * start and completion still shows what the execution began under.
   *
   * `decide()` is deterministic and side-effect-free, so this agrees with the
   * authoritative decision in `run()`. The one case it cannot foresee is a grant
   * reservation turning `ask` into `allow` — but a grant-unlocked allow carries
   * no constraints, and the constraint-bearing decisions are pure allows, so the
   * summary is exact for everything it reports.
   */
  describeEnforcement(call: ToolCall): readonly EnforcedConstraint[] {
    const tool = this.registry.get(call.name)
    if (!tool) return []
    try {
      const decision = this.pdp.decide(this.buildRequest(call, tool, undefined))
      // A preview is synchronous by contract; an async PDP simply yields no
      // preview rather than blocking the start path.
      if (decision instanceof Promise) return []
      return decision.action === "allow" ? summarizeConstraints(decision.constraints) : []
    } catch {
      return [] // a preview must never throw into the caller's start path
    }
  }

  async run(
    call: ToolCall,
    options?: {
      signal?: AbortSignal
      executionId?: string
      /**
       * Called with EVERY decision — allow, ask and deny — BEFORE anything is
       * executed, so the caller can persist it durably. A crash mid-tool must
       * never lose the decision that authorised the tool. Same principle as
       * `onRollbackStart`: the record lands before the effect.
       *
       * If it throws, the call FAILS CLOSED: nothing executes.
       */
      onDecision?: (record: ControlRecord) => Promise<void> | void
      /**
       * Final durable barrier immediately before the tool receives control.
       * All policy, approval, freshness, disk and isolation-grant checks have
       * completed. If persistence fails, the tool is never invoked.
       */
      onBeforeEffect?: (binding: {
        readonly request: ControlRequest
        readonly control: ControlRecord
        readonly execution: ControlledExecutionGrant
      }) => Promise<void> | void
      /** Emitted BEFORE a guarded rollback runs, so the caller can log it durably. */
      onRollbackStart?: (receipt: MutationReceipt) => Promise<void> | void
      /**
       * CL-16A2-B. Durable sink for the four isolation events. The launcher
       * AWAITS it before the spawn, so an isolation proof always lands before
       * the process it describes. If it throws, nothing executes.
       */
      onIsolation?: IsolationEventSink
      /**
       * Sprint 25: the run's mode. Supplied by the RUNTIME — it is not part
       * of the call, so a model cannot widen its own ceiling.
       */
      mode?: AgentMode
      /**
       * Sprint 26: the plan context, also from the runtime. `approvedPlanId` is
       * present only when the LOG holds an approval — the runner never takes the
       * model's word that a plan exists.
       */
      plan?: { approvedPlanId?: string; filesChangedSoFar: number }
    },
  ): Promise<ToolOutcome> {
    const secrets = this.options.secrets ?? []
    const audit = this.options.audit ?? (() => {})

    const tool = this.registry.get(call.name)
    if (!tool) return { ok: false, error: `unknown_tool: ${call.name}` }

    // Validate arguments against the tool's schema up front — a coded error goes
    // back to the model (so it can fix the call) instead of executing garbage.
    const valid = validateInput(tool.inputSchema, call.input)
    if (!valid.ok) return { ok: false, error: `${valid.code}: ${valid.message}` }

    // --- decide (PDP) -------------------------------------------------------
    let request = this.buildRequest(call, tool, options?.executionId)

    // Sprint 25: the MODE is checked before anything else, because it answers a
    // question that comes first — is an operation of this kind even on the table
    // right now. It arrives in `options` from the RUNTIME, never from
    // `call.input`: a mode a model can choose is a mode a model can leave.
    if (options?.mode !== undefined) {
      const classes = classifyRisk(request.risk)
      const verdict = evaluateMode(options.mode, classes)
      if (!verdict.allowed) {
        const suggestion = narrowestModeFor(classes)
        const control = controlRecord(request, {
          version: CONTROL_CONTRACT_VERSION,
          action: "deny",
          ruleId: "mode",
          reasonCode: "mode_excludes_operation",
        })
        audit({ tool: call.name, decision: "denied", rule: "mode", control })
        return {
          ok: false,
          denied: true,
          control,
          error:
            `mode_denied: ${verdict.reason}` +
            (suggestion !== undefined ? ` (the narrowest mode that would is ${suggestion})` : ""),
        }
      }
    }

    // Raised by the plan gate when the change is past the fast path, applied
    // after the policy decision so it can only tighten it.
    let planAsksApproval: string | undefined
    // Sprint 26: nothing mutates without a plan, unless the fast path applies —
    // and the fast path is MEASURED here rather than judged. Checked after the
    // mode (which asks whether the KIND of operation is on the table) and before
    // any approval, because asking a human to approve something that should have
    // been planned is asking the wrong question.
    if (options?.plan !== undefined) {
      const classes = classifyRisk(request.risk)
      const planVerdict = evaluatePlanGate({
        mutates: !classes.every((c) => c === "read"),
        classes,
        capabilities: request.risk.capabilities ?? [request.capability],
        ...(request.normalizedOperation.summary !== undefined ? { summary: request.normalizedOperation.summary } : {}),
        filesChangedSoFar: options.plan.filesChangedSoFar,
        ...(options.plan.approvedPlanId !== undefined ? { approvedPlanId: options.plan.approvedPlanId } : {}),
      })
      if (planVerdict.decision === "deny") {
        const control = controlRecord(request, {
          version: CONTROL_CONTRACT_VERSION,
          action: "deny",
          ruleId: "plan_gate",
          reasonCode: "plan_required",
        })
        audit({ tool: call.name, decision: "denied", rule: "plan_gate", control })
        return { ok: false, denied: true, control, error: `plan_required: ${planVerdict.reason}` }
      }
      // Past the fast path a person decides, rather than the run hitting a wall
      // it has no way through. Recorded here and applied after the policy
      // decision below, so an operation the policy would deny stays denied: this
      // can only ever make a decision stricter, never looser.
      if (planVerdict.decision === "ask") planAsksApproval = planVerdict.reason
      // An exception nobody can audit becomes the rule, so the fast path says
      // so with the numbers it used.
      if (planVerdict.decision === "allow_fast_path") {
        audit({ tool: call.name, decision: "allow", rule: `plan_gate:fast_path ${planVerdict.reason}` })
      }
    }
    // CL-11 3B: for an install, the HOST verifier fills the workspace verdict —
    // from the filesystem, never from `call.input`. The same directory is used
    // for the pre-execution re-check, so the two views compare like for like.
    let scDir: string | undefined
    let scAtDecision: SupplyChainVerdict | undefined
    if (request.installSource?.isInstall && this.options.supplyChainVerifier) {
      scDir = this.installDir(call, request)
      try {
        scAtDecision = this.options.supplyChainVerifier(scDir, commandTextOf(call))
      } catch {
        scAtDecision = undefined // a broken verifier yields no verdict -> stays ask
      }
      if (scAtDecision) request = { ...request, workspaceSupplyChain: toRequestVerdict(scAtDecision) }
    }
    let decision: ControlDecision = await this.pdp.decide(request)
    if (planAsksApproval !== undefined && decision.action === "allow") {
      decision = {
        version: CONTROL_CONTRACT_VERSION,
        action: "ask",
        ruleId: "plan_gate",
        reasonCode: "plan_required",
        approvalRequestId: randomUUID(),
      }
      audit({ tool: call.name, decision: "ask", rule: `plan_gate ${planAsksApproval}` })
    }
    const danger = { rule: request.risk.rule }

    // --- enforce (PEP) ------------------------------------------------------
    // Record the decision BEFORE it can lead to anything. An `ask` is recorded
    // first too, so a crash while a human is deciding still leaves evidence
    // that approval was pending rather than a silent gap.
    // The pending `ask` and the final decision are SEPARATE records, and the
    // final one names the pending one it replaces — no guessing which is which.
    let pendingId: string | undefined
    let approvalRequestId: string | undefined
    const publish = async (d: ControlDecision): Promise<ToolOutcome | undefined> => {
      const rec = controlRecord(request, d, {
        ...(pendingId ? { supersedes: pendingId } : {}),
        ...(approvalRequestId ? { approvalRequestId } : {}),
      })
      if (rec.phase === "pending") {
        pendingId = rec.decisionId
        approvalRequestId = rec.approvalRequestId
      }
      try {
        await options?.onDecision?.(rec)
      } catch (e) {
        // Fail closed: if the decision cannot be durably recorded, nothing runs.
        return { ok: false, control: rec, error: `decision_not_recorded: ${e instanceof Error ? e.message : String(e)}` }
      }
      return undefined
    }
    const unrecorded = await publish(decision)
    if (unrecorded) return unrecorded

    if (decision.action === "ask") {
      // A durable grant is checked FIRST and reserved atomically before any
      // execution. This is what replaces process-global override flags.
      let reservedGrantId: string | undefined
      if (this.options.grants) {
        try {
          const res = await this.options.grants.reserve(request)
          if (res.reserved) reservedGrantId = res.grantId
        } catch {
          reservedGrantId = undefined // fail closed: a broken ledger grants nothing
        }
      }
      // Sprint 20: a permit and an approval are not interchangeable. A grant is
      // a durable, scoped, use-capped thing issued ahead of time; an approval is
      // a human looking at THIS act now. An operation that is destructive,
      // external or financial needs the human — accepting a grant issued earlier
      // for something else would collapse two safety properties into the weaker
      // one. The classes are derived from the measured risk, not declared.
      const classPolicy = evaluatePolicy(request.risk, { grantId: reservedGrantId })
      if (reservedGrantId && classPolicy.decision === "allow") {
        decision = {
          version: CONTROL_CONTRACT_VERSION,
          action: "allow",
          ruleId: decision.ruleId,
          reasonCode: "approval_granted",
          constraints: [],
          grantId: reservedGrantId,
        }
        const viaGrant = await publish(decision)
        if (viaGrant) return viaGrant
      } else {
      const approved = this.options.approver
        ? await this.options.approver.approve({
            tool: call.name,
            input: call.input,
            risk: tool.policy.risk,
            rule: danger.rule,
            reason: decision.reasonCode,
          })
        : false
      decision = approved
        ? { version: CONTROL_CONTRACT_VERSION, action: "allow", ruleId: decision.ruleId, reasonCode: "approval_granted", constraints: [] }
        : {
            version: CONTROL_CONTRACT_VERSION,
            action: "deny",
            ruleId: decision.ruleId,
            reasonCode: this.options.approver ? "approval_denied" : "no_approver_available",
          }
      const resolved = await publish(decision)
      if (resolved) return resolved
      }
    }
    const control = controlRecord(request, decision)
    if (decision.action === "deny") {
      audit({ tool: call.name, decision: "denied", rule: danger.rule, control })
      return { ok: false, denied: true, error: `denied: ${decision.reasonCode}${danger.rule ? ` (${danger.rule})` : ""}`, control }
    }
    const verdict = { decision: "allow" as Decision }

    if (this.options.dryRunFirst && tool.policy.supportsDryRun && tool.dryRun) {
      try {
        await tool.dryRun(call.input)
      } catch (e) {
        return { ok: false, error: redact(e instanceof Error ? e.message : String(e), secrets) }
      }
    }

    // CL-11: a constraint that cannot be applied stops the execution. The tool
    // must have DECLARED that it honours an environment overlay; a tool that has
    // not is refused rather than run unconstrained, because the durable record
    // would otherwise state a protection nothing enforced.
    const envOverlay = decision.action === "allow" ? envOverlayOf(decision.constraints) : undefined
    if (envOverlay && !tool.honorsEnvOverlay) {
      audit({ tool: call.name, decision: "denied", rule: danger.rule, control })
      return {
        ok: false,
        control,
        error: `constraint_not_enforceable: ${call.name} cannot apply the required environment overlay (suppressImplicitLifecycleScripts); nothing was executed`,
      }
    }

    // CL-11 3B/3C TOCTOU + approval freshness. A supply-chain decision was made
    // against a SNAPSHOT (the evidence hashes); the filesystem can move before
    // the spawn. So the SAME workspace is re-verified right before execution:
    //
    //   - the verified AUTO-allow path must still be `verified` AND unchanged;
    //   - an `approval_granted` install is NOT re-gated on the source risk (the
    //     human accepted that), but it IS re-gated on FRESHNESS: if the manifest,
    //     lockfile or npm config changed after the human saw it, the approved
    //     snapshot is stale, the decision is cancelled, and a NEW approval must be
    //     obtained — an approval does not authorise a snapshot nobody approved.
    if (decision.action === "allow" && scAtDecision && scDir && this.options.supplyChainVerifier) {
      const approved = decision.reasonCode === "approval_granted"
      let fresh: SupplyChainVerdict | undefined
      try {
        fresh = this.options.supplyChainVerifier(scDir, commandTextOf(call))
      } catch {
        fresh = undefined
      }
      const evidenceMoved =
        !fresh ||
        fresh.evidenceHash !== scAtDecision.evidenceHash ||
        fresh.policyVersion !== scAtDecision.policyVersion ||
        fresh.verifierVersion !== scAtDecision.verifierVersion
      // The auto path additionally requires the workspace to still be verified.
      const autoNoLongerVerified = !approved && (!fresh || fresh.status !== "verified")
      if (evidenceMoved || autoNoLongerVerified) {
        audit({ tool: call.name, decision: "denied", rule: danger.rule, control })
        const reason = approved
          ? `approval_snapshot_stale: the manifest/lockfile/npm config changed after approval was given; a fresh approval is required and nothing was executed`
          : `stale_supply_chain_evidence: the workspace changed between decision and execution (or is no longer verified); nothing was executed`
        return { ok: false, control, error: reason }
      }
    }

    // CL-11 3B free-space PRECHECK for installs — honestly a start gate, not a
    // budget. It refuses to start when the disk is already too low; it does NOT
    // bound growth (see installDiskGrowthBudget for that).
    if (decision.action === "allow" && request.installSource?.isInstall && this.options.diskBudget) {
      const budget = this.options.diskBudget(scDir ?? this.options.identity?.workspace ?? ".")
      if (!budget.allowed) {
        audit({ tool: call.name, decision: "denied", rule: danger.rule, control })
        return {
          ok: false,
          control,
          error: `disk_precheck_failed: ${budget.reason ?? "insufficient free disk to start the install"}; nothing was executed`,
        }
      }
    }

    // CL-11 3C REAL disk budget: bound how much an install may GROW the workspace
    // and KILL the process tree when it exceeds the cap. A monitor samples the
    // install dir's growth and aborts the tool's own signal — the shell tool
    // kills its child tree on abort — so this is an enforced ceiling, not a
    // precheck. Only installs, only when configured.
    const growth =
      decision.action === "allow" && request.installSource?.isInstall && this.options.installDiskGrowthBudget
        ? this.options.installDiskGrowthBudget
        : undefined
    // CL-11.4C2: measure the REAL install target (site-packages / --target), not
    // the project folder — an install can write far outside the workspace dir.
    const growthDir = scAtDecision?.installTarget ?? scDir ?? this.options.identity?.workspace ?? "."
    let growthController: AbortController | undefined
    let growthTimer: ReturnType<typeof setInterval> | undefined
    let growthExceeded = false
    let signalForTool = options?.signal
    if (growth) {
      let baseline = 0
      try {
        baseline = growth.measure(growthDir)
      } catch {
        baseline = 0
      }
      growthController = new AbortController()
      if (options?.signal) {
        if (options.signal.aborted) growthController.abort()
        else options.signal.addEventListener("abort", () => growthController!.abort(), { once: true })
      }
      signalForTool = growthController.signal
      growthTimer = setInterval(() => {
        try {
          if (growth.measure(growthDir) - baseline > growth.maxGrowthBytes) {
            growthExceeded = true
            growthController!.abort()
          }
        } catch {
          // a measurement error must not crash the run; the timeout still bounds it
        }
      }, growth.sampleMs ?? 500)
    }

    // CL-16A2-B. The isolation grant. It is built HERE, from the decision, and
    // handed to the tool — the model never sees it and cannot name it in its
    // arguments. `approvalGranted` decides which staleness code a pre-spawn
    // change produces, and the supply-chain evidence hash is the thing the human
    // actually approved, so the launcher re-reads it right before the spawn.
    const isolationProfile = this.options.isolationPolicy?.(request) ?? INHERIT_PROFILE
    const execution: ControlledExecutionGrant = {
      profile: isolationProfile,
      capability: this.options.isolationCapability ?? UNMEASURED_CAPABILITY,
      approvalGranted: decision.reasonCode === "approval_granted",
      ...(scAtDecision ? { approvalEvidenceHash: scAtDecision.evidenceHash } : {}),
      ...(envOverlay ? { envConstraintNames: Object.keys(envOverlay).sort() } : {}),
      ...(control.decisionId ? { decisionId: control.decisionId } : {}),
      ...(options?.executionId ? { executionId: options.executionId } : {}),
      ...(options?.onIsolation ? { emit: options.onIsolation } : {}),
    }

    try {
      await options?.onBeforeEffect?.({ request, control, execution })
    } catch (e) {
      if (growthTimer) clearInterval(growthTimer)
      growthController?.abort()
      audit({ tool: call.name, decision: "denied", rule: danger.rule, control })
      return {
        ok: false,
        control,
        error: `effect_barrier_not_recorded: ${e instanceof Error ? e.message : String(e)}; nothing was executed`,
      }
    }

    try {
      const result = await withTimeout(
        tool.run(call.input, {
          dryRun: false,
          signal: signalForTool,
          executionId: options?.executionId,
          execution,
          ...(envOverlay ? { envOverlay } : {}),
        }),
        tool.policy.timeoutMs,
      )
      if (growthTimer) clearInterval(growthTimer)
      // The budget was blown mid-run: the process tree was aborted, and the
      // outcome — whatever it looks like — is reported as a budget refusal, not
      // as the tool's own result.
      if (growthExceeded) {
        audit({ tool: call.name, decision: "denied", rule: danger.rule, control })
        return {
          ok: false,
          control,
          error: `disk_budget_exceeded: the install grew past ${growth!.maxGrowthBytes} bytes and its process tree was killed`,
        }
      }
      if (result.ok) {
        audit({ tool: call.name, decision: verdict.decision, ok: true, rule: danger.rule, control })
        const cleaned = redactValueCounted(result.output, secrets)
        return {
          ok: true,
          control,
          output: cleaned.value,
          // Sprint 16: a receipt must be able to say the output was censored.
          // Silence here is indistinguishable from output that was simply clean.
          ...(cleaned.redactions.count > 0 ? { redactions: cleaned.redactions } : {}),
          ...(result.mutation ? { mutation: result.mutation } : {}),
          ...(result.resultFingerprint ? { resultFingerprint: result.resultFingerprint } : {}),
        }
      }
      // Guarded compensation: ONLY the failing invocation's own started mutation
      // is rolled back. A failure whose receipt says the mutation never started
      // (or that carries no receipt) must not touch the disk.
      let rollback: RollbackReport | undefined
      if (result.mutation?.mutationStarted && tool.rollback) {
        rollback = await this.tryRollback(tool, result.mutation, options?.onRollbackStart, "tool_failed_after_mutation_started")
      }
      audit({ tool: call.name, decision: verdict.decision, ok: false, rule: danger.rule, control })
      const cleanedError = redactCounted(result.error, secrets)
      const cleanedOutput =
        result.output !== undefined ? redactValueCounted(result.output, secrets) : { value: undefined, redactions: NO_REDACTIONS }
      const failureRedactions = {
        count: cleanedError.redactions.count + cleanedOutput.redactions.count,
        kinds: [...new Set([...cleanedError.redactions.kinds, ...cleanedOutput.redactions.kinds])],
      }
      return {
        ok: false,
        control,
        error: cleanedError.text,
        ...(failureRedactions.count > 0 ? { redactions: failureRedactions } : {}),
        // Structured failure detail travels WITH the failure — an error string
        // alone (e.g. "exit 1: ") starves the model of information.
        ...(result.output !== undefined ? { output: cleanedOutput.value } : {}),
        ...(result.mutation ? { mutation: result.mutation } : {}),
        ...(rollback ? { rollback } : {}),
        ...(result.resultFingerprint ? { resultFingerprint: result.resultFingerprint } : {}),
      }
    } catch (e) {
      if (growthTimer) clearInterval(growthTimer)
      if (growthExceeded) {
        audit({ tool: call.name, decision: "denied", rule: danger.rule, control })
        return { ok: false, control, error: `disk_budget_exceeded: the install grew past ${growth!.maxGrowthBytes} bytes and its process tree was killed` }
      }
      // Exception path (throw/timeout): there is NO receipt, so there is nothing
      // we can prove needs compensation — do not touch the disk. Mutating tools
      // must catch internally and return a receipt (the builtin file tools do).
      audit({ tool: call.name, decision: verdict.decision, ok: false, rule: danger.rule, control })
      return { ok: false, control, error: redact(e instanceof Error ? e.message : String(e), secrets) }
    }
  }

  private async tryRollback(
    tool: { rollback?(receipt: MutationReceipt): Promise<void> },
    receipt: MutationReceipt,
    onStart: ((receipt: MutationReceipt) => Promise<void> | void) | undefined,
    reason: string,
  ): Promise<RollbackReport> {
    try {
      await onStart?.(receipt)
    } catch {
      // Logging failure must not block compensation.
    }
    try {
      await tool.rollback!(receipt)
      return { status: "completed", reason, receipt }
    } catch (e) {
      // Best-effort compensation; a failed rollback must not mask the original error.
      return { status: "failed", reason, receipt, error: e instanceof Error ? e.message : String(e) }
    }
  }
}

// ------------------------------------------------ granting the enforcement brand

/**
 * CL-16A3 MEGA SPRINT 1 §1 — THE ONE PLACE THE ENFORCEMENT BRAND IS GRANTED.
 *
 * The brand used to be a field on `PolicyToolRunner` itself, which meant EVERY
 * instance carried it — including a half-wired one built in a hurry, and
 * including the fifty test constructions that never needed it. A mark that is
 * applied by merely calling `new` attests to the class's name, not to the
 * assembly of a control plane, and `RuntimeDeps.tools` is precisely the seat
 * where a partially-wired runner would do damage.
 *
 * So the class is now unbranded and this factory is the only way to obtain an
 * `EnforcedToolRunner`. It refuses compositions that are internally inconsistent
 * rather than branding them and hoping.
 *
 * WHAT THE BRAND ATTESTS — exactly this, and it is deliberately modest:
 *   the runner is the Policy Enforcement Point, obtained from this factory, with
 *   a decision point present and a composition whose parts agree.
 *
 * WHAT IT DOES NOT ATTEST, because a constructor cannot observe behaviour:
 * that every decision reached `control.decided` durably, that no path falls back
 * to direct execution, that cancellation kills a process TREE, or that isolation
 * evidence was re-derived before the spawn. Those are properties of the code
 * path and are proven by tests, not by a symbol — `control-plane-decisions`,
 * `control-plane-bypass` (one `this.tools.run` call site, no primitive in any
 * model-reachable package), `launcher-events`, and the launcher's own TOCTOU and
 * process-tree-kill suites. Claiming a symbol proves them would be the fake
 * branding this refactor exists to remove.
 */
export function createEnforcedToolRunner(registry: ToolRegistry, options: RunnerOptions = {}): PolicyToolRunner & PolicyEnforced {
  if (!registry) throw new Error("enforced_runner_incomplete: a ToolRegistry is required")
  // A supply-chain verifier reads the FILESYSTEM relative to the workspace. With
  // no workspace identity it would verify ".", which is not the workspace the
  // decision is about — a verifier answering about the wrong directory is worse
  // than none, because the decision then carries evidence that looks real.
  if (options.supplyChainVerifier && !options.identity?.workspace) {
    throw new Error("enforced_runner_incomplete: a supplyChainVerifier requires identity.workspace, or it verifies the wrong directory")
  }
  // Same shape: a disk budget is measured against the install target, which is
  // derived from the workspace root.
  if (options.installDiskGrowthBudget && !options.identity?.workspace) {
    throw new Error("enforced_runner_incomplete: installDiskGrowthBudget requires identity.workspace")
  }
  const runner = new PolicyToolRunner(registry, options)
  return Object.assign(runner, { [POLICY_ENFORCED]: true as const })
}
