/**
 * Sprint 25 GATE — writing while EXPLORE or PLAN is impossible by construction.
 *
 * "Impossible by construction" is the claim, so the test does not check that a
 * refusal was returned and stop there: it checks that the TOOL NEVER RAN. A
 * guard that returns an error after the side effect has happened is not a
 * guard, and that distinction is the whole sprint.
 *
 * The mode arrives from the runtime through `options`. The other half of the
 * claim is that a model cannot reach it — so there is a test that puts a mode
 * in the tool's own arguments and proves it changes nothing.
 */
import { describe, expect, test } from "bun:test"
import { PolicyToolRunner, ToolRegistry, policy, type Approver, type ToolDefinition } from "../src/index"
import { AGENT_MODES, evaluateMode, isReadOnlyMode, MODE_ALLOWS, narrowestModeFor } from "@abdo/control-contracts/modes"

const yes: Approver = { approve: async () => true }

/** A tool that records whether it was ever entered. */
function spy(name: string, risk: "read" | "medium" | "high" = "medium") {
  const state = { ran: 0 }
  const tool: ToolDefinition = {
    name,
    policy: policy({ risk, requiresApproval: risk !== "read" }),
    async run() {
      state.ran++
      return { ok: true, output: "did the thing" }
    },
  }
  return { tool, state }
}

const runnerFor = (tool: ToolDefinition, options: Record<string, unknown> = {}) =>
  new PolicyToolRunner(new ToolRegistry().register(tool), { approver: yes, ...options } as never)

describe("GATE — a read-only mode cannot write, and the tool never runs", () => {
  for (const mode of ["EXPLORE", "PLAN"] as const) {
    test(`${mode} refuses a write, and the tool body is never entered`, async () => {
      const { tool, state } = spy("write_file")
      const outcome = await runnerFor(tool).run({ name: "write_file", input: { path: "a.ts" } }, { executionId: "tex_1", mode })

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error).toContain("mode_denied")
      // the claim that matters
      expect(state.ran).toBe(0)
    })

    test(`${mode} still allows reading`, async () => {
      const { tool, state } = spy("read_file", "read")
      const outcome = await runnerFor(tool).run({ name: "read_file", input: { path: "a.ts" } }, { executionId: "tex_2", mode })
      expect(outcome.ok).toBe(true)
      expect(state.ran).toBe(1)
    })
  }

  test("the refusal is a recorded control decision, not just a returned string", async () => {
    const { tool } = spy("write_file")
    const seen: { reasonCode: string }[] = []
    const outcome = await runnerFor(tool).run(
      { name: "write_file", input: {} },
      { executionId: "tex_3", mode: "EXPLORE", onDecision: (r) => void seen.push(r as never) },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.control?.reasonCode).toBe("mode_excludes_operation")
    expect(outcome.control?.action).toBe("deny")
  })

  test("the refusal names the narrowest mode that WOULD permit it", async () => {
    const { tool } = spy("write_file")
    const outcome = await runnerFor(tool).run({ name: "write_file", input: {} }, { executionId: "tex_4", mode: "PLAN" })
    if (!outcome.ok) expect(outcome.error).toContain("BUILD")
  })
})

describe("GATE — the mode is not reachable from the model", () => {
  test("a mode inside the tool's own arguments changes nothing", async () => {
    const { tool, state } = spy("write_file")
    const outcome = await runnerFor(tool).run(
      // the model tries to widen its own ceiling
      { name: "write_file", input: { path: "a.ts", mode: "DEPLOY", agentMode: "BUILD" } },
      { executionId: "tex_5", mode: "EXPLORE" },
    )
    expect(outcome.ok).toBe(false)
    expect(state.ran).toBe(0)
  })

  test("no mode supplied means the mode gate does not fire — the runtime is what sets it", async () => {
    const { tool, state } = spy("write_file")
    const outcome = await runnerFor(tool).run({ name: "write_file", input: {} }, { executionId: "tex_6" })
    // this path exists for direct callers; the SessionRuntime always sets a mode
    expect(outcome.ok).toBe(true)
    expect(state.ran).toBe(1)
  })
})

