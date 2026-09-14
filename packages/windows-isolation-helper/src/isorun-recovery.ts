/**
 * CL-16A3 MEGA-1 §5 — recovery for the ISOLATED run.
 *
 * This is a separate folder and a separate sweep from `recovery.ts`, and the
 * separation was not a style choice. P4c briefly wrote its journal into the old
 * sweep's namespace, and the result was that a recovery pass deleted the
 * AppContainer profile and revoked the ACLs of a RUNNING run. The mechanism is
 * worth stating precisely, because every rule below exists to make one step of it
 * impossible:
 *
 *   - `foldRun` knew none of the new events, so every isolated run folded to
 *     "incomplete" forever, including ones that had finished perfectly;
 *   - the folded `profileName` was empty, so the sweep FELL BACK to
 *     `profileNameFor(runId)` — which happened to be the real profile name, so
 *     the ownership check passed and a guess became a deletion;
 *   - liveness was decided from the host's pid, which the driver had not even
 *     recorded, so the check was skipped entirely.
 *
 * Hence the three laws of this module:
 *
 *   1. **NOTHING IS INFERRED.** Every resource this sweep might touch — the
 *      profile name, the AppContainer SID, the run directory, each granted path
 *      with its original and granted descriptors — is read from a DURABLE EVENT
 *      or it is not known. There is no fallback, no reconstruction from a runId,
 *      no "it is almost certainly called this". A missing fact is reported as
 *      `manual_intervention_required`, which is a worse outcome for tidiness and
 *      the only safe one for correctness.
 *
 *   2. **HOST ALIVE IS NOT RUN ALIVE.** Liveness comes from the run's own
 *      durable LEASE (`run-lease.ts`). A long-lived host is alive across every
 *      run it has ever served, so keying on it would leave dead runs' ACEs on the
 *      machine forever; after a restart the same rule declares live runs dead.
 *      The host's pid is used for ONE thing: contradicting an expired lease.
 *
 *   3. **AN AMBIGUITY IS NEVER RESOLVED BY ACTING.** Expiry is wall-clock across
 *      processes, so a clock jump can expire a live lease. An expired lease whose
 *      owner is still running is a contradiction, not a licence; a run whose child
 *      process is still alive cannot have its ACLs pulled out from under it. Both
 *      are `manual_intervention_required`.
 */
import type { EventStore } from "@abdo/event-store"
import type { HelperRunner } from "./helper-runner"
import { OWNERSHIP_PREFIX, profileDirFor } from "./lifecycle"
import { acquireRunLease, assertMayMutate, foldRunLease, leaseIsExpired, newOperationId, releaseRunLease, runLeaseAggregateId, StaleLeaseHolder, type RunLeaseState } from "./run-lease"
import { RunLifecycle, type RunLifecycleEvent } from "./run-lifecycle-events"
import { JobEvents } from "./job-identity"
import { RUN_REFUSED } from "./run-lifecycle"
import { RunGrantEvents } from "./run-scope"

/** One granted object, as recorded — never as reconstructed. */
export interface RecordedGrant {
  readonly path: string
  readonly sid: string
  readonly originalSddl: string
  /** Present only once the grant was OBSERVED to have landed. */
  readonly grantedSddl?: string
  /**
   * The object's identity WHEN IT WAS GRANTED. A path is a name, not an
   * identity: between the crash and the sweep that name can point somewhere
   * else, and writing a stale descriptor onto an unrelated object is worse than
   * leaving an ACE behind.
   */
  readonly fileId?: string
  readonly volumeSerial?: string
  /** Which attempt wrote this grant. Unexplained provenance is a refusal. */
  readonly operationId?: string
  readonly fencingToken?: number
  /**
   * How many `grants_mutating` events named this object, and every DISTINCT
   * original descriptor they carried.
   *
   * Before the plan was normalised, one object could be granted twice, and the
   * second capture recorded an "original" that ALREADY CONTAINED the first ACE.
   * Restoring that chained value puts the object back to a state that still
   * carries the container. Two different originals for one object is therefore
   * not a duplicate to de-duplicate — it is CONFLICTING EVIDENCE, and the only
   * safe reading is that we do not know what the original was.
   */
  readonly mutationCount: number
  readonly originalsSeen: readonly string[]
}

/** Every principal named in an SDDL's ACEs, lowercased. */
export function principalsOf(sddl: string): string[] {
  const out: string[] = []
  for (const ace of sddl.match(/\(([^)]*)\)/g) ?? []) {
    const parts = ace.slice(1, -1).split(";")
    const sid = (parts[5] ?? "").trim().toLowerCase()
    if (sid) out.push(sid)
  }
  return out
}

export interface IsolatedRunProjection {
  readonly runId: string
  /** The ordered lifecycle stages actually recorded. */
  readonly stages: readonly RunLifecycleEvent[]
  readonly lastStage?: RunLifecycleEvent
  readonly refused: boolean
  /** From `run.requested`. Absent means we do not know it — never guessed. */
  readonly profileName?: string
  readonly appContainerSid?: string
  readonly runPath?: string
  readonly hostPid?: number
  readonly hostStartTime?: string
  readonly childPid?: number
  readonly childStartTime?: string
  /**
   * P5c. The EXACT job name, from `isorun.job.create_requested` — which the
   * driver writes BEFORE the helper is invoked, so a run killed at any point
   * after that still names the object that holds its tree.
   *
   * **There is no fallback and there must never be one.** A derived name would
   * re-point at whatever a re-derivation happens to produce, which for a
   * termination verb means terminating the wrong tree. Absent ⇒ the run is not
   * reclaimable through the job, and the sweep says so instead of guessing.
   */
  readonly jobName?: string
  readonly jobSessionId?: number
  readonly jobOperationId?: string
  readonly jobFencingToken?: number
  /**
   * P5c2. WHO IS HOLDING THAT NAME OPEN, from `isorun.job.keeper_ready`.
   *
   * A job name is only reachable while some process holds a handle to the
   * object — the object manager drops a temporary object's NAME at handle count
   * zero (P5c finding 21). P5c made the TARGET the holder, which meant an
   * uncooperative target could close the handle and make its own tree
   * unreachable. The holder is now a trusted per-run process, and these two
   * fields are how a later sweep tells the difference between the two states
   * P5c conflated: **the tree is gone** and **the keeper died and took the name
   * with it**.
   *
   * pid AND creation time. Absent ⇒ this run predates the keeper or never got
   * one, and the sweep will not infer one.
   */
  readonly jobKeeperPid?: number
  readonly jobKeeperStartTime?: string
  /** True once the helper proved the initial process was a member of the job. */
  readonly jobProcessInJob: boolean
  readonly lease?: RunLeaseState
  readonly grants: readonly RecordedGrant[]
  /** Did the run record that it revoked and cleaned up? */
  readonly revocationVerified: boolean
  readonly cleaned: boolean
  readonly completed: boolean
}

