/**
 * THE EGRESS GUARD — this product may only talk to places it has declared.
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-20 an audit of this codebase found twenty-one live connections to
 * the upstream project it was forked from, two days after a severance whose
 * gate reported every check green. Among them: whole sessions uploaded on every
 * message; a catalogue fetched at each launch with a User-Agent that
 * fingerprinted the installation; a tracking image planted in the USER'S pull
 * requests; a script that installed a stranger's build over the user's binary.
 *
 * None of them contained the upstream's name. Searching for a brand does not
 * find them. What they have in common is not a string — it is that each one
 * *reached a host nobody had declared*.
 *
 * So the guarantee is stated in those terms: **an undeclared destination is
 * refused.** Not logged, not warned about — refused. A control that merely
 * reports is a control that a future defect will quietly outlive.
 *
 * WHY IT SITS ON globalThis.fetch
 *
 * There is no single HTTP client here. Seven modules construct their own
 * `FetchHttpClient.layer`, and a dozen more call `fetch` directly. A guard
 * placed on any one of them would protect that one. They all bottom out in
 * `globalThis.fetch`, which is therefore the only place a single check can
 * cover every path — including paths added tomorrow by someone who never read
 * this file. That last property is the point: a guard you must remember to use
 * is not a guard.
 *
 * WHAT IT CANNOT SEE, stated plainly rather than implied
 *
 *   - child processes: git, npm, brew, curl, a language server that was already
 *     downloaded. They have their own network stacks.
 *   - raw sockets and WebSockets, which do not route through fetch.
 *   - anything that runs before the guard is installed.
 *
 * These are real gaps. `describeCoverage()` returns them so that a report can
 * print them, because a security control that lets its reader believe it covers
 * more than it does has already misled them.
 */

export type EgressDecision = "allowed" | "denied"

export interface EgressAttempt {
  readonly host: string
  readonly decision: EgressDecision
  readonly reason: string
  /** Wall-clock is injected so this module stays testable. */
  readonly at: number
}

export interface EgressRule {
  /** Exact host, or a leading-dot suffix such as ".example.com". */
  readonly match: string
  /** Why this destination is permitted. Written for a person, not a linter. */
  readonly why: string
}

export interface EgressPolicy {
  readonly rules: readonly EgressRule[]
  /**
   * Hosts that are never permitted regardless of any rule, so that a
   * broadly-written allow rule can never re-open a severed connection.
   */
  readonly forbidden: readonly EgressRule[]
}

/**
 * Destinations this product is permitted to reach on its own behalf.
 *
 * Deliberately tiny. This is not "hosts that seem fine" — it is the complete
 * list of places the software itself initiates contact with, each with a
 * reason. Model providers are NOT listed here: they are added at runtime, and
 * only once the user has configured them (see `allowProviderHosts`). The
 * product talking to a provider the user chose is the user's decision; the
 * product talking to anywhere else is ours, and has to be justified here.
 */
export const BASE_POLICY: EgressPolicy = {
  rules: [
    { match: "localhost", why: "local services, including a local model server" },
    { match: "127.0.0.1", why: "same" },
    { match: "::1", why: "same" },
    { match: "0.0.0.0", why: "same" },
  ],
  forbidden: [
    { match: ".opencode.ai", why: "upstream project" },
    { match: "opencode.ai", why: "upstream project" },
    { match: ".opncd.ai", why: "upstream short domain — the session-upload endpoint" },
    { match: "opncd.ai", why: "upstream short domain — the session-upload endpoint" },
    { match: ".anoma.ly", why: "upstream company" },
    { match: "anoma.ly", why: "upstream company" },
    { match: ".sst.dev", why: "upstream parent brand — social-cards.sst.dev was a tracking beacon" },
    { match: "sst.dev", why: "upstream parent brand" },
    { match: "models.dev", why: "upstream catalogue; a snapshot is vendored in this repository instead" },
  ],
}

function hostMatches(host: string, rule: string): boolean {
  const h = host.toLowerCase()
  const r = rule.toLowerCase()
  if (r.startsWith(".")) return h === r.slice(1) || h.endsWith(r)
  return h === r
}

/** State is module-local and explicit, so a test can reset it. */
interface GuardState {
  installed: boolean
  original?: typeof globalThis.fetch
  allowed: Map<string, string>
  policy: EgressPolicy
  ledger: EgressAttempt[]
  enforce: boolean
}

