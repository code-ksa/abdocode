/**
 * Semantic Strategy Guard — the SECOND, independent layer above the
 * repeated-identical-call block.
 *
 * The repeat guard keys on `workspaceGeneration`, which is correct: a real edit
 * between two identical commands is a real state change. But an expensive
 * STRATEGY does not depend on the project as a whole — a dependency reinstall
 * depends only on the dependency state. That is the loop the generation key
 * cannot see:
 *
 *     npm install ok -> edit tsconfig -> npm install -> edit jest.config -> npm install
 *
 * Every install above is a different repeat-guard key and the SAME strategy key.
 * These tests exercise the runtime mechanism with an injected policy; the real
 * dependency policy (manifests, lockfiles, package-manager discovery) is tested
 * over a real filesystem in @abdo/host.
 */
import { describe, expect, test } from "bun:test"
import { unenforcedToolRunner } from "@abdo/control-contracts"
import { MemoryEventStore } from "@abdo/event-store"
import {
  EventTypes,
  SessionRuntime,
  type ExpensiveStrategy,
  type ModelClient,
  type ModelInput,
  type ModelTurn,
  type RunLiveness,
  type StrategyPolicy,
} from "../src/index"

function scriptedModel(turns: ModelTurn[]): ModelClient {
  let i = 0
  return {
    async call(_input: ModelInput): Promise<ModelTurn> {
      const t = turns[Math.min(i, turns.length - 1)]!
      i++
      return t
    },
  }
}

const shellCall = (command: string): ModelTurn => ({ kind: "tools", calls: [{ id: "c", name: "shell", input: { command } }] })
const editCall = (path: string): ModelTurn => ({ kind: "tools", calls: [{ id: "c", name: "edit_file", input: { path } }] })
const final = (text: string): ModelTurn => ({ kind: "final", text })

interface ToolOutcomeShape { ok: boolean; output?: unknown; error?: string; resultFingerprint?: string; mutation?: unknown }
function scriptedRunner(handler: (call: { name: string; input: unknown }, n: number) => ToolOutcomeShape) {
  const r = {
    invocations: 0,
    commands: [] as string[],
    /** Optional hook: lets a test move the world's state on a file edit. */
    onEdit: undefined as (() => void) | undefined,
    async run(call: { name: string; input: unknown }) {
      r.invocations++
      const cmd = (call.input as { command?: string }).command
      if (cmd) r.commands.push(cmd)
      if (call.name === "edit_file" || call.name === "write_file") r.onEdit?.()
      return handler(call, r.invocations) as never
    },
  }
  return unenforcedToolRunner(r, "test fake")
}

/**
 * A stand-in dependency policy: every install-looking command is one strategy,
 * and `state()` is the hash the host computes from manifests/lockfiles. Tests
 * move `state` to simulate a real dependency change; edits to other files leave
 * it alone (exactly as the real hash behaves).
 */
function installPolicy(state: () => string, advisory?: string, scopeOf?: (command: string) => string): StrategyPolicy {
  return {
    classify({ tool, args }): ExpensiveStrategy | undefined {
      if (tool !== "shell") return undefined
      const command = String((args as { command?: string }).command ?? "")
      if (!/\b(npm|bun|pnpm|yarn)\s+(install|i|ci|add)\b/.test(command)) return undefined
      return {
        strategy: "dependency_reinstall",
        scope: scopeOf?.(command) ?? "",
        semanticStateHash: state(),
        ...(advisory ? { advisory } : {}),
      }
    },
  }
}

const committedEdit = (path: string) => ({
  ok: true as const,
  output: { replaced: 1 },
  mutation: { executionId: "x", path, beforeHash: "h", mutationStarted: true, mutationCommitted: true },
})

const strategyBlocks = async (store: MemoryEventStore, ses: string) =>
  (await store.read("session", ses)).filter((e) => e.type === EventTypes.ToolRedundantStrategyBlocked)