/**
 * The reclaim lease's TTL. Generous: a sweep restoring many descriptors and
 * deleting a profile can take seconds, and an expiry mid-reclaim would let a
 * second sweep in behind it.
 */
const RECLAIM_LEASE_TTL_MS = 120_000

/**
 * P5c2. How long a reclaim waits for the trusted keeper to exit after the tree
 * has been terminated and proved empty.
 *
 * The keeper polls its job every 100 ms and exits on the first empty answer, so
 * this is generous by two orders of magnitude. It is a bound, not an
 * expectation: exceeding it means the keeper cannot read the job it holds, and
 * that is a deferral rather than a longer wait.
 */
const KEEPER_EXIT_BUDGET_MS = 10_000
const KEEPER_EXIT_POLL_MS = 100

/** Normalise a path for comparison: forward slashes folded, no trailing separator. */
const lower = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()

const LIFECYCLE_SET = new Set<string>(Object.values(RunLifecycle))

/**
 * Fold ONE isolated run from its events.
 *
 * Every field is populated only from an event that carried it. A field this
 * function leaves `undefined` is a field the sweep must refuse to act on.
 */
export function foldIsolatedRun(runId: string, events: readonly { type: string; data: unknown }[]): IsolatedRunProjection {
  const stages: RunLifecycleEvent[] = []
  const grants = new Map<string, RecordedGrant>()
  let profileName: string | undefined
  let appContainerSid: string | undefined
  let runPath: string | undefined
  let hostPid: number | undefined
  let hostStartTime: string | undefined
  let childPid: number | undefined
  let childStartTime: string | undefined
  let jobName: string | undefined
  let jobSessionId: number | undefined
  let jobOperationId: string | undefined
  let jobFencingToken: number | undefined
  let jobKeeperPid: number | undefined
  let jobKeeperStartTime: string | undefined
  let jobProcessInJob = false
  let refused = false

  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>
    if (LIFECYCLE_SET.has(e.type)) stages.push(e.type as RunLifecycleEvent)
    if (e.type === RUN_REFUSED) refused = true

    if (typeof d.profileName === "string" && d.profileName) profileName = d.profileName
    if (typeof d.sid === "string" && d.sid) appContainerSid = d.sid
    if (typeof d.runPath === "string" && d.runPath) runPath = d.runPath
    if (typeof d.hostPid === "number" && d.hostPid > 0) hostPid = d.hostPid
    if (typeof d.hostStartTime === "string" && d.hostStartTime) hostStartTime = d.hostStartTime

    if (e.type === RunLifecycle.ProcessStarted) {
      if (typeof d.pid === "number" && d.pid > 0) childPid = d.pid
      if (typeof d.startTime === "string" && d.startTime) childStartTime = d.startTime
    }

    // P5c — THE JOB'S IDENTITY. Taken from the INTENT event, not the completion:
    // `create_requested` is written before the helper runs, so it survives a
    // death at any later point, which is exactly when it is needed. The
    // completion adds the session the OS reported and nothing else load-bearing.
    if (e.type === JobEvents.CreateRequested) {
      if (typeof d.jobName === "string" && d.jobName) jobName = d.jobName
      if (typeof d.sessionId === "number") jobSessionId = d.sessionId
      if (typeof d.operationId === "string" && d.operationId) jobOperationId = d.operationId
      if (typeof d.fencingToken === "number") jobFencingToken = d.fencingToken
    }
    if (e.type === JobEvents.Created && typeof d.sessionId === "number") jobSessionId = d.sessionId
    // P5c2 — THE KEEPER'S IDENTITY, recorded after it proved itself and before
    // the target existed. Both fields or neither: a pid without a creation time
    // is not an identity, and a sweep that accepted one would eventually decide
    // some recycled stranger was the keeper and trust the job name on it.
    if (e.type === JobEvents.KeeperReady) {
      if (typeof d.keeperPid === "number" && d.keeperPid > 0 && typeof d.keeperStartTime === "string" && d.keeperStartTime) {
        jobKeeperPid = d.keeperPid
        jobKeeperStartTime = d.keeperStartTime
      }
    }
    if (e.type === JobEvents.ProcessCreated) {
      if (d.isProcessInJob === true) jobProcessInJob = true
      if (typeof d.pid === "number" && d.pid > 0) childPid = d.pid
      if (typeof d.startTime === "string" && d.startTime) childStartTime = d.startTime
    }

    // THE ACL RECORD. `grants_mutating` is written BEFORE the mutation and
    // carries the original descriptor, so a run that died mid-grant still leaves
    // enough behind to be undone. `grant_observed` adds what the object actually
    // carried afterwards.
    if (e.type === RunGrantEvents.GrantsMutating && typeof d.path === "string") {
      const prev = grants.get(d.path.toLowerCase())
      grants.set(d.path.toLowerCase(), {
        path: d.path,
        sid: String(d.sid ?? prev?.sid ?? ""),
        originalSddl: String(d.originalSddl ?? prev?.originalSddl ?? ""),
        ...(prev?.grantedSddl ? { grantedSddl: prev.grantedSddl } : {}),
        ...(d.fileId ? { fileId: String(d.fileId) } : prev?.fileId ? { fileId: prev.fileId } : {}),
        ...(d.volumeSerial ? { volumeSerial: String(d.volumeSerial) } : prev?.volumeSerial ? { volumeSerial: prev.volumeSerial } : {}),
        ...(d.operationId ? { operationId: String(d.operationId) } : prev?.operationId ? { operationId: prev.operationId } : {}),
        ...(typeof d.fencingToken === "number" ? { fencingToken: d.fencingToken } : prev?.fencingToken ? { fencingToken: prev.fencingToken } : {}),
        mutationCount: (prev?.mutationCount ?? 0) + 1,
        originalsSeen: [...new Set([...(prev?.originalsSeen ?? []), String(d.originalSddl ?? "")])],
      })
    }
    if (e.type === RunGrantEvents.GrantObserved && typeof d.path === "string") {
      const prev = grants.get(d.path.toLowerCase())
      grants.set(d.path.toLowerCase(), {
        path: d.path,
        sid: String(d.sid ?? prev?.sid ?? ""),
        originalSddl: String(d.originalSddl ?? prev?.originalSddl ?? ""),
        grantedSddl: String(d.grantedSddl ?? ""),
        ...(prev?.fileId ? { fileId: prev.fileId } : {}),
        ...(prev?.volumeSerial ? { volumeSerial: prev.volumeSerial } : {}),
        ...(d.operationId ? { operationId: String(d.operationId) } : prev?.operationId ? { operationId: prev.operationId } : {}),
        ...(typeof d.fencingToken === "number" ? { fencingToken: d.fencingToken } : prev?.fencingToken ? { fencingToken: prev.fencingToken } : {}),
        mutationCount: prev?.mutationCount ?? 0,
        originalsSeen: prev?.originalsSeen ?? [],
      })
    }
  }

  const lease = foldRunLease(events)
  return {
    runId,
    stages,
    ...(stages.length > 0 ? { lastStage: stages[stages.length - 1] } : {}),
    refused,
    ...(profileName ? { profileName } : {}),
    ...(appContainerSid ? { appContainerSid } : {}),
    ...(runPath ? { runPath } : {}),
    ...(hostPid ? { hostPid } : {}),
    ...(hostStartTime ? { hostStartTime } : {}),
    ...(jobName ? { jobName } : {}),
    ...(jobSessionId !== undefined ? { jobSessionId } : {}),
    ...(jobOperationId ? { jobOperationId } : {}),
    ...(jobFencingToken !== undefined ? { jobFencingToken } : {}),
    ...(jobKeeperPid !== undefined ? { jobKeeperPid } : {}),
    ...(jobKeeperStartTime ? { jobKeeperStartTime } : {}),
    jobProcessInJob,
    ...(childPid ? { childPid } : {}),
    ...(childStartTime ? { childStartTime } : {}),
    ...(lease ? { lease } : {}),
    grants: [...grants.values()],
    revocationVerified: stages.includes(RunLifecycle.RevocationVerified),
    cleaned: stages.includes(RunLifecycle.Cleaned),
    completed: stages.includes(RunLifecycle.Completed),
  }
}

