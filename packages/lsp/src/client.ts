/**
 * The language-server client (Sprint 37) — and what it says when it cannot
 * answer.
 *
 * A language server is a separate process that crashes, hangs, and indexes for
 * thirty seconds after it starts. Every one of those is normal, and every one
 * of them arrives at the agent as a missing answer. What the agent does with a
 * missing answer decides whether code intelligence is an asset or a liability:
 *
 *   the wrong answer   fall back to a text search and present the result as if
 *                      the language server had produced it. The agent then
 *                      deletes a function with "12 references" that actually
 *                      had 30, because grep does not see the re-export.
 *   the right answer   UNAVAILABLE. A tool that says "I could not find out" is
 *                      usable. A tool that guesses is worse than no tool,
 *                      because its output is indistinguishable from knowledge.
 *
 * So every result here is a discriminated union with `unavailable` in it, and
 * there is no code path that turns a dead server into an empty array. An empty
 * array means the server answered and found nothing. That is a different fact.
 *
 * The transport is INJECTED. Nothing in this package spawns a process — the
 * host supplies the pipe — which keeps process execution behind the enforcement
 * point and lets the gate kill a server mid-request for real.
 */

export interface LspPosition {
  readonly line: number
  readonly character: number
}

export interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}

export interface LspLocation {
  readonly uri: string
  readonly range: LspRange
}

export interface LspDiagnostic {
  readonly uri: string
  readonly range: LspRange
  readonly severity: "error" | "warning" | "information" | "hint"
  readonly message: string
  readonly code?: string
  readonly source?: string
}

/** Every answer is one of these. There is no fourth case and no fallback. */
export type LspResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "unavailable"; readonly why: string; readonly recoverable: boolean }

export const ok = <T>(value: T): LspResult<T> => ({ kind: "ok", value })
export const unavailable = <T>(why: string, recoverable = true): LspResult<T> => ({
  kind: "unavailable",
  why,
  recoverable,
})

/** The pipe to one server process. Supplied by the host; nothing here spawns. */
export interface LspTransport {
  /** Send a request and resolve with the raw result. Rejects on transport death. */
  request(method: string, params: unknown): Promise<unknown>
  /** Fire-and-forget notification. */
  notify(method: string, params: unknown): void
  /** Resolves when the process exits, with the reason. Never rejects. */
  exited(): Promise<{ code: number | null; signal?: string }>
  /** Ask the process to stop. Idempotent. */
  kill(): void
  /** Diagnostics the server pushes without being asked. */
  onDiagnostics?(handler: (params: { uri: string; diagnostics: readonly LspDiagnostic[] }) => void): void
}

export interface LspClientOptions {
  readonly transport: LspTransport
  readonly rootUri: string
  readonly languageId: string
  /** Per-request budget. A hung server is the common case, not the rare one. */
  readonly requestTimeoutMs?: number
  readonly now?: () => number
}

export type ClientState = "starting" | "ready" | "crashed" | "stopped"

const DEFAULT_TIMEOUT = 10_000

export class LspClient {
  private state: ClientState = "starting"
  private crashReason?: string
  private readonly open = new Map<string, { version: number; text: string }>()
  private readonly diagnostics = new Map<string, readonly LspDiagnostic[]>()

  constructor(private readonly options: LspClientOptions) {
    this.options.transport.onDiagnostics?.(({ uri, diagnostics }) => {
      this.diagnostics.set(uri, diagnostics)
    })
    void this.watchForExit()
  }

  /**
   * A server that exits is CRASHED from that moment on.
   *
   * Recorded eagerly rather than discovered on the next request, because the
   * gap between "the process died" and "somebody asked it something" is where
   * a stale answer would otherwise be served as current.
   */
  private async watchForExit(): Promise<void> {
    const exit = await this.options.transport.exited()
    if (this.state === "stopped") return
    this.state = "crashed"
    this.crashReason = `the language server exited (code ${exit.code ?? "null"}${exit.signal !== undefined ? `, signal ${exit.signal}` : ""})`
  }

  status(): { state: ClientState; why?: string } {
    return { state: this.state, ...(this.crashReason !== undefined ? { why: this.crashReason } : {}) }
  }

  async initialize(): Promise<LspResult<{ capabilities: unknown }>> {
    const result = await this.send<{ capabilities?: unknown }>("initialize", {
      rootUri: this.options.rootUri,
      capabilities: {},
    })
    if (result.kind === "unavailable") return result
    // Only a STARTING client becomes ready. A server that died during
    // initialisation would otherwise have `ready` written over `crashed` by
    // the very call that was meant to bring it up, and every later request
    // would be attempted against a dead pipe instead of returning
    // `unavailable` immediately. Found by the gate that kills a server and
    // then stops the client.
    if (this.state !== "starting") return unavailable(this.crashReason ?? `the client is ${this.state}`, false)
    this.options.transport.notify("initialized", {})
    this.state = "ready"
    return ok({ capabilities: result.value?.capabilities ?? {} })
  }

