/**
 * Sprint 28 — the integration decision, on its own.
 *
 * The worktrees are proven against a real repository in the host gate. What is
 * tested here is the judgement that follows them: which claims are entitled to
 * apply, and what happens when two agents disagree about a file.
 */
import { describe, expect, test } from "bun:test"
import type { IntegrationClaim } from "@abdo/contracts/workspace"
import { parseChanged, planIntegration } from "../src/workspaces"

const claim = (id: string, changed: string[], verified = true): IntegrationClaim => ({
  workspaceId: `ws_${id}`,
  agentId: id,
  changed,
  verified,
})

describe("planIntegration", () => {
  test("disjoint verified work integrates in a stable order", () => {
    const plan = planIntegration([claim("beta", ["b.ts"]), claim("alpha", ["a.ts"])])
    expect(plan.decision).toBe("integrate")
    expect(plan.order).toEqual(["ws_alpha", "ws_beta"])
    expect(plan.conflicts).toEqual([])
  })

  test("unverified work never enters the shared tree", () => {
    const plan = planIntegration([claim("alpha", ["a.ts"]), claim("beta", ["b.ts"], false)])
    expect(plan.decision).toBe("integrate")
    expect(plan.order).toEqual(["ws_alpha"])
    expect(plan.refused[0]).toEqual({
      workspaceId: "ws_beta",
      why: "no verification verdict — unverified work does not enter the shared tree",
    })
  })

  test("an unverified claim does not create a conflict it was never going to cause", () => {
    // beta touched the same file, but beta is not being integrated. Reporting
    // that as a conflict would send someone to reconcile two things, one of
    // which is not going anywhere.
    const plan = planIntegration([claim("alpha", ["shared.ts"]), claim("beta", ["shared.ts"], false)])
    expect(plan.decision).toBe("integrate")
    expect(plan.conflicts).toEqual([])
    expect(plan.order).toEqual(["ws_alpha"])
  })

  test("three agents on one file name all three", () => {
    const plan = planIntegration([
      claim("alpha", ["shared.ts"]),
      claim("beta", ["shared.ts", "b.ts"]),
      claim("gamma", ["shared.ts"]),
    ])
    expect(plan.decision).toBe("refuse")
    expect(plan.conflicts).toEqual([{ path: "shared.ts", workspaces: ["ws_alpha", "ws_beta", "ws_gamma"] }])
    // and nothing partial slips through: one disputed file stops the batch
    expect(plan.order).toEqual([])
  })

  test("an agent that changed nothing is refused with the honest reason", () => {
    const plan = planIntegration([claim("alpha", ["a.ts"]), claim("beta", [])])
    expect(plan.decision).toBe("integrate")
    expect(plan.refused[0]!.why).toContain("changed no files")
  })

  test("nothing eligible is a refusal, not an empty success", () => {
    const plan = planIntegration([claim("alpha", ["a.ts"], false)])
    expect(plan.decision).toBe("refuse")
    expect(plan.reason).toContain("nothing was eligible")
  })

  test("no claims at all is refused too", () => {
    expect(planIntegration([]).decision).toBe("refuse")
  })
})

describe("parseChanged", () => {
  test("reads status codes, renames and quoted paths the way git writes them", () => {
    const porcelain = [
      " M src/a.ts",
      "?? src/new/deep.ts",
      "R  src/old.ts -> src/renamed.ts",
      ' M "src/with space.ts"',
      "",
    ].join("\n")
    expect(parseChanged(porcelain)).toEqual([
      "src/a.ts",
      "src/new/deep.ts",
      // the DESTINATION of a rename: that is the path that now exists
      "src/renamed.ts",
      "src/with space.ts",
    ])
  })

  test("an empty tree reports nothing rather than one empty path", () => {
    expect(parseChanged("")).toEqual([])
    expect(parseChanged("\n\n")).toEqual([])
  })
})