/** Every isolated run in the journal. */
export async function scanIsolatedRuns(store: EventStore): Promise<IsolatedRunProjection[]> {
  return (await scanIsolatedRunsWithEvents(store)).runs
}

/** The same scan, keeping the raw events so provenance can be checked. */
export async function scanIsolatedRunsWithEvents(store: EventStore): Promise<{ runs: IsolatedRunProjection[]; eventsByRun: Map<string, { type: string; data: unknown }[]> }> {
  const all = await store.readAll()
  const byRun = new Map<string, { type: string; data: unknown }[]>()
  const PREFIX = "winiso:isorun:"
  for (const e of all) {
    if (!e.aggregateId.startsWith(PREFIX)) continue
    const runId = e.aggregateId.slice(PREFIX.length)
    const list = byRun.get(runId) ?? []
    list.push({ type: e.type, data: e.data })
    byRun.set(runId, list)
  }
  return { runs: [...byRun.entries()].map(([runId, events]) => foldIsolatedRun(runId, events)), eventsByRun: byRun }
}

export type Liveness =
  /** The run finished, one way or another. Nothing is in flight. */
  | { readonly verdict: "finished"; readonly why: string }
  /** An execution is genuinely in flight. Leave it alone. */
  | { readonly verdict: "live"; readonly why: string }
  /** Nothing is running and the evidence says so. Safe to reclaim. */
  | { readonly verdict: "reclaimable"; readonly why: string }
  /** The evidence disagrees with itself, or is absent. A human decides. */
  | { readonly verdict: "unknown"; readonly why: string }

/**
 * Is an EXECUTION of this run still in flight?
 *
 * Note what is NOT consulted: whether the host process is alive, on its own.
 * That question is asked only to CONTRADICT an expired lease, never to establish
 * liveness — see law 2 in the header.
 */