const state: GuardState = {
  installed: false,
  allowed: new Map(),
  policy: BASE_POLICY,
  ledger: [],
  enforce: true,
}

/**
 * Permit a destination at runtime, with a reason.
 *
 * This is how a provider the USER configured becomes reachable: the product
 * ships permission to talk to nobody, and gains it only for the providers the
 * user actually chose.
 */
export function allow(host: string, why: string): void {
  if (!host) return
  state.allowed.set(host.toLowerCase(), why)
}

/**
 * Permit every provider endpoint in a catalogue.
 *
 * Called with the compiled-in catalogue once a provider is resolved. The
 * catalogue is data we ship, so this widens the policy to exactly the set of
 * providers this build offers — and to nothing else.
 */
export function allowProviderHosts(catalog: Record<string, { api?: string; name?: string }>): number {
  let added = 0
  for (const [id, provider] of Object.entries(catalog ?? {})) {
    if (!provider?.api) continue
    try {
      const host = new URL(provider.api).hostname
      if (!state.allowed.has(host.toLowerCase())) added++
      allow(host, `model provider ${provider.name ?? id}`)
    } catch {
      // A catalogue entry with an unparseable api is skipped rather than
      // widening the policy to something we could not read.
    }
  }
  return added
}

export function decide(host: string): { decision: EgressDecision; reason: string } {
  const forbidden = state.policy.forbidden.find((r) => hostMatches(host, r.match))
  if (forbidden) return { decision: "denied", reason: `forbidden destination (${forbidden.why})` }

  const rule = state.policy.rules.find((r) => hostMatches(host, r.match))
  if (rule) return { decision: "allowed", reason: rule.why }

  const runtime = state.allowed.get(host.toLowerCase())
  if (runtime) return { decision: "allowed", reason: runtime }

  return { decision: "denied", reason: "destination was never declared" }
}

export class EgressDeniedError extends Error {
  readonly host: string
  constructor(host: string, reason: string) {
    super(
      `egress refused: ${host} — ${reason}.\n` +
        `This build only contacts destinations it declares. If this host is legitimate, ` +
        `declare it in packages/core/src/security/egress.ts with a reason, or configure ` +
        `the provider that needs it.`,
    )
    this.name = "EgressDeniedError"
    this.host = host
  }
}

/**
 * Wrap `globalThis.fetch`. Idempotent: installing twice is a no-op rather than
 * a double wrap, because a double wrap would make the ledger lie.
 */
export function install(options?: { enforce?: boolean; now?: () => number }): void {
  if (state.installed) return
  const now = options?.now ?? (() => Date.now())
  state.enforce = options?.enforce ?? true
  state.original = globalThis.fetch

  const original = state.original
  if (typeof original !== "function") return

  globalThis.fetch = (async (input: any, init?: any) => {
    let host = ""
    try {
      const url = typeof input === "string" ? input : input?.url ?? String(input)
      host = new URL(url, "http://localhost").hostname
    } catch {
      host = ""
    }

    const { decision, reason } = host ? decide(host) : { decision: "allowed" as const, reason: "no host" }
    state.ledger.push({ host, decision, reason, at: now() })

    if (decision === "denied" && state.enforce) throw new EgressDeniedError(host, reason)
    return original(input, init)
  }) as typeof globalThis.fetch

  state.installed = true
}

/** Restore the original fetch. For tests, and for nothing else. */
export function uninstall(): void {
  if (!state.installed) return
  if (state.original) globalThis.fetch = state.original
  state.installed = false
  state.original = undefined
}

export function isInstalled(): boolean {
  return state.installed
}

export function ledger(): readonly EgressAttempt[] {
  return state.ledger
}

export function reset(): void {
  uninstall()
  state.allowed = new Map()
  state.ledger = []
  state.policy = BASE_POLICY
  state.enforce = true
}

/** Every destination this build may reach, with the reason for each. */
export function declared(): EgressRule[] {
  return [
    ...state.policy.rules.map((r) => ({ ...r })),
    ...[...state.allowed.entries()].map(([match, why]) => ({ match, why })),
  ]
}

/**
 * What this guard does NOT cover. Returned rather than commented so a report
 * can print it: a control whose limits are invisible will be trusted past them.
 */
export function describeCoverage(): string[] {
  return [
    "covers every call through globalThis.fetch, including Effect's HttpClient",
    "does NOT cover child processes (git, npm, brew, curl, language servers)",
    "does NOT cover raw sockets or WebSocket connections",
    "does NOT cover anything that ran before the guard was installed",
  ]
}
