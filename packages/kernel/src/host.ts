import {
  decodeEffectOutcome,
  decodeFrameHeader,
  encodeEffectRequest,
  FRAME_HEADER_BYTES,
  MAX_MESSAGE_BYTES,
  type EffectOutcome,
  type EffectRequest,
} from "./generated/contracts"

/**
 * The engine side of the kernel host.
 *
 * `ControlClient` carries envelopes across the boundary; this carries effects
 * across it and waits for what the ledger concluded. They are separate because
 * they refuse differently: an envelope that does not fit is dropped, and an
 * effect that was committed and never answered is a fact somebody has to
 * reconcile.
 *
 * Nothing here decides anything. Framing, the schema fingerprint and every
 * field rule come from the generated codec; a second parser here would be a
 * second opinion about the wire, and two opinions is how a boundary stops being
 * one.
 */

/** How many effects this client will have outstanding before refusing. */
export const DEFAULT_HOST_CAPACITY = 16

/**
 * What a send produced.
 *
 * Three answers, none of them silence. A client that resolved nothing when the
 * host died would be a caller hanging forever on a process that is gone, which
 * is the failure this shape exists to make impossible.
 */
export type HostReply =
  /** The host answered. What it says is the ledger's conclusion, not a promise. */
  | { readonly kind: "outcome"; readonly outcome: EffectOutcome }
  /** Refused because too many effects are already outstanding. Never silent. */
  | { readonly kind: "backpressure"; readonly capacity: number }
  /** The host is gone, or was never there. The reason is named. */
  | { readonly kind: "unreachable"; readonly reason: string }

export interface KernelHostOptions {
  /** The `abdo-kernel` binary this build produced. */
  readonly executable: string
  readonly journal: string
  /** `<64 hex characters>=<path>`, one per object the host may read. */
  readonly bindings: readonly string[]
  /** 64 hex characters. The host seals its own grants with it. */
  readonly sealingKey: string
  readonly capacity?: number
  /** Ask the host to commit a dispatch and stop, so it can be killed there. */
  readonly stopAfterCommit?: boolean
}

interface FrameSink {
  write(bytes: Uint8Array): unknown
  flush(): unknown
  end(): unknown
}

interface HostProcess {
  readonly stdin: unknown
  readonly stdout: unknown
  readonly stderr: unknown
  readonly exited: Promise<number>
  kill(): void
}

export class KernelHost {
  readonly #options: KernelHostOptions
  readonly #capacity: number
  readonly #waiting: ((reply: HostReply) => void)[] = []
  #child: HostProcess | undefined
  #sink: FrameSink | undefined
  #buffer = new Uint8Array(0)
  #unreachable: string | undefined
  #accepted = 0
  #refused = 0
  #highWater = 0

