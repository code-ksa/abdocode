/**
 * CL-01 gate: one contract, versioned, hashable, and explainable.
 */
import { describe, expect, test } from "bun:test"
import {
  CONTROL_CONTRACT_VERSION,
  controlRecord,
  decisionHash,
  POLICY_ENFORCED,
  targetIdentity,
  unenforcedToolRunner,
  type ControlDecision,
  type ControlRequest,
} from "../src/index"

const request = (over: Partial<ControlRequest> = {}): ControlRequest => ({
  version: CONTROL_CONTRACT_VERSION,
  sessionId: "ses_1",
  runId: "run_1",
  attemptId: 1,
  requestId: "req_1",
  toolExecutionId: "tex_1",
  actor: { agent: "abdo", model: "m", provider: "p" },
  tool: "shell",
  capability: "code.execute",
  target: { kind: "workspace", workspace: "/w" },
  normalizedOperation: { kind: "shell", summary: "shell: ls", certainty: "uncertain" },
  risk: { level: "medium", dangerous: false, certainty: "classified" },
  argsHash: "a1",
  secretRefs: [],
  provenance: ["model_tool_call"],
  ...over,
})

const allow: ControlDecision = {
  version: CONTROL_CONTRACT_VERSION,
  action: "allow",
  ruleId: "builtin.auto_allow_low_risk",
  reasonCode: "auto_allowed_low_risk",
  constraints: [],
}

describe("CL-01 control contract", () => {
  test("every decision carries a version, a rule and a structured reason", () => {
    const rec = controlRecord(request(), allow)
    expect(rec.version).toBe(CONTROL_CONTRACT_VERSION)
    expect(rec.ruleId).toBe("builtin.auto_allow_low_risk")
    expect(rec.reasonCode).toBe("auto_allowed_low_risk")
    expect(rec.capability).toBe("code.execute")
    expect(rec.target).toBe("workspace:/w")
    expect(rec.decisionHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test("the hash is stable across volatile identity — the SAME call under the SAME policy compares equal", () => {
    const a = decisionHash(request({ requestId: "req_A", toolExecutionId: "tex_A", attemptId: 1 }), allow)
    const b = decisionHash(request({ requestId: "req_B", toolExecutionId: "tex_B", attemptId: 7 }), allow)
    expect(a).toBe(b)
  })

  test("the hash moves when anything decision-relevant moves", () => {
    const base = decisionHash(request(), allow)
    expect(decisionHash(request({ argsHash: "different" }), allow)).not.toBe(base)
    expect(decisionHash(request({ target: { kind: "workspace", workspace: "/w", scope: "packages/api" } }), allow)).not.toBe(base)
    expect(decisionHash(request({ risk: { level: "critical", dangerous: true, rule: "rm -rf", certainty: "classified" } }), allow)).not.toBe(base)
    expect(
      decisionHash(request(), { version: CONTROL_CONTRACT_VERSION, action: "deny", ruleId: "builtin.critical_risk", reasonCode: "approval_denied" }),
    ).not.toBe(base)
  })

  test("target identity distinguishes package scopes inside one workspace", () => {
    expect(targetIdentity({ kind: "workspace", workspace: "/w" })).toBe("workspace:/w")
    expect(targetIdentity({ kind: "workspace", workspace: "/w", scope: "packages/api" })).toBe("workspace:/w#packages/api")
  })

  test("a grant id is recorded when one unlocked the allow (CL-03 hook)", () => {
    const rec = controlRecord(request(), { ...allow, grantId: "grant_1" })
    expect(rec.grantId).toBe("grant_1")
    expect(controlRecord(request(), allow).grantId).toBeUndefined()
  })

  test("the enforcement brand cannot be produced by writing a property name", () => {
    // Only importing POLICY_ENFORCED can mark a runner — that is the point.
    const fake = { run: async () => ({ ok: true as const, output: null }) }
    expect((fake as Record<string | symbol, unknown>)[POLICY_ENFORCED]).toBeUndefined()
    const marked = unenforcedToolRunner(fake, "test fake")
    expect((marked as unknown as Record<symbol, unknown>)[POLICY_ENFORCED]).toBe(true)
  })

  test("the escape hatch demands a reason", () => {
    expect(() => unenforcedToolRunner({ run: async () => ({ ok: true, output: null }) }, "")).toThrow(/reason/)
  })

  test("marking keeps the same object, so a fake's own counters survive", () => {
    const fake = { calls: 0, run: async () => ({ ok: true as const, output: null }) }
    const marked = unenforcedToolRunner(fake, "test fake")
    marked.calls++
    expect(fake.calls).toBe(1)
  })
})
