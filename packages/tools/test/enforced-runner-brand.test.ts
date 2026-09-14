/**
 * CL-16A3 MEGA SPRINT 1 §1 — the enforcement brand is granted, not inherent.
 *
 * `RuntimeDeps.tools` accepts only a branded runner, so the brand is the gate on
 * the single seat where a partially-wired enforcement point would do damage. It
 * used to be a FIELD on `PolicyToolRunner`, which meant `new PolicyToolRunner(reg)`
 * — with no identity, no verifier, nothing — was already "enforced" as far as the
 * type system was concerned. That attests to a class name, not to a control
 * plane having been assembled.
 *
 * These tests pin the two halves: a raw construction carries nothing, and the
 * factory refuses a composition whose parts disagree instead of branding it.
 */
import { describe, expect, test } from "bun:test"
import { POLICY_ENFORCED } from "@abdo/control-contracts"
import { createEnforcedToolRunner, PolicyToolRunner } from "../src/runner"
import { ToolRegistry } from "../src/registry"

const registry = () => new ToolRegistry()

describe("the enforcement brand", () => {
  test("a RAW construction is not branded — `new` attests to nothing", () => {
    const raw = new PolicyToolRunner(registry())
    expect(POLICY_ENFORCED in raw).toBe(false)
    // And the compile-time half, measured rather than asserted in prose: with the
    // brand absent, `RuntimeDeps.tools = new PolicyToolRunner(...)` is a type
    // error. Proven by construction — `EnforcedToolRunner = ToolRunner &
    // PolicyEnforced` cannot be satisfied without this symbol.
  })

  test("the factory brands, and the brand is the real symbol", () => {
    const enforced = createEnforcedToolRunner(registry())
    expect(POLICY_ENFORCED in enforced).toBe(true)
    expect(enforced[POLICY_ENFORCED]).toBe(true)
    // It is still the enforcement point itself, not a wrapper that could drop a check.
    expect(enforced).toBeInstanceOf(PolicyToolRunner)
  })

  test("a supply-chain verifier without a workspace is REFUSED, not branded", () => {
    // The verifier reads the filesystem relative to the workspace. With none it
    // would verify ".", and the decision would then carry evidence about the
    // wrong directory — which is worse than carrying none, because it looks real.
    expect(() => createEnforcedToolRunner(registry(), { supplyChainVerifier: () => ({ status: "verified" as const, evidenceHash: "x", policyVersion: 1, verifierVersion: 1 }) })).toThrow(/enforced_runner_incomplete/)
  })

  test("a disk-growth budget without a workspace is REFUSED", () => {
    expect(() => createEnforcedToolRunner(registry(), { installDiskGrowthBudget: { maxGrowthBytes: 1, measure: () => 0 } })).toThrow(/enforced_runner_incomplete/)
  })

  test("the same options WITH a workspace are accepted — fail-closed is not fail-always", () => {
    const enforced = createEnforcedToolRunner(registry(), {
      identity: { workspace: "/ws" },
      supplyChainVerifier: () => ({ status: "verified" as const, evidenceHash: "x", policyVersion: 1, verifierVersion: 1 }),
      installDiskGrowthBudget: { maxGrowthBytes: 1, measure: () => 0 },
    })
    expect(POLICY_ENFORCED in enforced).toBe(true)
  })
})
