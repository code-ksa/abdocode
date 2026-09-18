/**
 * Sprint 20 — the class requirement at the REAL enforcement point.
 *
 * The contracts test proves the table. This proves the PolicyToolRunner honours
 * it: before this, a durable grant satisfied ANY `ask`, so a permit issued for
 * something bounded and repeatable also authorised a destructive act that a
 * human was supposed to look at. Two different safety properties, one weaker
 * check.
 */
import { describe, expect, test } from "bun:test"
import { PolicyToolRunner, ToolRegistry, policy, type Approver, type ToolDefinition } from "../src/index"
import type { ControlRequest } from "@abdo/control-contracts"

const never: Approver = { approve: async () => false }
const always: Approver = { approve: async () => true }

/** A ledger that hands out a permit for anything asked of it. */
const generousGrants = {
  async reserve(_request: ControlRequest) {
    return { reserved: true, grantId: "grant_generous" }
  },
}

function runnerFor(tool: ToolDefinition, options: Record<string, unknown> = {}) {
  const registry = new ToolRegistry().register(tool)
  return new PolicyToolRunner(registry, options as never)
}

const deleteTool: ToolDefinition = {
  name: "shell",
  policy: policy({ risk: "high", requiresApproval: true }),
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
  async run() {
    return { ok: true, output: "deleted" }
  },
}

describe("a permit does not buy what an approval is for", () => {
  test("a destructive command is REFUSED when only a permit was reserved", async () => {
    const runner = runnerFor(deleteTool, { grants: generousGrants })
    const outcome = await runner.run({ name: "shell", input: { command: "rm -rf ./build" } }, { executionId: "tex_1" })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain("denied")
  })

  test("the same command runs when a human approves it", async () => {
    const runner = runnerFor(deleteTool, { approver: always })
    const outcome = await runner.run({ name: "shell", input: { command: "rm -rf ./build" } }, { executionId: "tex_2" })
    expect(outcome.ok).toBe(true)
  })

  test("and is refused when the human says no", async () => {
    const runner = runnerFor(deleteTool, { approver: never })
    const outcome = await runner.run({ name: "shell", input: { command: "rm -rf ./build" } }, { executionId: "tex_3" })
    expect(outcome.ok).toBe(false)
  })
})

describe("a permit still works where a permit is the right thing", () => {
  test("an ordinary high-risk write is satisfied by a reserved grant", async () => {
    const writeTool: ToolDefinition = {
      name: "write_config",
      policy: policy({ risk: "high", requiresApproval: true }),
      async run() {
        return { ok: true, output: "written" }
      },
    }
    const runner = runnerFor(writeTool, { grants: generousGrants })
    const outcome = await runner.run({ name: "write_config", input: { path: "a.json" } }, { executionId: "tex_4" })

    // a workspace write is local_write / credential-free: the permit governs it
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.control?.grantId).toBe("grant_generous")
  })

  test("a read needs neither, and asks for neither", async () => {
    const readTool: ToolDefinition = {
      name: "read_file",
      policy: policy({ risk: "read" }),
      async run() {
        return { ok: true, output: "contents" }
      },
    }
    let asked = false
    const runner = runnerFor(readTool, { approver: { approve: async () => ((asked = true), true) } })
    const outcome = await runner.run({ name: "read_file", input: { path: "a.ts" } }, { executionId: "tex_5" })

    expect(outcome.ok).toBe(true)
    expect(asked).toBe(false)
  })
})
