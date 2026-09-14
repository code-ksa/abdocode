/**
 * Sprint 26 GATE — nothing protected changes without an approved plan, and the
 * fast path is measured rather than judged.
 *
 * The four things the owner named — migrations, deploys, databases, secrets —
 * are refused whatever their size, and refused BEFORE anyone is asked to
 * approve them: asking a human to approve something that should have been
 * planned is asking the wrong question.
 *
 * The fast path exists so the gate is usable. It is bounded by a number that
 * comes from the run's own progress, and every use says so with that number,
 * because an exception nobody can audit becomes the rule.
 */
import { describe, expect, test } from "bun:test"
import { PolicyToolRunner, ToolRegistry, policy, type Approver, type ToolDefinition } from "../src/index"
import { DEFAULT_FAST_PATH, evaluatePlanGate, protectedAspects, PROTECTED_CAPABILITIES } from "@abdo/control-contracts/plangate"

const yes: Approver = { approve: async () => true }

function spy(name: string, risk: "read" | "medium" | "high" = "high") {
  const state = { ran: 0 }
  const tool: ToolDefinition = {
    name,
    policy: policy({ risk, requiresApproval: risk !== "read" }),
    inputSchema: { type: "object", properties: { command: { type: "string" }, path: { type: "string" } }, additionalProperties: true },
    async run() {
      state.ran++
      return { ok: true, output: "done" }
    },
  }
  return { tool, state }
}

/**
 * Runs in the mode that PERMITS the operation, so the plan gate is what is
 * being tested. In BUILD these same operations are refused a layer earlier by
 * the mode — which is the point of having both, and is asserted below.
 */
const run = (
  tool: ToolDefinition,
  input: unknown,
  plan: { approvedPlanId?: string; filesChangedSoFar: number },
  asked = { v: false },
  mode: "BUILD" | "DEPLOY" | "RECOVER" = "DEPLOY",
) =>
  new PolicyToolRunner(new ToolRegistry().register(tool), {
    approver: { approve: async () => ((asked.v = true), true) },
  } as never).run({ name: tool.name, input }, { executionId: "tex_p", mode, plan })

describe("GATE — the protected four need a plan, whatever their size", () => {
  const protectedCases: Array<[string, string]> = [
    ["a migration", "npx prisma migrate deploy"],
    ["another migration dialect", "alembic upgrade head"],
    ["a deploy over ssh", "ssh prod -- systemctl restart api"],
    ["a database write", "psql -c \"update users set role='admin'\""],
  ]

  for (const [name, command] of protectedCases) {
    test(`${name} is refused with no plan, and nobody is asked to approve it`, async () => {
      const { tool, state } = spy("shell")
      const asked = { v: false }
      const outcome = await run(tool, { command }, { filesChangedSoFar: 0 }, asked)

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error).toContain("plan_required")
      expect(state.ran).toBe(0)
      expect(asked.v).toBe(false)
    })
  }

  test("the refusal names what made it protected", async () => {
    const { tool } = spy("shell")
    const outcome = await run(tool, { command: "npx prisma migrate deploy" }, { filesChangedSoFar: 0 })
    if (!outcome.ok) expect(outcome.error).toContain("migration")
  })

  /**
   * The refusal states the ADAPTATION, not just the rule. "An approved plan is
   * required" reads, to an agent, as an instruction to write one — and a plan
   * cannot be minted from inside a run. The correct response is to stop
   * pursuing the operation and carry it in the handover as the blocker, and a
   * failure text that does not say so costs a guess per turn (measured twice
   * on the live ladder before the route-criteria texts learned the same rule).
   */
  test("the refusal tells the agent what to do instead of inviting a plan it cannot make", async () => {
    const { tool } = spy("shell")
    const outcome = await run(tool, { command: "npx prisma migrate deploy" }, { filesChangedSoFar: 0 })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain("no approval available inside this run")
      expect(outcome.error).toContain("record what you needed it for as your blocker")
    }
  })

  test("an approved plan lets the same operation through", async () => {
    const { tool, state } = spy("shell")
    const outcome = await run(tool, { command: "npx prisma migrate deploy" }, { approvedPlanId: "plan_7", filesChangedSoFar: 0 })
    expect(outcome.ok).toBe(true)
    expect(state.ran).toBe(1)
  })

  test("the model cannot assert a plan of its own", async () => {
    const { tool, state } = spy("shell")
    // the plan id is in the TOOL ARGUMENTS, where the runtime never looks
    const outcome = await run(tool, { command: "alembic upgrade head", approvedPlanId: "plan_i_made_up" }, { filesChangedSoFar: 0 })
    expect(outcome.ok).toBe(false)
    expect(state.ran).toBe(0)
  })
})

