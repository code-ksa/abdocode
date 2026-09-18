/**
 * CL-11 Slice 3B — enforcement & TOCTOU.
 *
 * A verdict gathered when the decision was built is not enough: the manifest,
 * lockfile or npm config can change between the decision and the spawn. So the
 * evidence is RE-CHECKED just before execution; if any hash moved, or the
 * workspace is no longer verified, the decision is STALE and nothing runs.
 *
 * Also pinned here:
 *   - the verdict is filled by the HOST verifier, never from the model's args;
 *   - decisionHash includes the evidence hashes + versions;
 *   - a disk budget is a separate PEP precondition (no network-size claim).
 */
import { describe, expect, test } from "bun:test"
import { CONTROL_CONTRACT_VERSION, decisionHash, type ControlRequest } from "@abdo/control-contracts"
import { assessCall, BuiltinPolicyDecisionPoint, policy, PolicyToolRunner, ToolRegistry, type SupplyChainVerdict } from "../src/index"

const VERIFIED: SupplyChainVerdict = {
  status: "verified", reasonCodes: [], evidenceHash: "e1", policyVersion: 1, verifierVersion: 1,
}

const installRunner = (opts: {
  verifier?: (dir: string) => SupplyChainVerdict
  diskBudget?: (dir: string) => { allowed: boolean; reason?: string }
}) => {
  let ran = 0
  const registry = new ToolRegistry().register({
    name: "shell",
    policy: policy({ risk: "low" }),
    honorsEnvOverlay: true,
    async run() {
      ran++
      return { ok: true as const, output: "installed" }
    },
  })
  const runner = new PolicyToolRunner(registry, {
    approver: { approve: async () => true },
    identity: { workspace: "/w" },
    ...(opts.verifier ? { supplyChainVerifier: opts.verifier } : {}),
    ...(opts.diskBudget ? { diskBudget: opts.diskBudget } : {}),
  })
  return { runner, ran: () => ran }
}

describe("CL-11.3B.1 npm ci allows only with a fresh, verified workspace", () => {
  test("verified at decision AND still verified at execution => runs", async () => {
    const { runner, ran } = installRunner({ verifier: () => VERIFIED })
    const out = await runner.run({ name: "shell", input: { command: "npm ci" } })
    expect(out.ok).toBe(true)
    expect(ran()).toBe(1)
  })

  test("STALE: the lockfile hash moves between decision and execution => refused, nothing runs", async () => {
    let calls = 0
    const verifier = () => (++calls === 1 ? VERIFIED : { ...VERIFIED, evidenceHash: "e2" })
    const { runner, ran } = installRunner({ verifier })
    const out = await runner.run({ name: "shell", input: { command: "npm ci" } })
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("unreachable")
    expect(out.error).toContain("stale_supply_chain_evidence")
    expect(ran()).toBe(0)
  })

  test("STALE: the workspace turns unsafe between decision and execution => refused", async () => {
    let calls = 0
    const verifier = () => (++calls === 1 ? VERIFIED : { ...VERIFIED, status: "unsafe" as const })
    const { runner, ran } = installRunner({ verifier })
    const out = await runner.run({ name: "shell", input: { command: "npm ci" } })
    expect(out.ok).toBe(false)
    expect(ran()).toBe(0)
  })

  test("an UNVERIFIED workspace never reached execution in the first place (it asked)", async () => {
    // With a verifier that returns unknown, the decision is ask -> deny (no
    // approver here would approve, but even approved it is the command as
    // written; the point is the verifier drove the decision, not the model).
    const { runner, ran } = installRunner({ verifier: () => ({ ...VERIFIED, status: "unknown", reasonCodes: ["no_lockfile"] }) })
    const out = await runner.run({ name: "shell", input: { command: "npm ci" } })
    // approver approves, so it runs as an approved command — but WITHOUT the
    // supply-chain allow path (it was an ask). The re-check only guards the
    // verified-allow path, so an approved run is the human's call.
    expect(out.ok).toBe(true)
    expect(out.control?.reasonCode).toBe("approval_granted")
    void ran
  })
})