export async function assessLiveness(deps: { helper: HelperRunner; now?: () => number }, run: IsolatedRunProjection): Promise<Liveness> {
  const now = (deps.now ?? Date.now)()

  // A run that recorded its own completion is finished regardless of leases.
  if (run.completed) return { verdict: "finished", why: "the run recorded run.completed" }

  const lease = run.lease
  if (!lease) {
    // NO LEASE AT ALL. This is either a run from before leases existed, or a
    // journal that lost its first write. Either way nothing here establishes
    // whether a process is running, and the safe answer is not to guess.
    return { verdict: "unknown", why: "no lease was ever recorded for this run; its liveness cannot be established from the journal" }
  }
  if (lease.released) return { verdict: "finished", why: `the lease was released (${lease.releaseReason ?? "no reason recorded"})` }
  // NOTE for the caller: "finished" means NOTHING IS IN FLIGHT. It does not mean
  // the machine is clean. `recoverIsolatedRuns` re-inspects a released run's
  // resources anyway — see `releasedRunResidue` — because a release is a claim
  // made by a process that may have been wrong.
  if (!leaseIsExpired(lease, now)) {
    return { verdict: "live", why: `the lease is held by pid ${lease.ownerPid} and does not expire for ${lease.expiresAt - now}ms` }
  }

  // THE LEASE HAS EXPIRED. That is a necessary condition for reclaiming, and on
  // its own it is not a sufficient one.

  // (a) Is the owner somehow still alive? Expiry is wall-clock across processes,
  // so a clock change or a very long OS call can expire the lease of a process
  // that is perfectly healthy. Reclaiming under it would be the exact corruption
  // this module exists to prevent.
  //
  // A PID WITHOUT A CREATION TIME IS NOT AN IDENTITY, and the check is refused
  // rather than performed on one. Windows reuses pids: asking "is 4812 alive?"
  // about a lease whose owner died an hour ago will cheerfully say yes about
  // whatever unrelated process now holds that number — and the answer would be
  // used, here, to decide whether to delete an AppContainer. `--expect-start`
  // turns the question into "is THAT process alive?" (measured: a mismatched
  // expectation returns `alive:false, pidReused:true`), so without the creation
  // time there is no question worth asking.
  if (lease.ownerPid > 0 && !lease.ownerStartTime) {
    return {
      verdict: "unknown",
      why: `the lease records owner pid ${lease.ownerPid} but no creation time, so its liveness cannot be distinguished from an unrelated process that has since been given the same pid`,
    }
  }
  if (lease.ownerPid > 0) {
    const owner = await deps.helper({ argv: ["inspect-process", "--pid", String(lease.ownerPid), "--expect-start", lease.ownerStartTime] })
    if (owner.alive === true) {
      return {
        verdict: "unknown",
        why: `the lease expired at ${lease.expiresAt} but its owner (pid ${lease.ownerPid}, started ${lease.ownerStartTime}) is still running. An expired lease held by a live process is a contradiction — a stalled host and a clock jump look identical from here — and it is not resolved by deleting its resources.`,
      }
    }
  }

  // (b) Is the CHILD still running? A dead host does not imply a dead child: the
  // process was created in a job object owned by a host that is now gone, and
  // its ACEs are what it is using RIGHT NOW — so revoking them under it is not
  // cleanup, it is sabotage.
  //
  // P5c CHANGES THE ANSWER, but only where it has earned the right to.
  // `terminate-process-tree` can now end that tree and PROVE it ended, so a live
  // child is reclaimable — provided the run durably recorded the job's exact
  // name. Without a name there is still no safe action: killing by pid reaches
  // one process and leaves its children, and killing by image name reaches
  // strangers. That case defers exactly as before.
  if (run.childPid && run.childPid > 0) {
    if (!run.childStartTime) {
      return { verdict: "unknown", why: `the run recorded child pid ${run.childPid} with no creation time; whether that process is still running cannot be told from a reused pid` }
    }
    const child = await deps.helper({ argv: ["inspect-process", "--pid", String(run.childPid), "--expect-start", run.childStartTime] })
    if (child.alive === true) {
      if (!run.jobName) {
        return {
          verdict: "unknown",
          why:
            `the lease expired and the host is gone, but the run's child (pid ${run.childPid}) is STILL RUNNING and the run recorded no job name. ` +
            `Its ACEs are in use, and there is no way to reach its whole tree without the job — a pid kill leaves the grandchildren and a name kill reaches strangers.`,
        }
      }
      if (run.jobSessionId === undefined || !run.jobOperationId || run.jobFencingToken === undefined) {
        return {
          verdict: "unknown",
          why: `the run's child (pid ${run.childPid}) is still running and a job name was recorded, but its session, operation id or fencing token was not — the helper cannot be given the evidence it requires to prove which job that name means`,
        }
      }
      // P5c2. A NAME IS ONLY REACHABLE WHILE SOMETHING HOLDS IT, so the keeper
      // is checked before the name is believed.
      //
      // This is the check P5c could not make. There, the holder was the target
      // itself, so "is the holder alive?" and "is the tree alive?" were the same
      // question and a closed handle was indistinguishable from a finished run.
      // With a trusted holder they are different questions, and the difference
      // is the whole point: a LIVE TREE with a DEAD KEEPER is a tree whose name
      // has already been dropped by the object manager. `terminate-process-tree`
      // would answer `terminate_job_absent` for it — correctly refusing to claim
      // `treeGone`, but leaving a sweep that could not tell why.
      //
      // So it is named here instead of discovered downstream, and it is NOT
      // reclaimable: there is no safe action left, because the only route to the
      // whole tree has been closed while the tree is still using its ACEs.
      if (run.jobKeeperPid === undefined || !run.jobKeeperStartTime) {
        return {
          verdict: "unknown",
          why:
            `the run's child (pid ${run.childPid}) is still running and job ${run.jobName} was recorded, but the run recorded no keeper identity. ` +
            `Without it there is no way to tell whether that name is still held open, and a name that has been dropped cannot be distinguished from a tree that ended.`,
        }
      }
      const keeper = await deps.helper({ argv: ["inspect-process", "--pid", String(run.jobKeeperPid), "--expect-start", run.jobKeeperStartTime] })
      if (keeper.alive !== true) {
        return {
          verdict: "unknown",
          why:
            `the run's child (pid ${run.childPid}) is STILL RUNNING but its job keeper (pid ${run.jobKeeperPid}, started ${run.jobKeeperStartTime}) is gone. ` +
            `The job's name is dropped by the object manager when its last handle closes, so the tree is live and ${run.jobName} is no longer openable: ` +
            `there is no route to the whole tree, and a pid kill would leave its grandchildren running with their ACEs in place. This needs a human.`,
        }
      }
      // RECLAIMABLE, and the sweep must terminate the tree BEFORE it touches an
      // ACE. That ordering is enforced at the reclaim site, not here; this only
      // states that the run is no longer beyond reach.
      return {
        verdict: "reclaimable",
        why: `the lease expired at ${lease.expiresAt} and its owner is gone; the run's child (pid ${run.childPid}) is still running but its tree is reachable through the recorded job ${run.jobName}, whose name is still held open by the live keeper pid ${run.jobKeeperPid} — the tree will be terminated and proved empty before anything is restored`,
      }
    }
  }

  return { verdict: "reclaimable", why: `the lease expired at ${lease.expiresAt}, its owner is gone, and no child process survives` }
}

export interface IsolatedRecoveryOutcome {
  readonly runId: string
  readonly action: "nothing_to_do" | "skipped_live" | "reclaimed" | "manual_intervention_required"
  readonly liveness: Liveness["verdict"]
  readonly detail: string
  /** Paths whose ACE was proved gone. */
  readonly restored?: readonly string[]
  /** Paths we could not prove clean. Any entry makes the outcome manual. */
  readonly unproven?: readonly string[]
  readonly profileDeleted?: boolean
  readonly runDirectoryRemoved?: boolean
  /**
   * B6 (XP-06): the reclaim COMPLETED — machine proven clean, `Reclaimed`
   * durably recorded — but this pass's own lease release was refused because a
   * sibling recovery had already minted a strictly higher generation. The
   * supersession is fencing working as designed; reporting the whole pass as
   * refused for it was the accounting defect. The superseded lease is left to
   * expire, which is inert: its token can never mutate again.
   */
  readonly releaseSuperseded?: boolean
}

export interface IsolatedRecoveryDeps {
  readonly store: EventStore
  readonly helper: HelperRunner
  readonly now?: () => number
  /**
   * P5c2. Injected so the keeper-exit wait can be driven in a unit test without
   * a real hundred-millisecond pause, and so a test's fake clock is not paired
   * with a real sleep — which is how a bounded wait becomes an infinite one.
   */
  readonly sleep?: (ms: number) => Promise<void>
  /** Proves a directory is gone. Injected so the sweep is testable. */
  readonly removeDirectory?: (path: string) => void
  /**
   * Restrict the sweep to runs recorded as living inside THIS execution root.
   *
   * Set when recovery runs BEFORE `bootstrapExecutionRoot` — see
   * `reclaimBeforeBootstrap`. A run whose recorded `runPath` is not inside the
   * root we are about to adopt belongs to a different root, a different host
   * SID, or a layout we do not recognise, and this sweep has no business
   * touching it. It is deferred, not skipped silently.
   */
  readonly trustedRootPath?: string
}

