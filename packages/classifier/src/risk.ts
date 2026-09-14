/**
 * CL-05 — risk assessment over the dimensions the plan names.
 *
 * The LEVEL is derived, never asserted: each capability contributes known
 * dimension values, the worst value across the operation wins, and the level
 * falls out of a fixed rule. That is what makes "this scored high" explainable
 * and testable instead of a number someone chose.
 *
 * Two invariants the gate checks:
 *   - a destructive/privileged capability can NEVER produce a level below
 *     `high`, whatever the tool's declared policy says;
 *   - an unknown capability, an uncertain parse, or unfilled resource analysis
 *     each force at least `high` with `certainty: "conservative_default"`.
 */
import type { Capability, NormalizedOperation, RiskAssessment, RiskDimensions, RiskLevel } from "@abdo/control-contracts"

type Partials = Partial<RiskDimensions>

/** What each capability tells us. Absent fields stay `unknown`. */
const BY_CAPABILITY: Readonly<Record<string, Partials>> = {
  "filesystem.read": { reversibility: "reversible", blastRadius: "file", persistence: "ephemeral", externalSideEffects: "none", estimatedCost: "none", privilegeEscalation: "no", dataSensitivity: "project" },
  "filesystem.write": { reversibility: "compensable", blastRadius: "file", persistence: "workspace", externalSideEffects: "none", estimatedCost: "low", privilegeEscalation: "no", dataSensitivity: "project" },
  "filesystem.delete": { reversibility: "irreversible", blastRadius: "workspace", persistence: "workspace", externalSideEffects: "none", estimatedCost: "low", privilegeEscalation: "no", dataSensitivity: "project" },
  "filesystem.permission": { reversibility: "compensable", blastRadius: "machine", persistence: "system", privilegeEscalation: "yes" },
  "package.install": { reversibility: "compensable", blastRadius: "package", persistence: "workspace", externalSideEffects: "yes", estimatedCost: "high" },
  "package.update": { reversibility: "compensable", blastRadius: "package", persistence: "workspace", externalSideEffects: "yes", estimatedCost: "high" },
  "package.remove": { reversibility: "compensable", blastRadius: "package", persistence: "workspace", estimatedCost: "low" },
  "package.script": { reversibility: "unknown", blastRadius: "unknown", persistence: "unknown", estimatedCost: "low" },
  "process.start": { reversibility: "reversible", blastRadius: "machine", persistence: "ephemeral" },
  "process.kill": { reversibility: "irreversible", blastRadius: "machine", persistence: "ephemeral" },
  "network.request": { reversibility: "unknown", blastRadius: "external", externalSideEffects: "yes", persistence: "ephemeral", estimatedCost: "low" },
  "network.listen": { reversibility: "reversible", blastRadius: "external", externalSideEffects: "yes", persistence: "ephemeral" },
  "git.read": { reversibility: "reversible", blastRadius: "workspace", persistence: "ephemeral", externalSideEffects: "none", estimatedCost: "none", privilegeEscalation: "no", dataSensitivity: "project" },
  "git.commit": { reversibility: "compensable", blastRadius: "workspace", persistence: "workspace", externalSideEffects: "none", estimatedCost: "none", privilegeEscalation: "no", dataSensitivity: "project" },
  "git.push": { reversibility: "compensable", blastRadius: "external", externalSideEffects: "yes", persistence: "system", credentialScope: "uses_secret" },
  "git.force": { reversibility: "irreversible", blastRadius: "external", externalSideEffects: "yes", persistence: "system", credentialScope: "uses_secret" },
  "git.reset": { reversibility: "irreversible", blastRadius: "workspace", persistence: "workspace" },
  "docker.inspect": { reversibility: "reversible", blastRadius: "machine", persistence: "ephemeral" },
  "docker.build": { reversibility: "compensable", blastRadius: "machine", externalSideEffects: "yes", estimatedCost: "high", persistence: "system" },
  "docker.run": { reversibility: "compensable", blastRadius: "machine", persistence: "system", privilegeEscalation: "unknown" },
  "docker.exec": { reversibility: "unknown", blastRadius: "machine", persistence: "unknown", privilegeEscalation: "unknown" },
  "docker.remove": { reversibility: "irreversible", blastRadius: "machine", persistence: "system" },
  "docker.prune": { reversibility: "irreversible", blastRadius: "machine", persistence: "system" },
  "ssh.connect": { reversibility: "reversible", blastRadius: "external", externalSideEffects: "yes", credentialScope: "uses_secret" },
  "ssh.exec": { reversibility: "unknown", blastRadius: "external", externalSideEffects: "yes", credentialScope: "uses_secret", persistence: "unknown" },
  "ssh.copy": { reversibility: "compensable", blastRadius: "external", externalSideEffects: "yes", credentialScope: "uses_secret" },
  "ssh.tunnel": { reversibility: "reversible", blastRadius: "external", externalSideEffects: "yes", credentialScope: "uses_secret" },
  "database.read": { reversibility: "reversible", blastRadius: "external", dataSensitivity: "project", credentialScope: "uses_secret" },
  "database.write": { reversibility: "compensable", blastRadius: "external", dataSensitivity: "project", credentialScope: "uses_secret" },
  "database.schema": { reversibility: "irreversible", blastRadius: "external", credentialScope: "uses_secret" },
  "database.drop": { reversibility: "irreversible", blastRadius: "external", credentialScope: "uses_secret" },
  "kubernetes.read": { reversibility: "reversible", blastRadius: "external", credentialScope: "uses_secret" },
  "kubernetes.apply": { reversibility: "compensable", blastRadius: "external", externalSideEffects: "yes", credentialScope: "uses_secret", persistence: "system" },
  "kubernetes.delete": { reversibility: "irreversible", blastRadius: "external", externalSideEffects: "yes", credentialScope: "uses_secret" },
  "kubernetes.exec": { reversibility: "unknown", blastRadius: "external", credentialScope: "uses_secret", persistence: "unknown" },
  "cloud.read": { reversibility: "reversible", blastRadius: "external", credentialScope: "uses_secret" },
  "cloud.deploy": { reversibility: "compensable", blastRadius: "external", externalSideEffects: "yes", credentialScope: "uses_secret", estimatedCost: "high", persistence: "system" },
  "cloud.delete": { reversibility: "irreversible", blastRadius: "external", externalSideEffects: "yes", credentialScope: "uses_secret" },
  "cloud.iam": { reversibility: "compensable", blastRadius: "external", credentialScope: "writes_secret", privilegeEscalation: "yes" },
  "system.read": { reversibility: "reversible", blastRadius: "file", persistence: "ephemeral", externalSideEffects: "none", estimatedCost: "none", privilegeEscalation: "no", dataSensitivity: "none" },
  "system.service": { reversibility: "compensable", blastRadius: "machine", persistence: "system", privilegeEscalation: "yes" },
  "system.restart": { reversibility: "irreversible", blastRadius: "machine", persistence: "system", privilegeEscalation: "yes" },
  "system.disable": { reversibility: "compensable", blastRadius: "machine", persistence: "system", privilegeEscalation: "yes" },
  "secret.read": { credentialScope: "reads_secret", dataSensitivity: "credential", blastRadius: "external" },
  "secret.use": { credentialScope: "uses_secret", dataSensitivity: "credential" },
  "secret.write": { credentialScope: "writes_secret", dataSensitivity: "credential", blastRadius: "external" },
  "artifact.publish": { reversibility: "irreversible", blastRadius: "external", externalSideEffects: "yes", credentialScope: "uses_secret", persistence: "system" },
  "code.execute": { reversibility: "unknown", blastRadius: "unknown", persistence: "unknown", privilegeEscalation: "unknown" },
  unknown: {},
}

