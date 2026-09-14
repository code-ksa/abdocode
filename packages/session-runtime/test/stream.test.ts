import { describe, expect, test } from "bun:test"
import { BufferedDeltaSink, StreamAssembler, StreamFailure, type DeltaWriter } from "../src/index"
import type { ModelStreamEvent } from "../src/index"

const feed = (a: StreamAssembler, events: ModelStreamEvent[]) => events.forEach((e) => a.accept(e))

describe("StreamAssembler", () => {
  test("text arriving over many chunks reconstructs the final message", () => {
    const a = new StreamAssembler()
    feed(a, [
      { type: "response.started" },
      { type: "text.delta", text: "Hel" },
      { type: "text.delta", text: "lo, " },
      { type: "text.delta", text: "world" },
      { type: "response.completed", finishReason: "stop" },
    ])
    const r = a.result()
    expect(r).toEqual({ kind: "final", text: "Hello, world" })
  })

  test("fragmented tool arguments are joined and parsed only at the end", () => {
    const a = new StreamAssembler()
    feed(a, [
      { type: "tool_call.started", providerToolCallId: "c1", name: "read_file" },
      { type: "tool_call.arguments.delta", providerToolCallId: "c1", delta: '{"pa' },
      { type: "tool_call.arguments.delta", providerToolCallId: "c1", delta: 'th":"pack' },
      { type: "tool_call.arguments.delta", providerToolCallId: "c1", delta: 'age.json"}' },
      { type: "tool_call.completed", providerToolCallId: "c1" },
      { type: "response.completed", finishReason: "tool_calls" },
    ])
    const r = a.result()
    expect(r).toEqual({ kind: "tools", calls: [{ id: "c1", name: "read_file", input: { path: "package.json" } }] })
  })

  test("multiple tool calls in one stream keep arrival order", () => {
    const a = new StreamAssembler()
    feed(a, [
      { type: "tool_call.started", providerToolCallId: "c1", name: "a" },
      { type: "tool_call.started", providerToolCallId: "c2", name: "b" },
      { type: "tool_call.arguments.delta", providerToolCallId: "c2", delta: "{}" },
      { type: "tool_call.arguments.delta", providerToolCallId: "c1", delta: "{}" },
      { type: "response.completed", finishReason: "tool_calls" },
    ])
    const r = a.result()
    expect(r.kind).toBe("tools")
    if (r.kind === "tools") expect(r.calls.map((c) => c.id)).toEqual(["c1", "c2"])
  })

  test("malformed tool JSON is preserved as _raw (never silently dropped)", () => {
    const a = new StreamAssembler()
    feed(a, [
      { type: "tool_call.started", providerToolCallId: "c1", name: "shell" },
      { type: "tool_call.arguments.delta", providerToolCallId: "c1", delta: "{ not json" },
      { type: "response.completed", finishReason: "tool_calls" },
    ])
    const r = a.result()
    expect(r.kind).toBe("tools")
    if (r.kind === "tools") expect(r.calls[0]!.input).toEqual({ _raw: "{ not json" })
  })

  test("events after a terminal event are ignored (exactly-once)", () => {
    const a = new StreamAssembler()
    feed(a, [
      { type: "text.delta", text: "done" },
      { type: "response.completed", finishReason: "stop" },
      { type: "text.delta", text: " LATE" }, // must be ignored
      { type: "response.completed", finishReason: "stop" },
    ])
    expect(a.result()).toEqual({ kind: "final", text: "done" })
  })

  test("a failed response makes result() throw a StreamFailure", () => {
    const a = new StreamAssembler()
    feed(a, [
      { type: "text.delta", text: "partial" },
      { type: "response.failed", error: { message: "upstream 500", retryable: true } },
    ])
    expect(() => a.result()).toThrow(StreamFailure)
  })

  test("usage is captured for the manifest", () => {
    const a = new StreamAssembler()
    feed(a, [{ type: "usage", inputTokens: 120, outputTokens: 42 }, { type: "response.completed", finishReason: "stop" }])
    expect(a.usageSoFar).toEqual({ inputTokens: 120, outputTokens: 42 })
  })
})

describe("BufferedDeltaSink", () => {
  const recorder = () => {
    const writes: string[] = []
    const writer: DeltaWriter = {
      async write(text) {
        writes.push(text)
        return true
      },
    }
    return { writes, writer }
  }

  test("batches text and flushes at the byte threshold", async () => {
    const { writes, writer } = recorder()
    const sink = new BufferedDeltaSink(writer, 8)
    await sink.onEvent({ type: "text.delta", text: "1234" })
    expect(writes).toHaveLength(0) // under threshold
    await sink.onEvent({ type: "text.delta", text: "5678" }) // hits 8 bytes
    expect(writes).toEqual(["12345678"])
  })

  test("flushes buffered text at a tool-call boundary and on completion", async () => {
    const { writes, writer } = recorder()
    const sink = new BufferedDeltaSink(writer, 10_000)
    await sink.onEvent({ type: "text.delta", text: "before-tool" })
    await sink.onEvent({ type: "tool_call.started", providerToolCallId: "c1", name: "x" })
    expect(writes).toEqual(["before-tool"]) // boundary forced a flush
    await sink.onEvent({ type: "text.delta", text: "tail" })
    await sink.onEvent({ type: "response.completed", finishReason: "stop" })
    expect(writes).toEqual(["before-tool", "tail"])
  })

  test("reasoning deltas are display-only and never persisted", async () => {
    const { writes, writer } = recorder()
    const sink = new BufferedDeltaSink(writer, 10_000)
    await sink.onEvent({ type: "reasoning.delta", text: "thinking..." })
    await sink.flush()
    expect(writes).toHaveLength(0)
  })

  test("an explicit flush emits whatever is buffered", async () => {
    const { writes, writer } = recorder()
    const sink = new BufferedDeltaSink(writer, 10_000)
    await sink.onEvent({ type: "text.delta", text: "partial" })
    await sink.flush()
    expect(writes).toEqual(["partial"])
  })
})
