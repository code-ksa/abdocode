/**
 * Sprint 20 GATE — a high-risk operation does not run without the RIGHT permit
 * or approval.
 *
 * "The right one" is the load-bearing word. A permit is a durable, scoped,
 * use-capped grant issued ahead of time; an approval is a human saying yes to
 * this act, now. Letting either satisfy the other would collapse two different
 * safety properties into one weaker one, so the gate tests the mismatches as
 * carefully as it tests the matches.
 */
import { describe, expect, test } from "bun:test"
import type { RiskAssessment, RiskDimensions } from "../src/index"
import {
  classifyRisk,
  evaluatePolicy,
  REQUIREMENT_OF,
  RISK_CLASSES,
  strictestRequirement,
  type RiskClass,
} from "../src/riskclass"

const dimensions = (over: Partial<RiskDimensions> = {}): RiskDimensions => ({
  reversibility: "reversible",
  blastRadius: "file",
  environment: "local",
  credentialScope: "none",
  dataSensitivity: "none",
  persistence: "ephemeral",
  externalSideEffects: "none",
  estimatedCost: "none",
  privilegeEscalation: "no",
  parserCertainty: "parsed",
  ...over,
})

const risk = (over: Partial<RiskAssessment> = {}, dims: Partial<RiskDimensions> = {}): RiskAssessment => ({
  level: "low",
  dangerous: false,
  certainty: "classified",
  dimensions: dimensions(dims),
  capabilities: [],
  ...over,
})

describe("the taxonomy is complete and each class has one requirement", () => {
  test("all seven classes the owner named exist", () => {
    expect([...RISK_CLASSES].sort()).toEqual(
      (["read", "local_write", "production_write", "credential_use", "external_side_effect", "destructive", "financial"] as RiskClass[]).sort(),
    )
  })

  test("each class carries exactly one requirement", () => {
    for (const c of RISK_CLASSES) expect(["none", "permit", "approval"]).toContain(REQUIREMENT_OF[c])
  })

  test("the strictest requirement wins when several classes apply", () => {
    expect(strictestRequirement(["read"])).toBe("none")
    expect(strictestRequirement(["read", "local_write"])).toBe("none")
    expect(strictestRequirement(["local_write", "production_write"])).toBe("permit")
    expect(strictestRequirement(["production_write", "financial"])).toBe("approval")
    expect(strictestRequirement([])).toBe("none")
  })
})

