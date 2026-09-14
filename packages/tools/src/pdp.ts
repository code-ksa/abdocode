/**
 * The Policy Decision Point (CL-01).
 *
 * It ANSWERS; it never executes. Before this split the decision lived inline in
 * `PolicyToolRunner.run` — the same function that ran the tool — so nothing
 * structurally stopped a tool from deciding its own fate, and the verdict had
 * no shape anyone else could consume.
 *
 * The rules themselves are unchanged from `decide()` in policy.ts; what is new
 * is that they now produce a `ControlDecision` with a rule id, a structured
 * reason code, and a hashable identity. The rule LANGUAGE (scopes, TTL,
 * priorities, deny-precedence) is CL-02 and is not started here.
 */
import {
  CONTROL_CONTRACT_VERSION,
  type Capability,
  type ControlDecision,
  type ControlRequest,
  type NormalizedOperation,
  type Constraint,
  type PolicyDecisionPoint,
  type RiskAssessment,
} from "@abdo/control-contracts"
import { analyzeResources, assessInstallSource, assessLifecycleEnforcement, assessPipInstallSource, assessRisk, classifyAll } from "@abdo/classifier"
import { normalize } from "@abdo/normalizer"
import { classifyCommand, classifyResolved, commandOf } from "./danger"
import type { ToolPolicy } from "./registry"

/** Rule ids are stable strings — an audit entry must survive a refactor. */
export const RULE = {
  dangerousCommand: "builtin.dangerous_command",
  criticalRisk: "builtin.critical_risk",
  requiresApproval: "builtin.requires_approval",
  highRisk: "builtin.high_risk",
  autoAllow: "builtin.auto_allow_low_risk",
  unknownTool: "builtin.unknown_tool",
  invalidArguments: "builtin.invalid_arguments",
  unparsedOperation: "builtin.unparsed_operation",
  lifecycleScripts: "builtin.lifecycle_scripts",
  installSource: "builtin.install_source",
  unanalyzedResources: "builtin.unanalyzed_resources",
  verificationConstantCommand: "runtime.verification_constant_command",
} as const

/** The built-in decision point: risk + danger classification, nothing else. */
export class BuiltinPolicyDecisionPoint implements PolicyDecisionPoint {
  constructor(private readonly approvalRequestId: () => string) {}

  decide(request: ControlRequest): ControlDecision {
    const v = CONTROL_CONTRACT_VERSION
    const ask = (ruleId: string, reasonCode: ControlDecision["reasonCode"]): ControlDecision => ({
      version: v,
      action: "ask",
      ruleId,
      reasonCode,
      approvalRequestId: this.approvalRequestId(),
    })
    // A dangerous command outranks the tool's own risk level: the tool may be
    // "medium" while the command inside it is `rm -rf /`.
    if (request.risk.dangerous) return ask(RULE.dangerousCommand, "dangerous_command_requires_approval")
    if (request.risk.level === "critical") return ask(RULE.criticalRisk, "critical_risk_requires_approval")
    // Escalate on any conservative default, but say WHICH kind: a command we
    // could not parse (CL-04) and a command we parsed but whose effects are not
    // analysed (CL-05) are different situations and deserve different rules.
    if (request.risk.certainty === "conservative_default") {
      return request.normalizedOperation.certainty === "uncertain"
        ? ask(RULE.unparsedOperation, "unparsed_operation_requires_approval")
        : ask(RULE.unanalyzedResources, "unanalyzed_resources_requires_approval")
    }
    if (request.risk.level === "high") return ask(RULE.highRisk, "high_risk_requires_approval")

    // CL-11. IMPLICIT lifecycle scripts — a fetched package's install hooks, the
    // project's own pre/post — can be removed by a measured environment overlay.
    // When they are present but cannot be suppressed (yarn/bun/pnpm/pip, a
    // command that undoes the overlay), the answer is `ask`: a protection the
    // enforcement point cannot deliver is never announced.
    //
    // An EXPLICIT named script (`npm test`) is NOT handled here — the overlay
    // does not stop it. It has already passed the risk gates above, which is the
    // right authority for code the user asked to run; the constraint rides along
    // only to strip its implicit wrappers, and claims nothing about the script
    // itself.
    const lifecycle = request.lifecycle
    if (lifecycle?.implicitRequired && !lifecycle.implicitEnforceable) {
      return ask(RULE.lifecycleScripts, "lifecycle_scripts_not_suppressible")
    }

    // CL-11 supply-chain gate. Suppressing scripts does NOT vet WHERE packages
    // come from or whether the resolution is pinned. So an install auto-allows
    // ONLY as the deterministic, default-source subset — `npm ci`, which
    // reproduces the lockfile and fails if it is missing or mismatched — AND
    // only when the WORKSPACE it runs in is verified.
    const source = request.installSource
    if (source?.isInstall) {
      // 1. Command-side: a resolving install, a custom registry, or a git/URL
      //    source is a supply-chain decision on its face.
      if (source.blockers.length > 0) return ask(RULE.installSource, "install_source_not_verified")
      // 2. Filesystem-side, FAIL-CLOSED. Even a clean `npm ci` can pull from a
      //    custom `.npmrc` registry or an untrusted `resolved` host baked into
      //    the lockfile — facts the command cannot show. Until a host verifier
      //    confirms the workspace, an install does not sit on the allow path.
      const supplyChain = request.workspaceSupplyChain?.status ?? "unknown"
      if (supplyChain === "unsafe") return ask(RULE.installSource, "install_supply_chain_unsafe")
      if (supplyChain !== "verified") return ask(RULE.installSource, "install_source_not_verified")
    }

    const constraints: Constraint[] =
      lifecycle?.implicitRequired && lifecycle.implicitEnforceable
        ? [{ kind: "suppressImplicitLifecycleScripts", value: true, env: lifecycle.envOverlay }]
        : []
    return {
      version: v,
      action: "allow",
      ruleId: constraints.length > 0 ? RULE.lifecycleScripts : RULE.autoAllow,
      reasonCode: "auto_allowed_low_risk",
      constraints,
    }
  }
}

