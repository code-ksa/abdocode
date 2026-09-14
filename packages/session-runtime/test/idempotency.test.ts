/**
 * Sprint 17 GATE — re-sending an operation does not repeat its side effect.
 *
 * `ToolCall.idempotencyKey` existed from the first slice and its comment
 * promised it "guards double-execution on retry". It did not: the key was
 * written onto the events and never read before dispatch, so a resent operation
 * ran a second time and the log dutifully recorded both. This is that promise
 * being kept, across every kind of operation whose second execution is a second
 * real event in the world.
 *
 * The counter in each case is the world. If it reads 2, the side effect
 * happened twice, whatever the log says.
 */
import { describe, expect, test } from "bun:test"
import { unenforcedToolRunner } from "@abdo/control-contracts"
import { idempotencyKeyFor, OPERATION_KINDS, type OperationKind } from "@abdo/contracts/idempotency"
import { foldReceipts } from "@abdo/contracts/receipt"
import { MemoryEventStore } from "@abdo/event-store"
import { EventTypes, SessionRuntime } from "../src/index"
import type { EnforcedToolRunner, ModelClient, ModelTurn } from "../src/index"

const SID = "ses_idem"

/** The world: how many times each operation actually executed. */
function countingTools(counts: Map<string, number>): EnforcedToolRunner {
  return unenforcedToolRunner(
    {
      // A ToolRunner receives the CALL, not the bare arguments.
      async run(call: { input?: unknown }) {
        const op = String((call.input as { op?: unknown } | undefined)?.op ?? "unknown")
        counts.set(op, (counts.get(op) ?? 0) + 1)
        return { ok: true as const, output: `${op} executed` }
      },
    },
    "test fake",
  )
}

/** Asks for the SAME keyed operation `times` times, then finishes. */
function repeatingModel(tool: string, op: string, key: string, times: number): ModelClient {
  let issued = 0
  return {
    async call(): Promise<ModelTurn> {
      if (issued >= times) return { kind: "final", text: "done" }
      issued++
      return { kind: "tools", calls: [{ id: `c${issued}`, name: tool, input: { op }, idempotencyKey: key }] }
    },
  }
}

