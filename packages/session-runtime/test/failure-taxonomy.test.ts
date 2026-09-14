/**
 * Sprint 15 — the taxonomy where it is actually used.
 *
 * The contracts test proves the table is total. This proves the runtime writes
 * the verdict into the log: a run that fails, a tool that fails and a check
 * that fails all say WHAT kind of failure it was and whether anything may be
 * done about it. Before this, all three produced a message string and a caller
 * had to guess.
 */
import { describe, expect, test } from "bun:test"
import { unenforcedToolRunner } from "@abdo/control-contracts"
import { DISPOSITION_OF, type FailureClass, type FailureDisposition } from "@abdo/contracts/failure"
import { MemoryEventStore } from "@abdo/event-store"
import { EventTypes, SessionRuntime } from "../src/index"
import type { EnforcedToolRunner, ModelClient, ModelTurn } from "../src/index"

const SID = "ses_failure"

interface LoggedFailure {
  class: FailureClass
  disposition: FailureDisposition
  code: string
}

const failureOn = (data: unknown): LoggedFailure | undefined => (data as { failure?: LoggedFailure }).failure

const okTools: EnforcedToolRunner = unenforcedToolRunner(
  { async run() { return { ok: true as const, output: "ok" } } },
  "test fake",
)
const failingTools = (error: string): EnforcedToolRunner =>
  unenforcedToolRunner({ async run() { return { ok: false as const, error } } }, "test fake")

const harness = (model: ModelClient, tools: EnforcedToolRunner = okTools, budgets = {}) => {
  const store = new MemoryEventStore()
  return { store, runtime: new SessionRuntime({ store, model, tools, budgets }) }
}

const wantsTool = (name = "do_thing"): ModelClient => ({
  async call(): Promise<ModelTurn> {
    return { kind: "tools", calls: [{ id: "c", name, input: {} }] }
  },
})

describe("a failed run says what kind of failure it was", () => {
  test("an unrecognised provider error before any tool is transport, and retryable", async () => {
    const { store, runtime } = harness({
      async call() {
        throw new Error("socket hung up")
      },
    })
    const r = await runtime.run(SID)
    expect(r.state).toBe("failed")

    const failed = (await store.readAll()).find((e) => e.type === EventTypes.RunFailed)!
    const f = failureOn(failed.data)!
    expect(f.class).toBe("TRANSPORT")
    expect(f.disposition).toBe("retry")
    expect(DISPOSITION_OF[f.class]).toBe(f.disposition)
  })

  test("an auth failure is recorded as a wall, not as something to try again", async () => {
    const { store, runtime } = harness({
      async call() {
        throw Object.assign(new Error("Unauthorized"), { status: 401 })
      },
    })
    await runtime.run(SID)

    const failed = (await store.readAll()).find((e) => e.type === EventTypes.RunFailed)!
    const f = failureOn(failed.data)!
    expect(f.class).toBe("AUTH")
    expect(f.disposition).toBe("stop")
    expect(f.code).toBe("http_401")
  })

  test("the whole-call timeout is terminal, and says so", async () => {
    const { store, runtime } = harness({
      async call() {
        throw { _tag: "Abdo.ProviderTimeoutError", kind: "total", timeoutMs: 1, message: "timed out" }
      },
    })
    await runtime.run(SID)

    const f = failureOn((await store.readAll()).find((e) => e.type === EventTypes.RunFailed)!.data)!
    expect(f.class).toBe("UNRECOVERABLE")
    expect(f.disposition).toBe("stop")
  })

  // FOUND TWICE IN ONE DAY, the second time by a live 64k run: the terminal
  // event read `"error": ""` next to `model_timeout_total`. A tagged error
  // whose facts live in FIELDS has an empty `.message`, and the sentence that
  // explains it had already been composed by the classifier — the event dropped
  // it on the way out. A reader learned the CLASS of the fault and not the one
  // number they could act on.
  test("a timeout that carries no message still explains itself on the event", async () => {
    const { store, runtime } = harness({
      async call() {
        throw { _tag: "Abdo.ProviderTimeoutError", kind: "total", timeoutMs: 600_000 }
      },
    })
    await runtime.run(SID)

    const failed = (await store.readAll()).find((e) => e.type === EventTypes.RunFailed)!
    const data = failed.data as { error?: string }
    expect(data.error ?? "").not.toBe("")
    expect(data.error).toContain("600000")
    expect(failureOn(failed.data)!.code).toBe("model_timeout_total")
  })
})

