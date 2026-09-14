/**
 * CL-16A2-D §2/§4 — the durable journal and its state machine.
 *
 * The Abdo Event Store is the source of truth. Nothing here keeps authoritative
 * state in memory: a run's state is a FOLD over its events, so a host that dies
 * and restarts reaches the same conclusion a host that never died would.
 *
 * THE LOST-UPDATE RULE (§3), which shapes every operation:
 *
 *     durable intent -> idempotent helper op -> OBSERVE the OS -> completion
 *
 * and never `mutate then log`. A crash between a mutation and its event is not
 * an edge case, it is the normal case at scale, and the design that loses state
 * there is the design that leaves orphans. Because the intent lands first and
 * the resource name is DERIVED FROM THE runId, recovery can always find what a
 * dead run might have created — even when no completion event was ever written.
 *
 * WHAT IS NEVER RECORDED: file content, environment values, secrets, tokens.
 * A DACL in SDDL form IS recorded, and that is a deliberate, bounded exception:
 * it is access-control structure (SIDs and rights), it contains none of the
 * above, and without it a restore after a crash is impossible — the journal
 * would know a grant happened and not what to undo.
 */
import { createHash } from "node:crypto"
import type { AppendRequest, EventStore } from "@abdo/event-store"

export const JOURNAL_VERSION = 1

/** Every event this slice writes. */
export const AC = {
  RunRequested: "appcontainer.run_requested",
  ProfileCreateRequested: "appcontainer.profile_create_requested",
  ProfileCreated: "appcontainer.profile_created",
  AclGrantRequested: "appcontainer.acl_grant_requested",
  AclGranted: "appcontainer.acl_granted",
  ProcessStartRequested: "appcontainer.process_start_requested",
  ProcessStarted: "appcontainer.process_started",
  ProcessExited: "appcontainer.process_exited",
  CleanupRequested: "appcontainer.cleanup_requested",
  AclRestoreRequested: "appcontainer.acl_restore_requested",
  AclRestored: "appcontainer.acl_restored",
  ProfileDeleteRequested: "appcontainer.profile_delete_requested",
  ProfileDeleted: "appcontainer.profile_deleted",
  RunCompleted: "appcontainer.run_completed",
  CleanupFailed: "appcontainer.cleanup_failed",
  ManualInterventionRequired: "appcontainer.manual_intervention_required",
  RecoveryCompleted: "appcontainer.recovery_completed",
  LeaseAcquired: "appcontainer.lease_acquired",
  LeaseReleased: "appcontainer.lease_released",
} as const
export type AcEventType = (typeof AC)[keyof typeof AC]

/** §4's explicit states. */
export type RunState =
  | "requested"
  | "profile_creating"
  | "profile_created"
  | "acl_granting"
  | "acl_granted"
  | "process_starting"
  | "process_running"
  | "process_exited"
  | "cleanup_pending"
  | "acl_restoring"
  | "profile_deleting"
  | "completed"
  | "cleanup_blocked"
  | "manual_intervention_required"

/**
 * Progress order. Transitions are MONOTONIC inside a stateEpoch: a fold that
 * sees an out-of-order event keeps the further state rather than rewinding, so a
 * duplicated or replayed event can never walk a completed run backwards into
 * "process_starting" and cause a second spawn.
 */
const ORDER: Record<RunState, number> = {
  requested: 0,
  profile_creating: 1,
  profile_created: 2,
  acl_granting: 3,
  acl_granted: 4,
  process_starting: 5,
  process_running: 6,
  process_exited: 7,
  cleanup_pending: 8,
  acl_restoring: 9,
  profile_deleting: 10,
  completed: 11,
  // Off the happy path. Both are ABSORBING: once a run needs a human, no later
  // event quietly promotes it back to "completed".
  cleanup_blocked: 90,
  manual_intervention_required: 91,
}

const STATE_OF: Partial<Record<string, RunState>> = {
  [AC.RunRequested]: "requested",
  [AC.ProfileCreateRequested]: "profile_creating",
  [AC.ProfileCreated]: "profile_created",
  [AC.AclGrantRequested]: "acl_granting",
  [AC.AclGranted]: "acl_granted",
  [AC.ProcessStartRequested]: "process_starting",
  [AC.ProcessStarted]: "process_running",
  [AC.ProcessExited]: "process_exited",
  [AC.CleanupRequested]: "cleanup_pending",
  [AC.AclRestoreRequested]: "acl_restoring",
  [AC.ProfileDeleteRequested]: "profile_deleting",
  [AC.RunCompleted]: "completed",
  [AC.CleanupFailed]: "cleanup_blocked",
  [AC.ManualInterventionRequired]: "manual_intervention_required",
}

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")

