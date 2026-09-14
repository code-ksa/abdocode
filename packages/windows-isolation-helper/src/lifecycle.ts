/**
 * CL-16A2-D §3/§4 — the orchestrator.
 *
 * Every stage obeys the same four beats, in this order and no other:
 *
 *     1. write the INTENT durably
 *     2. run the IDEMPOTENT helper operation
 *     3. OBSERVE what the OS actually did
 *     4. write the COMPLETION from that observation
 *
 * Beat 3 is the one that is easy to skip and the one that matters. The
 * completion event records `profileExists` as the helper SAW it, not "the API
 * returned 0" — so a journal entry saying a profile exists is a statement about
 * the machine, not about a return code.
 *
 * Resource names are DERIVED FROM THE runId. That is what makes beat 1 useful:
 * if the host dies between the intent and the completion, recovery still knows
 * the exact profile name to look for, because it can compute it.
 */
import { readFileSync } from "node:fs"
import { writeCompactMarkerFile } from "./controlled-fs"
import { join as joinPath } from "node:path"
import type { EventStore } from "@abdo/event-store"
import { AC, appendAc, foldRun, leaseKey, runAggregateId, sha256, type GrantRecord, type RunProjection } from "./journal"
import { acquireLease, releaseLease } from "./leases"
import { ElevatedHostNotSupported, type HelperResponse, type HelperRunner } from "./helper-runner"

export const OWNERSHIP_PREFIX = "abdo-winiso-"

/** DETERMINISTIC, and derivable by recovery from the runId alone. */
export const profileNameFor = (runId: string) => `${OWNERSHIP_PREFIX}${runId}`.slice(0, 64)

/** Where Windows keeps an AppContainer's package directory. */
export const profileDirFor = (profileName: string) => joinPath(process.env.LOCALAPPDATA ?? "", "Packages", profileName)

/** The owner marker's filename inside that directory. */
export const OWNER_MARKER = "abdo-owner.json"

export interface OwnerMarker {
  readonly runId: string
  readonly hostPid: number
  /** Creation time as decimal DIGITS: a FILETIME does not fit in a JS number. */
  readonly hostStartTime: string
  readonly stateEpoch: number
}

/**
 * Stamp the profile with WHO owns it, on disk, next to the resource itself.
 *
 * The orphan sweep's only guard used to be the name prefix: a recovery pass with
 * an empty journal deleted EVERY `abdo-winiso-*` profile on the machine without
 * ever asking whether one was in use. That is correct only while exactly one
 * host with one journal exists — the moment a second host runs, or a journal is
 * lost, the sweep destroys live containers.
 *
 * The marker survives journal loss because it lives beside the thing it
 * describes, and it carries pid AND creation time because Windows reuses pids
 * (the §5.4 lesson, applied to ownership rather than to liveness).
 */
export function writeOwnerMarker(profileName: string, marker: OwnerMarker): void {
  try {
    writeCompactMarkerFile(joinPath(profileDirFor(profileName), OWNER_MARKER), marker)
  } catch {
    // Best effort: a profile without a marker is treated as UNOWNED by the
    // sweep, which is the conservative direction only because the sweep also
    // refuses anything a live run claims. It is never a reason to fail a run.
  }
}

export function readOwnerMarker(profileName: string): OwnerMarker | undefined {
  try {
    const raw = readFileSync(joinPath(profileDirFor(profileName), OWNER_MARKER), "utf8")
    const m = JSON.parse(raw) as OwnerMarker
    return typeof m.hostPid === "number" ? m : undefined
  } catch {
    return undefined
  }
}

/**
 * Runs THIS host currently has in flight.
 *
 * Recovery must never reclaim a run that is executing right now, and the
 * journal alone cannot tell that: between `run_requested` and `process_started`
 * there is no pid to ask about, and after a sink failure a run is abandoned
 * even though its host process is still very much alive. The host's own
 * in-flight set answers the in-process half exactly, and the recorded
 * `hostPid` + `hostStartTime` answer the cross-process half.
 *
 * A run leaves this set as soon as `executeRun` returns OR throws — being
 * abandoned is precisely the state in which recovery SHOULD take it over.
 */
