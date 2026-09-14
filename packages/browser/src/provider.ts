/**
 * The browser provider port (Sprint 60) and the session daemon (Sprint 61).
 *
 * The owner's ordering rule governs this whole package and is worth stating
 * before any code: DOM and the accessibility tree first, semantics before
 * pixels, vision only after a RECORDED semantic failure, and raw coordinates
 * last. Every agent that drives a browser badly does it in the opposite order,
 * because a screenshot and a click at (412, 388) is the shortest thing to
 * write. It is also the thing that breaks when a banner appears.
 *
 * Sprint 60 is the seam that makes the rest possible: the agent's logic talks
 * to a PROVIDER, and swapping Playwright for CDP for BiDi changes nothing above
 * this line. The test of that claim is not an interface — it is running the
 * same agent logic against two providers and getting the same decisions, which
 * is what the gate does.
 *
 * Nothing in this package launches a browser. The provider is injected, as
 * every process-touching thing has been since Sprint 24.
 */

export interface DomNode {
  readonly nodeId: string
  readonly tag: string
  readonly attributes: Readonly<Record<string, string>>
  readonly text?: string
  readonly children: readonly DomNode[]
}

/**
 * One node of the accessibility tree.
 *
 * Role and name are the stable pair. A button that changes colour, class,
 * position and DOM depth is still `button "Save"`, which is why Sprint 63
 * targets on this rather than on a CSS selector.
 */
export interface AxNode {
  readonly nodeId: string
  readonly role: string
  readonly name: string
  readonly value?: string
  readonly disabled?: boolean
  readonly focused?: boolean
  /** Where it is, for the coordinate fallback of last resort. */
  readonly box?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly children: readonly AxNode[]
}

export interface ConsoleMessage {
  readonly level: "log" | "info" | "warning" | "error"
  readonly text: string
  readonly at: number
}

export interface NetworkEvent {
  readonly url: string
  readonly method: string
  readonly status?: number
  readonly failed?: boolean
  readonly at: number
}

/** Serialised cookies and storage — what makes a session survive a crash. */
export interface StorageState {
  readonly cookies: readonly { readonly name: string; readonly value: string; readonly domain: string }[]
  readonly origins: readonly { readonly origin: string; readonly localStorage: Readonly<Record<string, string>> }[]
}

export type ProviderName = "playwright" | "cdp" | "bidi"

/**
 * Everything the agent may ask a browser to do.
 *
 * Deliberately small and deliberately semantic. There is no `click(x, y)` at
 * this level: coordinates enter through Sprint 67's guarded path, so a provider
 * cannot offer the agent a shortcut past the ordering rule.
 */
export interface BrowserProvider {
  readonly name: ProviderName
  navigate(url: string): Promise<void>
  currentUrl(): Promise<string>
  dom(): Promise<DomNode>
  accessibility(): Promise<AxNode>
  /** Click a node the agent found semantically. */
  clickNode(nodeId: string): Promise<void>
  typeInto(nodeId: string, text: string): Promise<void>
  /** Read a field back — the only way to know what actually landed. */
  readValue(nodeId: string): Promise<string | undefined>
  screenshot(): Promise<Uint8Array>
  consoleMessages(): Promise<readonly ConsoleMessage[]>
  networkEvents(): Promise<readonly NetworkEvent[]>
  storageState(): Promise<StorageState>
  restoreStorage(state: StorageState): Promise<void>
  /** Raw pointer. Reached only through the Sprint 67 guard. */
  clickAt(x: number, y: number): Promise<void>
  close(): Promise<void>
}

// --------------------------------------------------------------------------
// Sprint 61 — the persistent daemon
// --------------------------------------------------------------------------

export interface SessionSnapshot {
  readonly sessionId: string
  readonly url: string
  readonly storage: StorageState
  readonly at: number
}

export type DaemonState = "starting" | "ready" | "crashed" | "closed"

export interface DaemonOptions {
  readonly sessionId: string
  /** Makes a provider. Called again after a crash. */
  readonly launch: () => Promise<BrowserProvider>
  readonly now?: () => number
  /** How often the daemon takes a snapshot it could restore from. */
  readonly snapshotEveryMs?: number
}

/**
 * A browser that survives its own crash without losing the login.
 *
 * The property that matters is narrow and specific: after a crash, the agent
 * must not have to log in again. Everything else about a browser session is
 * cheap to rebuild; the authenticated state is the part that costs a human's
 * time, a 2FA code, or a rate limit.
 *
 * So the daemon snapshots cookies and storage, and a restart restores them
 * BEFORE navigating. A restart that navigates first and restores second lands
 * on the login page and then applies the cookies to it, which looks like it
 * worked and leaves the agent one redirect from where it thinks it is.
 */
export class BrowserDaemon {
  private provider?: BrowserProvider
  private state: DaemonState = "starting"
  private snapshot?: SessionSnapshot
  private crashes = 0

  constructor(private readonly options: DaemonOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  status(): { state: DaemonState; crashes: number; hasSnapshot: boolean } {
    return { state: this.state, crashes: this.crashes, hasSnapshot: this.snapshot !== undefined }
  }

  async start(): Promise<BrowserProvider> {
    this.provider = await this.options.launch()
    this.state = "ready"
    return this.provider
  }

  /** Record what a restart would need. Cheap, and taken on purpose after login. */
  async capture(): Promise<SessionSnapshot> {
    if (this.provider === undefined) throw new Error("the daemon has not started")
    const snapshot: SessionSnapshot = {
      sessionId: this.options.sessionId,
      url: await this.provider.currentUrl(),
      storage: await this.provider.storageState(),
      at: this.now(),
    }
    this.snapshot = snapshot
    return snapshot
  }

  markCrashed(why: string): void {
    this.state = "crashed"
    this.crashes++
    void why
  }

  /**
   * Bring the browser back to where it was.
   *
   * Restore, THEN navigate. The order is the whole trick and getting it wrong
   * produces a session that is authenticated for a page it is no longer on.
   */
  async recover(): Promise<{ recovered: boolean; why: string; url?: string }> {
    if (this.snapshot === undefined)
      return {
        recovered: false,
        why: "no snapshot was ever captured, so the login cannot be restored — the agent has to authenticate again",
      }
    this.provider = await this.options.launch()
    await this.provider.restoreStorage(this.snapshot.storage)
    await this.provider.navigate(this.snapshot.url)
    this.state = "ready"
    return {
      recovered: true,
      why: `restored ${this.snapshot.storage.cookies.length} cookie(s) and ${this.snapshot.storage.origins.length} origin(s) BEFORE navigating, then returned to ${this.snapshot.url}`,
      url: this.snapshot.url,
    }
  }

  current(): BrowserProvider {
    if (this.provider === undefined) throw new Error("the daemon has not started")
    return this.provider
  }

  async close(): Promise<void> {
    await this.provider?.close()
    this.state = "closed"
  }
}
