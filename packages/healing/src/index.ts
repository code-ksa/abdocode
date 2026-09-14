/**
 * Self-healing (Sprints 93-96).
 *
 * Recovery is the part of an agent that is easiest to fake. "It retried and
 * succeeded" is a sentence anybody can write, and the usual implementation is a
 * loop that repeats the same call until something changes or the budget dies.
 * Four rules make the difference:
 *
 *   S93  the same failure must produce the SAME fingerprint on another machine
 *        next month, or nothing can be learned from it
 *   S94  a strategy that failed is not retried while THE WORLD IS UNCHANGED —
 *        the loop is the failure, not the strategy
 *   S95  a reboot mid-sprint resumes, and a dead run cannot hold a claim
 *   S96  a rollback never touches a committed sprint, and every injected fault
 *        is classified and either recovered or escalated. Never silent.
 */

// --------------------------------------------------------------------------
// Sprint 93 — failure fingerprinting
// --------------------------------------------------------------------------

export interface FailureInput {
  /** The error class from Sprint 15's taxonomy. */
  readonly failureClass: string
  readonly message: string
  /** Where it happened — tool name, command, or phase. */
  readonly site: string
  readonly exitCode?: number | null
  readonly stack?: string
}

/**
 * Everything that varies between two occurrences of ONE failure.
 *
 * This list is the whole sprint. A fingerprint that keeps a path, a pid, a
 * timestamp or a port is a fingerprint that never matches twice, and a
 * knowledge base keyed on it stays empty while looking full.
 */
