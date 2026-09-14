/**
 * Process ownership (Sprint 55), container ownership (Sprint 56) and bounded
 * search (Sprint 57).
 *
 * All three are the same question: what does this run OWN, and what happens to
 * it when the run ends?
 *
 * A cancelled command that leaves a process alive is the failure I measured on
 * this very machine an hour ago: a dev server from a session sixteen hours dead
 * and an emulator from the day before, both invisible until somebody looked at
 * a memory graph. Killing the process you spawned is not enough — it spawned
 * others, and the shell it ran under is usually the only thing that knows.
 *
 * Containers are worse, because they outlive the machine's own process table.
 * The rule that makes them safe is ownership by LABEL: the agent reaps what it
 * labelled and nothing else. A reaper that matches on a name prefix eventually
 * deletes something a human made, and the ones it CANNOT see — containers
 * created before the labelling existed — must be reported rather than silently
 * excluded.
 */

export interface ProcessNode {
  readonly pid: number
  readonly ppid: number
  readonly name: string
  /** Milliseconds of CPU consumed. Distinguishes hung from working. */
  readonly cpuMs?: number
  readonly startedAt?: number
}

/**
 * Every descendant of a root pid.
 *
 * Computed from the whole table rather than by walking children one level at a
 * time, because the interesting case is the grandchild: `npm run dev` spawns a
 * shell that spawns node that spawns four workers, and killing `npm` leaves all
 * six.
 */
export function descendants(table: readonly ProcessNode[], root: number): ProcessNode[] {
  const byParent = new Map<number, ProcessNode[]>()
  for (const p of table) {
    const list = byParent.get(p.ppid) ?? []
    list.push(p)
    byParent.set(p.ppid, list)
  }
  const out: ProcessNode[] = []
  const queue = [root]
  const seen = new Set<number>([root])
  while (queue.length > 0) {
    const pid = queue.shift()!
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      out.push(child)
      queue.push(child.pid)
    }
  }
  return out
}

export interface KillPlan {
  /** Deepest first: a parent killed first can respawn its children. */
  readonly order: readonly number[]
  readonly protectedPids: readonly number[]
  readonly why: string
}

/**
 * Plan a tree kill.
 *
 * Deepest-first, and with an explicit protected set. The protected set exists
 * because the ancestors of the killing process are in the same table, and a
 * tree-kill that walks up instead of down takes the agent with it — which I
 * would rather find in a test than in a session.
 */
export function planTreeKill(
  table: readonly ProcessNode[],
  root: number,
  protectedPids: readonly number[] = [],
): KillPlan {
  const protectedSet = new Set(protectedPids)
  if (protectedSet.has(root))
    return { order: [], protectedPids, why: `${root} is protected — refusing to kill the process doing the killing` }

  const depth = new Map<number, number>([[root, 0]])
  const children = descendants(table, root)
  for (const child of children) {
    const parentDepth = depth.get(child.ppid) ?? 0
    depth.set(child.pid, parentDepth + 1)
  }

  const order = [root, ...children.map((c) => c.pid)]
    .filter((pid) => !protectedSet.has(pid))
    .sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0))

  return {
    order,
    protectedPids,
    why: `${order.length} process(es), deepest first — a parent killed first can respawn its children`,
  }
}

/** Processes still alive that a run claimed to have finished with. */
export function survivors(table: readonly ProcessNode[], expectedDead: readonly number[]): ProcessNode[] {
  const dead = new Set(expectedDead)
  return table.filter((p) => dead.has(p.pid))
}

/**
 * Is this process hung, or working?
 *
 * The distinction the memory audit turned on: a tree at 0.2s of CPU after three
 * hours is hung, and one at 600s is doing something. Killing the second is
 * destroying work; killing the first is cleaning up.
 */
export function looksHung(node: ProcessNode, now: number, minCpuRatio = 0.005): boolean | undefined {
  if (node.cpuMs === undefined || node.startedAt === undefined) return undefined
  const ageMs = now - node.startedAt
  if (ageMs < 60_000) return false
  return node.cpuMs / ageMs < minCpuRatio
}

// --------------------------------------------------------------------------
// Sprint 56 — container ownership
// --------------------------------------------------------------------------

export const OWNER_LABEL = "abdo.run_id"

export interface ContainerInfo {
  readonly id: string
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  readonly running: boolean
}

export interface ReapPlan {
  readonly reap: readonly string[]
  readonly keep: readonly { readonly id: string; readonly why: string }[]
  /** Containers with no ownership label at all — reported, never touched. */
  readonly unlabelled: readonly string[]
  readonly why: string
}

/**
 * Which containers may this cleanup remove?
 *
 * Only those labelled with a run id that is no longer alive. Three deliberate
 * refusals:
 *
 *   no label            not ours. Reported, because a machine accumulating
 *                       unlabelled containers is a fact somebody should see,
 *                       and because a reaper that matched on a NAME PREFIX
 *                       instead would eventually delete something a human made.
 *   a live run's        the run is still using it.
 *   a different owner   another agent's container is not garbage.
 */