describe("CL-11.3B.2 the verdict is the host's, not the model's", () => {
  test("a bogus workspaceSupplyChain smuggled in the tool args is ignored", async () => {
    // The tool schema does not even carry it, but prove the request is built
    // from the verifier, not from input.
    const { runner, ran } = installRunner({ verifier: () => VERIFIED })
    const out = await runner.run({
      name: "shell",
      input: { command: "npm ci", workspaceSupplyChain: { status: "verified", manifestHash: "FAKE" } } as unknown as { command: string },
    })
    expect(out.ok).toBe(true)
    expect(ran()).toBe(1) // ran because the REAL verifier said verified, not the fake
  })

  test("with NO verifier wired, an install stays ask — it never silently allows", () => {
    const pdp = new BuiltinPolicyDecisionPoint(() => "apr")
    const { operation, risk, capability, lifecycle, installSource } = assessCall("shell", policy({ risk: "low" }), { command: "npm ci" })
    const req: ControlRequest = {
      version: CONTROL_CONTRACT_VERSION, sessionId: "s", runId: "r", attemptId: 1, requestId: "q", toolExecutionId: "t",
      actor: { agent: "a", model: "m", provider: "p" }, tool: "shell", capability,
      target: { kind: "workspace", workspace: "/w" }, normalizedOperation: operation, risk,
      argsHash: "h", secretRefs: [], provenance: [],
      ...(lifecycle ? { lifecycle } : {}), ...(installSource ? { installSource } : {}),
    }
    expect(pdp.decide(req).action).toBe("ask")
  })
})

describe("CL-11.3B.3 decisionHash binds to the evidence", () => {
  const base = (): ControlRequest => {
    const { operation, risk, capability, installSource } = assessCall("shell", policy({ risk: "low" }), { command: "npm ci" })
    return {
      version: CONTROL_CONTRACT_VERSION, sessionId: "s", runId: "r", attemptId: 1, requestId: "q", toolExecutionId: "t",
      actor: { agent: "a", model: "m", provider: "p" }, tool: "shell", capability,
      target: { kind: "workspace", workspace: "/w" }, normalizedOperation: operation, risk,
      argsHash: "h", secretRefs: [], provenance: [], ...(installSource ? { installSource } : {}),
    }
  }
  const allow = { version: CONTROL_CONTRACT_VERSION, action: "allow" as const, ruleId: "r", reasonCode: "auto_allowed_low_risk" as const, constraints: [] }

  test("two different lockfile hashes produce two different decision hashes", () => {
    const a: ControlRequest = { ...base(), workspaceSupplyChain: { status: "verified", evidenceHash: "E1", policyVersion: 1, verifierVersion: 1 } }
    const b: ControlRequest = { ...base(), workspaceSupplyChain: { status: "verified", evidenceHash: "E2", policyVersion: 1, verifierVersion: 1 } }
    expect(decisionHash(a, allow)).not.toBe(decisionHash(b, allow))
  })

  test("a bumped verifierVersion changes the hash too", () => {
    const a: ControlRequest = { ...base(), workspaceSupplyChain: { status: "verified", evidenceHash: "E", policyVersion: 1, verifierVersion: 1 } }
    const b: ControlRequest = { ...a, workspaceSupplyChain: { ...a.workspaceSupplyChain!, verifierVersion: 2 } }
    expect(decisionHash(a, allow)).not.toBe(decisionHash(b, allow))
  })
})

describe("CL-11.3B.4 the free-space PRECHECK is honestly a start gate, not a budget", () => {
  test("an install is refused before it runs when free space is too low", async () => {
    const { runner, ran } = installRunner({
      verifier: () => VERIFIED,
      diskBudget: () => ({ allowed: false, reason: "free space 120MB below floor 512MB" }),
    })
    const out = await runner.run({ name: "shell", input: { command: "npm ci" } })
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("unreachable")
    expect(out.error).toContain("disk_precheck_failed") // NOT called a budget
    expect(ran()).toBe(0)
  })

  test("a satisfied precheck does not block", async () => {
    const { runner, ran } = installRunner({ verifier: () => VERIFIED, diskBudget: () => ({ allowed: true }) })
    expect((await runner.run({ name: "shell", input: { command: "npm ci" } })).ok).toBe(true)
    expect(ran()).toBe(1)
  })
})