  constructor(options: KernelHostOptions) {
    const capacity = options.capacity ?? DEFAULT_HOST_CAPACITY
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("a kernel host client needs a positive integer capacity")
    }
    this.#options = options
    this.#capacity = capacity
  }

  get capacity(): number {
    return this.#capacity
  }

  get outstanding(): number {
    return this.#waiting.length
  }

  /**
   * The most effects that were ever outstanding at once.
   *
   * Reported because a bound is a claim about the worst moment, not about the
   * moment somebody happened to look.
   */
  get highWater(): number {
    return this.#highWater
  }

  get accepted(): number {
    return this.#accepted
  }

  get refused(): number {
    return this.#refused
  }

  /** Why the host is gone, if it is. */
  get unreachable(): string | undefined {
    return this.#unreachable
  }

  start(): void {
    if (this.#child !== undefined) throw new Error("this kernel host client already started a host")
    const argv = [
      this.#options.executable,
      "--journal",
      this.#options.journal,
      "--sealing-key",
      this.#options.sealingKey,
      ...this.#options.bindings.flatMap((binding) => ["--bind", binding]),
    ]
    if (this.#options.stopAfterCommit === true) argv.push("--stop-after-commit")
    const child = Bun.spawn(argv, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }) as unknown as HostProcess
    this.#child = child
    this.#sink = child.stdin as FrameSink
    void this.#pump(child.stdout as ReadableStream<Uint8Array>)
    // A host that exits owes an answer to everything still in flight. Waiting
    // for its exit is how that answer gets sent instead of never arriving.
    void child.exited.then((status) => {
      this.#collapse(`the kernel host exited with status ${status}`)
    })
  }

  /**
   * Ask the host to discharge one effect.
   *
   * Resolves rather than throws, for every outcome including the bad ones. A
   * refusal that arrives as an exception is one a caller can forget to catch;
   * one that arrives as a value has to be read.
   */
  async send(request: EffectRequest): Promise<HostReply> {
    if (this.#unreachable !== undefined) {
      return { kind: "unreachable", reason: this.#unreachable }
    }
    const sink = this.#sink
    if (sink === undefined) return { kind: "unreachable", reason: "no kernel host was started" }
    if (this.#waiting.length >= this.#capacity) {
      this.#refused += 1
      return { kind: "backpressure", capacity: this.#capacity }
    }

    const frame = encodeEffectRequest(request)
    const reply = new Promise<HostReply>((resolve) => {
      this.#waiting.push(resolve)
    })
    this.#accepted += 1
    if (this.#waiting.length > this.#highWater) this.#highWater = this.#waiting.length
    try {
      sink.write(frame)
      sink.flush()
    } catch (error) {
      this.#collapse(`the kernel host would not take a frame: ${describe(error)}`)
    }
    return reply
  }

  /** Close the input the host is waiting on, and wait for it to finish. */
  async close(): Promise<number> {
    const child = this.#child
    if (child === undefined) return 0
    try {
      this.#sink?.end()
    } catch {
      // A sink that is already gone needs no closing, and failing to close it
      // is not a reason to leave the caller without the exit status.
    }
    return child.exited
  }

  /** Kill the host. Every effect still in flight is answered, not dropped. */
  async kill(reason: string): Promise<number> {
    const child = this.#child
    if (child === undefined) return 0
    child.kill()
    const status = await child.exited
    this.#collapse(reason)
    return status
  }

  /** Whatever the host wrote to its error stream, once it has finished. */
  async diagnostics(): Promise<string> {
    const child = this.#child
    if (child === undefined) return ""
    return new Response(child.stderr as ReadableStream<Uint8Array>).text()
  }

  async #pump(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done === true) break
        this.#absorb(chunk.value)
        if (this.#unreachable !== undefined) break
      }
    } catch (error) {
      this.#collapse(`the kernel host output could not be read: ${describe(error)}`)
    }
  }

  /**
   * Take bytes off the pipe and hand out whole frames.
   *
   * The length comes from the generated header decoder, so this file never
   * learns where a frame ends by counting bytes itself.
   */
  #absorb(chunk: Uint8Array) {
    const merged = new Uint8Array(this.#buffer.length + chunk.length)
    merged.set(this.#buffer, 0)
    merged.set(chunk, this.#buffer.length)
    this.#buffer = merged
    for (;;) {
      if (this.#buffer.length < FRAME_HEADER_BYTES) break
      let frameLength: number
      try {
        frameLength = decodeFrameHeader(this.#buffer.subarray(0, FRAME_HEADER_BYTES)).frameLength
      } catch (error) {
        this.#collapse(`the kernel host sent a header this build cannot read: ${describe(error)}`)
        return
      }
      if (this.#buffer.length < frameLength) {
        // A partial frame is normal; an unbounded partial frame is not. The
        // protocol caps a frame, so anything past that cap is a peer spending
        // this process's memory.
        if (this.#buffer.length > MAX_MESSAGE_BYTES) {
          this.#collapse("the kernel host sent more bytes than a frame may contain")
        }
        return
      }
      const frame = this.#buffer.subarray(0, frameLength)
      let outcome: EffectOutcome
      try {
        outcome = decodeEffectOutcome(frame)
      } catch (error) {
        this.#collapse(`the kernel host sent a frame this build cannot read: ${describe(error)}`)
        return
      }
      this.#buffer = this.#buffer.slice(frameLength)
      const waiting = this.#waiting.shift()
      if (waiting === undefined) {
        this.#collapse("the kernel host answered an effect nobody asked for")
        return
      }
      waiting({ kind: "outcome", outcome })
    }
  }

  /** Answer everything in flight with one named reason, and refuse the rest. */
  #collapse(reason: string) {
    if (this.#unreachable === undefined) this.#unreachable = reason
    const settled = this.#unreachable
    while (this.#waiting.length > 0) {
      const waiting = this.#waiting.shift()
      waiting?.({ kind: "unreachable", reason: settled })
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
