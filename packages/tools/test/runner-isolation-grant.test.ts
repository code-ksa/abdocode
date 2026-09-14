/**
 * CL-16A2-B §3 — the ENFORCEMENT POINT issues the isolation grant.
 *
 * The profile a run executes under is chosen by the control plane from the
 * ControlRequest, and it reaches the tool through `ToolContext.execution`. The
 * tool call's arguments are not consulted, and there is no way for a tool to ask
 * for a different one. These tests hold the PEP to that.
 */
import { describe, expect, test } from "bun:test"
import { PolicyToolRunner, ToolRegistry, policy, type Approver, type ControlledExecutionGrant, type ToolDefinition } from "../src/index"
import { DENY_ALL_PROFILE, ISOLATION_VERSION, type IsolationCapabilityReport } from "../src/isolation"
import { INHERIT_PROFILE, type IsolationEvent } from "../src/launcher"

const yes: Approver = { approve: async () => true }

/** A tool that only reports the grant it was handed — it starts nothing. */
function spy(): { tool: ToolDefinition; seen: () => ControlledExecutionGrant | undefined } {
  let seen: ControlledExecutionGrant | undefined
  return {
    seen: () => seen,
    tool: {
      name: "shell",
      policy: policy({ risk: "high", requiresApproval: true }),
      honorsEnvOverlay: true,
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
      async run(_input, ctx) {
        seen = ctx.execution
        return { ok: true, output: {} }
      },
    },
  }
}

const LINUX_CAP: IsolationCapabilityReport = {
  platform: "linux",
  mechanism: "linux-userns-unshare",
  denyAll: "supported",
  processTree: "supported",
  childInheritance: "supported",
  loopbackInsideDenyAll: "up",
  requiresElevation: false,
  mutatesGlobalState: false,
  reasonCodes: [],
  evidenceHash: "cap-1",
  isolationVersion: ISOLATION_VERSION,
}

const registryWith = (t: ToolDefinition) => {
  const r = new ToolRegistry()
  r.register(t)
  return r
}

describe("the PEP issues the grant", () => {
  test("no isolationPolicy => the tool is granted INHERIT and an unmeasured capability", async () => {
    const s = spy()
    const runner = new PolicyToolRunner(registryWith(s.tool), { approver: yes })
    const out = await runner.run({ name: "shell", input: { command: "echo hi" } })
    expect(out.ok).toBe(true)
    expect(s.seen()!.profile.network).toBe("inherit")
    // Fail-closed: an unmeasured capability can never satisfy deny_all.
    expect(s.seen()!.capability.denyAll).toBe("unknown")
  })

  test("an isolationPolicy's profile reaches the tool, together with the MEASURED capability", async () => {
    const s = spy()
    const runner = new PolicyToolRunner(registryWith(s.tool), {
      approver: yes,
      isolationPolicy: () => DENY_ALL_PROFILE,
      isolationCapability: LINUX_CAP,
    })
    await runner.run({ name: "shell", input: { command: "npm install" } })
    expect(s.seen()!.profile.network).toBe("deny_all")
    expect(s.seen()!.capability.evidenceHash).toBe("cap-1")
  })

  test("the isolation policy sees the CONTROL REQUEST, not the raw tool arguments", async () => {
    const s = spy()
    let sawTool = ""
    const runner = new PolicyToolRunner(registryWith(s.tool), {
      approver: yes,
      isolationPolicy: (req) => {
        sawTool = req.tool
        return INHERIT_PROFILE
      },
    })
    await runner.run({ name: "shell", input: { command: "echo hi" } })
    expect(sawTool).toBe("shell")
  })

  test("a human approval is recorded on the grant — it selects the staleness code later", async () => {
    const s = spy()
    const runner = new PolicyToolRunner(registryWith(s.tool), { approver: yes })
    await runner.run({ name: "shell", input: { command: "echo hi" } })
    expect(s.seen()!.approvalGranted).toBe(true)
  })

  test("the constraint's env KEY NAMES ride on the grant; the values do not", async () => {
    const s = spy()
    const runner = new PolicyToolRunner(registryWith(s.tool), {
      approver: yes,
      supplyChainVerifier: () => ({ status: "verified", evidenceHash: "sc-1", policyVersion: 1, verifierVersion: 1 }),
      identity: { workspace: process.cwd() },
    })
    await runner.run({ name: "shell", input: { command: "npm install" } })
    const grant = s.seen()!
    expect(grant.approvalEvidenceHash).toBe("sc-1")
    for (const name of grant.envConstraintNames ?? []) expect(typeof name).toBe("string")
    expect(JSON.stringify(grant.envConstraintNames ?? [])).not.toContain("=")
  })

  test("the durable isolation sink is threaded from the caller to the grant", async () => {
    const s = spy()
    const events: IsolationEvent[] = []
    const runner = new PolicyToolRunner(registryWith(s.tool), { approver: yes })
    await runner.run({ name: "shell", input: { command: "echo hi" } }, { onIsolation: (e) => void events.push(e), executionId: "tex-9" })
    expect(s.seen()!.emit).toBeDefined()
    expect(s.seen()!.executionId).toBe("tex-9")
  })

  test("the durable effect barrier lands after the grant and before tool control", async () => {
    const order: string[] = []
    const s = spy()
    const original = s.tool.run
    s.tool.run = async (input, ctx) => {
      order.push("tool")
      return original(input, ctx)
    }
    const runner = new PolicyToolRunner(registryWith(s.tool), { approver: yes })
    const out = await runner.run(
      { name: "shell", input: { command: "echo hi" } },
      {
        executionId: "effect-1",
        onBeforeEffect: ({ control, execution }) => {
          expect(control.phase).toBe("final")
          expect(execution.executionId).toBe("effect-1")
          order.push("barrier")
        },
      },
    )
    expect(out.ok).toBe(true)
    expect(order).toEqual(["barrier", "tool"])
  })

  test("a failed durable effect barrier refuses before the tool", async () => {
    const s = spy()
    const runner = new PolicyToolRunner(registryWith(s.tool), { approver: yes })
    const out = await runner.run(
      { name: "shell", input: { command: "echo hi" } },
      { onBeforeEffect: () => { throw new Error("ledger_busy") } },
    )
    expect(out.ok).toBe(false)
    expect(out.ok ? "" : out.error).toContain("effect_barrier_not_recorded")
    expect(s.seen()).toBeUndefined()
  })

  test("a DENIED call never produces a grant — nothing reaches the tool at all", async () => {
    const s = spy()
    const runner = new PolicyToolRunner(registryWith(s.tool), { approver: { approve: async () => false } })
    const out = await runner.run({ name: "shell", input: { command: "echo hi" } })
    expect(out.ok).toBe(false)
    expect(s.seen()).toBeUndefined()
  })
})