describe("GATE — every kind of side effect happens at most once per key", () => {
  const cases: Array<[OperationKind, string, string]> = [
    ["file_edit", "write_file", "src/app.ts"],
    ["command", "shell", "npm run migrate"],
    ["migration", "run_migration", "0007_add_users"],
    ["deploy", "deploy_release", "prod:20260819"],
    ["browser", "browser_click", "https://example.com#submit"],
    ["network_send", "send_email", "customer@example.com"],
  ]

  for (const [kind, tool, target] of cases) {
    test(`${kind}: sending it three times executes it once`, async () => {
      const counts = new Map<string, number>()
      const key = idempotencyKeyFor({ kind, target, payloadDigest: "payload1" })
      const store = new MemoryEventStore()
      const runtime = new SessionRuntime({
        store,
        model: repeatingModel(tool, kind, key, 3),
        tools: countingTools(counts),
        budgets: { maxTurns: 20 },
      })

      const r = await runtime.run(SID)
      expect(r.state).toBe("completed")
      // the world moved exactly once
      expect(counts.get(kind)).toBe(1)

      // and the log is explicit about what happened to the other two
      const events = await store.readAll()
      const replays = events.filter((e) => e.type === EventTypes.ToolIdempotentReplay)
      expect(replays).toHaveLength(2)
      for (const replay of replays) {
        expect((replay.data as { decision: string }).decision).toBe("replay")
        expect((replay.data as { idempotencyKey: string }).idempotencyKey).toBe(key)
      }
    })
  }

  test("the model still receives the original result, so a replay is not a dead end", async () => {
    const counts = new Map<string, number>()
    const key = idempotencyKeyFor({ kind: "network_send", target: "a@b.c" })
    const store = new MemoryEventStore()
    const runtime = new SessionRuntime({
      store,
      model: repeatingModel("send_email", "network_send", key, 2),
      tools: countingTools(counts),
      budgets: { maxTurns: 20 },
    })
    await runtime.run(SID)

    const executed = (await store.readAll()).filter((e) => e.type === EventTypes.ToolExecuted)
    expect(executed).toHaveLength(2)
    const [first, second] = executed.map((e) => e.data as Record<string, unknown>)
    expect(first!.ok).toBe(true)
    expect(second!.ok).toBe(true)
    // identical result, and the second says whose result it is
    expect(second!.output).toEqual(first!.output)
    expect(second!.replayOf).toBe((first as { toolExecutionId: string }).toolExecutionId)
  })

  test("different payloads are different operations", async () => {
    const counts = new Map<string, number>()
    const store = new MemoryEventStore()
    const keyA = idempotencyKeyFor({ kind: "file_edit", target: "a.ts", payloadDigest: "v1" })
    const keyB = idempotencyKeyFor({ kind: "file_edit", target: "a.ts", payloadDigest: "v2" })
    expect(keyA).not.toBe(keyB)

    let issued = 0
    const runtime = new SessionRuntime({
      store,
      model: {
        async call(): Promise<ModelTurn> {
          issued++
          if (issued === 1) return { kind: "tools", calls: [{ id: "c1", name: "write_file", input: { op: "edit" }, idempotencyKey: keyA }] }
          if (issued === 2) return { kind: "tools", calls: [{ id: "c2", name: "write_file", input: { op: "edit" }, idempotencyKey: keyB }] }
          return { kind: "final", text: "done" }
        },
      },
      tools: countingTools(counts),
      budgets: { maxTurns: 20 },
    })
    await runtime.run(SID)
    // two genuinely different edits: both ran
    expect(counts.get("edit")).toBe(2)
    expect((await store.readAll()).filter((e) => e.type === EventTypes.ToolIdempotentReplay)).toHaveLength(0)
  })

  test("a call with no key is never silently deduplicated", async () => {
    const counts = new Map<string, number>()
    const store = new MemoryEventStore()
    let issued = 0
    const runtime = new SessionRuntime({
      store,
      model: {
        async call(): Promise<ModelTurn> {
          issued++
          return issued <= 2
            ? { kind: "tools", calls: [{ id: `c${issued}`, name: "read_file", input: { op: "read" } }] }
            : { kind: "final", text: "done" }
        },
      },
      tools: countingTools(counts),
      budgets: { maxTurns: 20 },
    })
    await runtime.run(SID)
    // no key means no claim of idempotency — the runtime must not invent one
    expect(counts.get("read")).toBe(2)
  })

  test("an operation that STARTED and never reported is verified, never replayed or re-run", async () => {
    const counts = new Map<string, number>()
    const key = idempotencyKeyFor({ kind: "deploy", target: "prod" })
    const store = new MemoryEventStore()
    // a crashed attempt: started, no completion
    await store.append({
      aggregateKind: "session",
      aggregateId: SID,
      type: EventTypes.ToolStarted,
      data: { runId: "run_dead", attempt: 1, tool: "deploy_release", toolExecutionId: "tex_dead", idempotencyKey: key },
    })

    const runtime = new SessionRuntime({
      store,
      model: repeatingModel("deploy_release", "deploy", key, 1),
      tools: countingTools(counts),
      budgets: { maxTurns: 20, maxConsecutiveToolFailures: 5 },
    })
    await runtime.run(SID)

    // the deploy did NOT run again
    expect(counts.get("deploy")).toBeUndefined()
    const events = await store.readAll()
    const replay = events.find((e) => e.type === EventTypes.ToolIdempotentReplay)!
    expect((replay.data as { decision: string }).decision).toBe("verify_first")
    // and the model was told why, as a failure it can act on
    const executed = events.filter((e) => e.type === EventTypes.ToolExecuted)
    expect(executed).toHaveLength(1)
    expect((executed[0]!.data as { ok: boolean }).ok).toBe(false)
    expect((executed[0]!.data as { failure: { disposition: string } }).failure.disposition).toBe("repair")
  })

  test("a FAILED prior execution may be retried — a failure that changed nothing is safe to repeat", async () => {
    const key = idempotencyKeyFor({ kind: "command", target: "flaky" })
    const store = new MemoryEventStore()
    let attempts = 0
    const tools = unenforcedToolRunner(
      {
        async run() {
          attempts++
          return attempts === 1 ? { ok: false as const, error: "transient" } : { ok: true as const, output: "worked" }
        },
      },
      "test fake",
    )
    const runtime = new SessionRuntime({
      store,
      model: repeatingModel("shell", "command", key, 2),
      tools,
      budgets: { maxTurns: 20 },
    })
    await runtime.run(SID)

    expect(attempts).toBe(2) // the retry was allowed
    expect((await store.readAll()).filter((e) => e.type === EventTypes.ToolIdempotentReplay)).toHaveLength(0)
  })

  test("every operation kind the sprint names has a key derivation", () => {
    expect(OPERATION_KINDS).toHaveLength(7)
    const keys = new Set(OPERATION_KINDS.map((kind) => idempotencyKeyFor({ kind, target: "same", payloadDigest: "same" })))
    // same target and payload, different kind => different operation
    expect(keys.size).toBe(OPERATION_KINDS.length)
  })

  test("a replayed execution is receipted, and says whose result it is", async () => {
    const counts = new Map<string, number>()
    const key = idempotencyKeyFor({ kind: "migration", target: "0001" })
    const store = new MemoryEventStore()
    const runtime = new SessionRuntime({
      store,
      model: repeatingModel("run_migration", "migration", key, 2),
      tools: countingTools(counts),
      budgets: { maxTurns: 20 },
    })
    const r = await runtime.run(SID)

    const receipts = [...foldReceipts(await store.readAll(), r.runId).values()]
    expect(receipts).toHaveLength(2)
    for (const receipt of receipts) expect(receipt.exit).toBe("ok")
    expect(counts.get("migration")).toBe(1)
  })
})
