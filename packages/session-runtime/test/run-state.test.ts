/**
 * Sprint 11 — the runtime's half of the unified Run state.
 *
 * The fold in `@abdo/contracts/run` is only worth as much as the events it has
 * to read, so these tests assert the RUNTIME actually records the facts: the
 * objective copied out of the conversation, spend attributed to the run that
 * incurred it, and a subtask linked AND resolved from the parent's side.
 * Without this file the S11 gate would be a well-tested fold over events that
 * nothing emits.
 */
import { describe, expect, test } from "bun:test"
import { unenforcedToolRunner } from "@abdo/control-contracts"
import { foldRun, RunEventTypes } from "@abdo/contracts/run"
import type { EnforcedToolRunner } from "../src/index"
import { MemoryEventStore } from "@abdo/event-store"
import { SessionRuntime, EventTypes } from "../src/index"
import type { ModelClient, ModelInput, ModelTurn } from "../src/index"

const SID = "ses_runstate"

function scriptedModel(turns: ModelTurn[], seen?: ModelInput[]): ModelClient {
  let i = 0
  return {
    async call(input) {
      seen?.push(input)
      const t = turns[Math.min(i, turns.length - 1)]!
      i++
      return t
    },
  }
}

const okTools: EnforcedToolRunner = unenforcedToolRunner({ async run() { return { ok: true as const, output: null } } }, "test fake")

const harness = (model: ModelClient) => {
  const store = new MemoryEventStore()
  return { store, runtime: new SessionRuntime({ store, model, tools: okTools }) }
}

const final = () => scriptedModel([{ kind: "final", text: "done" }])

describe("SessionRuntime — the run records what it is doing", () => {
  test("an explicit objective is recorded as data, with a hash of the full text", async () => {
    const { store, runtime } = harness(final())
    await runtime.admit(SID, "اعمل صفحة تسجيل دخول")
    const r = await runtime.run(SID, { objective: "add a login page" })

    const run = foldRun(r.runId, await store.readAll())!
    expect(run.objective?.text).toBe("add a login page")
    expect(run.objective?.source).toBe("explicit")
    expect(run.objective?.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test("with no explicit objective the promoted input is lifted, so the run still knows its job", async () => {
    const { store, runtime } = harness(final())
    await runtime.admit(SID, "اعمل صفحة تسجيل دخول")
    const r = await runtime.run(SID)

    const run = foldRun(r.runId, await store.readAll())!
    expect(run.objective?.text).toBe("اعمل صفحة تسجيل دخول")
    expect(run.objective?.source).toBe("input")
  })

  test("a run with nothing to go on claims no objective rather than inventing one", async () => {
    const { store, runtime } = harness(final())
    await runtime.run(SID)
    expect((await store.readAll()).some((e) => e.type === EventTypes.RunObjectiveRecorded)).toBe(false)
  })

  test("the model turn carries the run id, so spend can be attributed", async () => {
    const seen: ModelInput[] = []
    const { runtime } = harness(scriptedModel([{ kind: "final", text: "done" }], seen))
    const r = await runtime.run(SID)
    expect(seen.length).toBeGreaterThan(0)
    for (const input of seen) expect(input.runId).toBe(r.runId)
  })

  test("a subtask is linked from the parent and resolved when it ends", async () => {
    const { store, runtime } = harness(final())
    const parent = await runtime.run(SID)
    const child = await runtime.run(SID, { parentRunId: parent.runId, objective: "typecheck it" })

    const events = await store.readAll()
    const parentRun = foldRun(parent.runId, events)!
    expect(parentRun.subtasks).toHaveLength(1)
    expect(parentRun.subtasks[0]!.childRunId).toBe(child.runId)
    expect(parentRun.subtasks[0]!.objective).toBe("typecheck it")
    // resolved, so the parent is not left waiting on a child that already ended
    expect(parentRun.subtasks[0]!.resolvedAt).toBeGreaterThan(0)
    expect(parentRun.subtasks[0]!.state).toBe("completed")
    expect(parentRun.nextAction.kind).not.toBe("await_subtasks")

    // and the child's own admission carries the parent
    const childRun = foldRun(child.runId, events)!
    expect(childRun.parentRunId).toBe(parent.runId)
    expect(parentRun.parentRunId).toBeUndefined()
  })

  test("a subtask that fails still resolves — the parent is never left waiting", async () => {
    const store = new MemoryEventStore()
    const runtime = new SessionRuntime({
      store,
      model: {
        async call() {
          throw new Error("provider down")
        },
      },
      tools: okTools,
    })
    const parent = await runtime.run(SID)
    const child = await runtime.run(SID, { parentRunId: parent.runId })

    const parentRun = foldRun(parent.runId, await store.readAll())!
    expect(parentRun.subtasks[0]!.childRunId).toBe(child.runId)
    expect(parentRun.subtasks[0]!.resolvedAt).toBeGreaterThan(0)
    expect(parentRun.subtasks[0]!.state).toBe("failed")
  })
})

/**
 * Names the fold reads that this runtime does NOT emit, and why. Written down
 * rather than quietly tolerated: an unlisted mismatch fails the first test, and
 * a name that later gets wired up fails the second until it is removed from
 * here. The list is allowed to shrink; it must never grow silently.
 */
const NOT_EMITTED_BY_RUNTIME: Record<string, string> = {
  // The host's model client records provider usage — the runtime never sees a
  // token count, so this name lives one layer up by design.
  "model.usage": "emitted by @abdo/host's model client, not the runtime",
  // Real gaps (Sprint 11 finding): both states exist in the machine and both are
  // mapped by the fold, but no code path anywhere enters them. A run parked on a
  // human approval therefore does NOT read as awaiting_permission. Approval is
  // Sprint 20's subject; the fold is left ready for it rather than fabricating.
  "run.awaiting_permission": "no code path emits it yet — approval is Sprint 20",
  "run.compacting": "no code path emits it yet — compaction runs outside the run state",
}

describe("event names — one vocabulary, not two", () => {
  test("every name the fold reads is emitted, or is a documented gap", () => {
    // The fold in @abdo/contracts/run and the runtime's EventTypes table are
    // separate literals on purpose (contracts stays dependency-free). This is
    // the check that keeps them from drifting into two half-blind vocabularies.
    const runtimeNames = new Set(Object.values(EventTypes) as string[])
    const undocumented = Object.entries(RunEventTypes)
      .filter(([, wire]) => !runtimeNames.has(wire) && NOT_EMITTED_BY_RUNTIME[wire] === undefined)
      .map(([key, wire]) => `${key} (${wire})`)
    expect(undocumented).toEqual([])
  })

  test("the documented gaps are still gaps — close one and this makes you say so", () => {
    const runtimeNames = new Set(Object.values(EventTypes) as string[])
    const nowEmitted = Object.keys(NOT_EMITTED_BY_RUNTIME).filter((wire) => runtimeNames.has(wire))
    expect(nowEmitted).toEqual([])
  })
})
