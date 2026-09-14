/**
 * Streaming plumbing — all provider-neutral, all testable without a network.
 *
 * `StreamAssembler` folds a sequence of ModelStreamEvents into the SAME ModelTurn
 * the non-streaming path produces: text is accumulated, fragmented tool-call
 * arguments are joined by providerToolCallId and only parsed AFTER completion
 * (never per chunk), and exactly-once finalization is enforced (events after a
 * terminal event are ignored). Malformed tool JSON is preserved as `_raw` so the
 * tool runtime reports a coded error instead of executing garbage.
 *
 * `BufferedDeltaSink` batches text so the event log isn't flooded with one event
 * per token: it flushes on a size threshold and at every boundary that must be
 * durable (a tool call, completion, failure, or an explicit flush before a
 * checkpoint / cancellation). Each flush is guarded, so a late chunk from a
 * superseded request never lands.
 */
import type { ModelStreamEvent, ModelTurn, StreamSink, ToolCall } from "./ports"

interface AssembledTool {
  readonly id: string
  name: string
  args: string
  order: number
}

export class StreamAssembler {
  private text = ""
  private reasoning = ""
  private readonly tools = new Map<string, AssembledTool>()
  private nextOrder = 0
  private finishReason: string | null = null
  private failure: { message: string; retryable?: boolean } | null = null
  private usage: { inputTokens?: number; outputTokens?: number } = {}

  /** Fold one event. Anything after a terminal event is ignored (exactly-once). */
  accept(event: ModelStreamEvent): void {
    if (this.finishReason !== null || this.failure !== null) return
    switch (event.type) {
      case "text.delta":
        this.text += event.text
        break
      case "reasoning.delta":
        this.reasoning += event.text
        break
      case "tool_call.started":
        if (!this.tools.has(event.providerToolCallId)) {
          this.tools.set(event.providerToolCallId, { id: event.providerToolCallId, name: event.name ?? "", args: "", order: this.nextOrder++ })
        } else if (event.name) {
          this.tools.get(event.providerToolCallId)!.name = event.name
        }
        break
      case "tool_call.arguments.delta": {
        const t = this.tools.get(event.providerToolCallId) ?? { id: event.providerToolCallId, name: "", args: "", order: this.nextOrder++ }
        t.args += event.delta
        this.tools.set(event.providerToolCallId, t)
        break
      }
      case "tool_call.completed":
        break // completion is a boundary; args already accumulated
      case "usage":
        this.usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
        break
      case "response.completed":
        this.finishReason = event.finishReason
        break
      case "response.failed":
        this.failure = event.error
        break
    }
  }

  get textSoFar(): string {
    return this.text
  }
  get reasoningSoFar(): string {
    return this.reasoning
  }
  get usageSoFar(): { inputTokens?: number; outputTokens?: number } {
    return this.usage
  }
  isTerminal(): boolean {
    return this.finishReason !== null || this.failure !== null
  }

  /** The assembled turn. Throws if the stream failed (caller maps to provider_error). */
  result(): ModelTurn {
    if (this.failure) throw new StreamFailure(this.failure.message, this.failure.retryable)
    // `length` is the provider saying it ran out of output room, not the model
    // saying it was done. Recorded here and acted on by the runtime; before
    // this the reason was assembled and then dropped on the floor.
    const truncated = this.finishReason === "length"
    const calls = [...this.tools.values()]
      .sort((a, b) => a.order - b.order)
      .filter((t) => t.name.length > 0)
      .map((t): ToolCall => ({ id: t.id, name: t.name, input: parseArgs(t.args) }))
      // A turn cut off mid-arguments leaves the LAST call with unparseable
      // JSON, which `parseArgs` hands back as `{_raw}`. Executing that is how
      // an agent writes a half-finished file: the tool sees a shape it does not
      // recognise, or worse, one it partly does. A call the provider never
      // finished sending is not a call.
      .filter((c, i, all) => !(truncated && i === all.length - 1 && isUnparsed(c.input)))
    if (calls.length > 0) return { kind: "tools", calls, ...(truncated ? { truncated } : {}) }
    return { kind: "final", text: this.text, ...(truncated ? { truncated } : {}) }
  }
}

export class StreamFailure extends Error {
  constructor(
    message: string,
    readonly retryable?: boolean,
  ) {
    super(message)
    this.name = "StreamFailure"
  }
}

/** Robust tool-arg parse: valid JSON object stays; malformed is kept as `_raw`. */
/** What `parseArgs` returns when the JSON did not parse. */
const isUnparsed = (input: unknown): boolean =>
  typeof input === "object" && input !== null && "_raw" in (input as Record<string, unknown>)

function parseArgs(argsText: string): unknown {
  const trimmed = argsText.trim()
  if (trimmed === "") return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    return { _raw: argsText }
  }
}

export interface DeltaWriter {
  /** Persist one batch of accumulated display text; returns false if dropped (late). */
  write(text: string): Promise<boolean>
}

const utf8 = new TextEncoder()

/**
 * Buffers text deltas and flushes on a byte threshold or at any durable boundary.
 * `reasoning.delta` is display-only and never persisted here.
 */
export class BufferedDeltaSink implements StreamSink {
  private buffer = ""
  constructor(
    private readonly writer: DeltaWriter,
    private readonly maxBytes = 2048,
  ) {}

  async onEvent(event: ModelStreamEvent): Promise<void> {
    switch (event.type) {
      case "text.delta":
        this.buffer += event.text
        if (utf8.encode(this.buffer).length >= this.maxBytes) await this.flush()
        break
      case "tool_call.started":
      case "response.completed":
      case "response.failed":
        await this.flush() // boundary: text before a tool call / terminal must be durable
        break
    }
  }

  /** Force any buffered text out (call before a checkpoint or on cancellation). */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const text = this.buffer
    this.buffer = ""
    await this.writer.write(text)
  }
}

/**
 * Replay persisted streamed text after a cursor — the source of truth for a
 * consumer that reconnected or restarted. It reads the durable delta batches
 * (never the live socket), so a display can catch up from `afterSequence`
 * without losing or duplicating text. Ordered by sequence.
 */
export function replayStreamText(
  events: readonly { readonly type: string; readonly sequence: string | number | bigint; readonly data: unknown }[],
  afterSequence = 0,
): Array<{ sequence: number; text: string }> {
  return events
    .filter((e) => e.type === "message.delta_batch" && Number(e.sequence) > afterSequence)
    .map((e) => ({ sequence: Number(e.sequence), text: (e.data as { text: string }).text }))
    .sort((a, b) => a.sequence - b.sequence)
}