export const inFlightRuns = new Set<string>()

/** Points at which a test kills the HOST. See `HostCrashed`. */
export type HostCrashPoint =
  | "after_run_requested"
  | "after_profile_intent_before_create"
  | "after_profile_created_before_event"
  | "after_acl_intent_before_grant"
  | "after_acl_granted_before_event"
  | "after_process_started_before_event"
  | "during_process_running"
  | "after_process_exit_before_acl_restore"
  | "after_acl_restore_before_event"
  | "after_profile_delete_before_event"

/**
 * A simulated host death. It is thrown and NEVER caught inside the lifecycle, so
 * no cleanup runs — which is the whole point: a `finally` that tidied up would
 * make the test prove the opposite of what it claims. Helper-side crashes are
 * real (`--crash-at` calls `abort()`); this is the host side.
 */
export class HostCrashed extends Error {
  constructor(readonly point: HostCrashPoint) {
    super(`host crashed at ${point}`)
  }
}

export interface GrantRequest {
  readonly path: string
  readonly rights: "rx" | "modify"
}

export interface RunRequest {
  readonly runId: string
  readonly argv: readonly string[]
  readonly grants: readonly GrantRequest[]
  readonly timeoutMs?: number
  readonly cwd?: string
  /** Forwarded to the helper: a REAL abort inside the child. */
  readonly helperCrashAt?: string
  readonly hostCrashAt?: HostCrashPoint
  /** Announce arrival at each point. Used to kill this process for real. */
  readonly onPoint?: CrashPointHook
}

export interface LifecycleDeps {
  readonly store: EventStore
  readonly helper: HelperRunner
  readonly helperBinaryHash: string
  readonly helperProtocolVersion: number
}

/**
 * Called as each point is reached, BEFORE the in-process `HostCrashed` throw.
 *
 * CL-16A2-D-R exists partly because the only "host crash" this slice had was
 * that throw — a control-flow simulation in a process that never died, against
 * a store that lived in RAM. This hook is what lets a child process announce
 * "I am exactly here" and then block, so a parent can kill it for real and
 * prove the journal survived a death rather than an exception.
 */
export type CrashPointHook = (point: HostCrashPoint) => void | Promise<void>

interface CrashPoints {
  readonly hostCrashAt?: HostCrashPoint
  readonly onPoint?: CrashPointHook
}

const crash = async (req: CrashPoints, here: HostCrashPoint): Promise<void> => {
  if (req.onPoint) await req.onPoint(here)
  if (req.hostCrashAt === here) throw new HostCrashed(here)
}

/**
 * The child's OUTPUT, returned to the caller and never written to the journal.
 *
 * §2 forbids stdout/stderr in events — it is exactly where a secret shows up —
 * but the production launcher has to hand the output back to the tool. So it
 * travels as a return value and stops there.
 */
export interface RunOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly timedOut: boolean
  /** Proof a child really ran: a pid the OS gave us, and its creation time. */
  readonly childStarted: boolean
  readonly pid?: number
  /** OBSERVED containment, for the launcher's `isolation.applied` precondition. */
  readonly assignedToJob: boolean
  readonly isProcessInJob: boolean
  readonly resumed: boolean
}

export interface RunResult extends RunProjection {
  readonly output?: RunOutput
}

export async function readRun(store: EventStore, runId: string): Promise<RunProjection> {
  const events = await store.read("project", runAggregateId(runId))
  return foldRun(runId, events)
}

/**
 * Run one command inside an AppContainer, journalling every step.
 *
 * Returns the final projection. It does NOT throw on a failed command — a
 * non-zero exit is a result. It DOES propagate `HostCrashed`, because a test
 * that swallowed it would be testing nothing.
 */