export const IsoRecoveryEvents = {
  Requested: "isorun.recovery_requested",
  Reclaimed: "isorun.recovery_reclaimed",
  Deferred: "isorun.recovery_deferred",
} as const

/**
 * Reclaim what abandoned isolated runs left behind — and nothing else.
 *
 * Idempotent: reclaiming a run twice restores descriptors that are already
 * restored and deletes a profile that is already gone, both of which are
 * no-ops that are re-verified rather than assumed.
 */
export async function recoverIsolatedRuns(deps: IsolatedRecoveryDeps): Promise<IsolatedRecoveryOutcome[]> {
  const { runs, eventsByRun } = await scanIsolatedRunsWithEvents(deps.store)
  const outcomes: IsolatedRecoveryOutcome[] = []

  for (const run of runs) {
    // SCOPE FIRST, when a trusted root was named. A run that does not live
    // inside the root we are about to adopt is not ours to touch on this pass:
    // it may belong to another host SID, another layout version, or a root
    // nobody has proved anything about. Deferred rather than skipped, so it is
    // visible rather than forgotten.
    if (deps.trustedRootPath) {
      const inside = run.runPath ? lower(run.runPath).startsWith(`${lower(deps.trustedRootPath)}\\`) : false
      if (!inside) {
        const detail = `this run records ${run.runPath ?? "no run path"}, which is not inside the execution root being adopted (${deps.trustedRootPath}); a pre-bootstrap sweep does not touch roots it has proved nothing about`
        await emit(deps.store, run.runId, IsoRecoveryEvents.Deferred, { runId: run.runId, reasonCode: "recovery_root_not_trusted", detail })
        outcomes.push({ runId: run.runId, action: "manual_intervention_required", liveness: "unknown", detail })
        continue
      }
    }

    const liveness = await assessLiveness(deps, run)

    if (liveness.verdict === "live") {
      outcomes.push({ runId: run.runId, action: "skipped_live", liveness: liveness.verdict, detail: liveness.why })
      continue
    }
    if (liveness.verdict === "unknown") {
      await emit(deps.store, run.runId, IsoRecoveryEvents.Deferred, { runId: run.runId, reasonCode: "liveness_unknown", detail: liveness.why })
      outcomes.push({ runId: run.runId, action: "manual_intervention_required", liveness: liveness.verdict, detail: liveness.why })
      continue
    }
    if (liveness.verdict === "finished" && run.revocationVerified && run.cleaned) {
      // TRUST, THEN VERIFY. A released lease is a CLAIM — "I finished and left
      // nothing" — made by a process that may have been wrong, or that may have
      // died between the claim and the reality. Believing it unconditionally
      // makes the one signal recovery leans on hardest the one signal nothing
      // checks, and residue under a released lease would then be invisible
      // forever, because no later pass would ever look again.
      //
      // So the resources are re-inspected. This is cheap (a handful of reads)
      // and it is the difference between "the journal says it is clean" and "it
      // is clean".
      const residue = await releasedRunResidue(deps, run)
      if (residue.length > 0) {
        const detail = `this run released its lease, but its resources are still present: ${residue.join(", ")}. A release is a claim, and this one is false.`
        await emit(deps.store, run.runId, IsoRecoveryEvents.Deferred, { runId: run.runId, reasonCode: "released_run_residue_detected", residue, detail })
        outcomes.push({ runId: run.runId, action: "manual_intervention_required", liveness: liveness.verdict, detail, unproven: residue })
        continue
      }
      outcomes.push({ runId: run.runId, action: "nothing_to_do", liveness: liveness.verdict, detail: "the run recorded a verified revocation and a completed cleanup, and re-inspection found no residue" })
      continue
    }

    // Either reclaimable, or finished-but-not-fully-cleaned (a refusal that died
    // partway through its own compensation). Both need the same work.

    // LAW 1. Everything below is read from a recorded event or the run is
    // deferred. A guessed profile name is what turned a namespace collision into
    // a deletion, and there is no version of that guess which is safe.
    const missing: string[] = []
    if (run.grants.length > 0 && !run.appContainerSid) missing.push("appContainerSid")

    // Every operation that ever legitimately held this run. A grant written by
    // anything else is evidence of unknown provenance.
    const knownOperations = new Set<string>()
    for (const e of eventsByRun.get(run.runId) ?? []) {
      if (e.type !== "isorun.lease_acquired") continue
      const op = String((e.data as Record<string, unknown>)?.operationId ?? "")
      if (op) knownOperations.add(op)
    }

    for (const g of run.grants) {
      if (!g.originalSddl) missing.push(`originalSddl:${g.path}`)
      if (!g.sid) missing.push(`sid:${g.path}`)

      // ONE ORIGINAL PER OBJECT. More than one DISTINCT original descriptor for
      // the same object is conflicting evidence, not a duplicate: the later
      // capture recorded a state that already contained the earlier ACE, so
      // restoring it would leave the container on the object. We do not know
      // which is the true original, and guessing is how residue becomes
      // permanent while the log says "reclaimed".
      if (g.originalsSeen.length > 1) {
        missing.push(`conflicting_originals:${g.path} (${g.originalsSeen.length} distinct originals across ${g.mutationCount} mutations)`)
      }

      // PROVENANCE. A grant whose operation never appears in this run's lease
      // history was written by something that did not hold the run. Undoing it
      // means acting on a record we cannot explain.
      if (g.operationId && knownOperations.size > 0 && !knownOperations.has(g.operationId)) {
        missing.push(`unknown_operation:${g.path} (grant claims ${g.operationId}, which never held this run)`)
      }
    }
    if (missing.length > 0) {
      const detail = `these facts were never recorded, so the resources they name cannot be safely touched: ${missing.join(", ")}. Reconstructing them from the runId is exactly the inference that made a previous defect destructive.`
      await emit(deps.store, run.runId, IsoRecoveryEvents.Deferred, { runId: run.runId, reasonCode: "recovery_evidence_missing", missing, detail })
      outcomes.push({ runId: run.runId, action: "manual_intervention_required", liveness: liveness.verdict, detail })
      continue
    }

    // RECOVERY TAKES OWNERSHIP BEFORE IT TOUCHES ANYTHING.
    //
    // It acquires a lease of its own, which mints a strictly higher fencing
    // token. That is not bookkeeping — it is what makes the reclaim safe:
    //
    //   - the dead run's holder is now provably stale, so if it ever comes back
    //     (a resumed VM, a merely-suspended process) every mutation and even its
    //     release is refused by `assertMayMutate`, rather than racing this sweep
    //     over the same ACEs and profile;
    //   - two RECOVERY passes cannot both proceed, because the CAS behind the
    //     token means only one of them can be current;
    //   - and the reclaim is recorded under an owner, so the journal says who
    //     did it rather than implying it happened by itself.
    //
    // Acquired AFTER the evidence checks above, so a run we are going to defer on
    // does not get its token bumped for nothing.
    const reclaimLease = await acquireRunLease({ store: deps.store, ...(deps.now ? { now: deps.now } : {}) }, { runId: run.runId, operationId: newOperationId(), ownerPid: process.pid, ownerStartTime: `recovery-${process.pid}` }, RECLAIM_LEASE_TTL_MS)
    await assertMayMutate({ store: deps.store, ...(deps.now ? { now: deps.now } : {}) }, reclaimLease, "reclaim an abandoned run")

    await emit(deps.store, run.runId, IsoRecoveryEvents.Requested, {
      runId: run.runId,
      liveness: liveness.verdict,
      grants: run.grants.length,
      profileName: run.profileName ?? null,
      runPath: run.runPath ?? null,
      reclaimOperationId: reclaimLease.operationId,
      reclaimFencingToken: reclaimLease.fencingToken,
    })

    // ---- THE PROCESS TREE, ENDED BEFORE A SINGLE ACE IS TOUCHED.
    //
    // This ordering is the whole reason the step exists here rather than later.
    // The run's ACEs are what a surviving process is USING; restoring them under
    // it would leave a live container that has lost access to its own working
    // directory — the definition of sabotage rather than cleanup — and would then
    // report the object clean while a process still held handles into it.
    //
    // So: terminate, prove the tree is empty, and only then restore.
    //
    // The verb is given ONLY what the run durably recorded. There is no derived
    // name, no fallback, no kill by image name and no bare-pid kill: the job's
    // MEMBERSHIP is the authorisation, and anything else can reach a stranger.
    let treeTerminated: boolean | undefined
    if (run.jobName && run.jobSessionId !== undefined && run.jobOperationId && run.jobFencingToken !== undefined) {
      const argv = [
        "terminate-process-tree",
        "--job-name",
        run.jobName,
        "--run-id",
        run.runId,
        "--operation-id",
        run.jobOperationId,
        "--fencing-token",
        String(run.jobFencingToken),
        "--expect-session-id",
        String(run.jobSessionId),
        ...(run.childPid && run.childStartTime ? ["--expect-initial-pid", String(run.childPid), "--expect-initial-start", run.childStartTime] : []),
        ...(run.appContainerSid ? ["--expect-appcontainer-sid", run.appContainerSid] : []),
        ...(deps.trustedRootPath ? ["--expect-root-path", deps.trustedRootPath] : []),
      ]
      const killed = await deps.helper({ argv })
      treeTerminated = killed.treeGone === true

      // `terminate_job_absent` means the NAME no longer resolves, which is NOT
      // proof the tree ended — a name does not outlive its last handle. It is
      // only acceptable here when the recorded child is independently confirmed
      // gone, which is the one thing that case can still measure.
      const absentButChildGone = killed.stage === "terminate_job_absent" && killed.initialProcessAlive === false

      // ---- P5c2. AN ABSENT NAME WITH A MISSING KEEPER IS ITS OWN DIAGNOSIS.
      //
      // `terminate_job_absent` has two completely different causes and P5c could
      // not tell them apart:
      //
      //   * the tree ended and the last handle went with it — benign; or
      //   * THE KEEPER DIED while the tree kept running, so the object manager
      //     dropped the name and the live tree became unreachable.
      //
      // The second is unrecoverable by any automatic action available here, and
      // the one thing that must never happen is for it to be reported as a
      // reclaimed run. It is named explicitly, with the keeper checked as pid
      // AND creation time, so an operator is told what is actually wrong rather
      // than being handed "the job was absent".
      if (killed.stage === "terminate_job_absent" && !absentButChildGone && run.jobKeeperPid !== undefined && run.jobKeeperStartTime) {
        const keeper = await deps.helper({ argv: ["inspect-process", "--pid", String(run.jobKeeperPid), "--expect-start", run.jobKeeperStartTime] })
        if (keeper.alive !== true) {
          const detail =
            `job ${run.jobName} is no longer openable and its keeper (pid ${run.jobKeeperPid}, started ${run.jobKeeperStartTime}) is gone, ` +
            `so the name was dropped rather than released: a temporary kernel object loses its NAME when its last handle closes. ` +
            `The run's child could not be independently confirmed gone either, so this tree may still be running with no route left to reach it as a whole. ` +
            `Nothing was terminated and no ACE was touched. This needs a human: identify the surviving processes by hand before anything is restored.`
          await emit(deps.store, run.runId, IsoRecoveryEvents.Deferred, {
            runId: run.runId,
            reasonCode: "job_keeper_missing",
            jobName: run.jobName,
            keeperPid: run.jobKeeperPid,
            keeperStartTime: run.jobKeeperStartTime,
            stage: killed.stage ?? null,
            detail,
          })
          outcomes.push({ runId: run.runId, action: "manual_intervention_required", liveness: liveness.verdict, detail })
          continue
        }
      }

      if (!treeTerminated && !absentButChildGone) {
        const detail =
          `this run's process tree could not be proved to have ended (${String(killed.stage ?? "no stage")}: ${String(killed.detail ?? killed.error ?? "no detail")}). ` +
          `Its ACEs are left exactly as they are: restoring them under processes that may still be using them is not recovery.`
        await emit(deps.store, run.runId, IsoRecoveryEvents.Deferred, {
          runId: run.runId,
          reasonCode: "tree_termination_unproven",
          jobName: run.jobName,
          stage: killed.stage ?? null,
          processesBefore: killed.processesBefore ?? null,
          processesAfter: killed.processesAfter ?? null,
          detail,
        })
        outcomes.push({ runId: run.runId, action: "manual_intervention_required", liveness: liveness.verdict, detail })
        continue
      }

      // ---- P5c2. THE KEEPER IS PART OF THE RUN, so it is reaped and CONFIRMED
      // before anything is restored.
      //
      // Nothing signals it: it exits on its own when the job's member list comes
      // back empty, which the termination above has just made true. Waiting for
      // that is not politeness — it is the last independent confirmation
      // available. The keeper holds a handle to the same object and reaches the
      // same conclusion by its own query; its exit is a SECOND witness that the
      // job really is empty, from a process that has been watching the whole
      // time.
      //
      // A keeper that does NOT exit here has failed to read the job it holds,
      // which is precisely the unknown state it is built to sit still in. That
      // is not a reclaim — the run defers, with the keeper left alone.
      if (treeTerminated && run.jobKeeperPid !== undefined && run.jobKeeperStartTime) {
        let keeperGone = false
        const clock = deps.now ?? Date.now
        const pause = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
        const deadline = clock() + KEEPER_EXIT_BUDGET_MS
        // Asked at least once even if the budget is already spent, so a caller
        // with a frozen test clock measures the keeper rather than the clock.
        for (;;) {
          const k = await deps.helper({ argv: ["inspect-process", "--pid", String(run.jobKeeperPid), "--expect-start", run.jobKeeperStartTime] })
          if (k.alive !== true) {
            keeperGone = true
            break
          }
          if (clock() >= deadline) break
          await pause(KEEPER_EXIT_POLL_MS)
        }
        if (!keeperGone) {
          const detail =
            `the tree of job ${run.jobName} was terminated and proved empty, but its keeper (pid ${run.jobKeeperPid}) is still running. ` +
            `The keeper exits on an OS-confirmed empty job, so one that has not exited has failed to read the job it holds — an unknown state, not a finished one. ` +
            `Nothing was restored. The keeper was left alone: killing it would drop the job's name while its own view of the job is still unresolved.`
          await emit(deps.store, run.runId, IsoRecoveryEvents.Deferred, {
            runId: run.runId,
            reasonCode: "job_keeper_still_running",
            jobName: run.jobName,
            keeperPid: run.jobKeeperPid,
            keeperStartTime: run.jobKeeperStartTime,
            detail,
          })
          outcomes.push({ runId: run.runId, action: "manual_intervention_required", liveness: liveness.verdict, detail })
          continue
        }
      }
    }

    // ---- ACLs, restored from the DURABLE original and proved by re-reading.
    const restored: string[] = []
    const unproven: string[] = []
    for (const g of [...run.grants].reverse()) {
      // IDENTITY BEFORE MUTATION. The recorded descriptor belongs to a specific
      // file, not to a path. If the object now at that path is a DIFFERENT one —
      // a new volume, a recreated directory, a name that has been reused — then
      // restoring is writing somebody else's ACL, and refusing is the only safe
      // move. An object that has VANISHED is fine: it carries no ACE.
      const nowId = await deps.helper({ argv: ["inspect-dir", "--path", g.path] })
      if (nowId.pathExists === true && (g.fileId || g.volumeSerial)) {
        const same = String(nowId.pathFileId ?? "") === (g.fileId ?? "") && String(nowId.pathVolumeSerial ?? "") === (g.volumeSerial ?? "")
        if (!same) {
          unproven.push(`${g.path} (identity moved: granted ${g.fileId}:${g.volumeSerial}, now ${String(nowId.pathFileId ?? "")}:${String(nowId.pathVolumeSerial ?? "")})`)
          continue
        }
      }
      const args = ["restore-acl", "--path", g.path, "--sid", g.sid, "--original-sddl", g.originalSddl, ...(g.grantedSddl ? ["--expect-granted-sddl", g.grantedSddl] : [])]
      await deps.helper({ argv: args })
      const now = String((await deps.helper({ argv: ["inspect-acl", "--path", g.path] })).sddl ?? "")
      // THE PROOF IS THE RE-READ. An object that no longer exists is also clean:
      // a deleted run directory cannot be carrying an ACE.
      // THE PROOF IS THE RE-READ, not `r.ok`. Two things count as clean: the
      // object no longer carries the container's SID, or the object is not there
      // at all — a deleted run directory cannot be holding an ACE. Anything else
      // is unproven, INCLUDING a `restore-acl` that returned success, because a
      // call returning is not a descriptor changing.
      const stillCarriesSid = now.toLowerCase().includes(g.sid.toLowerCase())
      const objectGone = (await deps.helper({ argv: ["inspect-dir", "--path", g.path] })).pathExists !== true
      if (objectGone) {
        restored.push(g.path)
        continue
      }
      if (stillCarriesSid) {
        unproven.push(g.path)
        continue
      }
      // NO FOREIGN PRINCIPAL SURVIVES. Losing OUR container's ACE is necessary
      // but not sufficient: the descriptor must be back to what it was. Any
      // principal present now that the recorded original did not name is
      // something this run's restore introduced or failed to remove — most
      // likely a DIFFERENT container from an overlapping run — and reporting
      // that as reclaimed would hide exactly the residue this sweep exists for.
      const before = new Set(principalsOf(g.originalSddl))
      const foreign = [...new Set(principalsOf(now))].filter((sid) => !before.has(sid))
      if (foreign.length > 0) {
        unproven.push(`${g.path} (foreign principal survived: ${foreign.join(", ")})`)
        continue
      }
      restored.push(g.path)
    }

    // ---- The profile, by its RECORDED name only.
    let profileDeleted: boolean | undefined
    if (run.profileName) {
      if (!run.profileName.startsWith(OWNERSHIP_PREFIX)) {
        // The helper enforces this too; refusing here as well means a bad name
        // never even reaches it.
        profileDeleted = false
        unproven.push(`profile:${run.profileName}`)
      } else {
        const del = await deps.helper({ argv: ["delete-profile", "--name", run.profileName] })
        profileDeleted = del.profileExists === false
        if (!profileDeleted) unproven.push(`profile:${run.profileName}`)
      }
    }

    // ---- The run directory, by its RECORDED path only.
    let runDirectoryRemoved: boolean | undefined
    if (run.runPath) {
      deps.removeDirectory?.(run.runPath)
      runDirectoryRemoved = (await deps.helper({ argv: ["inspect-dir", "--path", run.runPath] })).pathExists !== true
      if (!runDirectoryRemoved) unproven.push(`runPath:${run.runPath}`)
    }

    if (unproven.length > 0) {
      const detail = `reclamation could not prove these clean: ${unproven.join(", ")}`
      await emit(deps.store, run.runId, IsoRecoveryEvents.Deferred, { runId: run.runId, reasonCode: "reclaim_unproven", unproven, detail })
      // NOT released: the reclaim did not achieve a clean machine, and a release
      // is a claim that it did. Leaving it to expire keeps the run visible.
      outcomes.push({ runId: run.runId, action: "manual_intervention_required", liveness: liveness.verdict, detail, restored, unproven, ...(profileDeleted === undefined ? {} : { profileDeleted }), ...(runDirectoryRemoved === undefined ? {} : { runDirectoryRemoved }) })
      continue
    }

    await emit(deps.store, run.runId, IsoRecoveryEvents.Reclaimed, { runId: run.runId, restored: restored.length, profileDeleted: profileDeleted ?? null, runDirectoryRemoved: runDirectoryRemoved ?? null, reclaimOperationId: reclaimLease.operationId, jobName: run.jobName ?? null, treeTerminated: treeTerminated ?? null })
    // The machine is clean and re-inspected, so the reclaim lease may honestly
    // be released — the same rule a normal run obeys.
    //
    // B6 (XP-06): THE RELEASE CAN BE REFUSED FOR A RECLAIM THAT SUCCEEDED. The
    // `Reclaimed` event above is already durable, and `assertMayMutate` inside
    // the release refuses ANY superseded holder — including this pass, when a
    // sibling recovery minted a strictly higher generation mid-pass. Letting
    // that refusal escape here discarded the whole pass's outcomes and reported
    // completed work as refused: two Reclaimed events in the store against one
    // reclaiming pass in the log, the exact intermittent XP-06 red. The
    // supersession itself is fencing doing its job, so it is caught HERE,
    // narrowly, and reported truthfully on the outcome; every other error still
    // propagates.
    let releaseSuperseded = false
    try {
      await releaseRunLease(
        { store: deps.store, ...(deps.now ? { now: deps.now } : {}) },
        reclaimLease,
        "completed",
        { clean: true, checkedAt: (deps.now ?? Date.now)(), aclPathsClean: restored, aclPathsDirty: [], profileAbsent: profileDeleted ?? "never_created", runRootAbsent: runDirectoryRemoved ?? "never_created", childProcessGone: true },
      )
    } catch (e) {
      if (!(e instanceof StaleLeaseHolder)) throw e
      releaseSuperseded = true
    }
    outcomes.push({
      runId: run.runId,
      action: "reclaimed",
      liveness: liveness.verdict,
      detail: `restored ${restored.length} descriptor(s)` + (releaseSuperseded ? "; release superseded by a newer recovery generation (lease left to expire)" : ""),
      restored,
      unproven,
      ...(profileDeleted === undefined ? {} : { profileDeleted }),
      ...(runDirectoryRemoved === undefined ? {} : { runDirectoryRemoved }),
      ...(releaseSuperseded ? { releaseSuperseded } : {}),
    })
  }

  return outcomes
}

