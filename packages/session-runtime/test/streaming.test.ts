import { describe, expect, test } from "bun:test"
import { unenforcedToolRunner } from "@abdo/control-contracts"
import { MemoryEventStore } from "@abdo/event-store"
import { EventTypes, SessionRuntime, replayStreamText, type ModelClient, type ModelInput, type StreamSink } from "../src/index"

const deltasOf = async (store: MemoryEventStore, sessionId: string) =>
  (await store.read("session", sessionId)).filter((e) => e.type === EventTypes.MessageDeltaBatch).map((e) => (e.data as { text: string }).text)

const finalOf = async (store: MemoryEventStore, sessionId: string) => {
  const m = (await store.read("session", sessionId)).find((e) => e.type === EventTypes.MessageAppended)
  return m ? (m.data as { text: string }).text : undefined
}

/** A streaming model client that emits scripted events then returns the ModelTurn. */
function streamingModel(script: (sink: StreamSink) => Promise<void>, text: string): ModelClient {
  return {
    async call() {
      return { kind: "final", text }
    },
    async stream(_input: ModelInput, { sink }) {
      await script(sink)
      return { kind: "final", text }
    },
  }
}

describe("runtime streaming", () => {
  test("streamed text is persisted as delta batches and reconciles to the final message", async () => {
    const store = new MemoryEventStore()
    const model = streamingModel(async (sink) => {
      await sink.onEvent({ type: "text.delta", text: "Hello " })
      await sink.onEvent({ type: "text.delta", text: "streamed " })
      await sink.onEvent({ type: "text.delta", text: "world" })
      await sink.onEvent({ type: "response.completed", finishReason: "stop" })
    }, "Hello streamed world")
    const runtime = new SessionRuntime({ store, model, tools: unenforcedToolRunner({ async run() { return { ok: true, output: null } } }, "test fake"), deltaFlushBytes: 4 })

    await runtime.admit("ses_s", "hi")
    const r = await runtime.run("ses_s")

    expect(r.state).toBe("completed")
    const batches = await deltasOf(store, "ses_s")
    expect(batches.join("")).toBe("Hello streamed world") // display stream == final
    expect(await finalOf(store, "ses_s")).toBe("Hello streamed world")
  })

  test("cancellation mid-stream persists accepted text, then no text after run.cancelled", async () => {
    const store = new MemoryEventStore()
    const controller = new AbortController()
    const model = streamingModel(async (sink) => {
      // deltaFlushBytes:1 flushes this immediately (durable before the abort)
      await sink.onEvent({ type: "text.delta", text: "kept-before-cancel" })
      controller.abort()
      throw new Error("aborted") // the provider notices the abort
    }, "never")
    const runtime = new SessionRuntime({ store, model, tools: unenforcedToolRunner({ async run() { return { ok: true, output: null } } }, "test fake"), deltaFlushBytes: 1 })

    await runtime.admit("ses_x", "hi")
    const r = await runtime.run("ses_x", { signal: controller.signal })

    expect(r.state).toBe("cancelled")
    const events = await store.read("session", "ses_x")
    const cancelIdx = events.findIndex((e) => e.type === EventTypes.RunCancelled)
    const deltaAfterCancel = events.slice(cancelIdx + 1).some((e) => e.type === EventTypes.MessageDeltaBatch)
    expect(deltaAfterCancel).toBe(false)
    // the text accepted before the abort was still persisted
    expect((await deltasOf(store, "ses_x")).join("")).toContain("kept-before-cancel")
  })

  test("a late chunk from a superseded request is dropped, not persisted", async () => {
    const store = new MemoryEventStore()
    let runId = ""
    const model: ModelClient = {
      async call() {
        return { kind: "final", text: "x" }
      },
      async stream(input, { sink }) {
        // capture this run's id from the request-started event
        const events = await store.read("session", input.sessionId)
        const started = events.filter((e) => e.type === EventTypes.ModelRequestStarted)
        runId = (started[started.length - 1]!.data as { runId: string }).runId
        await sink.onEvent({ type: "text.delta", text: "early" })
        await sink.onEvent({ type: "response.completed", finishReason: "stop" }) // flush "early"
        // a NEWER request supersedes this one mid-flight
        await store.append({
          aggregateKind: "session",
          aggregateId: input.sessionId,
          type: EventTypes.ModelRequestStarted,
          data: { runId, requestId: "req_newer", attempt: 1, turn: input.turn },
        })
        // this late text must be rejected by the guard
        await sink.onEvent({ type: "text.delta", text: "LATE-should-drop" })
        await sink.onEvent({ type: "response.completed", finishReason: "stop" })
        return { kind: "final", text: "x" }
      },
    }
    const runtime = new SessionRuntime({ store, model, tools: unenforcedToolRunner({ async run() { return { ok: true, output: null } } }, "test fake"), deltaFlushBytes: 1 })
    await runtime.admit("ses_l", "hi")
    const r = await runtime.run("ses_l")

    // superseded -> the run cancels rather than applying a stale response
    expect(r.state).toBe("cancelled")
    const batches = await deltasOf(store, "ses_l")
    expect(batches.join("")).toBe("early")
    expect(batches.join("")).not.toContain("LATE")
  })

  test("a reconnecting consumer replays persisted text from a cursor (source of truth is the log)", async () => {
    const store = new MemoryEventStore()
    const model = streamingModel(async (sink) => {
      await sink.onEvent({ type: "text.delta", text: "part-A" })
      await sink.onEvent({ type: "text.delta", text: "part-B" })
      await sink.onEvent({ type: "text.delta", text: "part-C" })
      await sink.onEvent({ type: "response.completed", finishReason: "stop" })
    }, "part-Apart-Bpart-C")
    const runtime = new SessionRuntime({ store, model, tools: unenforcedToolRunner({ async run() { return { ok: true, output: null } } }, "test fake"), deltaFlushBytes: 1 })
    await runtime.admit("ses_r", "hi")
    await runtime.run("ses_r")

    const events = await store.read("session", "ses_r")
    const all = replayStreamText(events)
    expect(all.map((d) => d.text).join("")).toBe("part-Apart-Bpart-C")
    // a consumer that already saw the first batch replays only the rest — no dupes, no loss
    const cursor = all[0]!.sequence
    const rest = replayStreamText(events, cursor)
    expect(rest.map((d) => d.text).join("")).toBe("part-Bpart-C")
  })

  test("a stalled stream (no chunk within idleChunkMs) is aborted; a live one is not", async () => {
    // stalled: emit one delta then hang until aborted
    const stalled: ModelClient = {
      async call() {
        return { kind: "final", text: "x" }
      },
      async stream(_input, { sink, signal }) {
        await sink.onEvent({ type: "text.delta", text: "start" })
        await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
        return { kind: "final", text: "never" }
      },
    }
    const store1 = new MemoryEventStore()
    const rt1 = new SessionRuntime({ store: store1, model: stalled, tools: unenforcedToolRunner({ async run() { return { ok: true, output: null } } }, "test fake"), streamTimeouts: { idleChunkMs: 40 }, deltaFlushBytes: 1 })
    await rt1.admit("ses_stall", "hi")
    const stalledResult = await rt1.run("ses_stall")
    expect(stalledResult.state).toBe("failed") // idle watchdog fired

    // live: several deltas spaced under the idle window -> completes
    const live = streamingModel(async (sink) => {
      for (const t of ["a", "b", "c"]) {
        await new Promise((r) => setTimeout(r, 10))
        await sink.onEvent({ type: "text.delta", text: t })
      }
      await sink.onEvent({ type: "response.completed", finishReason: "stop" })
    }, "abc")
    const store2 = new MemoryEventStore()
    const rt2 = new SessionRuntime({ store: store2, model: live, tools: unenforcedToolRunner({ async run() { return { ok: true, output: null } } }, "test fake"), streamTimeouts: { idleChunkMs: 40 }, deltaFlushBytes: 1 })
    await rt2.admit("ses_live", "hi")
    expect((await rt2.run("ses_live")).state).toBe("completed")
  })

  test("a mid-stream break before any tool is SAFELY retried, then the run completes", async () => {
    const store = new MemoryEventStore()
    let attempts = 0
    const model: ModelClient = {
      async call() {
        return { kind: "final", text: "x" }
      },
      async stream(_input, { sink }) {
        attempts++
        if (attempts === 1) {
          await sink.onEvent({ type: "text.delta", text: "partial" })
          throw new Error("ECONNRESET") // transport drop mid-stream (no tool yet)
        }
        await sink.onEvent({ type: "text.delta", text: "recovered answer" })
        await sink.onEvent({ type: "response.completed", finishReason: "stop" })
        return { kind: "final", text: "recovered answer" }
      },
    }
    const runtime = new SessionRuntime({ store, model, tools: unenforcedToolRunner({ async run() { return { ok: true, output: null } } }, "test fake"), deltaFlushBytes: 1 })
    await runtime.admit("ses_mid", "hi")
    const r = await runtime.run("ses_mid")

    expect(r.state).toBe("completed")
    expect(r.text).toBe("recovered answer")
    expect(attempts).toBe(2) // one retry
    // two request-started events this turn (the interrupted one + the retry)
    const started = (await store.read("session", "ses_mid")).filter((e) => e.type === EventTypes.ModelRequestStarted)
    expect(started.length).toBe(2)
    // the final authoritative message is the recovered one, exactly once
    const finals = (await store.read("session", "ses_mid")).filter((e) => e.type === EventTypes.MessageAppended)
    expect(finals).toHaveLength(1)
    expect((finals[0]!.data as { text: string }).text).toBe("recovered answer")
  })

  test("an idle-chunk stall is RETRIED pre-tool; the second attempt completes the run (12I.6 fix 1)", async () => {
    const store = new MemoryEventStore()
    let attempts = 0
    const model: ModelClient = {
      async call() {
        return { kind: "final", text: "x" }
      },
      async stream(_input, { sink, signal }) {
        attempts++
        if (attempts === 1) {
          // stall: one delta then hang until the idle watchdog aborts us
          await sink.onEvent({ type: "text.delta", text: "start" })
          await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }))
        }
        await sink.onEvent({ type: "text.delta", text: "recovered" })
        await sink.onEvent({ type: "response.completed", finishReason: "stop" })
        return { kind: "final", text: "recovered" }
      },
    }
    const runtime = new SessionRuntime({ store, model, tools: unenforcedToolRunner({ async run() { return { ok: true, output: null } } }, "test fake"), streamTimeouts: { idleChunkMs: 40 }, deltaFlushBytes: 1 })
    await runtime.admit("ses_stall_retry", "hi")
    const r = await runtime.run("ses_stall_retry")

    expect(r.state).toBe("completed") // watchdog stall no longer terminal
    expect(r.text).toBe("recovered")
    expect(attempts).toBe(2) // exactly one retry, fresh request id
    const started = (await store.read("session", "ses_stall_retry")).filter((e) => e.type === EventTypes.ModelRequestStarted)
    expect(started.length).toBe(2)
    const finals = (await store.read("session", "ses_stall_retry")).filter((e) => e.type === EventTypes.MessageAppended)
    expect(finals).toHaveLength(1) // no duplicated authoritative message
  })

  test("the TOTAL call budget is NEVER retried — one attempt, run fails", async () => {
    const store = new MemoryEventStore()
    let attempts = 0
    const model: ModelClient = {
      async call() {
        return { kind: "final", text: "x" }
      },
      async stream(_input, { sink, signal }) {
        attempts++
        // keep the stream ALIVE (idle watchdog keeps resetting) but never finish,
        // so only the total budget can fire
        for (;;) {
          if (signal?.aborted) throw signal.reason
          await new Promise((r) => setTimeout(r, 10))
          await sink.onEvent({ type: "text.delta", text: "." })
        }
      },
    }
    const runtime = new SessionRuntime({ store, model, tools: unenforcedToolRunner({ async run() { return { ok: true, output: null } } }, "test fake"), streamTimeouts: { idleChunkMs: 200, totalMs: 80 }, deltaFlushBytes: 1 })
    await runtime.admit("ses_total", "hi")
    const r = await runtime.run("ses_total")
    expect(r.state).toBe("failed")
    expect(attempts).toBe(1) // no retry on the total budget
  })

  test("mid-stream retries are capped, then the run fails", async () => {
    const store = new MemoryEventStore()
    let attempts = 0
    const model: ModelClient = {
      async call() {
        return { kind: "final", text: "x" }
      },
      async stream() {
        attempts++
        throw new Error("ECONNRESET")
      },
    }
    const runtime = new SessionRuntime({ store, model, tools: unenforcedToolRunner({ async run() { return { ok: true, output: null } } }, "test fake"), maxStreamRetries: 2 })
    await runtime.admit("ses_cap", "hi")
    const r = await runtime.run("ses_cap")
    expect(r.state).toBe("failed")
    expect(attempts).toBe(3) // initial + 2 retries
  })

  test("a non-streaming model client still works (no regression, no delta batches)", async () => {
    const store = new MemoryEventStore()
    const model: ModelClient = { async call() { return { kind: "final", text: "plain" } } }
    const runtime = new SessionRuntime({ store, model, tools: unenforcedToolRunner({ async run() { return { ok: true, output: null } } }, "test fake") })
    await runtime.admit("ses_n", "hi")
    const r = await runtime.run("ses_n")
    expect(r.state).toBe("completed")
    expect(await finalOf(store, "ses_n")).toBe("plain")
    expect(await deltasOf(store, "ses_n")).toHaveLength(0)
  })
})