/** Identity of a granted resource, for leases and for TOCTOU. */
export interface GrantRecord {
  readonly path: string
  /** `volumeSerial:fileIndex` — survives a rename, changes on a junction swap. */
  readonly resourceIdentity: string
  readonly rights: "rx" | "modify"
  readonly originalSddl: string
  readonly originalSddlHash: string
  readonly grantedSddl: string
  readonly grantedSddlHash: string
  readonly restored?: boolean
  readonly restoreMode?: string
}

export interface RunProjection {
  readonly runId: string
  readonly profileName: string
  readonly sid: string
  readonly state: RunState
  readonly stateEpoch: number
  /** Grants this run ASKED for — present from the intent, before the mutation. */
  readonly intendedGrants: readonly { path: string; rights: "rx" | "modify" }[]
  readonly grants: readonly GrantRecord[]
  readonly profileCreated: boolean
  readonly profileDeleted: boolean
  readonly pid?: number
  /** Decimal FILETIME digits as a STRING: the value exceeds 2^53. */
  readonly processStartTime?: string
  /** The HOST that owns this run — recovery must not take over a live host. */
  readonly hostPid?: number
  readonly hostStartTime?: string
  readonly exitCode?: number | null
  readonly helperBinaryHash?: string
  readonly helperProtocolVersion?: number
  readonly reasonCodes: readonly string[]
  readonly events: number
}

export const runAggregateId = (runId: string) => `winiso:run:${runId}`
export const leaseAggregateId = (key: string) => `winiso:lease:${key}`
/** Leases key on the RESOURCE plus the SID plus the rights — the exact triple
 *  §7 names, so two runs wanting different access to the same path are two
 *  different leases and neither can release the other's. */
export const leaseKey = (resourceIdentity: string, sid: string, rights: string) => sha256(`${resourceIdentity}|${sid}|${rights}`)