export async function executeRun(deps: LifecycleDeps, req: RunRequest): Promise<RunResult> {
  const { store } = deps
  const runId = req.runId
  const agg = runAggregateId(runId)
  const profileName = profileNameFor(runId)
  const base = {
    runId,
    profileName,
    stateEpoch: 0,
    helperBinaryHash: deps.helperBinaryHash,
    helperProtocolVersion: deps.helperProtocolVersion,
  }

  // ---- 0. PRECONDITION, before the journal is even touched (§9).
  //
  // The runner enforces this too, but the LIFECYCLE is the layer that decides
  // whether this machine's AppContainer path is usable at all, and a policy
  // that lives only in one adapter is a policy that a second adapter silently
  // omits. The refusal rests on the helper's own report of its privilege — a
  // measurement — not on an assumption about the shell.
  const privilege = await deps.helper({ argv: ["version"] })
  if (privilege.elevated === true) throw new ElevatedHostNotSupported()

  // WHO IS RUNNING THIS, recorded before anything else.
  //
  // Recovery could otherwise take over a run that is still in progress. Between
  // `run_requested` and `process_started` the journal holds no pid at all, so a
  // sweep had no way to distinguish "the host died early" from "the host is
  // alive and about to start the process" — and it chose to clean up, deleting
  // the profile and ACLs of a live run. Measured by the §7 case where a normal
  // cleanup and a recovery pass run at the same time.
  //
  // pid AND creation time, as digits: a pid alone is not an identity.
  const self = await deps.helper({ argv: ["inspect-process", "--pid", String(process.pid)] })
  const host = { hostPid: process.pid, hostStartTime: String(self.startTime ?? "") }
  inFlightRuns.add(runId)
  try {

  // ---- 1. INTENT for the whole run, before anything exists.
  await appendAc({ store }, agg, AC.RunRequested, { ...base, ...host, grants: req.grants.map((g) => ({ path: g.path, rights: g.rights })) }, `run-requested:${runId}`)
  await crash(req, "after_run_requested")

  // ---- 2. PROFILE: intent -> ensure -> observe -> completion.
  await appendAc({ store }, agg, AC.ProfileCreateRequested, base, `profile-intent:${runId}`)
  await crash(req, "after_profile_intent_before_create")
  const ensured = await deps.helper({ argv: ["ensure-profile", "--name", profileName] })
  await crash(req, "after_profile_created_before_event")
  const sid = String(ensured.sid ?? "")
  if (!ensured.ok || !sid) {
    await appendAc({ store }, agg, AC.CleanupFailed, { ...base, reasonCode: "profile_create_failed", detail: String(ensured.error ?? ensured.createHresult ?? "") })
    return readRun(store, runId)
  }
  await appendAc(
    { store },
    agg,
    AC.ProfileCreated,
    { ...base, sid, created: ensured.created === true, existed: ensured.existed === true, profileExists: ensured.profileExists === true },
    `profile-created:${runId}`,
  )
  // Stamp ownership ON THE RESOURCE, so a sweep that has lost the journal can
  // still tell a live container from an abandoned one.
  const hostIdentity = await deps.helper({ argv: ["inspect-process", "--pid", String(process.pid)] })
  writeOwnerMarker(profileName, {
    runId,
    hostPid: process.pid,
    hostStartTime: String(hostIdentity.startTime ?? ""),
    stateEpoch: 0,
  })

  // ---- 3. GRANTS: one intent, one lease, one grant, one completion, each.
  const leases: { key: string; path: string }[] = []
  for (const g of req.grants) {
    const inspected = await deps.helper({ argv: ["inspect-acl", "--path", g.path] })
    const resourceIdentity = String(inspected.fileIdentity ?? "")
    const originalSddl = String(inspected.sddl ?? "")
    if (!inspected.ok || !resourceIdentity) {
      await appendAc({ store }, agg, AC.CleanupFailed, { ...base, sid, reasonCode: "acl_inspect_failed", path: g.path })
      continue
    }
    await appendAc(
      { store },
      agg,
      AC.AclGrantRequested,
      { ...base, sid, path: g.path, resourceIdentity, rights: g.rights, originalSddl, originalSddlHash: sha256(originalSddl) },
      `acl-intent:${runId}:${g.path}`,
    )
    await crash(req, "after_acl_intent_before_grant")

    const lease = await acquireLease(store, { resourceIdentity, sid, rights: g.rights }, runId)
    leases.push({ key: lease.ref.key, path: g.path })

    let grantedSddl = originalSddl
    if (lease.mustGrant) {
      const granted = await deps.helper({ argv: ["grant-acl", "--path", g.path, "--sid", sid, "--rights", g.rights] })
      await crash(req, "after_acl_granted_before_event")
      if (!granted.ok) {
        await appendAc({ store }, agg, AC.CleanupFailed, { ...base, sid, reasonCode: "acl_grant_failed", path: g.path, detail: String(granted.errorCode ?? "") })
        continue
      }
      grantedSddl = String(granted.sddlAfter ?? "")
    } else {
      // Another holder already granted it. OBSERVE rather than assume.
      const seen = await deps.helper({ argv: ["inspect-acl", "--path", g.path] })
      grantedSddl = String(seen.sddl ?? "")
    }
    const record: GrantRecord = {
      path: g.path,
      resourceIdentity,
      rights: g.rights,
      originalSddl,
      originalSddlHash: sha256(originalSddl),
      grantedSddl,
      grantedSddlHash: sha256(grantedSddl),
    }
    await appendAc({ store }, agg, AC.AclGranted, { ...base, sid, ...record, leaseKey: lease.ref.key, sharedWith: lease.holders.length - 1 }, `acl-granted:${runId}:${g.path}`)
  }

  // ---- 4. PROCESS: intent -> launch -> observe -> completion.
  await appendAc({ store }, agg, AC.ProcessStartRequested, { ...base, sid, argvLength: req.argv.length, commandHash: sha256(JSON.stringify(req.argv)) }, `process-intent:${runId}`)
  const launchArgs = [
    "launch-in-profile",
    "--name",
    profileName,
    "--timeout-ms",
    String(req.timeoutMs ?? 30_000),
    ...(req.cwd ? ["--cwd", req.cwd] : []),
    ...(req.helperCrashAt ? ["--crash-at", req.helperCrashAt] : []),
    "--",
    ...req.argv,
  ]
  let launched: HelperResponse
  try {
    launched = await deps.helper({ argv: launchArgs, timeoutMs: (req.timeoutMs ?? 30_000) + 30_000 })
  } catch (e) {
    // The helper died (a real abort, or a crash injection). The journal keeps
    // the INTENT, which is what lets recovery find the profile afterwards.
    await appendAc({ store }, agg, AC.CleanupFailed, { ...base, sid, reasonCode: "helper_died_during_launch", detail: e instanceof Error ? e.message.slice(0, 300) : String(e) })
    await requestCleanup(deps, runId, sid, profileName, leases)
    return readRun(store, runId)
  }
  await crash(req, "after_process_started_before_event")
  // pid AND creation time: together they are a process IDENTITY. A pid alone is
  // not one, because Windows reuses them — and recovery asking about a reused
  // pid concludes a dead run is alive and never cleans it up.
  await appendAc(
    { store },
    agg,
    AC.ProcessStarted,
    { ...base, sid, pid: Number(launched.pid ?? 0), startTime: String(launched.startTime ?? ""), commandHash: sha256(JSON.stringify(req.argv)) },
    `process-started:${runId}`,
  )
  await crash(req, "during_process_running")
  await appendAc(
    { store },
    agg,
    AC.ProcessExited,
    { ...base, sid, exitCode: launched.exitCode ?? null, timedOut: launched.timedOut === true, assignedToJob: launched.assignedToJob === true },
    `process-exited:${runId}`,
  )
  await crash(req, "after_process_exit_before_acl_restore")

  // Captured BEFORE cleanup and returned to the caller. A real pid AND a real
  // creation time are what make `childStarted` a measurement rather than an
  // assumption: a result with neither is a run that never happened.
  const output: RunOutput = {
    stdout: String(launched.stdout ?? ""),
    stderr: String(launched.stderr ?? ""),
    exitCode: launched.exitCode === null || launched.exitCode === undefined ? null : Number(launched.exitCode),
    timedOut: launched.timedOut === true,
    childStarted: Number(launched.pid ?? 0) > 0 && String(launched.startTime ?? "") !== "",
    ...(Number(launched.pid ?? 0) > 0 ? { pid: Number(launched.pid) } : {}),
    assignedToJob: launched.assignedToJob === true,
    isProcessInJob: launched.isProcessInJob === true,
    resumed: launched.resumed === true,
  }

  await requestCleanup(deps, runId, sid, profileName, leases, req.hostCrashAt, req.onPoint)
  return { ...(await readRun(store, runId)), output }
  } finally {
    // Whether it completed or died, this host is no longer executing it.
    inFlightRuns.delete(runId)
  }
}

