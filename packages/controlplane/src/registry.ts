/**
 * The agent server (Sprint 85), the task registry (Sprint 88), roles
 * (Sprint 89) and dependency scheduling (Sprint 90).
 *
 * The one idea underneath all four: STATE LIVES IN THE LOG, NOT IN A PROCESS.
 * An agent whose state is in memory can only be watched from the machine it
 * runs on, can only be resumed by the process that started it, and disappears
 * with a laptop lid. Everything here is a fold over claims and events, so the
 * same task looks identical from a laptop, a server, and a phone — and looks
 * identical after any of them dies.
 */

export type TaskState = "queued" | "claimed" | "running" | "done" | "failed" | "abandoned"

export interface TaskRecord {
  readonly taskId: string
  readonly objective: string
  readonly state: TaskState
  readonly claimedBy?: string
  readonly claimedAt?: number
  /** Tasks that must be `done` before this one may start. */
  readonly dependsOn: readonly string[]
  readonly attempts: number
  readonly lastError?: string
}

export interface Claim {
  readonly taskId: string
  readonly agentId: string
  readonly at: number
  /** After this, an unfinished claim is stale and may be taken over. */
  readonly leaseMs: number
}

export type ClaimResult =
  | { readonly kind: "claimed"; readonly claim: Claim }
  | { readonly kind: "refused"; readonly why: string; readonly heldBy?: string }

/**
 * Claim a task, or be told why not.
 *
 * The registry's whole job is one sentence: a task is not done twice and is not
 * lost between agents. Those are opposite failures with the same cause — no
 * single place that knows who holds what — and both are fixed by a LEASE:
 *
 *   a live claim blocks a second agent          (never twice)
 *   an EXPIRED claim may be taken over          (never lost)
 *
 * The lease is what makes "the agent died" recoverable without a human. A claim
 * with no expiry would make a crashed agent's task unclaimable for ever, which
 * is the "lost" half arriving through the door built to stop the "twice" half.
 */
export function claimTask(
  task: TaskRecord,
  claims: readonly Claim[],
  request: { agentId: string; at: number; leaseMs?: number },
  allTasks: readonly TaskRecord[] = [],
): ClaimResult {
  if (task.state === "done") return { kind: "refused", why: `${task.taskId} is already done` }
  if (task.state === "abandoned") return { kind: "refused", why: `${task.taskId} was abandoned and needs a human to requeue it` }

  const blocking = task.dependsOn.filter((id) => allTasks.find((t) => t.taskId === id)?.state !== "done")
  if (blocking.length > 0)
    return {
      kind: "refused",
      why: `${task.taskId} depends on ${blocking.join(", ")}, which ${blocking.length === 1 ? "is" : "are"} not done — a task that starts before what it needs produces work against a state that does not exist yet`,
    }

  const existing = claims.filter((c) => c.taskId === task.taskId).sort((a, b) => b.at - a.at)[0]
  if (existing !== undefined) {
    const expired = request.at > existing.at + existing.leaseMs
    if (!expired && existing.agentId !== request.agentId)
      return {
        kind: "refused",
        heldBy: existing.agentId,
        why: `${existing.agentId} holds a live claim on ${task.taskId} (${existing.at + existing.leaseMs - request.at}ms left) — doing it twice is as bad as not doing it`,
      }
  }

  return {
    kind: "claimed",
    claim: { taskId: task.taskId, agentId: request.agentId, at: request.at, leaseMs: request.leaseMs ?? 60_000 },
  }
}

/**
 * Tasks that are neither finished nor held by anybody alive.
 *
 * This is the "lost between agents" detector, and it is a query rather than a
 * background process on purpose: a sweeper that silently requeues work is a
 * sweeper that can requeue something still running when a clock skews.
 */
export function orphanedTasks(tasks: readonly TaskRecord[], claims: readonly Claim[], now: number): TaskRecord[] {
  return tasks.filter((task) => {
    if (task.state === "done" || task.state === "abandoned" || task.state === "queued") return false
    const claim = claims.filter((c) => c.taskId === task.taskId).sort((a, b) => b.at - a.at)[0]
    return claim === undefined || now > claim.at + claim.leaseMs
  })
}

/**
 * The order tasks may run in.
 *
 * Returns levels: everything in level 0 may start now, level 1 after level 0,
 * and so on. A cycle is REPORTED rather than broken — breaking one silently
 * picks a starting point nobody chose, and the choice is usually wrong in a way
 * that only shows up as a task working against half-built state.
 */
export function scheduleLevels(tasks: readonly TaskRecord[]): {
  levels: string[][]
  cycle: string[]
  unknown: { taskId: string; missing: string[] }[]
} {
  const byId = new Map(tasks.map((t) => [t.taskId, t]))
  const unknown = tasks
    .map((t) => ({ taskId: t.taskId, missing: t.dependsOn.filter((d) => !byId.has(d)) }))
    .filter((u) => u.missing.length > 0)

  const remaining = new Map(tasks.map((t) => [t.taskId, new Set(t.dependsOn.filter((d) => byId.has(d)))]))
  const levels: string[][] = []
  const placed = new Set<string>()

  while (placed.size < tasks.length) {
    const ready = [...remaining.entries()]
      .filter(([id, deps]) => !placed.has(id) && [...deps].every((d) => placed.has(d)))
      .map(([id]) => id)
      .sort()

    if (ready.length === 0) {
      return { levels, cycle: tasks.map((t) => t.taskId).filter((id) => !placed.has(id)).sort(), unknown }
    }
    levels.push(ready)
    for (const id of ready) placed.add(id)
  }

  return { levels, cycle: [], unknown }
}

