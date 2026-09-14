/**
 * @abdo/classifier — CL-05. Pure: no execution, no IO, no policy.
 *
 * It answers three questions about an already-normalized operation:
 *   what capability is this (semantic, deterministic),
 *   what does it touch (argument-level resources),
 *   how risky is it (dimensions -> level).
 *
 * It does NOT decide. The PDP consumes the answers; keeping classification out
 * of the enforcement point is what lets CL-02's policy language replace the
 * decision without touching any of this.
 */
export { classifyCapability, classifyAll, firstArgument, type CapabilityMatch } from "./capability"
export {
  assessLifecycleScripts,
  assessLifecycleAll,
  assessLifecycleEnforcement,
  envSuppressionFor,
  type EnvSuppression,
  type LifecycleEnforcement,
  type LifecycleAssessment,
  type LifecycleVerdict,
  type Suppressor,
} from "./lifecycle"
export { assessInstallSource, type InstallSourceAssessment } from "./install-source"
export { assessPipInstallSource, type PipInstallSourceAssessment } from "./pip-source"
export { analyzeResources } from "./resources"
export { assessRisk, type RiskInput } from "./risk"

export { assessPoetryInstallSource, type PoetryInstallSourceAssessment } from "./poetry-source"

export { assessPipenvInstallSource, type PipenvInstallSourceAssessment } from "./pipenv-source"

export { assessCargo, type CargoAssessment } from "./cargo-source"

export { assessGo, type GoAssessment } from "./go-source"