/**
 * Cleanup, also intent-first. It is a separate function because RECOVERY calls
 * exactly the same code — a second cleanup path would be a second set of bugs,
 * and the property that matters (idempotent, ownership-checked, lease-aware) has
 * to hold identically whether a live host or a restarted one is doing it.
 */
export async function requestCleanup(
  deps: LifecycleDeps,
  runId: string,
  sid: string,
  profileName: string,
  leases: readonly { key: string; path: string }[],
  hostCrashAt?: HostCrashPoint,
  onPoint?: CrashPointHook,
  stateEpoch = 0,
): Promise<void> {
  const { store } = deps
  const agg = runAggregateId(runId)
  const base = { runId, profileName, sid, stateEpoch, helperBinaryHash: deps.helperBinaryHash, helperProtocolVersion: deps.helperProtocolVersion }
  // A CLEANUP PASS OWNS AN EPOCH, and only the newest one may act.
  //
  // Two hosts can believe they are recovering the same run: the original,
  // returning from a long pause, and a restarted one that has already taken
  // over. Without this the older pass would delete resources the newer pass is
  // relying on. `recovery_state_conflict` is the §4 reason code for exactly
  // that, and it is checked BEFORE the intent is written, so a losing pass
  // leaves no trace of work it never did.
  const atStart = await readRun(store, runId)
  if (atStart.stateEpoch > stateEpoch) {
    await appendAc({ store }, agg, AC.CleanupFailed, {
      ...base,
      stateEpoch: atStart.stateEpoch,
      reasonCode: "recovery_state_conflict",
      detail: `this pass holds epoch ${stateEpoch} but the run has advanced to ${atStart.stateEpoch}; a newer host owns it`,
    })
    return
  }
  // The cleanup intent carries the idempotency key of ITS OWN epoch, so a fresh
  // recovery generation is not silently deduplicated against the dead host's.
  await appendAc({ store }, agg, AC.CleanupRequested, base, `cleanup-intent:${runId}:${stateEpoch}`)

  const projection = await readRun(store, runId)
  let blocked = false

  // Grants include PENDING ones — recorded from the intent, before the OS was
  // touched. A pending grant may or may not have been applied; the only way to
  // know is to look, and `restore-acl` looking is exactly what it does.
  for (const grant of projection.grants) {
    if (grant.restored) continue // already done; repeating is safe but pointless
    // Recovery has no in-memory lease list, so the key is RECOMPUTED from the
    // journalled resource identity. Deriving it rather than storing a handle is
    // what lets a restarted host release a lease it never took.
    const key = leases.find((l) => l.path === grant.path)?.key || leaseKey(grant.resourceIdentity, sid, grant.rights)
    await appendAc({ store }, agg, AC.AclRestoreRequested, { ...base, path: grant.path, resourceIdentity: grant.resourceIdentity, leaseKey: key }, `acl-restore-intent:${runId}:${stateEpoch}:${grant.path}`)

    const release = await releaseLease(store, key, runId)
    if (!release.mustRevoke && release.holders.length > 0) {
      // Another run still depends on this grant. Leaving it is CORRECT, and it
      // is recorded so the journal does not look like a forgotten restore.
      await appendAc({ store }, agg, AC.AclRestored, { ...base, path: grant.path, ok: true, mode: "retained_for_other_holders", holders: release.holders }, `acl-restored:${runId}:${stateEpoch}:${grant.path}`)
      continue
    }
    // §11: re-verify the resource identity before mutating it. A path swapped
    // for a junction after the decision is a different object.
    const identityNow = await deps.helper({ argv: ["inspect-acl", "--path", grant.path] })
    if (String(identityNow.fileIdentity ?? "") !== grant.resourceIdentity && identityNow.exists === true) {
      await appendAc(
        { store },
        agg,
        AC.ManualInterventionRequired,
        { ...base, path: grant.path, reasonCode: "stale_isolation_evidence", detail: "the resource identity changed after the grant; no ACL was modified" },
        `manual:${runId}:${grant.path}`,
      )
      blocked = true
      continue
    }
    const restored = await deps.helper({
      argv: ["restore-acl", "--path", grant.path, "--sid", sid, "--expect-granted-sddl", grant.grantedSddl, "--original-sddl", grant.originalSddl],
    })
    await crash({ hostCrashAt, onPoint }, "after_acl_restore_before_event")
    await appendAc(
      { store },
      agg,
      AC.AclRestored,
      { ...base, path: grant.path, ok: restored.ok === true, mode: String(restored.mode ?? ""), externalChangePreserved: restored.externalChangePreserved === true, sddlAfterHash: sha256(String(restored.sddlAfter ?? "")) },
      `acl-restored:${runId}:${stateEpoch}:${grant.path}`,
    )
    if (restored.ok !== true) {
      await appendAc(
        { store },
        agg,
        AC.ManualInterventionRequired,
        { ...base, path: grant.path, reasonCode: "acl_restore_unproven", detail: `restore mode ${restored.mode}: Abdo's ACE could not be shown to be gone` },
        `manual:${runId}:${grant.path}`,
      )
      blocked = true
    }
  }

  await appendAc({ store }, agg, AC.ProfileDeleteRequested, base, `profile-delete-intent:${runId}:${stateEpoch}`)
  const deleted = await deps.helper({ argv: ["delete-profile", "--name", profileName] })
  await crash({ hostCrashAt, onPoint }, "after_profile_delete_before_event")
  await appendAc(
    { store },
    agg,
    AC.ProfileDeleted,
    {
      ...base,
      hresult: Number(deleted.hresult ?? 0),
      profileExists: deleted.profileExists === true,
      existedBefore: deleted.existedBefore === true,
      // §8: deleting something already gone is a SUCCESSFUL idempotent
      // operation, and it is recorded as such rather than as a deletion that
      // never happened. Recovery runs repeatedly and races normal cleanup, so
      // "already absent" is the common case, not an anomaly.
      observedAbsent: deleted.existedBefore === false && deleted.profileExists === false,
    },
    `profile-deleted:${runId}:${stateEpoch}`,
  )

  if (deleted.profileExists === true) {
    await appendAc({ store }, agg, AC.CleanupFailed, { ...base, reasonCode: "profile_delete_unproven", detail: "the package directory still exists after DeleteAppContainerProfile" })
    blocked = true
  }
  // COMPLETION IS EARNED. It is written only after the OS has been observed to
  // match — never merely because the code reached the end of the function.
  if (!blocked) await appendAc({ store }, agg, AC.RunCompleted, base, `run-completed:${runId}`)
}