// --------------------------------------------------------------------------
// Sprint 89 — sub-agents inherit and cannot widen
// --------------------------------------------------------------------------

/**
 * Resolve `.` and `..` before any path is compared.
 *
 * RED TEAM S97 FINDING. The write-root check was a string prefix, so
 * `src/../etc` passed it: it starts with `src/` as text and points outside as
 * a path. The S89 test caught the `srcx` case and missed this one, which is
 * the more dangerous half — a traversal is what an attacker writes, and a
 * confusingly-named sibling is what a typo writes.
 *
 * A path that climbs above its own root normalises to a leading `..`, and
 * anything with a leading `..` is refused outright rather than resolved
 * against something.
 */
export function normalisePath(path: string): string {
  const parts = path.split(/[\\/]/)
  const out: string[] = []
  for (const part of parts) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length === 0 || out[out.length - 1] === "..") out.push("..")
      else out.pop()
      continue
    }
    out.push(part)
  }
  return (path.startsWith("/") ? "/" : "") + out.join("/")
}

/** Is `child` inside `root`, as PATHS rather than as strings? */
export function isInside(child: string, root: string): boolean {
  const c = normalisePath(child)
  const r = normalisePath(root)
  if (c.startsWith("..")) return false
  return c === r || c.startsWith(`${r}/`)
}

export interface Capabilities {
  /** Risk classes this agent may produce (Sprint 20 vocabulary). */
  readonly classes: readonly string[]
  /** Tools it may call. */
  readonly tools: readonly string[]
  /** Paths it may write under. */
  readonly writeRoots: readonly string[]
  readonly maxTokens: number
}

export type GrantResult =
  | { readonly kind: "granted"; readonly capabilities: Capabilities; readonly narrowed: readonly string[] }
  | { readonly kind: "refused"; readonly why: string; readonly widened: readonly string[] }

/**
 * Derive a sub-agent's capabilities from its parent's.
 *
 * The rule is INHERIT AND NARROW, and the refusal is not a formality: a
 * sub-agent that can do something its parent cannot is a privilege-escalation
 * primitive with a friendly name. Any request that widens is refused with the
 * widening named, so the caller cannot fix it by trying a slightly different
 * shape and hoping.
 *
 * Narrowing silently would be the other bug: a child quietly given less than it
 * asked for fails later, in a place that looks like a task failure rather than
 * a permission one. So the narrowing is listed too.
 */
export function deriveCapabilities(parent: Capabilities, requested: Partial<Capabilities>): GrantResult {
  const widened: string[] = []
  const narrowed: string[] = []

  const classes = requested.classes ?? parent.classes
  const extraClasses = classes.filter((c) => !parent.classes.includes(c))
  if (extraClasses.length > 0) widened.push(`classes ${extraClasses.join(", ")}`)
  if (classes.length < parent.classes.length) narrowed.push("classes")

  const tools = requested.tools ?? parent.tools
  const extraTools = tools.filter((t) => !parent.tools.includes(t))
  if (extraTools.length > 0) widened.push(`tools ${extraTools.join(", ")}`)
  if (tools.length < parent.tools.length) narrowed.push("tools")

  const writeRoots = requested.writeRoots ?? parent.writeRoots
  const escaping = writeRoots.filter((r) => !parent.writeRoots.some((p) => isInside(r, p)))
  if (escaping.length > 0) widened.push(`write roots ${escaping.join(", ")}`)
  if (writeRoots.length < parent.writeRoots.length) narrowed.push("writeRoots")

  const maxTokens = requested.maxTokens ?? parent.maxTokens
  if (maxTokens > parent.maxTokens) widened.push(`token budget ${maxTokens} > ${parent.maxTokens}`)
  if (maxTokens < parent.maxTokens) narrowed.push("maxTokens")

  if (widened.length > 0)
    return {
      kind: "refused",
      widened,
      why: `a sub-agent inherits and narrows; this asks for ${widened.join("; ")} — an agent that can do what its parent cannot is a privilege-escalation primitive with a friendly name`,
    }

  return { kind: "granted", capabilities: { classes, tools, writeRoots, maxTokens }, narrowed }
}

/** Could this agent perform this operation at all? */
export function permits(capabilities: Capabilities, op: { tool: string; classes: readonly string[]; path?: string }): {
  allowed: boolean
  why: string
} {
  if (!capabilities.tools.includes(op.tool))
    return { allowed: false, why: `${op.tool} is not among this agent's tools` }

  const forbidden = op.classes.filter((c) => !capabilities.classes.includes(c))
  if (forbidden.length > 0) return { allowed: false, why: `classes ${forbidden.join(", ")} are outside this agent's grant` }

  if (op.path !== undefined && !capabilities.writeRoots.some((r) => isInside(op.path!, r)))
    return { allowed: false, why: `${op.path} is outside this agent's write roots (${capabilities.writeRoots.join(", ")})` }

  return { allowed: true, why: "within the grant" }
}