  /**
   * One request, with a timeout and no invented answer.
   *
   * The timeout resolves to `unavailable` rather than rejecting: a hung server
   * is an expected condition, and an exception here would propagate as a run
   * failure for something that should have been a shrug.
   */
  private async send<T>(method: string, params: unknown): Promise<LspResult<T>> {
    if (this.state === "crashed") return unavailable(this.crashReason ?? "the language server has crashed", false)
    if (this.state === "stopped") return unavailable("the language server was stopped", false)

    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<LspResult<T>>((resolve) => {
      timer = setTimeout(() => resolve(unavailable(`${method} did not answer within ${timeoutMs}ms`)), timeoutMs)
    })

    try {
      const raced = await Promise.race([
        this.options.transport.request(method, params).then((value) => ok(value as T)),
        timeout,
      ])
      return raced
    } catch (e) {
      // a transport that throws is a dead pipe, whatever the state said
      this.state = "crashed"
      this.crashReason = e instanceof Error ? e.message : String(e)
      return unavailable(`${method} failed: ${this.crashReason}`, false)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  // ---- document synchronisation -------------------------------------------

  /**
   * Open a document, or update it.
   *
   * The version is tracked here because a server answering about version 3
   * while the disk holds version 5 gives answers that are wrong in the most
   * expensive way — right-looking positions in the wrong text.
   */
  didOpenOrChange(uri: string, text: string, languageId: string = this.options.languageId): void {
    if (this.state !== "ready") return
    const existing = this.open.get(uri)
    if (existing === undefined) {
      this.open.set(uri, { version: 1, text })
      this.options.transport.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      })
      return
    }
    if (existing.text === text) return
    const version = existing.version + 1
    this.open.set(uri, { version, text })
    this.options.transport.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    })
  }

  didClose(uri: string): void {
    if (!this.open.delete(uri)) return
    this.options.transport.notify("textDocument/didClose", { textDocument: { uri } })
  }

  /** What the client believes the server currently holds. */
  syncedVersion(uri: string): number | undefined {
    return this.open.get(uri)?.version
  }

  // ---- queries -------------------------------------------------------------

  async definition(uri: string, position: LspPosition): Promise<LspResult<LspLocation[]>> {
    const result = await this.send<unknown>("textDocument/definition", { textDocument: { uri }, position })
    return result.kind === "ok" ? ok(toLocations(result.value)) : result
  }

  async references(uri: string, position: LspPosition, includeDeclaration = false): Promise<LspResult<LspLocation[]>> {
    const result = await this.send<unknown>("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    })
    return result.kind === "ok" ? ok(toLocations(result.value)) : result
  }

  async documentSymbols(uri: string): Promise<LspResult<unknown[]>> {
    const result = await this.send<unknown>("textDocument/documentSymbol", { textDocument: { uri } })
    return result.kind === "ok" ? ok(Array.isArray(result.value) ? result.value : []) : result
  }

  /**
   * Diagnostics for a file.
   *
   * A file nobody opened has no diagnostics BECAUSE NOBODY ASKED, which is not
   * the same as being clean — so it is `unavailable`, not an empty list.
   */
  diagnosticsFor(uri: string): LspResult<readonly LspDiagnostic[]> {
    if (this.state === "crashed") return unavailable(this.crashReason ?? "crashed", false)
    if (!this.open.has(uri)) return unavailable(`${uri} was never opened, so no diagnostics were ever published for it`)
    return ok(this.diagnostics.get(uri) ?? [])
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return
    if (this.state !== "crashed") {
      await this.send("shutdown", null)
      this.options.transport.notify("exit", null)
    }
    this.state = "stopped"
    this.options.transport.kill()
  }
}

/** Normalise the three shapes `textDocument/definition` is allowed to return. */
function toLocations(value: unknown): LspLocation[] {
  if (value === null || value === undefined) return []
  const one = (v: unknown): LspLocation | undefined => {
    const record = v as Record<string, unknown>
    const uri = typeof record?.uri === "string" ? record.uri : typeof record?.targetUri === "string" ? record.targetUri : undefined
    const range = (record?.range ?? record?.targetSelectionRange ?? record?.targetRange) as LspRange | undefined
    return uri !== undefined && range !== undefined ? { uri, range } : undefined
  }
  const list = Array.isArray(value) ? value : [value]
  return list.map(one).filter((l): l is LspLocation => l !== undefined)
}
