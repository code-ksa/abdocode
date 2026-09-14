/**
 * CL-11 — the constraints an execution runs under are recorded on `tool.started`,
 * not only on `tool.executed`.
 *
 * A crash during execution leaves the durable decision, but the decision proves
 * what was DECIDED, not that the overlay bound THIS attempt. So the runtime
 * previews the enforcement (a pure, deterministic call) and stamps the summary —
 * kinds and env key NAMES, never values — onto tool.started. A start with no
 * executed then still shows what the execution began under.
 */
import { describe, expect, test } from "bun:test"
import { unenforcedToolRunner } from "@abdo/control-contracts"
import { MemoryEventStore } from "@abdo/event-store"
import { EventTypes, SessionRuntime, type ModelClient, type ModelInput, type ModelTurn } from "../src/index"

function scriptedModel(turns: ModelTurn[]): ModelClient {
  let i = 0
  return { async call(_i: ModelInput) { const t = turns[Math.min(i, turns.length - 1)]!; i++; return t }, }
}
const shellCall = (command: string): ModelTurn => ({ kind: "tools", calls: [{ id: "c", name: "shell", input: { command } }] })
const final = (text: string): ModelTurn => ({ kind: "final", text })

/** A runner that reports a fixed constraint preview for the "npm test" command. */
function runnerWithPreview() {
  const r = {
    started: [] as unknown[],
    async run() {
      return { ok: true as const, output: "ran" }
    },
    describeEnforcement(call: { input: unknown }) {
      const cmd = String((call.input as { command?: string }).command ?? "")
      return /npm (test|run|start)/.test(cmd)
        ? [{ kind: "suppressImplicitLifecycleScripts", envKeys: ["npm_config_ignore_scripts"] }]
        : []
    },
  }
  return unenforcedToolRunner(r, "test fake with a constraint preview")
}

const startedEvents = async (store: MemoryEventStore, ses: string) =>
  (await store.read("session", ses)).filter((e) => e.type === EventTypes.ToolStarted)

describe("tool.started carries the enforced-constraint summary", () => {
  test("a constrained command stamps kinds + env key NAMES on tool.started", async () => {
    const store = new MemoryEventStore()
    const runtime = new SessionRuntime({
      store,
      model: scriptedModel([shellCall("npm test"), final("done")]),
      tools: runnerWithPreview(),
    })
    await runtime.admit("ses_c1", "run the tests")
    await runtime.run("ses_c1")

    const started = await startedEvents(store, "ses_c1")
    expect(started).toHaveLength(1)
    const d = started[0]!.data as { constraints?: { kind: string; envKeys?: string[] }[] }
    expect(d.constraints).toEqual([{ kind: "suppressImplicitLifecycleScripts", envKeys: ["npm_config_ignore_scripts"] }])
    // No env VALUE is ever written to the durable event.
    expect(JSON.stringify(d.constraints)).not.toContain("true")
  })

  test("an unconstrained command omits the field entirely", async () => {
    const store = new MemoryEventStore()
    const runtime = new SessionRuntime({
      store,
      model: scriptedModel([shellCall("git status"), final("done")]),
      tools: runnerWithPreview(),
    })
    await runtime.admit("ses_c2", "check status")
    await runtime.run("ses_c2")

    const started = await startedEvents(store, "ses_c2")
    expect((started[0]!.data as { constraints?: unknown }).constraints).toBeUndefined()
  })

  test("a runner without describeEnforcement is unaffected — plain hosts stay plain", async () => {
    const store = new MemoryEventStore()
    const plain = unenforcedToolRunner({ async run() { return { ok: true as const, output: "ran" } } }, "plain fake")
    const runtime = new SessionRuntime({ store, model: scriptedModel([shellCall("npm test"), final("done")]), tools: plain })
    await runtime.admit("ses_c3", "go")
    await runtime.run("ses_c3")

    const started = await startedEvents(store, "ses_c3")
    expect((started[0]!.data as { constraints?: unknown }).constraints).toBeUndefined()
  })
})