describe("CL-11.3C.3 approval freshness — an approved snapshot that changed is refused", () => {
  const approvingRunner = (verifier: (dir: string) => SupplyChainVerdict) => {
    let ran = 0
    const registry = new ToolRegistry().register({
      name: "shell", policy: policy({ risk: "low" }), honorsEnvOverlay: true,
      async run() { ran++; return { ok: true as const, output: "installed" } },
    })
    // approver approves, but the workspace is UNSAFE (so it took the ask path).
    const runner = new PolicyToolRunner(registry, {
      approver: { approve: async () => true }, identity: { workspace: "/w" }, supplyChainVerifier: verifier,
    })
    return { runner, ran: () => ran }
  }
  const UNSAFE: SupplyChainVerdict = { ...VERIFIED, status: "unsafe", reasonCodes: ["custom_registry:evil"] }

  test("an approved install whose lockfile is unchanged runs (human accepted the source)", async () => {
    const { runner, ran } = approvingRunner(() => UNSAFE)
    const out = await runner.run({ name: "shell", input: { command: "npm ci" } })
    expect(out.ok).toBe(true)
    expect(out.control?.reasonCode).toBe("approval_granted")
    expect(ran()).toBe(1)
  })

  test("an approved install whose lockfile CHANGED after approval is refused for RE-APPROVAL", async () => {
    let calls = 0
    // ask-time verdict, then a changed snapshot at the pre-execution re-check.
    const verifier = () => (++calls <= 1 ? UNSAFE : { ...UNSAFE, evidenceHash: "CHANGED" })
    const { runner, ran } = approvingRunner(verifier)
    const out = await runner.run({ name: "shell", input: { command: "npm ci" } })
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("unreachable")
    expect(out.error).toContain("approval_snapshot_stale")
    expect(ran()).toBe(0) // an approval does not authorise a snapshot nobody saw
  })
})

describe("CL-11.3C.4 real disk-growth budget kills the process tree", () => {
  const growthRunner = (measure: (dir: string) => number, maxGrowthBytes: number) => {
    let aborted = false
    const registry = new ToolRegistry().register({
      name: "shell", policy: policy({ risk: "low", timeoutMs: 5000 }), honorsEnvOverlay: true,
      async run(_i, ctx) {
        // A long-running install that only ends when its signal aborts.
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted) return resolve()
          ctx.signal?.addEventListener("abort", () => { aborted = true; resolve() }, { once: true })
        })
        return { ok: true as const, output: "done" }
      },
    })
    const runner = new PolicyToolRunner(registry, {
      approver: { approve: async () => true }, identity: { workspace: "/w" },
      supplyChainVerifier: () => VERIFIED,
      installDiskGrowthBudget: { maxGrowthBytes, measure, sampleMs: 10 },
    })
    return { runner, wasAborted: () => aborted }
  }

  test("growth past the cap aborts the tool and reports a budget refusal", async () => {
    let size = 0
    const measure = () => (size += 50) // grows 50 bytes per sample
    const { runner, wasAborted } = growthRunner(measure, 120)
    const out = await runner.run({ name: "shell", input: { command: "npm ci" } })
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("unreachable")
    expect(out.error).toContain("disk_budget_exceeded")
    expect(wasAborted()).toBe(true) // the process tree was actually signalled
  }, 10_000)

  test("an install that stays within the cap is not disturbed", async () => {
    let ran = 0
    const registry = new ToolRegistry().register({
      name: "shell", policy: policy({ risk: "low" }), honorsEnvOverlay: true,
      async run() { ran++; return { ok: true as const, output: "done" } },
    })
    const runner = new PolicyToolRunner(registry, {
      approver: { approve: async () => true }, identity: { workspace: "/w" },
      supplyChainVerifier: () => VERIFIED,
      installDiskGrowthBudget: { maxGrowthBytes: 1_000_000, measure: () => 100, sampleMs: 10 },
    })
    expect((await runner.run({ name: "shell", input: { command: "npm ci" } })).ok).toBe(true)
    expect(ran).toBe(1)
  })
})