/** Rebuild a run's state from its log. Pure. */
export function foldRun(runId: string, events: readonly { type: string; data: unknown }[]): RunProjection {
  let p: RunProjection = {
    runId,
    profileName: "",
    sid: "",
    state: "requested",
    stateEpoch: 0,
    intendedGrants: [],
    grants: [],
    profileCreated: false,
    profileDeleted: false,
    reasonCodes: [],
    events: 0,
  }
  /** The epoch the current `state` belongs to — see the monotonicity rule below. */
  let epochOfState = 0
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>
    const next = STATE_OF[e.type]
    const grants = [...p.grants]
    let intended = [...p.intendedGrants]
    let reasons = [...p.reasonCodes]

    if (typeof d.profileName === "string" && d.profileName) p = { ...p, profileName: d.profileName }
    if (typeof d.sid === "string" && d.sid) p = { ...p, sid: d.sid }
    if (typeof d.stateEpoch === "number") p = { ...p, stateEpoch: Math.max(p.stateEpoch, d.stateEpoch) }
    if (typeof d.hostPid === "number" && d.hostPid) p = { ...p, hostPid: d.hostPid }
    if (typeof d.hostStartTime === "string" && d.hostStartTime) p = { ...p, hostStartTime: d.hostStartTime }
    if (typeof d.helperBinaryHash === "string") p = { ...p, helperBinaryHash: d.helperBinaryHash }
    if (typeof d.helperProtocolVersion === "number") p = { ...p, helperProtocolVersion: d.helperProtocolVersion }
    if (typeof d.reasonCode === "string") reasons = [...reasons, d.reasonCode]

    switch (e.type) {
      case AC.RunRequested:
        intended = Array.isArray(d.grants) ? (d.grants as { path: string; rights: "rx" | "modify" }[]) : []
        break
      case AC.AclGrantRequested: {
        // THE INTENT CREATES THE RECORD. MEASURED: a host that crashed between
        // the OS grant and its completion event left an ACE behind forever,
        // because cleanup only looked at completed grants and therefore had
        // nothing to undo — and then reported the run `completed`. That is the
        // exact lost-update §3 forbids, and it was in this file.
        //
        // A grant is now PENDING from the moment its intent lands. `grantedSddl`
        // stays empty until the completion arrives, which tells the restore it
        // cannot assume anything about what is on disk and must look.
        const path = String(d.path ?? "")
        if (path && !grants.some((x) => x.path === path)) {
          grants.push({
            path,
            resourceIdentity: String(d.resourceIdentity ?? ""),
            rights: (d.rights === "modify" ? "modify" : "rx") as "rx" | "modify",
            originalSddl: String(d.originalSddl ?? ""),
            originalSddlHash: String(d.originalSddlHash ?? ""),
            grantedSddl: "",
            grantedSddlHash: "",
          })
        }
        break
      }
      case AC.ProfileCreated:
        p = { ...p, profileCreated: d.profileExists === true }
        break
      case AC.AclGranted: {
        const g = d as unknown as GrantRecord
        const i = grants.findIndex((x) => x.path === g.path)
        // Idempotent by path: a replayed grant updates in place instead of
        // appending a second record that a later restore would try to undo twice.
        if (i >= 0) grants[i] = { ...grants[i]!, ...g }
        else grants.push(g)
        break
      }
      case AC.AclRestored: {
        const i = grants.findIndex((x) => x.path === d.path)
        if (i >= 0) grants[i] = { ...grants[i]!, restored: d.ok === true, restoreMode: String(d.mode ?? "") }
        break
      }
      case AC.ProcessStarted:
        p = { ...p, pid: Number(d.pid) || undefined, processStartTime: typeof d.startTime === "string" && d.startTime !== "" && d.startTime !== "0" ? d.startTime : undefined }
        break
      case AC.ProcessExited:
        p = { ...p, exitCode: d.exitCode === null ? null : Number(d.exitCode) }
        break
      case AC.ProfileDeleted:
        p = { ...p, profileDeleted: d.profileExists === false }
        break
    }

    // MONOTONIC **WITHIN A stateEpoch**, which is the precise rule and not the
    // one this fold used to implement.
    //
    // A replay or a duplicate must never rewind a run — that is what stops a
    // completed run being walked back into `process_starting` and spawned a
    // second time. But a NEW EPOCH is not a replay: it is a different host
    // taking the run over after a death, and it has to be able to re-enter the
    // cleanup stages it is about to perform. Ordering therefore resets when the
    // epoch advances, and only then.
    //
    // Before this, `stateEpoch` was written as a hard-coded 0 everywhere and
    // folded with `Math.max(x, 0)`: it constrained nothing, while the design
    // document described it as though it did.
    const eventEpoch = typeof d.stateEpoch === "number" ? d.stateEpoch : 0
    // ABSORBING STATES OUTRANK THE EPOCH. A run that finished, or one that is
    // waiting for a human, is not re-opened by a later host's cleanup pass:
    // otherwise a recovery sweep could quietly promote `manual_intervention_
    // required` back onto the happy path, which is the one thing that state
    // exists to prevent.
    const absorbing = p.state === "completed" || p.state === "manual_intervention_required"
    if (eventEpoch > epochOfState && next && !absorbing) {
      p = { ...p, state: next }
      epochOfState = eventEpoch
    } else {
      const state = next && ORDER[next] > ORDER[p.state] ? next : p.state
      p = { ...p, state }
    }
    p = { ...p, grants, intendedGrants: intended, reasonCodes: reasons, events: p.events + 1 }
  }
  return p
}

/** Is this transition legal from here? Used to reject a rewind at write time. */
export const canTransition = (from: RunState, to: RunState) => ORDER[to] > ORDER[from]

/** A run that still owns OS resources, whatever its last event says. */
export const isIncomplete = (p: RunProjection) => p.state !== "completed" && p.state !== "manual_intervention_required"

export interface JournalDeps {
  readonly store: EventStore
  readonly now?: () => number
}

/**
 * Append one journal event. `idempotencyKey` makes a retried write a no-op, so
 * "did my event land before I died?" never needs answering — writing it again
 * is safe.
 */
export async function appendAc(
  deps: JournalDeps,
  aggregateId: string,
  type: AcEventType,
  data: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<void> {
  const req: AppendRequest = {
    aggregateKind: "project",
    aggregateId,
    type,
    version: JOURNAL_VERSION,
    data: { ...data, journalVersion: JOURNAL_VERSION },
    ...(idempotencyKey ? { idempotencyKey } : {}),
  }
  await deps.store.append(req)
}

/** Field names an event is never allowed to carry. Enforced by a test. */
export const FORBIDDEN_EVENT_FIELDS = ["env", "environment", "secret", "token", "password", "credential", "content", "fileContent", "stdout", "stderr"] as const
