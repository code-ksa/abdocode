/**
 * CL-04: the decision point now reasons about a PARSED operation, so the two
 * failure modes of text matching are closed — a dangerous command hidden behind
 * wrappers/separators is caught, and quoted text that merely LOOKS dangerous is
 * not. Anything unparsed escalates.
 */
import { describe, expect, test } from "bun:test"
import { assessCall, BuiltinPolicyDecisionPoint, policy } from "../src/index"
import { CONTROL_CONTRACT_VERSION, type ControlRequest } from "@abdo/control-contracts"

const pdp = new BuiltinPolicyDecisionPoint(() => "apr_test")
const decide = (command: string, risk: "low" | "high" = "low") => {
  const { operation, risk: assessed } = assessCall("shell", policy({ risk }), { command })
  const request = {
    version: CONTROL_CONTRACT_VERSION,
    sessionId: "s", runId: "r", attemptId: 1, requestId: "q", toolExecutionId: "t",
    actor: { agent: "a", model: "m", provider: "p" },
    tool: "shell", capability: "code.execute" as const,
    target: { kind: "workspace" as const, workspace: "/w" },
    normalizedOperation: operation, risk: assessed,
    argsHash: "h", secretRefs: [], provenance: [],
  } satisfies ControlRequest
  return { decision: pdp.decide(request), operation, risk: assessed }
}

describe("CL-04 decision point over normalized operations", () => {
  test("a dangerous command behind a wrapper and a separator is still caught", () => {
    const { decision, risk } = decide("cd /tmp && sudo rm -rf /var/data")
    expect(risk.dangerous).toBe(true)
    expect(decision.action).toBe("ask")
    expect(decision.reasonCode).toBe("dangerous_command_requires_approval")
  })

  test("quoted text that only LOOKS dangerous is not treated as the operation", () => {
    const { decision, risk, operation } = decide('echo "rm -rf /"')
    expect(operation.certainty).toBe("parsed")
    expect(risk.dangerous).toBe(false)
    // CL-05 completes the analysis for this command (an `echo` reads nothing and
    // writes nothing), so the blanket floor lifts exactly as promised and it is
    // auto-allowed. Before CL-05 this was `ask` because nothing was analysed.
    expect(operation.resources!.analysis).toBe("complete")
    expect(decision.action).toBe("allow")
  })

  test("an UNPARSED operation escalates with its own reason code — never allow", () => {
    const { decision, risk, operation } = decide("npm install $PACKAGE")
    expect(operation.certainty).toBe("uncertain")
    expect(risk.certainty).toBe("conservative_default")
    expect(decision.action).toBe("ask")
    expect(decision.ruleId).toBe("builtin.unparsed_operation")
  })

  test("an unparsed command that ALSO looks dangerous keeps the stronger signal", () => {
    const { decision, risk } = decide("rm -rf $TARGET")
    expect(risk.dangerous).toBe(true)
    expect(risk.certainty).toBe("conservative_default")
    expect(decision.action).toBe("ask")
    expect(decision.ruleId).toBe("builtin.dangerous_command")
  })

  test("a parsed shell command is STILL elevated while its resource effects are unanalyzed", () => {
    // Deferring resource analysis to CL-05 is fine; scoring the risk as low
    // meanwhile is not. `npm run build` parses perfectly and we still do not
    // know what it touches.
    const { decision, risk, operation } = decide("npm run build")
    expect(operation.certainty).toBe("parsed")
    expect(operation.resources!.analysis).not.toBe("complete")
    expect(risk.level).toBe("high")
    expect(decision.action).toBe("ask")
    // A PARSED command with unanalysed effects gets its own rule — not the
    // "could not parse" one, which would be a different and untrue claim.
    expect(decision.ruleId).toBe("builtin.unanalyzed_resources")
  })

  test("a NON-shell tool is unaffected by the shell risk floor", () => {
    const { operation } = assessCall("read_file", policy({ risk: "read" }), { path: "a.ts" })
    expect(operation.kind).toBe("file_read")
    expect(operation.certainty).toBe("parsed")
  })

  test("the parsed operation carries the resolved program and cwd for the audit", () => {
    const { operation } = decide("cd packages/api && npm ci")
    expect(operation.commands![0]).toMatchObject({ program: "npm", argv: ["ci"], cwd: "packages/api" })
    expect(operation.cwd).toBe("packages/api")
  })
})