/**
 * What a run that CLAIMED to be clean actually left behind.
 *
 * Deliberately read-only. A released run is not reclaimed automatically even
 * when residue is found, because the two explanations — "cleanup half-failed"
 * and "something else recreated this path" — are indistinguishable from here,
 * and one of them makes deletion destructive. It is reported for a human.
 *
 * Only resources whose identity was RECORDED are checked. An unrecorded profile
 * name is not searched for by guessing; that guess is the original defect.
 */
async function releasedRunResidue(deps: IsolatedRecoveryDeps, run: IsolatedRunProjection): Promise<string[]> {
  const residue: string[] = []
  if (run.runPath) {
    if ((await deps.helper({ argv: ["inspect-dir", "--path", run.runPath] })).pathExists === true) residue.push(`runPath:${run.runPath}`)
  }
  if (run.profileName && run.profileName.startsWith(OWNERSHIP_PREFIX)) {
    if ((await deps.helper({ argv: ["inspect-dir", "--path", profileDirFor(run.profileName)] })).pathExists === true) residue.push(`profile:${run.profileName}`)
  }
  for (const g of run.grants) {
    if (!g.sid) continue
    const sddl = String((await deps.helper({ argv: ["inspect-acl", "--path", g.path] })).sddl ?? "")
    const objectGone = (await deps.helper({ argv: ["inspect-dir", "--path", g.path] })).pathExists !== true
    if (!objectGone && sddl.toLowerCase().includes(g.sid.toLowerCase())) residue.push(`acl:${g.path}`)
  }
  if (run.childPid && run.childPid > 0 && run.childStartTime) {
    const p = await deps.helper({ argv: ["inspect-process", "--pid", String(run.childPid), "--expect-start", run.childStartTime] })
    if (p.alive === true) residue.push(`process:${run.childPid}`)
  }
  return residue
}