/**
 * Capability of a TOOL (not of a command). CL-05 classifies shell commands
 * semantically; this remains only for non-shell tools, whose capability really
 * is fixed by the tool itself.
 */
export function capabilityOf(tool: string): Capability {
  switch (tool) {
    case "shell":
      return "code.execute"
    case "read_file":
    case "list_dir":
      return "filesystem.read"
    case "write_file":
    case "edit_file":
      return "filesystem.write"
    case "git_read":
      return "git.read"
    case "git_change":
      return "git.commit"
    case "package_install":
      return "package.install"
    case "network_fetch":
      return "network.request"
    default:
      return "unknown"
  }
}

/**
 * Build the request's operation + risk view from what we can honestly determine
 * today. A shell command we cannot parse is `unparsed`, which the PDP escalates
 * — an unknown is a risk input, never an absence of risk.
 */
/** The tool's own cwd argument, when it has one. */
function cwdOf(input: unknown): string | undefined {
  const a = input as { cwd?: unknown } | null
  return typeof a?.cwd === "string" ? a.cwd : undefined
}

export function assessCall(
  tool: string,
  policy: ToolPolicy,
  input: unknown,
): { operation: NormalizedOperation; risk: RiskAssessment; capability: Capability; lifecycle?: ControlRequest["lifecycle"]; installSource?: ControlRequest["installSource"] } {
  const command = commandOf(input)
  const rawDanger = command ? classifyCommand(command) : { dangerous: false as const, rule: undefined }

  if (command === undefined) {
    // A non-shell tool: its capability is fixed and its operation is trivial.
    const capability = capabilityOf(tool)
    const operation: NormalizedOperation = {
      kind: capability === "filesystem.write" ? "file_write" : capability === "filesystem.read" ? "file_read" : "opaque",
      summary: tool,
      certainty: "parsed",
      resources: { analysis: "unknown" },
    }
    const risk = assessRisk({
      operation,
      capabilities: [capability],
      // A registered tool is not an unclassifiable command: its declared policy
      // is the authority. Only shell commands take the conservative floor.
      anyUnknownCapability: false,
      declared: policy.risk,
      declaredRequiresApproval: policy.requiresApproval,
      dangerous: false,
    })
    return { operation, risk, capability }
  }

  // CL-04 parsed it; CL-05 says what it IS and what it touches.
  const parsed = normalize(command, { cwd: cwdOf(input) })
  const resources = analyzeResources(parsed)
  const operation: NormalizedOperation = { ...parsed, resources }
  const { capabilities, anyUnknown } = classifyAll(operation.commands ?? [])

  // The danger classifier sees every RESOLVED command, so a dangerous verb
  // behind wrappers or after a separator cannot slip past a text match. With a
  // complete parse the resolved commands are the whole truth; when uncertain the
  // raw match is kept as well, because then we do not know what is in there.
  const resolvedDanger = (operation.commands ?? []).map((c) => classifyResolved(c.program, c.argv)).find((d) => d.dangerous)
  const match = resolvedDanger ?? (operation.certainty === "uncertain" ? rawDanger : { dangerous: false as const, rule: undefined })

  const risk = assessRisk({
    operation,
    capabilities,
    anyUnknownCapability: anyUnknown,
    declared: policy.risk,
    declaredRequiresApproval: policy.requiresApproval,
    dangerous: match.dangerous,
    ...(match.rule ? { dangerRule: match.rule } : {}),
  })
  // CL-11: assessed HERE because this is the only place holding both the parse
  // and the command AS WRITTEN. The raw text is not redundant — measured
  // 2026-07-23, `set npm_config_ignore_scripts=false && npm install` under cmd
  // normalizes to `npm install` with an empty env, so the assignment disappears
  // from the parse while still taking effect in the real shell.
  const enforcement = assessLifecycleEnforcement(operation, command)
  // The generic install-source view covers npm AND pip — a command is one, the
  // other, or neither. The PDP's supply-chain gate then reads the same shape
  // (isInstall + blockers), and the host verifier fills the workspace verdict
  // for whichever ecosystem it is.
  const npmSource = assessInstallSource(operation.commands ?? [])
  const pipSource = assessPipInstallSource(operation.commands ?? [])
  const installSource: ControlRequest["installSource"] = npmSource.isInstall
    ? { isInstall: true, deterministic: npmSource.deterministic, offline: npmSource.offline, blockers: npmSource.blockers }
    : pipSource.isInstall
      ? {
          isInstall: true,
          // pip's deterministic subset: a hash-required requirements install.
          deterministic: pipSource.requireHashes && pipSource.hasRequirementsFile && pipSource.blockers.length === 0,
          offline: false,
          blockers: pipSource.blockers,
        }
      : undefined
  const lifecycle: ControlRequest["lifecycle"] = {
    implicitRequired: enforcement.implicitRequired,
    implicitEnforceable: enforcement.implicitEnforceable,
    explicitCodeExecution: enforcement.explicitCodeExecution,
    envOverlay: enforcement.envOverlay,
    blockers: enforcement.blockers,
    detail: enforcement.assessment.reason,
  }

  // The capability RECORDED on the request is the riskiest one present, so a
  // grant or a policy rule binds to what actually matters in a compound command.
  return { operation, risk, capability: capabilities[0] ?? "unknown", lifecycle, ...(installSource ? { installSource } : {}) }
}