describe("classification comes from what was measured", () => {
  test("a plain read is read, and nothing else", () => {
    expect(classifyRisk(risk({ capabilities: ["filesystem.read"] }))).toEqual(["read"])
  })

  test("a workspace write is a local write", () => {
    expect(classifyRisk(risk({ capabilities: ["filesystem.write"] }, { persistence: "workspace" }))).toEqual(["local_write"])
  })

  test("production environment makes it a production write, not a local one", () => {
    const classes = classifyRisk(risk({ capabilities: ["database.write"] }, { environment: "production", persistence: "system" }))
    expect(classes).toContain("production_write")
    expect(classes).not.toContain("local_write")
  })

  test("touching a secret is credential use, however it is touched", () => {
    expect(classifyRisk(risk({}, { credentialScope: "reads_secret" }))).toContain("credential_use")
    expect(classifyRisk(risk({}, { credentialScope: "uses_secret" }))).toContain("credential_use")
    expect(classifyRisk(risk({ capabilities: ["secret.write"] }))).toContain("credential_use")
  })

  test("anything reaching off this machine is an external side effect", () => {
    expect(classifyRisk(risk({ capabilities: ["network.request"] }))).toContain("external_side_effect")
    expect(classifyRisk(risk({ capabilities: ["git.push"] }))).toContain("external_side_effect")
    expect(classifyRisk(risk({}, { externalSideEffects: "yes" }))).toContain("external_side_effect")
  })

  test("irreversible or dangerous is destructive", () => {
    expect(classifyRisk(risk({}, { reversibility: "irreversible" }))).toContain("destructive")
    expect(classifyRisk(risk({ dangerous: true, rule: "rm -rf" }))).toContain("destructive")
    expect(classifyRisk(risk({ capabilities: ["database.drop"] }))).toContain("destructive")
  })

  test("spending money is a CAPABILITY, not a cost estimate", () => {
    expect(classifyRisk(risk({ capabilities: ["cloud.deploy"] }))).toContain("financial")
    expect(classifyRisk(risk({ capabilities: ["cloud.iam"] }))).toContain("financial")
  })

  test("expense is not money — the two rules that got this wrong", () => {
    // v1 was `estimatedCost !== none`, and CL-05 rates `filesystem.write` as
    // `low`: every file write became financial, demanding a human approval and
    // excluded from BUILD. v2 was `high && external`, and an install is rated
    // `high` because it is slow and heavy: every `npm install` became
    // financial, which broke four crash-recovery tests.
    expect(classifyRisk(risk({ capabilities: ["filesystem.write"] }, { estimatedCost: "low", persistence: "workspace" }))).not.toContain("financial")
    expect(classifyRisk(risk({ capabilities: ["package.install"] }, { estimatedCost: "high", externalSideEffects: "yes" }))).not.toContain("financial")
    // and it is still external, which is where the real control sits
    expect(classifyRisk(risk({ capabilities: ["package.install"] }, { externalSideEffects: "yes" }))).toContain("external_side_effect")
  })

  test("an unknown dimension on a CLASSIFIED operation is not treated as danger", () => {
    // CL-05 already treats a registered tool's declared policy as authoritative,
    // so `unknown` there means the dimension does not apply — not that the tool
    // might reach the internet. A gate that fires on every custom tool is a gate
    // people route around.
    expect(classifyRisk(risk({}, { externalSideEffects: "unknown" }))).not.toContain("external_side_effect")
    expect(classifyRisk(risk({}, { credentialScope: "unknown" }))).not.toContain("credential_use")
  })

  test("but when the classifier could NOT parse, every unknown counts against it", () => {
    const blind = (dims: Partial<RiskDimensions>): RiskAssessment => ({
      level: "critical",
      dangerous: false,
      certainty: "conservative_default",
      dimensions: dimensions(dims),
    })
    expect(classifyRisk(blind({ externalSideEffects: "unknown" }))).toContain("external_side_effect")
    expect(classifyRisk(blind({ credentialScope: "unknown" }))).toContain("credential_use")
    // but unparseability alone is NOT destruction: claiming it made every
    // unparsed shell command need RECOVER, so DEPLOY could not deploy.
    const opaque: RiskAssessment = { level: "critical", dangerous: false, certainty: "conservative_default" }
    expect(classifyRisk(opaque)).not.toContain("destructive")
  })

  test("an operation is several classes at once, and says so", () => {
    const classes = classifyRisk(
      risk({ capabilities: ["cloud.deploy", "secret.use"] }, { environment: "production", credentialScope: "uses_secret", estimatedCost: "high" }),
    )
    expect(classes).toContain("production_write")
    expect(classes).toContain("credential_use")
    expect(classes).toContain("external_side_effect")
    expect(classes).toContain("financial")
  })

  test("a write that also read something is not made safe by the read", () => {
    const classes = classifyRisk(risk({ capabilities: ["filesystem.read", "filesystem.delete"] }))
    expect(classes).toContain("destructive")
    expect(classes).not.toContain("read")
  })
})