describe("semantic strategy guard", () => {
  test("S1 install succeeds, an UNRELATED edit bumps the generation, the reinstall is still BLOCKED", async () => {
    // The exact live loop. The repeat guard would (correctly, by its own rule)
    // re-allow the second install because a real file changed; the strategy
    // guard refuses it because the dependency state did not.
    const store = new MemoryEventStore()
    const runner = scriptedRunner((call) =>
      call.name === "edit_file" ? committedEdit("tsconfig.json") : { ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" },
    )
    const model = scriptedModel([
      shellCall("npm install"),
      editCall("tsconfig.json"),
      shellCall("rm -rf node_modules && npm install"), // different args, SAME strategy
      final("stopped reinstalling"),
    ])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: installPolicy(() => "DEP_STATE_A") })
    await runtime.admit("ses_s1", "make the tests run")
    const r = await runtime.run("ses_s1")

    expect(r.state).toBe("completed")
    expect(runner.commands).toEqual(["npm install"]) // the second install never spawned
    const blocked = await strategyBlocks(store, "ses_s1")
    expect(blocked).toHaveLength(1)
    const d = blocked[0]!.data as { error: { code: string; strategy: string }; reason: string; successes: number }
    expect(d.error.code).toBe("redundant_expensive_strategy")
    expect(d.error.strategy).toBe("dependency_reinstall")
    expect(d.reason).toBe("already_succeeded")
    expect(d.successes).toBe(1)
  })

  test("S2 a REAL dependency-state change re-allows the install", async () => {
    const store = new MemoryEventStore()
    let state = "DEP_STATE_A"
    const runner = scriptedRunner((call) => {
      if (call.name === "edit_file") {
        state = "DEP_STATE_B" // the edit touched package.json dependencies
        return committedEdit("package.json")
      }
      return { ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }
    })
    const model = scriptedModel([shellCall("npm install"), editCall("package.json"), shellCall("npm install"), final("done")])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: installPolicy(() => state) })
    await runtime.admit("ses_s2", "add a dependency")
    const r = await runtime.run("ses_s2")

    expect(r.state).toBe("completed")
    expect(runner.commands).toEqual(["npm install", "npm install"]) // both ran — a legitimate reinstall is untouched
    expect(await strategyBlocks(store, "ses_s2")).toHaveLength(0)
  })

  test("S3 one retry after a failure is allowed; the third blind attempt is blocked", async () => {
    const store = new MemoryEventStore()
    let n = 0
    // Different failures each time, so the identical-result guard cannot fire —
    // only the strategy ledger bounds this.
    const runner = scriptedRunner(() => ({ ok: false, error: "network flake", resultFingerprint: `FP${n++}` }))
    const model = scriptedModel([shellCall("npm install"), shellCall("npm install"), shellCall("npm install"), final("install unavailable — reported")])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: installPolicy(() => "DEP_STATE_A") })
    await runtime.admit("ses_s3", "install deps")
    const r = await runtime.run("ses_s3")

    expect(r.state).toBe("completed")
    expect(runner.invocations).toBe(2) // first + one informed retry
    const blocked = await strategyBlocks(store, "ses_s3")
    expect(blocked).toHaveLength(1)
    expect((blocked[0]!.data as { reason: string }).reason).toBe("repeated_failure")
  })

  test("S4 a block is NOT a tool execution: no started/executed pair, no process, no side effect", async () => {
    const store = new MemoryEventStore()
    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const model = scriptedModel([shellCall("npm install"), shellCall("npm install"), final("done")])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: installPolicy(() => "S") })
    await runtime.admit("ses_s4", "install")
    await runtime.run("ses_s4")

    const events = await store.read("session", "ses_s4")
    expect(events.filter((e) => e.type === EventTypes.ToolStarted)).toHaveLength(1)
    expect(events.filter((e) => e.type === EventTypes.ToolExecuted)).toHaveLength(1)
    expect(await strategyBlocks(store, "ses_s4")).toHaveLength(1)
    expect(runner.invocations).toBe(1)
    // The blocked event carries exactly one structured error the model can act on.
    const d = (await strategyBlocks(store, "ses_s4"))[0]!.data as { error: { message: string } }
    expect(d.error.message).toContain("dependency_reinstall")
  })

  test("S5 unclassified calls are untouched — this is not a general shell ban", async () => {
    const store = new MemoryEventStore()
    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: `t${Math.random()}` }))
    const model = scriptedModel([shellCall("bun test"), shellCall("bun test"), shellCall("bun test"), final("tests run")])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: installPolicy(() => "S") })
    await runtime.admit("ses_s5", "run the tests")
    const r = await runtime.run("ses_s5")

    expect(r.state).toBe("completed")
    expect(runner.invocations).toBe(3) // `bun test` is not an install — never guarded
    expect(await strategyBlocks(store, "ses_s5")).toHaveLength(0)
  })

  test("S6 the advisory rides on the tool's OWN result — exactly one result per call", async () => {
    const store = new MemoryEventStore()
    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const model = scriptedModel([shellCall("npm install"), final("done")])
    const runtime = new SessionRuntime({
      store,
      model,
      tools: runner,
      strategy: installPolicy(() => "S", "note: this project uses bun, not npm."),
    })
    await runtime.admit("ses_s6", "install")
    await runtime.run("ses_s6")

    const executed = (await store.read("session", "ses_s6")).filter((e) => e.type === EventTypes.ToolExecuted)
    expect(executed).toHaveLength(1)
    const d = executed[0]!.data as { advisory?: string; strategy?: string }
    expect(d.advisory).toContain("uses bun")
    expect(d.strategy).toBe("dependency_reinstall")
  })

  test("S7 crash/restart rebuilds the strategy ledger from the log — the resumed install is blocked", async () => {
    const store = new MemoryEventStore()
    const ses = "ses_s7"
    const runId = "run_s7"
    const seed = async (type: string, data: Record<string, unknown>) =>
      store.append({ aggregateKind: "session", aggregateId: ses, type, data: { runId, ...data } })
    // A prior SUCCESSFUL install at dependency state DEP_A, then the process died.
    await seed(EventTypes.ToolStarted, { tool: "shell", argsHash: "h1", toolExecutionId: "t1", strategy: "dependency_reinstall", semanticStateHash: "DEP_A" })
    await seed(EventTypes.ToolExecuted, { toolExecutionId: "t1", tool: "shell", ok: true, resultHash: "npm-ok" })

    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    // Different args this time — same strategy, same state: still blocked.
    const model = scriptedModel([shellCall("rm -rf node_modules && npm ci"), final("did not reinstall")])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: installPolicy(() => "DEP_A") })
    const r = await runtime.continueRun(ses, { runId, attempt: 2, fromState: "executing_tool", fromTurn: 2 })

    expect(r.state).toBe("completed")
    expect(runner.invocations).toBe(0) // the rebuilt ledger blocked it — no spawn after restart
    expect(await strategyBlocks(store, ses)).toHaveLength(1)
  })

  test("S8 the classification is REPLAYED from the log, not recomputed against today's files", async () => {
    // On resume the policy would hash the CURRENT dependency state; the prior
    // attempt happened at a different one. Keying the rebuild on the recorded
    // hash keeps history in the right bucket, so a genuine change since the
    // crash re-allows the install instead of blocking it forever.
    const store = new MemoryEventStore()
    const ses = "ses_s8"
    const runId = "run_s8"
    const seed = async (type: string, data: Record<string, unknown>) =>
      store.append({ aggregateKind: "session", aggregateId: ses, type, data: { runId, ...data } })
    await seed(EventTypes.ToolStarted, { tool: "shell", argsHash: "h1", toolExecutionId: "t1", strategy: "dependency_reinstall", semanticStateHash: "DEP_OLD" })
    await seed(EventTypes.ToolExecuted, { toolExecutionId: "t1", tool: "shell", ok: true, resultHash: "npm-ok" })

    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const model = scriptedModel([shellCall("npm install"), final("installed the new dependency")])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: installPolicy(() => "DEP_NEW") })
    const r = await runtime.continueRun(ses, { runId, attempt: 2, fromState: "executing_tool", fromTurn: 2 })

    expect(r.state).toBe("completed")
    expect(runner.invocations).toBe(1) // dependencies really changed -> allowed
    expect(await strategyBlocks(store, ses)).toHaveLength(0)
  })

  test("S10 SCOPE is part of the key: the same strategy at two package roots never collides", async () => {
    const store = new MemoryEventStore()
    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    // One dependency state, two scopes: frontend, backend, then frontend again.
    const scopeOf = (c: string) => (c.includes("frontend") ? "packages/frontend" : "packages/backend")
    const model = scriptedModel([
      shellCall("cd packages/frontend && npm install"),
      shellCall("cd packages/backend && npm install"),
      shellCall("cd packages/frontend && npm install"),
      final("done"),
    ])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: installPolicy(() => "SAME", undefined, scopeOf) })
    await runtime.admit("ses_s10", "install both packages")
    const r = await runtime.run("ses_s10")

    expect(r.state).toBe("completed")
    expect(runner.invocations).toBe(2) // both packages ran; only the frontend REPEAT was refused
    const blocked = await strategyBlocks(store, "ses_s10")
    expect(blocked).toHaveLength(1)
    expect((blocked[0]!.data as { scope: string }).scope).toBe("packages/frontend")
  })

  test("S11 resume rebuilds the ledger WITH the package scope — blocked exactly where it was", async () => {
    const store = new MemoryEventStore()
    const ses = "ses_s11"
    const runId = "run_s11"
    const seed = async (type: string, data: Record<string, unknown>) =>
      store.append({ aggregateKind: "session", aggregateId: ses, type, data: { runId, ...data } })
    // Before the crash: frontend installed successfully at state DEP_A.
    await seed(EventTypes.ToolStarted, { tool: "shell", argsHash: "h1", toolExecutionId: "t1", strategy: "dependency_reinstall", scope: "packages/frontend", semanticStateHash: "DEP_A" })
    await seed(EventTypes.ToolExecuted, { toolExecutionId: "t1", tool: "shell", ok: true, resultHash: "npm-ok" })

    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const scopeOf = (c: string) => (c.includes("frontend") ? "packages/frontend" : "packages/backend")
    // After the restart: backend is still allowed, frontend is still blocked.
    const model = scriptedModel([
      shellCall("cd packages/backend && npm install"),
      shellCall("cd packages/frontend && npm install"),
      final("done"),
    ])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: installPolicy(() => "DEP_A", undefined, scopeOf) })
    const r = await runtime.continueRun(ses, { runId, attempt: 2, fromState: "executing_tool", fromTurn: 2 })

    expect(r.state).toBe("completed")
    expect(runner.invocations).toBe(1) // only backend
    const blocked = await strategyBlocks(store, ses)
    expect(blocked).toHaveLength(1)
    expect((blocked[0]!.data as { scope: string }).scope).toBe("packages/frontend")
  })

  test("S12 an explicit authorization runs the refused strategy ONCE and is always logged", async () => {
    const store = new MemoryEventStore()
    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    let grants = 1
    const strategy: StrategyPolicy = {
      ...installPolicy(() => "S"),
      authorizeRetry: () => (grants-- > 0 ? { granted: true, reason: "explicit user request, one-shot" } : { granted: false }),
    }
    const model = scriptedModel([shellCall("npm install"), shellCall("npm install"), shellCall("npm install"), final("done")])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy })
    await runtime.admit("ses_s12", "reinstall anyway, node_modules is corrupted")
    await runtime.run("ses_s12")

    const events = await store.read("session", "ses_s12")
    expect(runner.invocations).toBe(2) // first + the single authorized retry
    expect(events.filter((e) => e.type === EventTypes.ToolStrategyOverrideGranted)).toHaveLength(1)
    expect(await strategyBlocks(store, "ses_s12")).toHaveLength(1) // the guard is back in force
  })

  test("S13 a throwing authorizer DENIES — a broken override never opens the guard", async () => {
    const store = new MemoryEventStore()
    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const strategy: StrategyPolicy = {
      ...installPolicy(() => "S"),
      authorizeRetry: () => {
        throw new Error("approver unreachable")
      },
    }
    const model = scriptedModel([shellCall("npm install"), shellCall("npm install"), final("done")])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy })
    await runtime.admit("ses_s13", "install")
    await runtime.run("ses_s13")

    expect(runner.invocations).toBe(1)
    expect(await strategyBlocks(store, "ses_s13")).toHaveLength(1)
  })

  test("S14 a state the run PRODUCED ITSELF is not new information — the self-reopening hole", async () => {
    // Measured 2026-07-23: a real `npm install` regenerates package-lock.json
    // (35 -> 603 bytes), so the pre-state of the NEXT install differs and the
    // strategy re-opened itself every time. The guard could never fire.
    const store = new MemoryEventStore()
    const runner = scriptedRunner((call) =>
      call.name === "edit_file"
        ? committedEdit("tsconfig.json")
        : { ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" },
    )
    let state = "DEP_A"
    const strategy: StrategyPolicy = {
      classify({ tool, args }) {
        if (tool !== "shell") return undefined
        if (!/npm (install|ci)/.test(String((args as { command?: string }).command ?? ""))) return undefined
        return { strategy: "dependency_reinstall", scope: "", semanticStateHash: state }
      },
      // The install rewrites its own lockfile: the state moves, by its own hand.
      observeState() {
        state = "DEP_A_AFTER_INSTALL"
        return state
      },
    }
    const model = scriptedModel([
      shellCall("npm install"),
      editCall("tsconfig.json"), // unrelated edit, bumps the workspace generation
      shellCall("rm -rf node_modules && npm install"),
      final("stopped"),
    ])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy })
    await runtime.admit("ses_s14", "make the tests run")
    const r = await runtime.run("ses_s14")

    expect(r.state).toBe("completed")
    expect(runner.commands).toEqual(["npm install"]) // the reinstall never spawned
    const blocked = await strategyBlocks(store, "ses_s14")
    expect(blocked).toHaveLength(1)
    expect((blocked[0]!.data as { reason: string }).reason).toBe("state_produced_by_prior_run")
  })

  test("S15 a state the WORLD changed still re-allows the strategy", async () => {
    const store = new MemoryEventStore()
    const runner = scriptedRunner((call) =>
      call.name === "edit_file" ? committedEdit("package.json") : { ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" },
    )
    let state = "DEP_A"
    const strategy: StrategyPolicy = {
      classify({ tool, args }) {
        if (tool !== "shell" || !/npm install/.test(String((args as { command?: string }).command ?? ""))) return undefined
        return { strategy: "dependency_reinstall", scope: "", semanticStateHash: state }
      },
      observeState: () => (state = "DEP_A_AFTER_INSTALL"),
    }
    const model = scriptedModel([shellCall("npm install"), editCall("package.json"), shellCall("npm install"), final("done")])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy })
    await runtime.admit("ses_s15", "add a dependency")
    // The edit changes the dependency state for real — a state NOBODY's install produced.
    runner.onEdit = () => {
      state = "DEP_B"
    }
    const r = await runtime.run("ses_s15")

    expect(r.state).toBe("completed")
    expect(runner.commands).toEqual(["npm install", "npm install"]) // both ran
    expect(await strategyBlocks(store, "ses_s15")).toHaveLength(0)
  })

  test("S16 resume replays the self-produced state from the log, not from today's files", async () => {
    const store = new MemoryEventStore()
    const ses = "ses_s16"
    const runId = "run_s16"
    const seed = async (type: string, data: Record<string, unknown>) =>
      store.append({ aggregateKind: "session", aggregateId: ses, type, data: { runId, ...data } })
    await seed(EventTypes.ToolStarted, { tool: "shell", argsHash: "h1", toolExecutionId: "t1", strategy: "dependency_reinstall", scope: "", semanticStateHash: "DEP_A" })
    await seed(EventTypes.ToolExecuted, { toolExecutionId: "t1", tool: "shell", ok: true, resultHash: "npm-ok", postSemanticStateHash: "DEP_A_AFTER" })

    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    // After the crash the workspace sits at the post-install state.
    const strategy: StrategyPolicy = {
      classify({ tool }) {
        return tool === "shell" ? { strategy: "dependency_reinstall", scope: "", semanticStateHash: "DEP_A_AFTER" } : undefined
      },
    }
    const model = scriptedModel([shellCall("npm install"), final("did not reinstall")])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy })
    const r = await runtime.continueRun(ses, { runId, attempt: 2, fromState: "executing_tool", fromTurn: 2 })

    expect(r.state).toBe("completed")
    expect(runner.invocations).toBe(0) // the rebuilt ledger knows this state was self-produced
    expect(await strategyBlocks(store, ses)).toHaveLength(1)
  })

  /**
   * A fetch-shaped policy: the state is the DESTINATION's digest, so it is
   * "missing" before the first fetch, the artifact's digest after it, and
   * "missing" again once the file is deleted. That return to an earlier value is
   * the whole point — a value-keyed ledger cannot tell it apart from never
   * having moved, and would refuse a fetch that genuinely must run.
   */
  function fetchPolicy(state: () => string): StrategyPolicy {
    return {
      classify({ tool, args }) {
        if (tool !== "shell" || !/curl/.test(String((args as { command?: string }).command ?? ""))) return undefined
        return { strategy: "resource_fetch", scope: "|url:https://example.com/pkg-1.2.3.tgz", semanticStateHash: state() }
      },
      observeState: () => state(),
    }
  }

  test("S17 THE SEQUENCE: missing -> fetch ok -> digest -> BLOCKED -> delete -> missing again -> ALLOWED", async () => {
    // The bug this fixes: after the delete the destination's hash is byte-for-byte
    // the hash of the first attempt, and the ledger refused the fetch because
    // "that state already succeeded" — a state that no longer exists. Deleting a
    // downloaded file is exactly the case where re-fetching is the right move.
    const store = new MemoryEventStore()
    let destination = "MISSING"
    const runner = scriptedRunner((call) => {
      const cmd = String((call.input as { command?: string }).command ?? "")
      if (cmd.includes("curl")) destination = "DIGEST_V1" // the fetch writes its artifact
      if (cmd.includes("rm ")) destination = "MISSING" // ...and the delete removes it
      return { ok: true, output: { exitCode: 0 }, resultFingerprint: `fp-${cmd}` }
    })
    const model = scriptedModel([
      shellCall("curl -o dep.tgz https://example.com/pkg-1.2.3.tgz"), // missing -> allowed
      shellCall("curl -o dep.tgz https://example.com/pkg-1.2.3.tgz"), // digest  -> BLOCKED
      shellCall("rm -f dep.tgz"), // not a fetch: never classified, always runs
      shellCall("curl -o dep.tgz https://example.com/pkg-1.2.3.tgz"), // missing in a NEW epoch -> allowed
      final("fetched, then re-fetched after the file was removed"),
    ])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: fetchPolicy(() => destination) })
    await runtime.admit("ses_s17", "download the pinned dependency")
    const r = await runtime.run("ses_s17")

    expect(r.state).toBe("completed")
    const fetches = runner.commands.filter((c) => c.includes("curl"))
    expect(fetches).toHaveLength(2) // the redundant one refused, the needed one allowed
    const blocked = await strategyBlocks(store, "ses_s17")
    expect(blocked).toHaveLength(1)
    const d = blocked[0]!.data as { reason: string; semanticStateHash: string; stateEpoch: number }
    // Refused because the fetch itself produced that state — not because the
    // hash was "seen before", which is what would also condemn the re-fetch.
    expect(d.reason).toBe("state_produced_by_prior_run")
    expect(d.semanticStateHash).toBe("DIGEST_V1")
    expect(d.stateEpoch).toBe(0)
    // The two executions sit in DIFFERENT epochs at the SAME hash: that is the
    // transition the ledger now records. The epoch counts changes the WORLD
    // made — the fetch's own post-state is not one of them — so the delete is
    // the single bump here.
    const started = (await store.read("session", "ses_s17"))
      .filter((e) => e.type === EventTypes.ToolStarted)
      .map((e) => e.data as { strategy?: string; semanticStateHash?: string; stateEpoch?: number })
      .filter((x) => x.strategy === "resource_fetch")
    expect(started.map((x) => x.semanticStateHash)).toEqual(["MISSING", "MISSING"])
    expect(started.map((x) => x.stateEpoch)).toEqual([0, 1])
  })

  test("S18 the re-allowed fetch is guarded AGAIN in its new epoch — one success per epoch, not a free pass", async () => {
    // An epoch bump must not be an escape hatch: it re-opens the strategy once,
    // and the ordinary rules apply immediately inside the new epoch.
    const store = new MemoryEventStore()
    let destination = "MISSING"
    const runner = scriptedRunner((call) => {
      const cmd = String((call.input as { command?: string }).command ?? "")
      if (cmd.includes("curl")) destination = "DIGEST_V1"
      if (cmd.includes("rm ")) destination = "MISSING"
      return { ok: true, output: { exitCode: 0 }, resultFingerprint: `fp-${cmd}` }
    })
    const model = scriptedModel([
      shellCall("curl -o dep.tgz https://example.com/pkg-1.2.3.tgz"),
      shellCall("rm -f dep.tgz"),
      shellCall("curl -o dep.tgz https://example.com/pkg-1.2.3.tgz"), // new epoch, allowed
      shellCall("curl -o dep.tgz https://example.com/pkg-1.2.3.tgz"), // still redundant
      final("done"),
    ])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: fetchPolicy(() => destination) })
    await runtime.admit("ses_s18", "download it")
    await runtime.run("ses_s18")

    expect(runner.commands.filter((c) => c.includes("curl"))).toHaveLength(2)
    const blocked = await strategyBlocks(store, "ses_s18")
    expect(blocked).toHaveLength(1)
    expect((blocked[0]!.data as { stateEpoch: number }).stateEpoch).toBe(1) // refused INSIDE the new epoch
  })

  test("S19 an unrelated edit still does NOT re-allow the fetch — the guard did not simply get looser", async () => {
    const store = new MemoryEventStore()
    let destination = "MISSING"
    const runner = scriptedRunner((call) => {
      if (call.name === "edit_file") return committedEdit("src/a.ts")
      destination = "DIGEST_V1"
      return { ok: true, output: { exitCode: 0 }, resultFingerprint: "fp" }
    })
    const model = scriptedModel([
      shellCall("curl -o dep.tgz https://example.com/pkg-1.2.3.tgz"),
      editCall("src/a.ts"), // touches nothing the fetch depends on
      shellCall("curl -o dep.tgz https://example.com/pkg-1.2.3.tgz"),
      final("stopped"),
    ])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: fetchPolicy(() => destination) })
    await runtime.admit("ses_s19", "download it")
    await runtime.run("ses_s19")

    expect(runner.commands.filter((c) => c.includes("curl"))).toHaveLength(1)
    expect(await strategyBlocks(store, "ses_s19")).toHaveLength(1)
  })

  test("S20 RESTART: the epoch is rebuilt from the log — the deletion that happened before the crash still re-allows", async () => {
    // The transition happened in the run that died. Nothing recomputes it: the
    // epoch is replayed from the recorded pre- and post-states, so the resumed
    // run knows the destination was created and then removed.
    const store = new MemoryEventStore()
    const ses = "ses_s20"
    const runId = "run_s20"
    const seed = async (type: string, data: Record<string, unknown>) =>
      store.append({ aggregateKind: "session", aggregateId: ses, type, data: { runId, ...data } })
    const SCOPE = "|url:https://example.com/pkg-1.2.3.tgz"
    // Before the crash: fetched at MISSING, left DIGEST_V1 behind.
    await seed(EventTypes.ToolStarted, { tool: "shell", argsHash: "h1", toolExecutionId: "t1", strategy: "resource_fetch", scope: SCOPE, semanticStateHash: "MISSING", stateEpoch: 0 })
    await seed(EventTypes.ToolExecuted, { toolExecutionId: "t1", tool: "shell", ok: true, resultHash: "fp", postSemanticStateHash: "DIGEST_V1" })

    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "fp" }))
    const model = scriptedModel([shellCall("curl -o dep.tgz https://example.com/pkg-1.2.3.tgz"), final("re-fetched")])
    // The file was deleted while the process was down: the destination is MISSING again.
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: fetchPolicy(() => "MISSING") })
    const r = await runtime.continueRun(ses, { runId, attempt: 2, fromState: "executing_tool", fromTurn: 2 })

    expect(r.state).toBe("completed")
    expect(runner.invocations).toBe(1) // allowed after the restart, in a new epoch
    expect(await strategyBlocks(store, ses)).toHaveLength(0)
    const started = (await store.read("session", ses))
      .filter((e) => e.type === EventTypes.ToolStarted)
      .map((e) => e.data as { toolExecutionId: string; stateEpoch?: number })
    expect(started.at(-1)!.stateEpoch).toBe(1) // rebuilt: MISSING -> DIGEST_V1 -> MISSING
  })

  test("S21 RESTART: the post-state still blocks — a rebuilt epoch does not forgive a redundant strategy", async () => {
    // The mirror of S20 and the guard against "fix the delete by re-allowing
    // everything": same seeded history, but the artifact is STILL there.
    const store = new MemoryEventStore()
    const ses = "ses_s21"
    const runId = "run_s21"
    const seed = async (type: string, data: Record<string, unknown>) =>
      store.append({ aggregateKind: "session", aggregateId: ses, type, data: { runId, ...data } })
    const SCOPE = "|url:https://example.com/pkg-1.2.3.tgz"
    await seed(EventTypes.ToolStarted, { tool: "shell", argsHash: "h1", toolExecutionId: "t1", strategy: "resource_fetch", scope: SCOPE, semanticStateHash: "MISSING", stateEpoch: 0 })
    await seed(EventTypes.ToolExecuted, { toolExecutionId: "t1", tool: "shell", ok: true, resultHash: "fp", postSemanticStateHash: "DIGEST_V1" })

    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "fp" }))
    const model = scriptedModel([shellCall("curl -o dep.tgz https://example.com/pkg-1.2.3.tgz"), final("used the copy I have")])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: fetchPolicy(() => "DIGEST_V1") })
    const r = await runtime.continueRun(ses, { runId, attempt: 2, fromState: "executing_tool", fromTurn: 2 })

    expect(r.state).toBe("completed")
    expect(runner.invocations).toBe(0)
    const blocked = await strategyBlocks(store, ses)
    expect(blocked).toHaveLength(1)
    expect((blocked[0]!.data as { reason: string }).reason).toBe("state_produced_by_prior_run")
  })

  test("S22 RESTART: a multi-step history replays to the RIGHT epoch, counts and all", async () => {
    // Two epochs and a failure before the crash. The rebuild must land the
    // failure in the epoch it happened in, or the resumed run either blocks a
    // first attempt or grants a third one.
    const store = new MemoryEventStore()
    const ses = "ses_s22"
    const runId = "run_s22"
    const seed = async (type: string, data: Record<string, unknown>) =>
      store.append({ aggregateKind: "session", aggregateId: ses, type, data: { runId, ...data } })
    // epoch 0: install at DEP_A fails once.
    await seed(EventTypes.ToolStarted, { tool: "shell", argsHash: "h1", toolExecutionId: "t1", strategy: "dependency_reinstall", scope: "", semanticStateHash: "DEP_A", stateEpoch: 0 })
    await seed(EventTypes.ToolExecuted, { toolExecutionId: "t1", tool: "shell", ok: false, resultHash: "ERR1" })
    // the world moves to DEP_B (epoch 1), where it fails twice — that is spent.
    await seed(EventTypes.ToolStarted, { tool: "shell", argsHash: "h2", toolExecutionId: "t2", strategy: "dependency_reinstall", scope: "", semanticStateHash: "DEP_B", stateEpoch: 1 })
    await seed(EventTypes.ToolExecuted, { toolExecutionId: "t2", tool: "shell", ok: false, resultHash: "ERR2" })
    await seed(EventTypes.ToolStarted, { tool: "shell", argsHash: "h3", toolExecutionId: "t3", strategy: "dependency_reinstall", scope: "", semanticStateHash: "DEP_B", stateEpoch: 1 })
    await seed(EventTypes.ToolExecuted, { toolExecutionId: "t3", tool: "shell", ok: false, resultHash: "ERR3" })

    const runner = scriptedRunner(() => ({ ok: false, error: "still broken", resultFingerprint: "ERR4" }))
    const model = scriptedModel([shellCall("npm install"), final("install is unavailable — reported")])
    // After the restart the state has NOT moved: still DEP_B, still spent.
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: installPolicy(() => "DEP_B") })
    const r = await runtime.continueRun(ses, { runId, attempt: 2, fromState: "executing_tool", fromTurn: 2 })

    expect(r.state).toBe("completed")
    expect(runner.invocations).toBe(0)
    const blocked = await strategyBlocks(store, ses)
    expect(blocked).toHaveLength(1)
    const d = blocked[0]!.data as { reason: string; failures: number; stateEpoch: number }
    expect(d.reason).toBe("repeated_failure") // the install gate, unchanged
    expect(d.failures).toBe(2) // both landed in epoch 1, not spread across DEP_A and DEP_B
    expect(d.stateEpoch).toBe(1)
  })

  test("S23 a state seen in an OLD epoch does not block in a new one — history is not a value set", async () => {
    // DEP_A -> DEP_B -> DEP_A. The last install is at a hash that already
    // succeeded once, and it must run: the world moved twice, and the state it
    // arrived back at is not one this strategy produced.
    const store = new MemoryEventStore()
    let state = "DEP_A"
    const runner = scriptedRunner((call) => {
      if (call.name === "edit_file") return committedEdit("package.json")
      return { ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }
    })
    const model = scriptedModel([
      shellCall("npm install"), // at DEP_A
      editCall("package.json"),
      shellCall("npm install"), // at DEP_B
      editCall("package.json"),
      shellCall("npm install"), // back at DEP_A — a NEW epoch, not the old one
      final("done"),
    ])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: installPolicy(() => state) })
    await runtime.admit("ses_s23", "flip a dependency back and forth")
    let edits = 0
    runner.onEdit = () => {
      state = ++edits === 1 ? "DEP_B" : "DEP_A" // the revert lands on the old hash
    }
    const r = await runtime.run("ses_s23")

    expect(r.state).toBe("completed")
    expect(runner.commands).toEqual(["npm install", "npm install", "npm install"])
    expect(await strategyBlocks(store, "ses_s23")).toHaveLength(0)
  })

  test("S24 CONCURRENCY: two runtimes at the same strategy+scope+state — only ONE executes in the epoch", async () => {
    // The ledger cannot live only in one run's memory. Two runtimes over the
    // SAME log, the same strategy, the same scope and the same state are two
    // attempts at one piece of the world: the second must be refused while the
    // first is still inside the tool. Whoever appended `tool.started` first owns
    // the epoch; the log — not a process-local map — is the arbiter.
    const store = new MemoryEventStore()
    const ses = "ses_s24"
    const commands: string[] = []
    /** A runner that reports when it is INSIDE the tool and waits to be let out. */
    const gatedRunner = (onEnter?: () => void, gate?: Promise<void>) =>
      unenforcedToolRunner(
        {
          async run(call: { name: string; input: unknown }) {
            commands.push(String((call.input as { command?: string }).command ?? call.name))
            onEnter?.()
            if (gate) await gate
            return { ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" } as never
          },
        },
        "test fake",
      )
    let letAOut = () => {}
    const aMayFinish = new Promise<void>((r) => (letAOut = r))
    let aIsInside = () => {}
    const aInside = new Promise<void>((r) => (aIsInside = r))
    // One world: the same strategy, scope and dependency state for both.
    const policy = () => installPolicy(() => "DEP_A", undefined, () => "packages/app")

    const a = new SessionRuntime({
      store,
      model: scriptedModel([shellCall("npm install"), final("A installed")]),
      tools: gatedRunner(aIsInside, aMayFinish),
      strategy: policy(),
    })
    const b = new SessionRuntime({
      store,
      model: scriptedModel([shellCall("npm install"), final("B did not reinstall")]),
      tools: gatedRunner(),
      strategy: policy(),
    })

    await a.admit(ses, "install the dependencies")
    const runA = a.run(ses)
    await aInside // A holds the epoch: started, not yet executed
    await b.admit(ses, "install the dependencies")
    const rb = await b.run(ses)
    letAOut()
    const ra = await runA

    expect(ra.state).toBe("completed")
    expect(rb.state).toBe("completed")
    expect(commands).toEqual(["npm install"]) // B never spawned a second install
    const blocked = await strategyBlocks(store, ses)
    expect(blocked).toHaveLength(1)
    const d = blocked[0]!.data as { reason: string; scope: string; stateEpoch: number; error: { code: string } }
    expect(d.reason).toBe("concurrent_execution_in_flight")
    expect(d.scope).toBe("packages/app")
    expect(d.stateEpoch).toBe(0) // the same epoch A is executing in
    expect(d.error.code).toBe("redundant_expensive_strategy")
  })

  test("S24b a SEQUENTIAL second run sees the first run's success — the ledger is the log, not the process", async () => {
    // The same hole without the race: run 1 installs, run 2 starts fresh in the
    // same session at an unchanged state. A per-run in-memory ledger would have
    // forgotten everything and reinstalled.
    const store = new MemoryEventStore()
    const ses = "ses_s24b"
    const commands: string[] = []
    const runnerFor = () =>
      unenforcedToolRunner(
        {
          async run(call: { name: string; input: unknown }) {
            commands.push(String((call.input as { command?: string }).command ?? call.name))
            return { ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" } as never
          },
        },
        "test fake",
      )
    const mk = (text: string) =>
      new SessionRuntime({
        store,
        model: scriptedModel([shellCall("npm install"), final(text)]),
        tools: runnerFor(),
        strategy: installPolicy(() => "DEP_A"),
      })

    const first = mk("installed")
    await first.admit(ses, "install")
    expect((await first.run(ses)).state).toBe("completed")

    const second = mk("already installed")
    await second.admit(ses, "install again")
    expect((await second.run(ses)).state).toBe("completed")

    expect(commands).toEqual(["npm install"])
    const blocked = await strategyBlocks(store, ses)
    expect(blocked).toHaveLength(1)
    expect((blocked[0]!.data as { reason: string }).reason).toBe("already_succeeded")
  })

  test("S25 CRASH BOUNDARY: a started with no executed is neither a success nor a post-state", async () => {
    // The process died INSIDE the install. The log holds `tool.started` and
    // nothing else. That orphan says one thing only — an attempt was made. It
    // must not be counted as a success, and the state the world happens to be in
    // afterwards must not be adopted as "the state this strategy produced":
    // nobody recorded producing it, and a phantom post-state would silently
    // block the retry the crash makes necessary.
    const store = new MemoryEventStore()
    const ses = "ses_s25"
    const runId = "run_s25"
    await store.append({
      aggregateKind: "session",
      aggregateId: ses,
      type: EventTypes.ToolStarted,
      data: {
        runId,
        tool: "shell",
        argsHash: "h1",
        toolExecutionId: "t1",
        strategy: "dependency_reinstall",
        scope: "",
        semanticStateHash: "DEP_A",
        stateEpoch: 0,
      },
    })
    // The world moved while the process was dying: the install got as far as
    // writing the lockfile. Had the crashed run RECORDED that post-state, this
    // hash would be "produced by a prior run" and the retry would be refused.
    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const model = scriptedModel([shellCall("npm install"), shellCall("npm install"), final("done")])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: installPolicy(() => "DEP_A_LOCKED") })
    const r = await runtime.continueRun(ses, { runId, attempt: 2, fromState: "executing_tool", fromTurn: 2 })

    expect(r.state).toBe("completed")
    // The retry ran (no phantom success, no phantom post-state)...
    expect(runner.commands).toEqual(["npm install"])
    const started = (await store.read("session", ses)).filter((e) => e.type === EventTypes.ToolStarted)
    expect(started).toHaveLength(2)
    expect((started[1]!.data as { stateEpoch: number }).stateEpoch).toBe(1) // the world moved: a new epoch
    // ...and exactly ONE success is on the books, so the next attempt is refused
    // for the right reason. An orphan that had counted would say successes: 2.
    const blocked = await strategyBlocks(store, ses)
    expect(blocked).toHaveLength(1)
    const d = blocked[0]!.data as { reason: string; successes: number; failures: number }
    expect(d.reason).toBe("already_succeeded")
    expect(d.successes).toBe(1)
    expect(d.failures).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // An orphan claim must not become a permanent lock. A dead owner's claim is
  // ABANDONED, and abandonment is RESOLVED — the effect on the world is
  // classified, written to the log, and the claim released — never simply held.
  // ---------------------------------------------------------------------------

  const DEAD: RunLiveness = { status: () => "dead" }
  const LIVE: RunLiveness = { status: () => "live" }
  const UNSURE: RunLiveness = { status: () => "unknown" }

  /** A `tool.started` from another run that never reported: the crash shape. */
  const seedOrphanClaim = async (store: MemoryEventStore, ses: string, runId: string, state: string, scope = "") =>
    store.append({
      aggregateKind: "session",
      aggregateId: ses,
      type: EventTypes.ToolStarted,
      data: {
        runId,
        tool: "shell",
        argsHash: "orphan",
        toolExecutionId: "tex_orphan",
        strategy: "dependency_reinstall",
        scope,
        semanticStateHash: state,
        stateEpoch: 0,
      },
    })

  const resolutions = async (store: MemoryEventStore, ses: string) =>
    (await store.read("session", ses)).filter((e) => e.type === EventTypes.ToolStrategyClaimResolved)

  test("S26 ABANDONED/applied: the state moved while the owner was gone — a new epoch, not a lock", async () => {
    const store = new MemoryEventStore()
    const ses = "ses_s26"
    await seedOrphanClaim(store, ses, "run_dead", "DEP_A")
    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const model = scriptedModel([shellCall("npm install"), final("installed")])
    // The world is at DEP_B now: whatever the dead run did, it reached the world.
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: installPolicy(() => "DEP_B"), liveness: DEAD })
    await runtime.admit(ses, "install")
    const r = await runtime.run(ses)

    expect(r.state).toBe("completed")
    expect(runner.commands).toEqual(["npm install"]) // the claim did not block us
    const res = await resolutions(store, ses)
    expect(res).toHaveLength(1)
    const d = res[0]!.data as { effect: string; claimedStateHash: string; observedStateHash: string; abandonedRunId: string }
    expect(d.effect).toBe("applied")
    expect(d.claimedStateHash).toBe("DEP_A")
    expect(d.observedStateHash).toBe("DEP_B")
    expect(d.abandonedRunId).toBe("run_dead")
    // ...and the attempt landed in the epoch that change opened.
    const started = (await store.read("session", ses)).filter((e) => e.type === EventTypes.ToolStarted)
    expect((started[1]!.data as { stateEpoch: number }).stateEpoch).toBe(1)
    expect(await strategyBlocks(store, ses)).toHaveLength(0)
  })

  test("S27 ABANDONED/not_applied: a family that can see its own writes says nothing landed", async () => {
    const store = new MemoryEventStore()
    const ses = "ses_s27"
    await seedOrphanClaim(store, ses, "run_dead", "DEP_A")
    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const model = scriptedModel([shellCall("npm install"), final("installed")])
    const strategy: StrategyPolicy = {
      ...installPolicy(() => "DEP_A"),
      // The observer looks at the world and reports the state the claim started
      // from: the dead run never got as far as writing.
      observeState: () => "DEP_A",
    }
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy, liveness: DEAD })
    await runtime.admit(ses, "install")
    const r = await runtime.run(ses)

    expect(r.state).toBe("completed")
    expect(runner.commands).toEqual(["npm install"]) // a clean retry, same epoch
    const d = (await resolutions(store, ses))[0]!.data as { effect: string; verifier: string }
    expect(d.effect).toBe("not_applied")
    expect(d.verifier).toBe("strategy_observe_state")
    expect(await strategyBlocks(store, ses)).toHaveLength(0)
  })

  test("S28 ABANDONED/unknown: the claim is RELEASED but the blind retry is still refused", async () => {
    // The honest middle case: the state is unchanged and this family cannot see
    // its own writes, so the execution MAY have half-landed. Releasing the claim
    // stops the deadlock; refusing the retry stops the duplicate side effect.
    const store = new MemoryEventStore()
    const ses = "ses_s28"
    await seedOrphanClaim(store, ses, "run_dead", "DEP_A")
    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const model = scriptedModel([shellCall("npm install"), final("did not reinstall blindly")])
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy: installPolicy(() => "DEP_A"), liveness: DEAD })
    await runtime.admit(ses, "install")
    const r = await runtime.run(ses)

    expect(r.state).toBe("completed")
    expect(runner.invocations).toBe(0)
    const d = (await resolutions(store, ses))[0]!.data as { effect: string; verifier: string }
    expect(d.effect).toBe("unknown")
    expect(d.verifier).toBe("classified_state_comparison")
    const blocked = await strategyBlocks(store, ses)
    expect(blocked).toHaveLength(1)
    expect((blocked[0]!.data as { reason: string }).reason).toBe("abandoned_execution_unknown_effect")
  })

  test("S28b an unknown effect IS overridable by an explicit authorization; a LIVE claim is not", async () => {
    // The difference that keeps this from being a lock: a human can pass an
    // abandoned execution. Nobody can pass one that is still running.
    const overridable = new MemoryEventStore()
    await seedOrphanClaim(overridable, "ses_s28b", "run_dead", "DEP_A")
    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const runtime = new SessionRuntime({
      store: overridable,
      model: scriptedModel([shellCall("npm install"), final("reinstalled with authorization")]),
      tools: runner,
      strategy: { ...installPolicy(() => "DEP_A"), authorizeRetry: () => ({ granted: true, reason: "operator checked the tree" }) },
      liveness: DEAD,
    })
    await runtime.admit("ses_s28b", "install")
    expect((await runtime.run("ses_s28b")).state).toBe("completed")
    expect(runner.commands).toEqual(["npm install"]) // authorized, and logged
    const granted = (await overridable.read("session", "ses_s28b")).filter((e) => e.type === EventTypes.ToolStrategyOverrideGranted)
    expect(granted).toHaveLength(1)
    expect((granted[0]!.data as { blockedReason: string }).blockedReason).toBe("abandoned_execution_unknown_effect")

    // The same authorizer against a LIVE owner changes nothing.
    const live = new MemoryEventStore()
    await seedOrphanClaim(live, "ses_s28c", "run_alive", "DEP_A")
    const liveRunner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const liveRuntime = new SessionRuntime({
      store: live,
      model: scriptedModel([shellCall("npm install"), final("waited")]),
      tools: liveRunner,
      strategy: { ...installPolicy(() => "DEP_A"), authorizeRetry: () => ({ granted: true, reason: "let me through" }) },
      liveness: LIVE,
    })
    await liveRuntime.admit("ses_s28c", "install")
    expect((await liveRuntime.run("ses_s28c")).state).toBe("completed")
    expect(liveRunner.invocations).toBe(0)
    expect(await resolutions(live, "ses_s28c")).toHaveLength(0) // a live claim is not resolved
    const blocked = await strategyBlocks(live, "ses_s28c")
    expect((blocked[0]!.data as { reason: string }).reason).toBe("concurrent_execution_in_flight")
  })

  test("S29 the TTL backstop releases a stale claim — and a FRESH one still blocks", async () => {
    // Without a liveness port the claim is judged by age alone. Both halves
    // matter: no eternal lock, and no stealing a claim from a live install.
    const fresh = new MemoryEventStore()
    await seedOrphanClaim(fresh, "ses_s29a", "run_gone", "DEP_A")
    const freshRunner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const freshRuntime = new SessionRuntime({
      store: fresh,
      model: scriptedModel([shellCall("npm install"), final("waited")]),
      tools: freshRunner,
      strategy: installPolicy(() => "DEP_A"),
    })
    await freshRuntime.admit("ses_s29a", "install")
    await freshRuntime.run("ses_s29a")
    expect(freshRunner.invocations).toBe(0)
    expect(await resolutions(fresh, "ses_s29a")).toHaveLength(0)
    expect((((await strategyBlocks(fresh, "ses_s29a"))[0]!.data) as { reason: string }).reason).toBe("concurrent_execution_in_flight")

    // The same claim, an hour later: abandoned, resolved, released.
    const stale = new MemoryEventStore()
    await seedOrphanClaim(stale, "ses_s29b", "run_gone", "DEP_A")
    const staleRunner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const staleRuntime = new SessionRuntime({
      store: stale,
      model: scriptedModel([shellCall("npm install"), final("moved on")]),
      tools: staleRunner,
      // The world moved while the owner was gone, so the effect reads `applied`.
      strategy: installPolicy(() => "DEP_B"),
      now: () => Date.now() + 60 * 60_000,
    })
    await staleRuntime.admit("ses_s29b", "install")
    await staleRuntime.run("ses_s29b")
    expect(staleRunner.commands).toEqual(["npm install"])
    const d = (await resolutions(stale, "ses_s29b"))[0]!.data as { effect: string; claimAgeMs: number }
    expect(d.effect).toBe("applied")
    expect(d.claimAgeMs).toBeGreaterThanOrEqual(60 * 60_000)
  })

  test("S29b liveness `unknown` is not `dead` — an unobservable owner keeps its fresh claim", async () => {
    const store = new MemoryEventStore()
    await seedOrphanClaim(store, "ses_s29c", "run_unclear", "DEP_A")
    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const runtime = new SessionRuntime({
      store,
      model: scriptedModel([shellCall("npm install"), final("waited")]),
      tools: runner,
      strategy: installPolicy(() => "DEP_A"),
      liveness: UNSURE,
    })
    await runtime.admit("ses_s29c", "install")
    await runtime.run("ses_s29c")
    expect(runner.invocations).toBe(0) // taking over an unobservable run makes two installs
    expect(await resolutions(store, "ses_s29c")).toHaveLength(0)
  })

  test("S30 RESTART: the resolution is REPLAYED from the log, not re-derived from today's world", async () => {
    // The verdict was reached against the world as it stood then. After a
    // restart the world has moved on — and the log, not the filesystem, is what
    // says what was decided. The claim is not re-created and no second
    // resolution is written.
    const store = new MemoryEventStore()
    const ses = "ses_s30"
    await seedOrphanClaim(store, ses, "run_dead", "DEP_A")
    await store.append({
      aggregateKind: "session",
      aggregateId: ses,
      type: EventTypes.ToolStrategyClaimResolved,
      data: {
        runId: "run_resolver",
        toolExecutionId: "tex_orphan",
        abandonedRunId: "run_dead",
        strategy: "dependency_reinstall",
        scope: "",
        stateEpoch: 0,
        claimedStateHash: "DEP_A",
        effect: "unknown",
        verifier: "classified_state_comparison",
      },
    })
    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const runtime = new SessionRuntime({
      store,
      model: scriptedModel([shellCall("npm install"), final("still not blindly")]),
      tools: runner,
      strategy: installPolicy(() => "DEP_A"),
      liveness: DEAD,
    })
    await runtime.admit(ses, "install")
    expect((await runtime.run(ses)).state).toBe("completed")

    expect(runner.invocations).toBe(0) // the unknown effect still refuses
    expect(await resolutions(store, ses)).toHaveLength(1) // no second verdict
    const blocked = await strategyBlocks(store, ses)
    expect((blocked[0]!.data as { reason: string }).reason).toBe("abandoned_execution_unknown_effect")
  })

  test("S30b a resolved `unknown` is cleared by a REAL change to the world", async () => {
    // The refusal is bounded by the world, not only by a human: once the state
    // this strategy depends on actually moves, the unresolved past says nothing.
    const store = new MemoryEventStore()
    const ses = "ses_s30b"
    await seedOrphanClaim(store, ses, "run_dead", "DEP_A")
    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const runtime = new SessionRuntime({
      store,
      model: scriptedModel([shellCall("npm install"), final("installed")]),
      tools: runner,
      // Someone edited package.json in the meantime: DEP_C, not DEP_A.
      strategy: installPolicy(() => "DEP_C"),
      liveness: DEAD,
    })
    await runtime.admit(ses, "install")
    expect((await runtime.run(ses)).state).toBe("completed")
    expect(runner.commands).toEqual(["npm install"])
    expect(await strategyBlocks(store, ses)).toHaveLength(0)
  })

  test("S9 a throwing policy never breaks the run — an unclassifiable call is simply unguarded", async () => {
    const store = new MemoryEventStore()
    const runner = scriptedRunner(() => ({ ok: true, output: { exitCode: 0 }, resultFingerprint: "npm-ok" }))
    const model = scriptedModel([shellCall("npm install"), shellCall("npm install"), final("done")])
    const strategy: StrategyPolicy = {
      classify() {
        throw new Error("package.json is unreadable")
      },
    }
    const runtime = new SessionRuntime({ store, model, tools: runner, strategy })
    await runtime.admit("ses_s9", "install")
    const r = await runtime.run("ses_s9")

    expect(r.state).toBe("completed")
    expect(runner.invocations).toBe(2)
    expect(await strategyBlocks(store, "ses_s9")).toHaveLength(0)
  })
})