export function planReap(
  containers: readonly ContainerInfo[],
  liveRunIds: readonly string[],
  /**
   * Run ids this agent actually created containers for.
   *
   * RED TEAM S59 FINDING. The rule used to be "labelled, and the owner is not
   * alive" — so anyone who could set `abdo.run_id` to a plausible dead id got
   * the agent to delete their container for them, including a production
   * database somebody had labelled by hand or by copying a compose file.
   * Ownership is now something we REMEMBER, not something the container
   * asserts about itself. Omitted = the old behaviour, for callers that have
   * no ledger yet; supplying it is strictly safer and the gate supplies it.
   */
  ownRunIds?: readonly string[],
): ReapPlan {
  const live = new Set(liveRunIds)
  const owned = ownRunIds === undefined ? undefined : new Set(ownRunIds)
  const reap: string[] = []
  const keep: { id: string; why: string }[] = []
  const unlabelled: string[] = []

  for (const container of containers) {
    const owner = container.labels[OWNER_LABEL]
    if (owner === undefined) {
      unlabelled.push(container.id)
      keep.push({ id: container.id, why: "no ownership label — not created by this agent, and a name-prefix match would eventually delete something a human made" })
      continue
    }
    if (live.has(owner)) {
      keep.push({ id: container.id, why: `run ${owner} is still alive and using it` })
      continue
    }
    if (owned !== undefined && !owned.has(owner)) {
      keep.push({
        id: container.id,
        why: `it is labelled for run ${owner}, which this agent never created — a label is a claim the container makes about itself, and acting on it is how a forged label gets a production database deleted`,
      })
      continue
    }
    reap.push(container.id)
  }

  return {
    reap,
    keep,
    unlabelled,
    why:
      `${reap.length} container(s) owned by dead runs` +
      (unlabelled.length > 0 ? `; ${unlabelled.length} unlabelled container(s) left alone and reported` : ""),
  }
}

// --------------------------------------------------------------------------
// Sprint 57 — bounded, repeatable search
// --------------------------------------------------------------------------

export interface SearchHit {
  readonly path: string
  readonly line: number
  readonly text: string
}

export interface SearchLimits {
  readonly maxHits: number
  readonly maxMs: number
  readonly maxFileBytes: number
}

export const DEFAULT_SEARCH_LIMITS: SearchLimits = { maxHits: 500, maxMs: 10_000, maxFileBytes: 2 * 1024 * 1024 }

export interface SearchOutcome {
  readonly hits: readonly SearchHit[]
  readonly truncated: boolean
  readonly reason?: "hit_limit" | "time_limit"
  readonly filesScanned: number
  readonly filesSkipped: readonly { readonly path: string; readonly why: string }[]
  readonly ms: number
}

/**
 * Search with declared bounds, and results in a deterministic order.
 *
 * Two properties the gate needs. Bounded, so a search of a repository larger
 * than memory returns in a stated time instead of eventually. And REPEATABLE:
 * hits are sorted by path and line rather than by whatever order the walk
 * produced, because a search whose output order depends on the filesystem gives
 * a different answer on the same repository and cannot be diffed between runs.
 *
 * Truncation is reported with its reason. A truncated result that looks
 * complete is how an agent concludes a symbol has three references.
 */
export function searchFiles(
  files: readonly { path: string; bytes: number; read: () => string }[],
  pattern: RegExp,
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
  now: () => number = Date.now,
): SearchOutcome {
  const started = now()
  const hits: SearchHit[] = []
  const skipped: { path: string; why: string }[] = []
  let filesScanned = 0
  let truncated = false
  let reason: "hit_limit" | "time_limit" | undefined

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (now() - started > limits.maxMs) {
      truncated = true
      reason = "time_limit"
      break
    }
    if (file.bytes > limits.maxFileBytes) {
      skipped.push({ path: file.path, why: `${file.bytes} bytes exceeds the ${limits.maxFileBytes}-byte file limit` })
      continue
    }
    filesScanned++
    const lines = file.read().split("\n")
    for (let i = 0; i < lines.length; i++) {
      // RED TEAM S59 FINDING. The clock was checked once per FILE, so a
      // catastrophically backtracking pattern (`^(a+)+$` over a long
      // non-matching line) could run for minutes inside a search that had
      // declared a 10ms budget. A budget that is only checked between files is
      // not a budget for a tool whose input includes the pattern.
      if (now() - started > limits.maxMs) {
        truncated = true
        reason = "time_limit"
        break
      }
      const re = new RegExp(pattern.source, pattern.flags.replace("g", ""))
      if (!re.test(lines[i]!)) continue
      if (hits.length >= limits.maxHits) {
        truncated = true
        reason = "hit_limit"
        break
      }
      hits.push({ path: file.path, line: i + 1, text: lines[i]!.slice(0, 500) })
    }
    if (truncated) break
  }

  hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return {
    hits,
    truncated,
    ...(reason !== undefined ? { reason } : {}),
    filesScanned,
    filesSkipped: skipped,
    ms: now() - started,
  }
}