describe("GATE — nothing high-risk runs without the right thing", () => {
  test("reads and local writes need nothing", () => {
    expect(evaluatePolicy(risk({ capabilities: ["filesystem.read"] })).decision).toBe("allow")
    expect(evaluatePolicy(risk({ capabilities: ["filesystem.write"] }, { persistence: "workspace" })).decision).toBe("allow")
  })

  const highRisk: Array<[string, RiskAssessment, "permit" | "approval"]> = [
    ["a production write", risk({ capabilities: ["database.write"] }, { environment: "production" }), "permit"],
    ["credential use", risk({}, { credentialScope: "uses_secret" }), "permit"],
    ["an external side effect", risk({ capabilities: ["network.request"] }), "approval"],
    ["a destructive operation", risk({ capabilities: ["filesystem.delete"] }), "approval"],
    ["a financial operation", risk({ capabilities: ["cloud.iam"] }), "approval"],
  ]

  for (const [name, assessment, requirement] of highRisk) {
    test(`${name} is DENIED with nothing`, () => {
      const outcome = evaluatePolicy(assessment)
      expect(outcome.decision).toBe("deny")
      expect(outcome.requirement).toBe(requirement)
    })

    test(`${name} is allowed with the right ${requirement}`, () => {
      const evidence = requirement === "permit" ? { grantId: "grant_1" } : { approvalId: "appr_1", approvedBy: "owner" }
      const outcome = evaluatePolicy(assessment, evidence)
      expect(outcome.decision).toBe("allow")
      expect(outcome.requirement).toBe(requirement)
    })
  }

  test("a permit does NOT stand in for an approval", () => {
    const outcome = evaluatePolicy(risk({ capabilities: ["filesystem.delete"] }), { grantId: "grant_1" })
    expect(outcome.decision).toBe("deny")
    if (outcome.decision === "deny") expect(outcome.reason).toContain("does not stand in")
  })

  test("an approval does NOT stand in for a permit", () => {
    const outcome = evaluatePolicy(risk({}, { credentialScope: "uses_secret" }), { approvalId: "appr_1" })
    expect(outcome.decision).toBe("deny")
    expect(outcome.requirement).toBe("permit")
  })

  test("a permit for the write does not cover the spending beside it", () => {
    // production_write (permit) + financial (approval) => the approval governs
    const both = risk({ capabilities: ["cloud.deploy"] }, { environment: "production", estimatedCost: "high", externalSideEffects: "yes" })
    expect(evaluatePolicy(both, { grantId: "grant_for_the_deploy" }).decision).toBe("deny")
    expect(evaluatePolicy(both, { approvalId: "appr_1" }).decision).toBe("allow")
  })

  test("the outcome always names the classes it judged, allowed or denied", () => {
    for (const [, assessment] of highRisk) {
      expect(evaluatePolicy(assessment).classes.length).toBeGreaterThan(0)
      expect(evaluatePolicy(assessment, { approvalId: "a", grantId: "g" }).classes.length).toBeGreaterThan(0)
    }
  })

  test("an unparseable operation cannot slip through as harmless", () => {
    const blind: RiskAssessment = { level: "high", dangerous: false, certainty: "conservative_default" }
    const outcome = evaluatePolicy(blind)
    // It is NOT called destructive — that claim needs evidence, and making it
    // meant every unparsed command required RECOVER. It requires a human
    // because nobody knows what it does, which is the honest reason.
    expect(outcome.decision).toBe("deny")
    expect(outcome.requirement).toBe("approval")
    expect(outcome.classes).not.toContain("destructive")
    // and a human's yes is what clears it
    expect(evaluatePolicy(blind, { approvalId: "appr_1" }).decision).toBe("allow")
  })
})

describe("destruction is claimed on evidence, not on ignorance", () => {
  test("a matched dangerous rule is destructive even when nothing else is known", () => {
    expect(classifyRisk({ level: "critical", dangerous: true, rule: "rm -rf", certainty: "conservative_default" })).toContain(
      "destructive",
    )
  })

  test("a removal capability is destructive", () => {
    expect(classifyRisk(risk({ capabilities: ["database.drop"] }))).toContain("destructive")
  })

  test("an unreadable but benign command is not", () => {
    expect(classifyRisk({ level: "high", dangerous: false, certainty: "conservative_default" })).not.toContain("destructive")
  })
})

describe("reaching outside the machine is an external side effect, not a production write (measured 2026-09-13)", () => {
  test("a public GET with an external blast radius stays permitted in BUILD and needs approval, not a DEPLOY permit", () => {
    const classes = classifyRisk(risk({ capabilities: ["network.request"] }, { blastRadius: "external", externalSideEffects: "yes", persistence: "ephemeral" }))
    expect(classes).toContain("external_side_effect")
    expect(classes).not.toContain("production_write")
    expect(strictestRequirement(classes)).toBe("approval")
  })
  test("twin: a production environment still makes it a production write even with the same blast radius", () => {
    const classes = classifyRisk(risk({ capabilities: ["network.request"] }, { blastRadius: "external", environment: "production" }))
    expect(classes).toContain("production_write")
  })
})
