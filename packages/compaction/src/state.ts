/**
 * StructuredState — the AUTHORITATIVE result of compaction. The human summary is
 * a convenience view; this typed state is the source of truth, so decisions,
 * tasks, and pending tools are never lost to prose drift.
 *
 * Every decision keeps provenance (which events / messages / tool executions /
 * files / prior decisions it came from) so a claim in the summary can always be
 * traced back to the log. Superseding never deletes: the old decision moves to
 * `superseded` with a link to the new one.
 */

export interface Provenance {
  readonly sourceEventIds?: readonly string[]
  readonly sourceMessageIds?: readonly string[]
  readonly sourceToolExecutionIds?: readonly string[]
  readonly sourceFilePaths?: readonly string[]
  readonly sourceDecisionIds?: readonly string[]
}

export interface Decision extends Provenance {
  readonly id: string
  readonly decision: string
  readonly verified: boolean
  /** Set when this decision was replaced; points at the superseding decision id. */
  readonly supersededBy?: string
}

export interface StructuredState {
  readonly objective: string
  readonly completed: readonly string[]
  readonly active: readonly string[]
  readonly blocked: readonly string[]
  readonly decisions: readonly Decision[]
  readonly knownErrors: readonly string[]
  readonly modifiedFiles: readonly string[]
  readonly pendingTools: readonly string[]
  readonly nextActions: readonly string[]
  /** Historical decisions that were replaced (kept for provenance, never dropped). */
  readonly superseded: readonly Decision[]
}

export const EMPTY_STATE: StructuredState = {
  objective: "",
  completed: [],
  active: [],
  blocked: [],
  decisions: [],
  knownErrors: [],
  modifiedFiles: [],
  pendingTools: [],
  nextActions: [],
  superseded: [],
}

export type ParseResult = { readonly ok: true; readonly state: StructuredState } | { readonly ok: false; readonly error: string }

const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])

function asDecisions(v: unknown): Decision[] {
  if (!Array.isArray(v)) return []
  const out: Decision[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue
    const d = raw as Record<string, unknown>
    if (typeof d.decision !== "string") continue
    out.push({
      id: typeof d.id === "string" && d.id.length > 0 ? d.id : hashId(d.decision),
      decision: d.decision,
      verified: d.verified === true,
      sourceEventIds: asStringArray(d.sourceEventIds),
      sourceMessageIds: asStringArray(d.sourceMessageIds),
      sourceToolExecutionIds: asStringArray(d.sourceToolExecutionIds),
      sourceFilePaths: asStringArray(d.sourceFilePaths),
      sourceDecisionIds: asStringArray(d.sourceDecisionIds),
    })
  }
  return out
}

/**
 * Parse + validate a model-produced state JSON. A malformed payload is REJECTED
 * (never silently accepted); the caller retries or falls back. Missing arrays
 * default to empty, but the root must be an object with a string objective.
 */
export function parseStructuredState(json: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "state must be a JSON object" }
  }
  const o = parsed as Record<string, unknown>
  if (o.objective !== undefined && typeof o.objective !== "string") {
    return { ok: false, error: "objective must be a string" }
  }
  return {
    ok: true,
    state: {
      objective: typeof o.objective === "string" ? o.objective : "",
      completed: asStringArray(o.completed),
      active: asStringArray(o.active),
      blocked: asStringArray(o.blocked),
      decisions: asDecisions(o.decisions),
      knownErrors: asStringArray(o.knownErrors),
      modifiedFiles: asStringArray(o.modifiedFiles),
      pendingTools: asStringArray(o.pendingTools),
      nextActions: asStringArray(o.nextActions),
      superseded: asDecisions(o.superseded),
    },
  }
}

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)]

/**
 * Incremental merge: accumulate durable facts (completed/errors/files/decisions),
 * replace the "current" fields (active/pendingTools/nextActions) with the newer
 * view, and supersede a decision when a new one shares its id.
 */
export function mergeState(prev: StructuredState, inc: StructuredState): StructuredState {
  const superseded: Decision[] = [...prev.superseded]
  const byId = new Map<string, Decision>()
  for (const d of prev.decisions) byId.set(d.id, d)
  for (const d of inc.decisions) {
    const old = byId.get(d.id)
    if (old && old.decision !== d.decision) {
      superseded.push({ ...old, supersededBy: d.id })
    }
    byId.set(d.id, d)
  }
  return {
    objective: inc.objective || prev.objective,
    completed: uniq([...prev.completed, ...inc.completed]),
    active: inc.active, // current view replaces
    blocked: inc.blocked,
    decisions: [...byId.values()],
    knownErrors: uniq([...prev.knownErrors, ...inc.knownErrors]),
    modifiedFiles: uniq([...prev.modifiedFiles, ...inc.modifiedFiles]),
    pendingTools: inc.pendingTools, // current view replaces
    nextActions: inc.nextActions,
    superseded,
  }
}

/** Small stable id from a decision string (FNV-1a) so provenance links survive. */
function hashId(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return "d_" + (h >>> 0).toString(16).padStart(8, "0")
}
