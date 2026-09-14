/**
 * Risk classes and what each one requires (Sprint 20).
 *
 * CL-05 already derives a risk LEVEL from measured dimensions, and the grant
 * ledger already issues permits. What was missing sat between them: a level of
 * `high` says how worried to be, not what KIND of thing is being done, and
 * "requires approval" was a boolean on a tool's policy rather than a
 * consequence of what the operation actually touches.
 *
 * So the seven classes name the kinds that matter, derived from the dimensions
 * rather than declared by a tool about itself:
 *
 *   read                  looks, changes nothing
 *   local_write           changes this machine's working state
 *   production_write      changes something users depend on
 *   credential_use        reads, uses or writes a secret
 *   external_side_effect  reaches something outside this machine
 *   destructive           removes or overwrites in a way that is not reversible
 *   financial             spends money
 *
 * An operation is usually several at once. A deploy that reads a secret and
 * charges for compute is production_write AND credential_use AND financial, and
 * the requirement is the STRICTEST of them — a permit for the production write
 * does not cover the spending.
 */
import type { Capability, RiskAssessment, RiskDimensions } from "./index"

export type RiskClass =
  | "read"
  | "local_write"
  | "production_write"
  | "credential_use"
  | "external_side_effect"
  | "destructive"
  | "financial"

export const RISK_CLASSES: readonly RiskClass[] = [
  "read",
  "local_write",
  "production_write",
  "credential_use",
  "external_side_effect",
  "destructive",
  "financial",
]

/**
 * What an operation must carry before it may run.
 *
 * `permit` is a durable, scoped, use-capped grant issued ahead of time — the
 * right shape for something that will happen repeatedly and must be bounded.
 * `approval` is a human saying yes to THIS act, now — the right shape for
 * something whose consequences a human should look at before it happens.
 * They are not interchangeable, which is the point of separating them.
 */
export type Requirement = "none" | "permit" | "approval"

/** The requirement each class carries on its own. */
export const REQUIREMENT_OF: Readonly<Record<RiskClass, Requirement>> = {
  read: "none",
  local_write: "none",
  production_write: "permit",
  credential_use: "permit",
  external_side_effect: "approval",
  destructive: "approval",
  financial: "approval",
}

const STRICTNESS: Readonly<Record<Requirement, number>> = { none: 0, permit: 1, approval: 2 }

/** The strictest requirement among several classes. */
export function strictestRequirement(classes: readonly RiskClass[]): Requirement {
  let out: Requirement = "none"
  for (const c of classes) {
    const r = REQUIREMENT_OF[c]
    if (STRICTNESS[r] > STRICTNESS[out]) out = r
  }
  return out
}

const DESTRUCTIVE_CAPABILITIES: readonly Capability[] = [
  "filesystem.delete",
  "database.drop",
  "docker.remove",
  "docker.prune",
  "git.force",
  "git.reset",
  "kubernetes.delete",
  "cloud.delete",
  "package.remove",
  "system.disable",
]

const EXTERNAL_CAPABILITIES: readonly Capability[] = [
  "network.request",
  "ssh.connect",
  "ssh.exec",
  "ssh.copy",
  "ssh.tunnel",
  "git.push",
  "artifact.publish",
  "cloud.deploy",
  "cloud.iam",
  "kubernetes.apply",
]

const FINANCIAL_CAPABILITIES: readonly Capability[] = ["cloud.deploy", "cloud.iam"]

/**
 * Classify from what was MEASURED, never from what a tool says about itself.
 *
 * An `unknown` dimension elevates risk ONLY when the classifier admits it could
 * not analyse the operation (`conservative_default`). That distinction is the
 * whole difference between a rule and a nuisance: CL-05 already treats a
 * registered tool's declared policy as authoritative, so an `unknown` there
 * means "this dimension does not apply to this capability", not "this might
 * reach the internet". Reading every unknown as danger would put a human in
 * front of every custom tool, and a gate that fires on everything is one people
 * route around. When the classifier DID fail to parse — a shell command it
 * could not understand — every unknown counts against it, because then the
 * unknown really is hiding something.
 */