describe("a failed tool says whether anything can be done about it", () => {
  test("an unknown tool error after a possible side effect never reads as retryable", async () => {
    const { store, runtime } = harness(wantsTool(), failingTools("the thing went wrong"), {
      maxConsecutiveToolFailures: 1,
    })
    await runtime.run(SID)

    const executed = (await store.readAll()).filter((e) => e.type === EventTypes.ToolExecuted)
    expect(executed.length).toBeGreaterThan(0)
    const f = failureOn(executed[0]!.data)!
    expect(f.class).toBe("UNRECOVERABLE")
    expect(f.disposition).toBe("stop")
  })

  test("a recognised tool error keeps its own class — a full disk is a resource problem", async () => {
    const { store, runtime } = harness(wantsTool(), failingTools("ENOSPC: no space left on device"), {
      maxConsecutiveToolFailures: 1,
    })
    await runtime.run(SID)

    const executed = (await store.readAll()).filter((e) => e.type === EventTypes.ToolExecuted)
    const f = failureOn(executed[0]!.data)!
    // classified from the message, since a tool result carries no code
    expect(["RESOURCE", "UNRECOVERABLE"]).toContain(f.class)
    expect(DISPOSITION_OF[f.class]).toBe(f.disposition)
  })

  test("a successful tool carries no failure at all", async () => {
    let turn = 0
    const { store, runtime } = harness({
      async call(): Promise<ModelTurn> {
        turn++
        return turn === 1 ? { kind: "tools", calls: [{ id: "c", name: "t", input: {} }] } : { kind: "final", text: "done" }
      },
    })
    await runtime.run(SID)
    const executed = (await store.readAll()).filter((e) => e.type === EventTypes.ToolExecuted)
    expect(failureOn(executed[0]!.data)).toBeUndefined()
  })
})

describe("GATE (Sprint 16) — no claim of completion without receipts", () => {
  test("a run refuses to report done while an operation of this attempt never reported", async () => {
    const store = new MemoryEventStore()
    // The log says this attempt started something that never came back.
    await store.append({
      aggregateKind: "session",
      aggregateId: SID,
      type: EventTypes.ToolStarted,
      data: { runId: "run_unbacked", attempt: 1, tool: "shell", toolExecutionId: "tex_ghost", argsHash: "h" },
    })
    const runtime = new SessionRuntime({
      store,
      model: { async call(): Promise<ModelTurn> { return { kind: "final", text: "all done!" } } },
      tools: okTools,
    })

    const r = await runtime.continueRun(SID, {
      runId: "run_unbacked",
      attempt: 1,
      fromState: "executing_tool",
      fromTurn: 1,
    })

    // it did NOT complete, and it said exactly why
    expect(r.state).toBe("failed")
    const events = await store.readAll()
    expect(events.some((e) => e.type === EventTypes.RunCompleted)).toBe(false)
    const unbacked = events.find((e) => e.type === EventTypes.RunClaimUnbacked)!
    expect(unbacked).toBeDefined()
    expect((unbacked.data as { claims: { operationId: string }[] }).claims[0]!.operationId).toBe("tex_ghost")
    const failed = events.find((e) => e.type === EventTypes.RunFailed)!
    expect(failureOn(failed.data)!.code).toBe("unbacked_completion_claim")
    // the assistant's "all done!" was never appended as an answer
    expect(events.some((e) => e.type === EventTypes.MessageAppended)).toBe(false)
  })

  test("a run whose every operation reported completes normally", async () => {
    let turn = 0
    const store = new MemoryEventStore()
    const runtime = new SessionRuntime({
      store,
      model: {
        async call(): Promise<ModelTurn> {
          turn++
          return turn === 1 ? { kind: "tools", calls: [{ id: "c", name: "t", input: {} }] } : { kind: "final", text: "done" }
        },
      },
      tools: okTools,
    })
    const r = await runtime.run(SID)
    expect(r.state).toBe("completed")
    const events = await store.readAll()
    expect(events.some((e) => e.type === EventTypes.RunClaimUnbacked)).toBe(false)
  })
})

