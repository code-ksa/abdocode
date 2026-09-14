/**
 * CL-11 — the transitional supply-chain gate (fail-closed).
 *
 * `npm ci` is deterministic on the COMMAND, but its safety depends on facts the
 * command cannot show: a custom registry in `.npmrc`, an untrusted `resolved`
 * host or a missing `integrity` in `package-lock.json`, npm config inherited
 * from the user or environment. Those are FILESYSTEM facts, supplied by a
 * host-side verifier that does not exist yet.
 *
 * Until it does, the workspace is `unknown`, and unknown must not auto-allow:
 *
 *   verified -> npm ci + suppression = allow
 *   unknown  -> ask   (the default, so nothing installs unverified)
 *   unsafe   -> ask   (with a distinct reason; per-reason deny is the next slice)
 */
import { describe, expect, test } from "bun:test"
import { CONTROL_CONTRACT_VERSION, type ControlRequest } from "@abdo/control-contracts"
import { assessCall, BuiltinPolicyDecisionPoint, policy } from "../src/index"

const pdp = new BuiltinPolicyDecisionPoint(() => "apr_test")

const requestFor = (command: string, supplyChain?: ControlRequest["workspaceSupplyChain"]): ControlRequest => {
  const { operation, risk, capability, lifecycle, installSource } = assessCall("shell", policy({ risk: "low" }), { command })
  return {
    version: CONTROL_CONTRACT_VERSION,
    sessionId: "s", runId: "r", attemptId: 1, requestId: "q", toolExecutionId: "t",
    actor: { agent: "a", model: "m", provider: "p" },
    tool: "shell", capability,
    target: { kind: "workspace", workspace: "/w" },
    normalizedOperation: operation, risk,
    argsHash: "h", secretRefs: [], provenance: [],
    ...(lifecycle ? { lifecycle } : {}),
    ...(installSource ? { installSource } : {}),
    ...(supplyChain ? { workspaceSupplyChain: supplyChain } : {}),
  }
}
const decide = (command: string, sc?: ControlRequest["workspaceSupplyChain"]) => pdp.decide(requestFor(command, sc))

describe("CL-11.13 the workspace supply chain must be VERIFIED before npm ci allows", () => {
  test("DEFAULT (no verifier yet): `npm ci` is ASK, not allow — unknown never auto-allows", () => {
    const d = decide("npm ci")
    expect(d.action).toBe("ask")
    expect(d.reasonCode).toBe("install_source_not_verified")
  })

  test("an explicit `unknown` verdict is the same — ask", () => {
    expect(decide("npm ci", { status: "unknown" }).action).toBe("ask")
  })

  test("ONLY a `verified` workspace lets `npm ci` reach allow + suppression", () => {
    const d = decide("npm ci", { status: "verified" })
    expect(d.action).toBe("allow")
    if (d.action !== "allow") throw new Error("unreachable")
    expect(d.constraints).toEqual([{ kind: "suppressImplicitLifecycleScripts", value: true, env: { npm_config_ignore_scripts: "true" } }])
  })

  test("an `unsafe` workspace is refused with its OWN reason, even verified-looking commands", () => {
    const d = decide("npm ci", { status: "unsafe", reasons: ["untrusted_resolved_host:evil.example"] })
    expect(d.action).toBe("ask")
    expect(d.reasonCode).toBe("install_supply_chain_unsafe")
  })

  test("a verified workspace does NOT rescue a command-side blocker — npm install still asks", () => {
    // The two gates are independent: a clean workspace cannot make a
    // lockfile-rewriting `npm install` deterministic.
    const d = decide("npm install", { status: "verified" })
    expect(d.action).toBe("ask")
    expect(d.reasonCode).toBe("install_source_not_verified")
  })

  test("a custom registry on the command still asks even with a verified workspace", () => {
    expect(decide("npm ci --registry https://evil.example/", { status: "verified" }).action).toBe("ask")
  })

  test("the gate is install-only — a verified/absent verdict does not change non-installs", () => {
    expect(decide("npm test").action).toBe("allow") // explicit script, unaffected
    expect(decide("git status").action).toBe("allow")
    expect(decide("npm test", { status: "unsafe" }).action).toBe("allow") // not an install
  })
})