async function emit(store: EventStore, runId: string, type: string, data: Record<string, unknown>): Promise<void> {
  await store.append({ aggregateKind: "project", aggregateId: runLeaseAggregateId(runId), type, version: 1, data })
}

/**
 * Reclaim abandoned runs BEFORE a new execution root is bootstrapped.
 *
 * WHY THE ORDER MATTERS, measured rather than theorised. A host killed just as
 * its ACEs landed leaves an AppContainer ACE on the SHARED execution root.
 * `bootstrapExecutionRoot` is fail-closed and refuses to adopt a root whose DACL
 * has drifted from its marker — correctly. But recovery used to run only AFTER
 * bootstrap, so the host could never get far enough to repair the very thing
 * blocking it: one crash disabled every subsequent run on the machine until a
 * human intervened. Reversing the order is what makes the host self-healing.
 *
 * IT IS DELIBERATELY NARROW. Running a mutating sweep before anything has been
 * proved is how a recovery pass becomes the thing that breaks a machine, so this
 * touches ONLY runs that:
 *
 *   - record a `runPath` INSIDE the root about to be adopted (`trustedRootPath`);
 *   - carry complete durable evidence — original descriptor, SID, object
 *     identity — which the sweep already demands;
 *   - are provably not live, by lease and by process identity;
 *   - and can be owned, via the reclaim lease's fencing token.
 *
 * It NEVER repairs a root it cannot identify, never invents a profile name, and
 * never deletes anything an event did not name. Anything short of the above is
 * `manual_intervention_required` — a human looks at it, and the host stays
 * refusing to run rather than guessing its way back to health.
 */
export async function reclaimBeforeBootstrap(deps: Omit<IsolatedRecoveryDeps, "trustedRootPath">, trustedRootPath: string): Promise<IsolatedRecoveryOutcome[]> {
  if (!trustedRootPath) return []
  return await recoverIsolatedRuns({ ...deps, trustedRootPath })
}