const VOLATILE: readonly { readonly re: RegExp; readonly with: string }[] = [
  { re: /\b[A-Za-z]:\\[^\s"'`]+/g, with: "<path>" },
  { re: /(?:^|[\s"'`(])\/(?:[\w.-]+\/)+[\w.-]+/g, with: " <path>" },
  { re: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, with: "<time>" },
  { re: /\b(?:pid|PID)[= ]?\d+\b/g, with: "pid=<n>" },
  { re: /\bport[= ]?\d{2,5}\b/gi, with: "port=<n>" },
  { re: /:\d{2,5}\b/g, with: ":<port>" },
  { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, with: "<uuid>" },
  { re: /\b[0-9a-f]{7,40}\b/gi, with: "<hash>" },
  { re: /\b\d{3,}\b/g, with: "<n>" },
  { re: /0x[0-9a-f]+/gi, with: "<addr>" },
]

/** FNV-1a: stable across processes and machines, unlike anything hash-seeded. */
function stableHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

export const normaliseFailure = (message: string): string => {
  let out = message
  for (const { re, with: replacement } of VOLATILE) out = out.replace(re, replacement)
  return out.replace(/\s+/g, " ").trim().toLowerCase()
}

export interface Fingerprint {
  readonly id: string
  readonly failureClass: string
  readonly site: string
  readonly normalised: string
}

/**
 * A fingerprint that is the same failure on another machine next month.
 *
 * Deliberately built from class + site + normalised message and nothing else.
 * The stack is excluded: line numbers move with every edit, and a fingerprint
 * that changes when an unrelated import is added has told you nothing.
 */
export function fingerprint(input: FailureInput): Fingerprint {
  const normalised = normaliseFailure(input.message)
  const site = normaliseFailure(input.site)
  return {
    id: stableHash(`${input.failureClass}|${site}|${normalised}`),
    failureClass: input.failureClass,
    site,
    normalised,
  }
}

// --------------------------------------------------------------------------
// Sprint 94 — the strategy ladder
// --------------------------------------------------------------------------

export interface WorldState {
  /** Anything whose change could make a repeat worth trying. */
  readonly facts: Readonly<Record<string, string>>
}

export const worldHash = (world: WorldState): string =>
  stableHash(
    Object.entries(world.facts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&"),
  )

export interface Attempt {
  readonly fingerprintId: string
  readonly strategy: string
  readonly worldHash: string
  readonly at: number
}

export type LadderDecision =
  | { readonly kind: "try"; readonly strategy: string; readonly why: string }
  | { readonly kind: "wait"; readonly why: string; readonly changeNeeded: string }
  | { readonly kind: "escalate"; readonly why: string; readonly tried: readonly string[] }

/**
 * What to do about a failure that just happened.
 *
 * The rule that stops the stupid loop: a strategy already tried for THIS
 * fingerprint WITH THIS WORLD is not tried again. Retrying while nothing has
 * changed is not a retry — it is the same call, and the only thing it consumes
 * is budget.
 *
 * `wait` is a real answer and the useful one. It says: this could work, but not
 * until something moves, and here is what has to move. An agent that gets that
 * back can go and change the world instead of hammering the same door.
 */
export function nextStrategy(
  ladder: readonly string[],
  attempts: readonly Attempt[],
  context: { fingerprintId: string; world: WorldState },
): LadderDecision {
  const hash = worldHash(context.world)
  const mine = attempts.filter((a) => a.fingerprintId === context.fingerprintId)
  const triedNow = new Set(mine.filter((a) => a.worldHash === hash).map((a) => a.strategy))
  const triedEver = new Set(mine.map((a) => a.strategy))

  const fresh = ladder.find((s) => !triedNow.has(s))
  if (fresh !== undefined)
    return {
      kind: "try",
      strategy: fresh,
      why:
        triedEver.has(fresh)
          ? `${fresh} failed before, but the world has changed since (${hash}) — that is what makes a repeat a retry rather than the same call`
          : `${fresh} has not been tried for this failure`,
    }

  // Everything has been tried against THIS world. Whether that is "wait" or
  // "escalate" depends on something the first version of this function never
  // asked: has changing the world already been tried?
  //
  // The dead branch is worth recording. `wait` was originally guarded by
  // `ladder.length > triedEver.size`, which can never be true here — triedEver
  // is a superset of triedNow, and triedNow already covers the ladder. So the
  // function had a documented outcome it could not reach, which is a comment
  // describing behaviour that does not exist.
  const worldsPerStrategy = new Map<string, Set<string>>()
  for (const attempt of mine) {
    const worlds = worldsPerStrategy.get(attempt.strategy) ?? new Set<string>()
    worlds.add(attempt.worldHash)
    worldsPerStrategy.set(attempt.strategy, worlds)
  }
  const everyStrategyTriedTwice = ladder.every((s) => (worldsPerStrategy.get(s)?.size ?? 0) >= 2)

  if (!everyStrategyTriedTwice)
    return {
      kind: "wait",
      changeNeeded: "any fact in the world state",
      why: `every strategy has been tried against this exact world (${hash}); one could still work, but not until something moves — and no strategy has yet been tried under a second world`,
    }

  return {
    kind: "escalate",
    tried: [...triedEver],
    why: `the ladder is exhausted: every strategy has failed under more than one world (${[...triedEver].join(", ")}) — changing the world has already been tried and did not help`,
  }
}

// --------------------------------------------------------------------------
// Sprint 95 — reboot reconciliation and the watchdog
// --------------------------------------------------------------------------

export interface RunHeartbeat {
  readonly runId: string
  readonly agentId: string
  readonly lastBeatAt: number
  readonly intervalMs: number
  readonly holdsClaim?: string
}

export interface WatchdogVerdict {
  readonly dead: readonly RunHeartbeat[]
  readonly alive: readonly RunHeartbeat[]
  readonly claimsToRelease: readonly string[]
  readonly why: string
}

/**
 * Which runs stopped breathing, and what they were holding.
 *
 * The tolerance is three missed beats rather than one: a single missed beat is
 * a slow disk or a stop-the-world pause, and killing a healthy run for that is
 * worse than waiting two more intervals for a genuinely dead one.
 */
export function watchdog(beats: readonly RunHeartbeat[], now: number, missedBeats = 3): WatchdogVerdict {
  const dead = beats.filter((b) => now - b.lastBeatAt > b.intervalMs * missedBeats)
  const alive = beats.filter((b) => !dead.includes(b))
  const claimsToRelease = dead.map((d) => d.holdsClaim).filter((c): c is string => c !== undefined)
  return {
    dead,
    alive,
    claimsToRelease,
    why:
      dead.length === 0
        ? `${alive.length} run(s) breathing`
        : `${dead.length} run(s) missed ${missedBeats} beats and are holding ${claimsToRelease.length} claim(s) — a dead run must not hold a claim for ever`,
  }
}

export interface RebootState {
  /** Sprints the ledger says were in flight. */
  readonly inFlight: readonly { readonly sprintId: string; readonly state: string; readonly commit?: string }[]
  /** Whether the working tree matches what the ledger last recorded. */
  readonly treeMatchesLedger: boolean
  readonly treeReadable: boolean
}

export type RebootDecision =
  | { readonly kind: "resume"; readonly sprintId: string; readonly why: string }
  | { readonly kind: "reconcile_first"; readonly why: string }
  | { readonly kind: "nothing_to_do"; readonly why: string }

/**
 * What to do after the machine came back.
 *
 * Resuming onto a tree nobody has checked is how a restart destroys a manual
 * fix somebody made while the machine was down — which is Sprint 24's rule,
 * arriving here through a different door. An unreadable tree is NOT a clean
 * one, and it blocks for the same reason.
 */
export function afterReboot(state: RebootState): RebootDecision {
  const running = state.inFlight.filter((s) => s.state !== "COMMITTED" && s.state !== "CLOSED")
  if (running.length === 0) return { kind: "nothing_to_do", why: "no sprint was in flight when the machine went down" }

  if (!state.treeReadable)
    return { kind: "reconcile_first", why: "the working tree could not be read — a blind spot is not a clean tree" }

  if (!state.treeMatchesLedger)
    return {
      kind: "reconcile_first",
      why: `the tree does not match what the ledger last recorded — resuming onto it is how a restart destroys a manual fix somebody made while the machine was down`,
    }

  return { kind: "resume", sprintId: running[0]!.sprintId, why: `${running[0]!.sprintId} was in flight and the tree matches the ledger` }
}

// --------------------------------------------------------------------------
// Sprint 96 — rollback, escalation, and no silence
// --------------------------------------------------------------------------

export interface SprintSnapshot {
  readonly sprintId: string
  readonly state: string
  readonly commit?: string
  readonly filesChanged: readonly string[]
}

export type RollbackDecision =
  | { readonly kind: "rollback"; readonly files: readonly string[]; readonly why: string }
  | { readonly kind: "refuse"; readonly why: string; readonly wouldTouch: readonly string[] }

/**
 * Undo a sprint — and never a committed one.
 *
 * The refusal is not about permissions. A committed sprint is work somebody
 * else's work now sits on top of, and rolling it back does not restore an
 * earlier state; it produces a state that never existed, in which a later
 * sprint depends on something that is no longer there.
 *
 * A file touched by BOTH the target and a committed sprint is also refused,
 * with the overlap named. Reverting it would silently undo part of the
 * committed one.
 */
export function planRollback(target: SprintSnapshot, committed: readonly SprintSnapshot[]): RollbackDecision {
  if (target.state === "COMMITTED" || target.state === "CLOSED")
    return {
      kind: "refuse",
      wouldTouch: target.filesChanged,
      why: `${target.sprintId} is ${target.state} — later work sits on top of it, and undoing it produces a state that never existed rather than an earlier one`,
    }

  const committedFiles = new Set(committed.flatMap((s) => s.filesChanged))
  const overlap = target.filesChanged.filter((f) => committedFiles.has(f))
  if (overlap.length > 0)
    return {
      kind: "refuse",
      wouldTouch: overlap,
      why: `${overlap.join(", ")} ${overlap.length === 1 ? "was" : "were"} also changed by a committed sprint — reverting would silently undo part of it`,
    }

  return { kind: "rollback", files: target.filesChanged, why: `${target.filesChanged.length} file(s), none touched by a committed sprint` }
}

export type FaultDisposition = "recovered" | "escalated"

export interface FaultRecord {
  readonly fingerprintId: string
  readonly classified: boolean
  readonly disposition?: FaultDisposition
  readonly detail?: string
}

export interface SilenceReport {
  readonly total: number
  readonly recovered: number
  readonly escalated: number
  readonly silent: readonly string[]
  readonly ok: boolean
  readonly why: string
}

/**
 * The Sprint 96 gate in one function: NO SILENCE.
 *
 * Every injected fault must be classified and then either recovered from or
 * escalated. A fault that is neither is the outcome this whole programme exists
 * to make impossible — something went wrong, nothing was decided about it, and
 * the run carried on as though it had not happened.
 */
export function checkNoSilence(faults: readonly FaultRecord[]): SilenceReport {
  const silent = faults.filter((f) => !f.classified || f.disposition === undefined).map((f) => f.fingerprintId)
  const recovered = faults.filter((f) => f.disposition === "recovered").length
  const escalated = faults.filter((f) => f.disposition === "escalated").length
  return {
    total: faults.length,
    recovered,
    escalated,
    silent,
    ok: silent.length === 0,
    why:
      silent.length === 0
        ? `${faults.length} fault(s): ${recovered} recovered, ${escalated} escalated, none silent`
        : `${silent.length} fault(s) were neither classified nor disposed of (${silent.slice(0, 3).join(", ")}) — something went wrong, nothing was decided about it, and the run carried on as though it had not happened`,
  }
}