export function classifyRisk(risk: RiskAssessment): RiskClass[] {
  const classes = new Set<RiskClass>()
  const d: Partial<RiskDimensions> = risk.dimensions ?? {}
  const capabilities = risk.capabilities ?? []
  const has = (list: readonly Capability[]): boolean => capabilities.some((c) => list.includes(c))

  // A classifier that could not parse assumes the worst — the same
  // conservative default CL-05 uses, made explicit here.
  const blind = risk.certainty === "conservative_default"

  const unknownCounts = (value: string | undefined): boolean => blind && value === "unknown"

  if ((d.credentialScope !== undefined && d.credentialScope !== "none" && d.credentialScope !== "unknown") ||
      unknownCounts(d.credentialScope) ||
      capabilities.some((c) => c.startsWith("secret."))) {
    classes.add("credential_use")
  }

  if (d.externalSideEffects === "yes" || unknownCounts(d.externalSideEffects) || has(EXTERNAL_CAPABILITIES)) {
    classes.add("external_side_effect")
  }

  if (d.environment === "production" || d.environment === "staging") classes.add("production_write")
  // مقيسٌ 2026-09-13 في مهمّةٍ حقيقيّة: `network.request` (GET لصفحةٍ عامّة) يحمل `blastRadius: "external"`
  // في الكتالوج، فكان يُصنَّف «كتابةً إنتاجيّة» فيرفضه نمطُ BUILD — والوكيلُ يُحرَم من قراءة الويب كلّه.
  // الوصولُ إلى خارج الجهاز أثرٌ خارجيّ (يحتاج موافقةً)، لا كتابةً فيما يعتمد عليه المستخدمون؛ الكتابةُ
  // الإنتاجيّةُ تُدَّعى على دليلها: بيئةٌ إنتاجيّة/تجريبيّة (أعلاه) لا مجرّدُ اتّساع الأثر.
  if (d.blastRadius === "external") classes.add("external_side_effect")

  // Destruction is claimed on EVIDENCE of destruction: an irreversible
  // dimension, a matched dangerous rule (`rm -rf`, `DROP DATABASE`), or a
  // capability whose whole purpose is removal.
  //
  // It is deliberately NOT claimed on unparseability. The first version added
  // `destructive` whenever the classifier could not read a command, on the
  // reasoning that an unknown might remove something — which made every
  // unparsed shell command require RECOVER, so DEPLOY could not run a deploy
  // script and BUILD could not run a build one. Unparseability is already
  // expressed honestly elsewhere: CL-05 raises the LEVEL for it (so approval is
  // required), and Sprint 15 classifies an unknown failure after a side effect
  // as UNRECOVERABLE. Saying it a third time here only removed the ordinary
  // case, and a rule that removes the ordinary case gets removed itself.
  if (d.reversibility === "irreversible" || risk.dangerous || has(DESTRUCTIVE_CAPABILITIES)) classes.add("destructive")

  // `financial` means money leaves an account, and the only honest signal for
  // that is the CAPABILITY. CL-05's `estimatedCost` measures expense in the
  // general sense — it rates `package.install` as `high` because an install is
  // slow and heavy, and `filesystem.write` as `low` because writing costs
  // something. Reading either as money mislabels ordinary work: the first
  // version of this rule made every file write financial, and the second made
  // every dependency install financial. Both demanded a human approval for
  // something nobody would call a purchase.
  if (has(FINANCIAL_CAPABILITIES)) classes.add("financial")

  const writes =
    capabilities.some((c) => /\.(write|commit|install|update|start|kill|apply|schema|build|run|exec|service|restart)$/.test(c)) ||
    d.persistence === "workspace" ||
    d.persistence === "system"
  if (writes && !classes.has("production_write")) classes.add("local_write")

  // `read` only when nothing else applies: an operation that also writes is not
  // made safe by having read something along the way.
  if (classes.size === 0) classes.add("read")
  return [...classes]
}

export interface PermitEvidence {
  /** A durable grant that matched this operation (capability + target + hash). */
  readonly grantId?: string
  /** A human's yes to this specific act. */
  readonly approvalId?: string
  /** Who approved, for the record. */
  readonly approvedBy?: string
}

export type PolicyOutcome =
  | { readonly decision: "allow"; readonly classes: readonly RiskClass[]; readonly requirement: Requirement; readonly satisfiedBy?: string }
  | {
      readonly decision: "deny"
      readonly classes: readonly RiskClass[]
      readonly requirement: Requirement
      readonly reason: string
    }

/**
 * The gate: may this run, given what it is and what it carries?
 *
 * A permit does not stand in for an approval. An operation that needs a human
 * to look at it is not satisfied by a grant issued earlier for something else,
 * and an operation that needs a bounded, use-capped permit is not satisfied by
 * someone clicking yes once. Accepting either for the other would collapse two
 * different safety properties into one weaker one.
 */
export function evaluatePolicy(risk: RiskAssessment, evidence: PermitEvidence = {}): PolicyOutcome {
  const classes = classifyRisk(risk)
  // An operation the classifier could not read is not destructive — claiming
  // that made every unparsed command need RECOVER. But it is not harmless
  // either: nobody knows what it does. So it takes the honest form, a
  // REQUIREMENT rather than an invented class, and a human looks at it.
  const requirement =
    risk.certainty === "conservative_default" ? "approval" : strictestRequirement(classes)

  if (requirement === "none") return { decision: "allow", classes, requirement }

  if (requirement === "permit") {
    return evidence.grantId !== undefined
      ? { decision: "allow", classes, requirement, satisfiedBy: evidence.grantId }
      : {
          decision: "deny",
          classes,
          requirement,
          reason: `${classes.join(", ")} requires a permit; none was presented`,
        }
  }

  // approval
  return evidence.approvalId !== undefined
    ? { decision: "allow", classes, requirement, satisfiedBy: evidence.approvalId }
    : {
        decision: "deny",
        classes,
        requirement,
        reason:
          evidence.grantId !== undefined
            ? `${classes.join(", ")} requires a human approval; a permit (${evidence.grantId}) does not stand in for one`
            : `${classes.join(", ")} requires a human approval; none was given`,
      }
}