describe("GATE — the fast path is bounded and audited", () => {
  test("a small local edit passes without a plan", () => {
    const verdict = evaluatePlanGate({
      mutates: true,
      classes: ["local_write"],
      capabilities: ["filesystem.write"],
      filesChangedSoFar: 0,
    })
    expect(verdict.decision).toBe("allow_fast_path")
    expect(verdict.reason).toContain("0/3")
  })

  /**
   * Past the bound a PERSON decides. It used to be a flat refusal, and the live
   * CRM run showed what that costs: the agent had no way to produce the plan it
   * was being asked for — `approvedPlanId` comes from the caller, before the
   * run — so four consecutive edits were refused and the run died on the clock
   * with a two-line route unwritten. A gate nothing can satisfy is the S105
   * failure again.
   */
  test("past the bound a person decides, rather than the run hitting a wall", () => {
    const verdict = evaluatePlanGate({
      mutates: true,
      classes: ["local_write"],
      capabilities: ["filesystem.write"],
      filesChangedSoFar: DEFAULT_FAST_PATH.maxFilesChanged,
    })
    expect(verdict.decision).toBe("ask")
    expect(verdict.reason).toContain("a person decides")
  })

  test("the bound counts files the RUN has changed, not files this call touches", async () => {
    const { tool, state } = spy("write_file", "medium")
    const asked = { v: false }
    const escalated = await run(tool, { path: "a.ts" }, { filesChangedSoFar: 3 }, asked, "BUILD")
    // Asked, and only allowed because somebody said yes.
    expect(asked.v).toBe(true)
    expect(escalated.ok).toBe(true)

    const allowed = await run(tool, { path: "a.ts" }, { filesChangedSoFar: 2 }, { v: false }, "BUILD")
    expect(allowed.ok).toBe(true)
    expect(state.ran).toBe(2)
  })

  /**
   * The escalation may never be looser than the refusal it replaced.
   *
   * With nobody to ask, past the bound is still refused. An unattended run is
   * exactly where a "ask instead of deny" change could quietly become "allow",
   * so it is asserted rather than assumed.
   */
  test("with nobody to ask, past the bound is still refused and nothing runs", async () => {
    const { tool, state } = spy("write_file", "medium")
    const outcome = await new PolicyToolRunner(new ToolRegistry().register(tool), {} as never).run(
      { name: tool.name, input: { path: "a.ts" } },
      { executionId: "tex_p", mode: "BUILD", plan: { filesChangedSoFar: 3 } },
    )
    expect(outcome.ok).toBe(false)
    expect(state.ran).toBe(0)
  })

  test("a read never needs a plan, however much has changed", () => {
    const verdict = evaluatePlanGate({
      mutates: false,
      classes: ["read"],
      capabilities: ["filesystem.read"],
      filesChangedSoFar: 99,
    })
    expect(verdict.decision).toBe("allow")
  })

  test("nothing protected slips through the fast path on size alone", () => {
    for (const capability of PROTECTED_CAPABILITIES) {
      const verdict = evaluatePlanGate({
        mutates: true,
        classes: ["local_write"],
        capabilities: [capability],
        filesChangedSoFar: 0,
      })
      expect(verdict.decision).toBe("deny")
    }
  })

  test("credential use, production writes and destruction are protected as classes, not just as capabilities", () => {
    for (const risky of ["credential_use", "production_write", "destructive", "financial"] as const) {
      const aspects = protectedAspects({ mutates: true, classes: [risky], capabilities: [], filesChangedSoFar: 0 })
      expect(aspects).toContain(risky)
    }
  })
})

describe("the gate is inert where it should be", () => {
  test("no plan context supplied means the runtime is not driving — the gate does not fire", async () => {
    const { tool, state } = spy("shell")
    const outcome = await new PolicyToolRunner(new ToolRegistry().register(tool), { approver: yes } as never).run(
      { name: "shell", input: { command: "npx prisma migrate deploy" } },
      { executionId: "tex_direct", mode: "DEPLOY" },
    )
    // direct callers are not the model; the SessionRuntime always supplies one
    expect(outcome.ok).toBe(true)
    expect(state.ran).toBe(1)
  })
})

describe("two guards, each doing its own job", () => {
  test("the MODE stops a kind of operation; the PLAN GATE stops an unplanned one", async () => {
    const { tool: destructive, state: s1 } = spy("shell")
    // `rm -rf` is destruction on evidence — BUILD excludes the whole kind
    const byMode = await run(destructive, { command: "rm -rf ./dist" }, { filesChangedSoFar: 0 }, { v: false }, "BUILD")
    expect(byMode.ok).toBe(false)
    if (!byMode.ok) expect(byMode.error).toContain("mode_denied")
    expect(s1.ran).toBe(0)

    // a migration is a kind DEPLOY permits — what stops it is having no plan
    const { tool: migration, state: s2 } = spy("shell")
    const byPlan = await run(migration, { command: "npx prisma migrate deploy" }, { filesChangedSoFar: 0 }, { v: false }, "DEPLOY")
    expect(byPlan.ok).toBe(false)
    if (!byPlan.ok) expect(byPlan.error).toContain("plan_required")
    expect(s2.ran).toBe(0)
  })
})