/**
 * Capabilities whose resource analysis is legitimately incomplete (they reach a
 * package registry we cannot enumerate) yet are KNOWN and bounded — so that
 * incompleteness must not, on its own, escalate them to the conservative floor.
 * Their real risk is carried by their dimensions (`medium`), and CL-11's
 * script-suppression is what makes an install safe to auto-allow. Deliberately
 * excludes `package.script` (that is code the project chose to run — explicit
 * execution, weighed on its own) and everything network/exec.
 */
const BOUNDED_WHEN_INCOMPLETE = new Set<Capability>(["package.install", "package.update", "package.remove"])

/** Capabilities that can never score below `high`, whatever a policy claims. */
const NEVER_LOW = new Set<Capability>([
  "filesystem.delete", "filesystem.permission",
  "process.kill",
  "git.force", "git.reset", "git.push",
  "docker.remove", "docker.prune", "docker.exec", "docker.run",
  "ssh.exec", "ssh.copy", "ssh.tunnel", "ssh.connect",
  "database.schema", "database.drop", "database.write",
  "kubernetes.apply", "kubernetes.delete", "kubernetes.exec",
  "cloud.deploy", "cloud.delete", "cloud.iam",
  "system.service", "system.restart", "system.disable",
  "secret.read", "secret.write",
  "artifact.publish",
])

/** Worst-wins ordering per dimension; the last entry is the worst. */
const ORDER: { [K in keyof RiskDimensions]: readonly RiskDimensions[K][] } = {
  reversibility: ["reversible", "compensable", "unknown", "irreversible"],
  blastRadius: ["file", "package", "workspace", "machine", "unknown", "external"],
  environment: ["local", "dev", "staging", "unknown", "production"],
  credentialScope: ["none", "uses_secret", "unknown", "reads_secret", "writes_secret"],
  dataSensitivity: ["none", "project", "unknown", "credential"],
  persistence: ["ephemeral", "workspace", "unknown", "system"],
  externalSideEffects: ["none", "unknown", "yes"],
  estimatedCost: ["none", "low", "unknown", "high"],
  privilegeEscalation: ["no", "unknown", "yes"],
  parserCertainty: ["parsed", "uncertain"],
}

const UNKNOWN_DIMENSIONS: RiskDimensions = {
  reversibility: "unknown", blastRadius: "unknown", environment: "unknown", credentialScope: "unknown",
  dataSensitivity: "unknown", persistence: "unknown", externalSideEffects: "unknown", estimatedCost: "unknown",
  privilegeEscalation: "unknown", parserCertainty: "parsed",
}

