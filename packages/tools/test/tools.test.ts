import { describe, expect, test } from "bun:test"
import {
  classifyCommand,
  containsSecret,
  decide,
  policy,
  PolicyToolRunner,
  redact,
  ToolRegistry,
  type Approver,
  type ToolDefinition,
} from "../src/index"

describe("dangerous-command guard", () => {
  const dangerous = [
    "rm -rf /var/www",
    "sudo rm -fr ~/data",
    "DROP DATABASE production;",
    "psql -c 'drop table users'",
    "systemctl disable nginx",
    "ufw disable",
    "docker system prune -a",
    "reboot now",
    "chown -R root:root /",
    "dd if=/dev/zero of=/dev/sda",
    "git push --force origin main",
  ]
  for (const cmd of dangerous) {
    test(`flags: ${cmd}`, () => expect(classifyCommand(cmd).dangerous).toBe(true))
  }
  const safe = ["ls -la", "git status", "rm file.txt", "systemctl status nginx", "git push --force-with-lease"]
  for (const cmd of safe) {
    test(`allows: ${cmd}`, () => expect(classifyCommand(cmd).dangerous).toBe(false))
  }
})

describe("secret redaction", () => {
  test("redacts known values and common token shapes", () => {
    const text = "token=sk-abcdefghijklmnopqrstuvwxyz key=AKIAIOSFODNN7EXAMPLE pw=hunter2secret"
    const out = redact(text, ["hunter2secret"])
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(out).not.toContain("hunter2secret")
    expect(containsSecret(text, ["hunter2secret"])).toBe(true)
  })
})

describe("policy engine", () => {
  test("read/low auto-allow; high/critical/requiresApproval/dangerous -> ask", () => {
    expect(decide(policy({ risk: "read" }), { dangerous: false }).decision).toBe("allow")
    expect(decide(policy({ risk: "low" }), { dangerous: false }).decision).toBe("allow")
    expect(decide(policy({ risk: "high" }), { dangerous: false }).decision).toBe("ask")
    expect(decide(policy({ risk: "critical" }), { dangerous: false }).decision).toBe("ask")
    expect(decide(policy({ risk: "low", requiresApproval: true }), { dangerous: false }).decision).toBe("ask")
    expect(decide(policy({ risk: "read" }), { dangerous: true }).decision).toBe("ask")
  })
})

// --- runner harness -------------------------------------------------------
const yes: Approver = { approve: async () => true }
const no: Approver = { approve: async () => false }

function echoTool(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "echo",
    policy: policy({ risk: "low" }),
    async run(input) {
      return { ok: true, output: input }
    },
    ...over,
  }
}