describe("BUILD does the work, and stops short of the rest", () => {
  test("BUILD writes", async () => {
    const { tool, state } = spy("write_file")
    const outcome = await runnerFor(tool).run({ name: "write_file", input: {} }, { executionId: "tex_7", mode: "BUILD" })
    expect(outcome.ok).toBe(true)
    expect(state.ran).toBe(1)
  })

  test("BUILD refuses a destructive command before anyone is asked to approve it", async () => {
    const shell: ToolDefinition = {
      name: "shell",
      policy: policy({ risk: "high", requiresApproval: true }),
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
      async run() {
        return { ok: true, output: "deleted" }
      },
    }
    let asked = false
    const runner = new PolicyToolRunner(new ToolRegistry().register(shell), {
      approver: { approve: async () => ((asked = true), true) },
    } as never)
    const outcome = await runner.run({ name: "shell", input: { command: "rm -rf ./build" } }, { executionId: "tex_8", mode: "BUILD" })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain("mode_denied")
    // the mode is checked FIRST: nobody is even asked
    expect(asked).toBe(false)
  })

  test("RECOVER is the mode that permits destruction — and still needs its approval", async () => {
    const shell: ToolDefinition = {
      name: "shell",
      policy: policy({ risk: "high", requiresApproval: true }),
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
      async run() {
        return { ok: true, output: "rolled back" }
      },
    }
    const denied = new PolicyToolRunner(new ToolRegistry().register(shell), { approver: { approve: async () => false } } as never)
    const refused = await denied.run({ name: "shell", input: { command: "rm -rf ./build" } }, { executionId: "tex_9", mode: "RECOVER" })
    // the mode lets it through; the policy engine still says no
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).not.toContain("mode_denied")

    const allowed = new PolicyToolRunner(new ToolRegistry().register(shell), { approver: yes } as never)
    const ok = await allowed.run({ name: "shell", input: { command: "rm -rf ./build" } }, { executionId: "tex_10", mode: "RECOVER" })
    expect(ok.ok).toBe(true)
  })
})

describe("the mode table", () => {
  test("all six modes exist and every one permits reading", () => {
    expect(AGENT_MODES).toHaveLength(6)
    for (const mode of AGENT_MODES) expect(MODE_ALLOWS[mode]).toContain("read")
  })

  test("a mode is a CEILING: no mode permits a class it does not list", () => {
    expect(evaluateMode("EXPLORE", ["local_write"]).allowed).toBe(false)
    expect(evaluateMode("BUILD", ["production_write"]).allowed).toBe(false)
    expect(evaluateMode("BUILD", ["destructive"]).allowed).toBe(false)
    expect(evaluateMode("VERIFY", ["credential_use"]).allowed).toBe(false)
    expect(evaluateMode("DEPLOY", ["destructive"]).allowed).toBe(false)
  })

  test("the strictest class decides — a local write does not rescue a production write", () => {
    expect(evaluateMode("BUILD", ["local_write", "production_write"]).allowed).toBe(false)
    expect(evaluateMode("DEPLOY", ["local_write", "production_write"]).allowed).toBe(true)
  })

  test("the narrowest mode is suggested, not the widest", () => {
    expect(narrowestModeFor(["read"])).toBe("EXPLORE")
    expect(narrowestModeFor(["local_write"])).toBe("BUILD")
    expect(narrowestModeFor(["production_write"])).toBe("DEPLOY")
    expect(narrowestModeFor(["destructive"])).toBe("RECOVER")
  })

  test("only EXPLORE and PLAN are read-only, and that list is explicit", () => {
    expect(AGENT_MODES.filter(isReadOnlyMode)).toEqual(["EXPLORE", "PLAN"])
  })
})