function worse<K extends keyof RiskDimensions>(key: K, a: RiskDimensions[K], b: RiskDimensions[K]): RiskDimensions[K] {
  const order = ORDER[key] as readonly RiskDimensions[K][]
  return order.indexOf(a) >= order.indexOf(b) ? a : b
}

export interface RiskInput {
  readonly operation: NormalizedOperation
  readonly capabilities: readonly Capability[]
  readonly anyUnknownCapability: boolean
  /** The tool's own declared risk — a FLOOR, never a ceiling. */
  readonly declared: RiskLevel
  readonly declaredRequiresApproval?: boolean
  /** A dangerous-command rule matched (rm -rf, DROP DATABASE, ...). */
  readonly dangerous: boolean
  readonly dangerRule?: string
}

/**
 * Derive the dimensions and the level. Deterministic and monotone: adding a
 * capability can only make the result worse, never better.
 */
export function assessRisk(input: RiskInput): RiskAssessment {
  let dims: RiskDimensions = { ...UNKNOWN_DIMENSIONS, parserCertainty: input.operation.certainty }
  // Start from the least-bad values a single-capability operation could have,
  // then take the worst across every capability present.
  let first = true
  for (const cap of input.capabilities) {
    const known = { ...UNKNOWN_DIMENSIONS, ...(BY_CAPABILITY[cap] ?? {}) }
    if (first) {
      dims = { ...known, parserCertainty: input.operation.certainty }
      first = false
      continue
    }
    const merged: Record<string, unknown> = {}
    for (const key of Object.keys(ORDER) as (keyof RiskDimensions)[]) {
      merged[key] = worse(key, dims[key] as never, known[key] as never)
    }
    dims = { ...(merged as unknown as RiskDimensions), parserCertainty: input.operation.certainty }
  }

  // The conservative floor is about COMMANDS WE COULD NOT CLASSIFY — an unknown
  // capability, a parse we could not trust, or a command whose EFFECTS we could
  // not analyse. It is NOT about the ONE incompleteness that is fully understood:
  // a package install reaches the registry it cannot name, and that is a KNOWN,
  // bounded operation (`medium` by its dimensions), not an unclassifiable one.
  //
  // Keying the floor on incompleteness alone conflated the two: it forced every
  // `npm install` to `high` — so a scripts-suppressed install could never reach
  // the allow path CL-11 gives it — while ALSO (correctly) catching `node app.js`
  // and `curl`, whose incompleteness hides arbitrary effects. So incompleteness
  // still forces conservative UNLESS every capability present is install-family
  // (install/update/remove). Anything else in the mix — code execution, network,
  // an unknown — keeps the floor, and `npm install && node x` stays conservative
  // on the strength of the `node`. (`resources.analysis` stays honestly
  // `incomplete` for an install; only this floor changed.)
  const isShell = input.operation.kind === "shell"
  const resourcesIncomplete = (input.operation.resources?.analysis ?? "unknown") !== "complete"
  const allInstallFamily =
    input.capabilities.length > 0 && input.capabilities.every((c) => BOUNDED_WHEN_INCOMPLETE.has(c))
  const conservative =
    input.operation.certainty === "uncertain" ||
    (isShell && (input.anyUnknownCapability || (resourcesIncomplete && !allInstallFamily)))

  let level: RiskLevel = "low"
  const bump = (l: RiskLevel) => {
    const order: RiskLevel[] = ["read", "low", "medium", "high", "critical"]
    if (order.indexOf(l) > order.indexOf(level)) level = l
  }
  // Read-only, local, no side effects, fully analysed.
  if (dims.reversibility === "reversible" && dims.blastRadius === "file" && dims.externalSideEffects === "none") level = "read"
  if (dims.reversibility === "compensable" || dims.persistence === "workspace") bump("medium")
  if (dims.estimatedCost === "high" || dims.externalSideEffects === "yes") bump("medium")
  if (dims.reversibility === "irreversible") bump("high")
  if (dims.blastRadius === "machine" || dims.blastRadius === "external") bump("high")
  if (dims.persistence === "system") bump("high")
  if (dims.credentialScope !== "none" && dims.credentialScope !== "unknown") bump("high")
  if (dims.dataSensitivity === "credential") bump("high")
  if (dims.privilegeEscalation === "yes") bump("critical")
  // A destructive capability can never be scored below high, whatever a policy
  // declares — the whole point of a classifier the policy cannot argue with.
  if (input.capabilities.some((c) => NEVER_LOW.has(c))) bump("high")
  if (input.dangerous) bump("critical")
  // Unknown of any kind: conservative, and honestly labelled as such.
  if (conservative) bump("high")
  // The tool's declared risk is a FLOOR.
  bump(input.declaredRequiresApproval ? "critical" : input.declared)

  return {
    level,
    dimensions: dims,
    capabilities: input.capabilities,
    dangerous: input.dangerous,
    ...(input.dangerRule ? { rule: input.dangerRule } : {}),
    certainty: conservative ? "conservative_default" : "classified",
  }
}