describe("PolicyToolRunner — enforcement", () => {
  test("auto-allowed tool runs and output is secret-redacted", async () => {
    const reg = new ToolRegistry().register({
      name: "leaky",
      policy: policy({ risk: "read", secretsAccess: "references" }),
      async run() {
        return { ok: true, output: { log: "connected with sk-abcdefghijklmnopqrstuvwxyz" } }
      },
    })
    const runner = new PolicyToolRunner(reg)
    const r = await runner.run({ name: "leaky", input: {} })
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
  })

  test("critical tool without approver is DENIED (never executes)", async () => {
    let ran = false
    const reg = new ToolRegistry().register({
      name: "deploy",
      policy: policy({ risk: "critical" }),
      async run() {
        ran = true
        return { ok: true, output: "deployed" }
      },
    })
    const r = await new PolicyToolRunner(reg).run({ name: "deploy", input: {} })
    expect(r.ok).toBe(false)
    expect(ran).toBe(false)
  })

  test("critical tool with approval executes", async () => {
    let ran = false
    const reg = new ToolRegistry().register({
      name: "deploy",
      policy: policy({ risk: "critical" }),
      async run() {
        ran = true
        return { ok: true, output: "deployed" }
      },
    })
    const r = await new PolicyToolRunner(reg, { approver: yes }).run({ name: "deploy", input: {} })
    expect(r.ok).toBe(true)
    expect(ran).toBe(true)
  })

  test("dangerous command is gated even when tool risk is low", async () => {
    let ran = false
    const reg = new ToolRegistry().register({
      name: "bash",
      policy: policy({ risk: "low" }),
      async run() {
        ran = true
        return { ok: true, output: "" }
      },
    })
    const denied = await new PolicyToolRunner(reg, { approver: no }).run({
      name: "bash",
      input: { command: "rm -rf /" },
    })
    expect(denied.ok).toBe(false)
    expect(ran).toBe(false)
  })

  test("unknown tool is refused", async () => {
    const r = await new PolicyToolRunner(new ToolRegistry()).run({ name: "ghost", input: {} })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain("unknown_tool")
  })

  test("rollback runs ONLY when the failed call's own mutation started", async () => {
    // Partial failure (mutation started, not committed) => rollback of THIS invocation.
    let rolledBackWith: unknown
    const reg = new ToolRegistry().register({
      name: "migrate",
      policy: policy({ risk: "low", reversible: true }),
      async run(_input, ctx) {
        return {
          ok: false,
          error: "write began then failed",
          mutation: {
            executionId: ctx.executionId ?? "tex_test",
            path: "db/schema",
            beforeHash: "abc",
            mutationStarted: true,
            mutationCommitted: false,
          },
        }
      },
      async rollback(receipt) {
        rolledBackWith = receipt
      },
    })
    const r = await new PolicyToolRunner(reg).run({ name: "migrate", input: {} }, { executionId: "tex_1" })
    expect(r.ok).toBe(false)
    expect((rolledBackWith as { executionId: string }).executionId).toBe("tex_1")
    expect(!r.ok && r.rollback?.status).toBe("completed")
  })

  test("NO rollback on a precondition failure (mutationStarted:false) or a receipt-less failure", async () => {
    // The 2026-07-23 multi-11 incident rule: ok:false alone never compensates.
    let rolledBack = 0
    const reg = new ToolRegistry()
      .register({
        name: "edit_like",
        policy: policy({ risk: "low", reversible: true }),
        async run() {
          return {
            ok: false,
            error: "find text not present",
            mutation: { executionId: "tex_x", path: "f", beforeHash: "h", mutationStarted: false, mutationCommitted: false },
          }
        },
        async rollback() {
          rolledBack++
        },
      })
      .register({
        name: "legacy_fail",
        policy: policy({ risk: "low", reversible: true }),
        async run() {
          return { ok: false, error: "failed with no receipt" }
        },
        async rollback() {
          rolledBack++
        },
      })
    const a = await new PolicyToolRunner(reg).run({ name: "edit_like", input: {} })
    const b = await new PolicyToolRunner(reg).run({ name: "legacy_fail", input: {} })
    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)
    expect(rolledBack).toBe(0)
    expect(!a.ok && a.rollback).toBeUndefined()
    expect(!b.ok && b.rollback).toBeUndefined()
  })

  test("a hung tool is killed by its timeout", async () => {
    const reg = new ToolRegistry().register({
      name: "hang",
      policy: policy({ risk: "low", timeoutMs: 20 }),
      async run() {
        await new Promise((r) => setTimeout(r, 1000))
        return { ok: true, output: "never" }
      },
    })
    const r = await new PolicyToolRunner(reg).run({ name: "hang", input: {} })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain("timed out")
  })

  test("dry-run probe runs before execution when enabled", async () => {
    const order: string[] = []
    const reg = new ToolRegistry().register({
      name: "probe",
      policy: policy({ risk: "low", supportsDryRun: true }),
      async dryRun() {
        order.push("dry")
      },
      async run() {
        order.push("real")
        return { ok: true, output: null }
      },
    })
    await new PolicyToolRunner(reg, { dryRunFirst: true }).run({ name: "probe", input: {} })
    expect(order).toEqual(["dry", "real"])
  })

  test("uses the echo tool helper (sanity)", async () => {
    const reg = new ToolRegistry().register(echoTool())
    const r = await new PolicyToolRunner(reg).run({ name: "echo", input: { hi: 1 } })
    expect(r.ok).toBe(true)
    expect((r as { output: unknown }).output).toEqual({ hi: 1 })
    // CL-01: every outcome carries the decision that produced it.
    expect(r.control).toMatchObject({ version: 3, action: "allow", ruleId: "builtin.auto_allow_low_risk", reasonCode: "auto_allowed_low_risk" })
    expect(r.control!.decisionHash).toMatch(/^[0-9a-f]{64}$/)
  })
})
