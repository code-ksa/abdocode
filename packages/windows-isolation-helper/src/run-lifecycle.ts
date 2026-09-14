/**
 * CL-16A3 MEGA-1 §4c — THE DRIVER. One run, end to end, under the contract.
 *
 * Everything this file needs already existed and was tested in isolation:
 * `createRunDirectory` (P2) makes the per-run directory, `planRunScope` /
 * `applyRunGrants` / `revokeRunGrants` (P3) turn a scope into least-privilege
 * ACEs and take them back, `measureExecutableAccess` (P3-probe) proves an
 * outside-root image is runnable without running it, `verifyPreLaunch` (P4a) is
 * the last gate, and `run-lifecycle-events.ts` (P4b) states the order they must
 * happen in. What did not exist is the thing that SEQUENCES them, and a sequence
 * is where the interesting failures live — a gate that is called too late, a
 * revoke that is skipped on the error path, a completion written for a stage that
 * did not happen.
 *
 * THE LAW, unchanged from every other mutating module here:
 *
 *     durable intent -> mutation -> OS re-inspection -> durable completion
 *
 * and the helper's return code is never the proof. `grant-acl` returning `ok`
 * means the call returned; the SDDL read back afterwards is what says the object
 * carries the ACE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE DECISIONS IN HERE ARE WORTH READING BEFORE CHANGING ANYTHING.
 *
 * 1. THE SID IS RE-DERIVED IMMEDIATELY BEFORE THE SPAWN, AND COMPARED AS BYTES.
 *    The ACLs were written for the SID `ensure-profile` returned. The process
 *    must start as THAT SID. It would be easy to argue this cannot drift — the
 *    same variable is passed to both — but that is an argument about today's
 *    control flow, and the invariant has to survive tomorrow's refactor. So the
 *    SID is asked of the OS again (`derive-sid`) at the last possible moment and
 *    compared byte for byte. Launching as B with grants for A yields a container
 *    that cannot read its own inputs, or — far worse — one running under an
 *    identity nobody authorised while A's ACEs sit on disk.
 *
 * 2. A REFUSED RUN DOES NOT RECORD THE REVOCATION STAGES OF THE HAPPY PATH.
 *    This is a real constraint the P4b contract imposes, and it is the right one.
 *    `LIFECYCLE_ORDER` puts `revocation_requested` AFTER `process_exited`, and
 *    `validateLifecycleSequence` rejects gaps — so a run refused at the
 *    pre-launch gate cannot emit `run.revocation_requested` without claiming, in
 *    the journal, that a process started and exited. It did not. Writing those
 *    events to keep the chain "tidy" would be the exact failure the contract
 *    exists to prevent: a log that reads fine and describes a world that never
 *    happened.
 *
 *    So a refusal STOPS the ordered chain where it stopped, which is legal —
 *    a prefix is legal because a crash is legal — and records `run.refused`,
 *    which is deliberately NOT a member of `LIFECYCLE_ORDER`. The compensating
 *    work still happens and is still journalled, under the `execution_run.*`
 *    vocabulary that `revokeRunGrants` already emits. An auditor reads the
 *    ordered chain to learn how far the run got, and `run.refused` to learn why
 *    it went no further.
 *
 * 3. STDOUT AND STDERR NEVER REACH THE JOURNAL. They are exactly where a secret
 *    shows up. They travel back as a return value and stop there.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import type { EventStore } from "@abdo/event-store"
import { RIGHTS_MODEL_VERSION, rightsPlanHash } from "@abdo/tools/windows-acl-matrix"
import { removeOwnedDirectoryTree } from "./controlled-fs"
import type { HelperRunner } from "./helper-runner"
import { JobEvents, newJobIdentity, parseJobEvidence, type JobEvent } from "./job-identity"
import { profileDirFor, profileNameFor } from "./lifecycle"
import { assessDialect } from "./dialect-capability"
import { acquireRunLease, assertMayMutate, DEFAULT_LEASE_TTL_MS, newOperationId, releaseRunLease, startLeaseHeartbeat, StaleLeaseHolder, type Heartbeat, type ResidueProof } from "./run-lease"
import { verifyPreLaunch, type PreLaunchExpectation, type PreLaunchObservation } from "./pre-launch"
import { createRunDirectory, newRunId, type RunReady, type RunSubdir } from "./run-root"
import { LIFECYCLE_ORDER, RunLifecycle, validateLifecycleSequence, type RunLifecycleEvent } from "./run-lifecycle-events"
import {
  applyRunGrants,
  measureExecutableAccess,
  planRunScope,
  revokeRunGrants,
  type AppliedGrant,
  type ExecutableAccessEvidence,
  type RunScopeBinding,
  type RunScopePlan,
} from "./run-scope"

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")
const lower = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()

/**
 * A terminal event that is NOT part of the ordered chain, carrying the reason a
 * run stopped early. See decision (2) in the header for why it must not be one
 * of the seventeen.
 */
export const RUN_REFUSED = "run.refused"

/**
 * The run could not prove it left nothing behind, so it did NOT release its
 * lease. Not one of the seventeen: it describes the run's relationship to the
 * machine, not its progress through the chain.
 */
export const RUN_RESIDUE_UNPROVEN = "run.residue_unproven"

/**
 * `isorun`, NOT `run`, AND THE DIFFERENCE IS LOAD-BEARING.
 *
 * The first version of this file used `winiso:run:<id>`, which is the namespace
 * the ORIGINAL lifecycle (`lifecycle.ts`) writes to and that `recovery.ts`
 * scans. Two vocabularies in one namespace, and the consequence was not a tidy
 * naming clash — it was live-run corruption:
 *
 *   1. `scanRuns` selects every `winiso:run:*` aggregate, so it picked these up.
 *   2. `foldRun` has no `STATE_OF` entry for any `run.*` event, so the projection
 *      stayed at its initial `requested` and `isIncomplete` was permanently true
 *      — including for runs that had completed perfectly.
 *   3. `profileName` folded to "", so recovery fell back to
 *      `profileNameFor(runId)` — which is EXACTLY the profile this driver
 *      creates. The ownership prefix check therefore passed.
 *   4. Both liveness guards were bypassed: this driver does not populate
 *      `inFlightRuns`, and it recorded no `hostPid`, so the "is the owner still
 *      alive?" branch was skipped entirely for want of a pid.
 *   5. Recovery then ran `requestCleanup` against a RUNNING run — deleting its
 *      AppContainer profile and restoring its ACLs underneath it.
 *
 * That is precisely the failure the comment at `recovery.ts` §"IS THE RUN'S
 * OWNER STILL ALIVE?" records as having been measured and fixed for the old
 * lifecycle, reintroduced through the side door of a shared namespace.
 *
 * The namespaces are separated rather than the folder taught both vocabularies,
 * because MEGA-1 recovery is not the old one with extra cases: it has to reason
 * about a binding hash, a set of applied ACEs and a run DIRECTORY, none of which
 * `foldRun` models. P5 builds it over this namespace. Until it exists, a MEGA-1
 * run is invisible to the old sweep — which is correct, since the old sweep
 * could only ever damage it.
 */
export const runLifecycleAggregateId = (runId: string): string => `winiso:isorun:${runId}`

export interface RunLifecycleDeps {
  readonly store: EventStore
  readonly helper: HelperRunner
  readonly helperProtocol: number
  readonly helperHash: string
  /** A PROVEN execution root (from `bootstrapExecutionRoot`). */
  readonly executionRootPath: string
  readonly executionRootFinalPath: string
  readonly hostSid: string
  /** Fail-closed: an incomplete inventory refuses before anything is created. */
  readonly profileInventory: { readonly complete: boolean; readonly hash: string; readonly roots: readonly string[] }
  readonly rightsModelVersion?: number
  readonly stateEpoch?: string
  /** Present once a human has authorised this specific state of the world. */
  readonly approvalSnapshot?: string
  /** How long the run lease survives without a heartbeat. */
  readonly leaseTtlMs?: number
  /** Injectable clock, so lease expiry can be tested without waiting. */
  readonly now?: () => number
  /** Kill points for the P5 crash matrix. Production never sets this. */
  readonly onPoint?: (point: RunLifecyclePoint) => void | Promise<void>
}

/**
 * Where a test may kill the host. Named for the BOUNDARY, not the stage, because
 * what the crash matrix needs to know is which side of a mutation the death fell
 * on — `after_grants_applied_before_event` is a very different world to
 * `after_grants_event`.
 */
export type RunLifecyclePoint =
  | "after_run_requested"
  | "after_root_ready"
  | "after_scope_planned"
  | "after_grants_intent_before_mutation"
  | "after_grants_applied_before_event"
  | "after_grants_verified"
  | "after_prelaunch_gate"
  | "after_launch_intent_before_spawn"
  | "after_process_started_before_event"
  | "during_process_running"
  | "after_process_exited"
  | "after_revocation_intent_before_restore"
  | "after_revocation_verified"
  | "after_cleanup_intent_before_delete"
  | "before_completed"

export interface IsolatedRunRequest {
  /** The image to run. Absolute. Inside the run root, or measurably accessible. */
  readonly executablePath: string
  /** Arguments AFTER the executable. Passed as an array; no shell exists. */
  readonly args?: readonly string[]
  /** Which dialect asked for this. Bound into the evidence. */
  readonly dialect: string
  /** The control-plane decision that authorised it. Bound into the evidence. */
  readonly decisionId: string
  readonly timeoutMs?: number
  /** Files inside the run the child may READ. Granted per file. */
  readonly inputFiles?: readonly string[]
  /** Directories the child must ENUMERATE. Separate from reading, deliberately. */
  readonly listableDirs?: readonly string[]
  /** Which run subdirectory the child starts in. `temp` unless stated. */
  readonly cwdSubdir?: RunSubdir
}

/** The child's output. Returned, never journalled. */
export interface IsolatedRunOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly timedOut: boolean
  /** A pid AND a creation time — together, proof a child really ran. */
  readonly childStarted: boolean
  readonly pid?: number
  readonly startTime?: string
  /** OBSERVED containment, not assumed. */
  readonly assignedToJob: boolean
  readonly isProcessInJob: boolean
}

export interface IsolatedRunResult {
  readonly ok: boolean
  readonly runId: string
  readonly operationId?: string
  readonly runPath?: string
  readonly appContainerSid?: string
  readonly bindingHash?: string
  /** The ordered chain this run actually recorded. */
  readonly lifecycle: readonly RunLifecycleEvent[]
  readonly output?: IsolatedRunOutput
  readonly reasonCode?: string
  readonly detail?: string
  /** Compensation, reported honestly: what was taken back, and what was not. */
  readonly revoked?: { readonly restored: number; readonly unproven: readonly string[] }
  readonly profileDeleted?: boolean
  readonly runDirectoryRemoved?: boolean
}

/**
 * Read one run's ordered chain back out of the journal.
 *
 * It FILTERS to the seventeen. `validateLifecycleSequence` treats an unrecognised
 * type as a problem — which is the right behaviour for catching a typo in a stage
 * name — but this aggregate also legitimately carries `run.refused`, so the two
 * would fight. Selecting the ordered vocabulary here keeps the validator strict
 * about what it is actually for: order.
 */
export async function readRunLifecycle(store: EventStore, runId: string): Promise<RunLifecycleEvent[]> {
  const events = await store.read("project", runLifecycleAggregateId(runId))
  return events.map((e) => e.type).filter((t): t is RunLifecycleEvent => (LIFECYCLE_ORDER as readonly string[]).includes(t))
}

/** The identity and DACL of every object a plan names, measured RIGHT NOW. */
async function measureObjects(
  helper: HelperRunner,
  paths: readonly string[],
): Promise<{ identities: Record<string, string>; daclHashes: Record<string, string>; reparseNow: string[] }> {
  const identities: Record<string, string> = {}
  const daclHashes: Record<string, string> = {}
  const reparseNow: string[] = []
  for (const p of paths) {
    const key = lower(p)
    const d = await helper({ argv: ["inspect-dir", "--path", p] })
    // A VANISHED OBJECT MUST NOT READ AS "UNCHANGED". `verifyPreLaunch` treats a
    // key missing from the observation as drift, so absence is recorded by
    // OMITTING the key rather than by writing an empty string that would compare
    // equal to another empty string.
    if (d.pathExists === true) {
      identities[key] = `${String(d.pathFileId ?? "")}:${String(d.pathVolumeSerial ?? "")}`
      if (d.pathIsReparsePoint === true) reparseNow.push(key)
    }
    const acl = await helper({ argv: ["inspect-acl", "--path", p] })
    daclHashes[key] = sha256(String(acl.sddl ?? ""))
  }
  return { identities, daclHashes, reparseNow }
}

/**
 * The executable's hash, read by the HOST.
 *
 * A file we cannot read is not one we will launch: an executable whose bytes
 * cannot be pinned cannot be re-checked at the gate, and an unpinnable image is
 * exactly what a swap looks like. The empty string is returned, and the caller
 * refuses on it, rather than substituting a placeholder that would compare equal
 * across two different files.
 */
function executableHashNow(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex")
  } catch {
    return ""
  }
}

/**
 * Run ONE command inside a per-run AppContainer, under the full contract.
 *
 * Returns a result; it does not throw for a refused run, because a refusal is an
 * outcome and the caller needs the reason code. It DOES propagate whatever an
 * `onPoint` hook throws — that is how the crash matrix kills the host, and a
 * `catch` around it would make those tests prove the opposite of what they claim.
 */
export async function executeIsolatedRun(deps: RunLifecycleDeps, req: IsolatedRunRequest): Promise<IsolatedRunResult> {
  const runId = newRunId()
  // A fresh id for THIS ATTEMPT. Without it a retry would inherit the previous
  // attempt's lease, and two executions would share one liveness claim.
  const operationId = newOperationId()
  const agg = runLifecycleAggregateId(runId)
  const stateEpoch = deps.stateEpoch ?? "epoch-0"
  const rightsModelVersion = deps.rightsModelVersion ?? RIGHTS_MODEL_VERSION
  const profileName = profileNameFor(runId)
  const recorded: RunLifecycleEvent[] = []

  const emit = async (type: RunLifecycleEvent, data: Record<string, unknown>): Promise<void> => {
    await deps.store.append({ aggregateKind: "project", aggregateId: agg, type, version: 1, data: { ...data, runId, stateEpoch }, idempotencyKey: `${runId}:${type}` })
    recorded.push(type)
  }
  /**
   * The job's own events, into the SAME aggregate but NOT into `recorded`.
   *
   * `recorded` is the seventeen-event chain `validateLifecycleSequence` checks
   * for gaps and reorders, and it rejects anything outside `LIFECYCLE_ORDER`.
   * Pushing `isorun.job.*` into it would make every run report a malformed
   * lifecycle; extending `LIFECYCLE_ORDER` instead would silently redefine what
   * a legal prefix is for every run ever recorded.
   *
   * So they sit beside the chain, exactly as `execution_run.*` and
   * `run.refused` already do — and in the aggregate `isorun-recovery` reads,
   * because evidence recovery cannot reach is evidence that does not exist.
   */
  const emitJob = async (type: JobEvent, data: Record<string, unknown>): Promise<void> => {
    await deps.store.append({ aggregateKind: "project", aggregateId: agg, type, version: 1, data: { ...data, runId, stateEpoch }, idempotencyKey: `${runId}:${type}` })
  }
  const at = async (point: RunLifecyclePoint): Promise<void> => {
    await deps.onPoint?.(point)
  }

  // Compensation state, so every exit path can take back exactly what it made.
  let created: RunReady | undefined
  let sid = ""
  let applied: readonly AppliedGrant[] = []
  let plan: RunScopePlan | undefined
  let profileEnsured = false
  let heartbeat: Heartbeat | undefined
  // Tracked outside the launch block so the residue proof can ask the OS whether
  // the child is really gone, with the creation time that makes the pid an identity.
  let childPid = 0
  let childStartTime = ""

  /**
   * RE-INSPECT THE WORLD and decide whether this run may claim it left nothing.
   *
   * Every field is read back from the OS. Nothing here trusts a return code, and
   * nothing here trusts what the driver believes it did — the two are exactly the
   * things that diverge when a cleanup half-fails.
   *
   * "Never created" is a first-class answer, and it is what makes an early
   * refusal releasable: a run refused before it touched anything has no profile
   * to be absent, and demanding proof of a deletion that was never needed would
   * be indistinguishable from demanding the impossible.
   */
  const proveZeroResidue = async (): Promise<ResidueProof> => {
    const checkedAt = (deps.now ?? Date.now)()
    const aclPathsClean: string[] = []
    const aclPathsDirty: string[] = []
    if (sid) {
      for (const a of applied) {
        const now = String((await deps.helper({ argv: ["inspect-acl", "--path", a.path] })).sddl ?? "")
        const objectGone = (await deps.helper({ argv: ["inspect-dir", "--path", a.path] })).pathExists !== true
        // An object that no longer exists cannot be carrying an ACE. That is not
        // a loophole — the run directory really is deleted by cleanup, and its
        // ACEs go with it.
        if (objectGone || !now.toLowerCase().includes(sid.toLowerCase())) aclPathsClean.push(a.path)
        else aclPathsDirty.push(a.path)
      }
    }

    let profileAbsent: boolean | "never_created" = "never_created"
    if (profileEnsured) {
      const d = await deps.helper({ argv: ["inspect-dir", "--path", profileDirFor(profileName)] })
      profileAbsent = d.pathExists !== true
    }

    let runRootAbsent: boolean | "never_created" = "never_created"
    if (created) {
      runRootAbsent = (await deps.helper({ argv: ["inspect-dir", "--path", created.runPath] })).pathExists !== true
    }

    let childProcessGone: boolean | "never_started" = "never_started"
    if (childPid > 0) {
      // With the creation time, so a reused pid cannot make a dead child look
      // alive — nor a live one look dead.
      const p = await deps.helper({ argv: ["inspect-process", "--pid", String(childPid), ...(childStartTime ? ["--expect-start", childStartTime] : [])] })
      childProcessGone = p.alive !== true
    }

    const clean = aclPathsDirty.length === 0 && profileAbsent !== false && runRootAbsent !== false && childProcessGone !== false
    return { clean, checkedAt, aclPathsClean, aclPathsDirty, profileAbsent, runRootAbsent, childProcessGone }
  }

  /**
   * Stop asserting that this run is in flight — but ONLY once that is true.
   *
   * The release is the run's last act and it is a CLAIM: recovery's cheapest
   * path believes it. So it is gated on a re-inspection, and a run that cannot
   * prove itself clean deliberately does NOT release. Letting the lease expire
   * is not a failure to tidy up; it is the mechanism that hands the run to
   * recovery, which is exactly where a run with unremovable residue belongs.
   * Marking it released would permanently hide that residue from the only thing
   * that would have reclaimed it.
   */
  const endLease = async (reason: "completed" | "refused" | "cancelled" | "failed"): Promise<ResidueProof | undefined> => {
    if (!heartbeat) return undefined
    const held = heartbeat.current()
    heartbeat.stop()
    heartbeat = undefined
    const proof = await proveZeroResidue()
    if (!proof.clean) {
      await deps.store.append({
        aggregateKind: "project",
        aggregateId: agg,
        type: RUN_RESIDUE_UNPROVEN,
        version: 1,
        data: {
          runId,
          operationId,
          reason,
          aclPathsDirty: proof.aclPathsDirty,
          profileAbsent: proof.profileAbsent,
          runRootAbsent: proof.runRootAbsent,
          childProcessGone: proof.childProcessGone,
          detail: "the lease is NOT released: this run could not prove it left nothing behind, so it is left to expire and be reclaimed",
        },
        idempotencyKey: `${operationId}:residue-unproven`,
      })
      return proof
    }
    try {
      await releaseRunLease({ store: deps.store, ...(deps.now ? { now: deps.now } : {}) }, held, reason, proof)
    } catch (e) {
      // A STALE HOLDER MUST NOT MARK A RUN CLEAN. If a newer attempt has taken
      // this run while we were finishing, our release would be a lie about
      // somebody else's resources. Swallowed rather than thrown because the
      // caller is already on its way out and the fencing event is the record.
      if (!(e instanceof StaleLeaseHolder)) throw e
    }
    return proof
  }

  /**
   * The single exit for a run that will not complete.
   *
   * There is ONE of these on purpose. The way residue gets left behind is not
   * that someone forgets cleanup entirely — it is that the fourth of six early
   * returns forgets one of the three things, and nothing notices because that
   * path is the rare one. Every refusal goes through here, so the compensation
   * is the same code every time.
   */
  const refuse = async (reasonCode: string, detail: string): Promise<IsolatedRunResult> => {
    const revoked = applied.length > 0 && plan ? await revokeRunGrants({ store: deps.store, helper: deps.helper }, plan.binding, applied) : undefined
    const { profileDeleted, runDirectoryRemoved } = await teardown(deps, profileEnsured ? profileName : "", created)
    // The lease is released for a REFUSAL exactly as for a completion: the
    // question it answers is "is an execution still in flight?", and the answer
    // is no either way. Releasing only on success would leave every refused run
    // looking live for a full TTL, and recovery unable to tell a refusal from a
    // hang for that whole window.
    await endLease("refused")
    await deps.store.append({
      aggregateKind: "project",
      aggregateId: agg,
      type: RUN_REFUSED,
      version: 1,
      data: { runId, stateEpoch, reasonCode, detail, stoppedAfter: recorded[recorded.length - 1] ?? null, revokedRestored: revoked?.restored ?? 0, revokedUnproven: revoked?.unproven.length ?? 0 },
      idempotencyKey: `${runId}:refused`,
    })
    return {
      ok: false,
      runId,
      operationId,
      reasonCode,
      detail,
      lifecycle: [...recorded],
      ...(created ? { runPath: created.runPath } : {}),
      ...(sid ? { appContainerSid: sid } : {}),
      ...(plan ? { bindingHash: plan.bindingHash } : {}),
      ...(revoked ? { revoked: { restored: revoked.restored, unproven: revoked.unproven } } : {}),
      profileDeleted,
      runDirectoryRemoved,
    }
  }

  // ── 1. INTENT for the whole run, before anything exists.
  //
  // WHO IS RUNNING THIS is part of that intent, as a pid AND a creation time. A
  // pid alone is not an identity — Windows reuses them, and a sweep that asks
  // about a recycled pid concludes a dead run is alive and never reclaims it.
  // Between `requested` and `process_started` the journal holds no CHILD pid at
  // all, so without the host's own identity a recovery pass cannot distinguish
  // "the host died early" from "the host is alive and about to launch", and the
  // safe-looking choice — clean up — is the one that destroys a live run.
  const self = await deps.helper({ argv: ["inspect-process", "--pid", String(process.pid)] })
  await emit(RunLifecycle.Requested, {
    hostPid: process.pid,
    hostStartTime: String(self.startTime ?? ""),
    profileName,
    dialect: req.dialect,
    decisionId: req.decisionId,
    executablePath: req.executablePath,
    // The COMMAND is hashed, never recorded: arguments carry secrets.
    commandHash: sha256(JSON.stringify([req.executablePath, ...(req.args ?? [])])),
    argCount: (req.args ?? []).length,
    helperHash: deps.helperHash,
    helperProtocol: deps.helperProtocol,
    operationId,
  })

  // THE LEASE, taken immediately after the intent and before anything exists.
  //
  // It is what makes this run's liveness a fact about the RUN rather than about
  // the process that happens to be driving it. `hostPid` above is recorded too,
  // but only so that an EXPIRED lease held by a live owner can be recognised as
  // a contradiction — it is never evidence of liveness on its own, because a
  // long-lived host is alive across every run it has ever served.
  const leaseDeps = { store: deps.store, ...(deps.now ? { now: deps.now } : {}) }
  heartbeat = startLeaseHeartbeat(leaseDeps, await acquireRunLease(leaseDeps, { runId, operationId, ownerPid: process.pid, ownerStartTime: String(self.startTime ?? "") }, deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS))
  await at("after_run_requested")

  // P11 (ADR-0028/ADR-0030): THE DIALECT GATE, the first fail-closed
  // precondition. An unsupported, unknown or malformed-entry dialect refuses
  // HERE — before a directory, a profile, a grant or a child exists — with a
  // structured reasonCode. There is no downgrade to another dialect, no
  // warn-only path, and no unrestricted fallback: the refusal IS the feature.
  const dialectDecision = assessDialect(req.dialect)
  if (!dialectDecision.supported) {
    return await refuse(dialectDecision.reasonCode, dialectDecision.detail)
  }

  // A fail-closed precondition, checked before a directory exists rather than
  // after: an unknown set of profile roots means a grant could name one.
  if (!deps.profileInventory.complete) {
    return await refuse("profile_inventory_unknown", "the profile inventory is incomplete; no run can be planned against an unknown set of profile roots")
  }

  // ── 2. THE RUN DIRECTORY (P2).
  const dir = await createRunDirectory(
    {
      store: deps.store,
      helper: deps.helper,
      helperProtocol: deps.helperProtocol,
      helperHash: deps.helperHash,
      executionRootPath: deps.executionRootPath,
      executionRootFinalPath: deps.executionRootFinalPath,
      hostSid: deps.hostSid,
      rightsModelVersion,
      stateEpoch,
    },
    runId,
  )
  if (!dir.ok) return await refuse(dir.reasonCode, dir.detail)
  created = dir
  await emit(RunLifecycle.RootReady, { runPath: dir.runPath, markerHash: dir.markerHash, runRootIdentity: `${dir.fileId}:${dir.volumeSerial}` })
  await at("after_root_ready")

  // ── 3. THE CONTAINER IDENTITY, before any grant names it.
  const ensured = await deps.helper({ argv: ["ensure-profile", "--name", profileName] })
  sid = String(ensured.sid ?? "")
  if (ensured.ok !== true || !sid) {
    return await refuse("profile_create_failed", `the AppContainer profile ${profileName} was not created: ${String(ensured.error ?? ensured.createHresult ?? "")}`)
  }
  profileEnsured = true

  // ── 4. ACCESSIBILITY OF THE IMAGE, measured — never inferred from its path.
  //
  // Inside the run root we own the file and grant it. Outside, the probe creates
  // it SUSPENDED in this very container, checks the token and the image the
  // kernel resolved, and terminates it without ever resuming the primary thread.
  // Anything short of a clean probe stays `unknown`, and the planner refuses.
  const executableHash = executableHashNow(req.executablePath)
  if (!executableHash) {
    return await refuse("executable_unreadable", `${req.executablePath} could not be read to pin its identity; an image whose bytes cannot be hashed cannot be re-checked at the gate`)
  }
  let access: ExecutableAccessEvidence | undefined
  const outsideRoot = !lower(req.executablePath).startsWith(`${lower(deps.executionRootPath)}\\`)
  if (outsideRoot) {
    access = await measureExecutableAccess(
      { helper: deps.helper },
      { executablePath: req.executablePath, appContainerSid: sid, helperHash: deps.helperHash, helperProtocol: deps.helperProtocol, stateEpoch, profileName, probeCwd: dir.subdirs.temp },
    )
    if (access.access !== "existing_access_verified") {
      return await refuse("executable_not_accessible_to_appcontainer", `${req.executablePath} is not provably runnable by ${sid}: ${access.reason ?? access.access}`)
    }
  }

  // ── 5. THE SCOPE (P3). Pure: the identities it binds are measured here.
  const binding: RunScopeBinding = {
    runId,
    operationId,
    fencingToken: heartbeat?.current().fencingToken ?? 0,
    stateEpoch,
    decisionId: req.decisionId,
    ...(deps.approvalSnapshot ? { approvalSnapshot: deps.approvalSnapshot } : {}),
    dialect: req.dialect,
    executablePath: req.executablePath,
    executableHash,
    workspaceIdentity: `${dir.fileId}:${dir.volumeSerial}`,
    appContainerSid: sid,
    rightsModelVersion,
    rightsModelHash: rightsPlanHash(),
    profileInventoryHash: deps.profileInventory.hash,
    helperHash: deps.helperHash,
    helperProtocol: deps.helperProtocol,
  }
  const scopePaths = scopeCandidatePaths(deps.executionRootPath, dir, req)
  const planTime = await measureObjects(deps.helper, scopePaths)
  const identities: Record<string, { fileId?: string; volumeSerial?: string; isReparsePoint?: boolean }> = {}
  for (const p of scopePaths) {
    const key = lower(p)
    const [fileId, volumeSerial] = (planTime.identities[key] ?? ":").split(":")
    identities[key] = { fileId, volumeSerial, isReparsePoint: planTime.reparseNow.includes(key) }
  }
  const planned = planRunScope({
    binding,
    runPath: dir.runPath,
    runSubdirs: dir.subdirs,
    executionRootPath: deps.executionRootPath,
    ...(req.inputFiles ? { inputFiles: req.inputFiles } : {}),
    ...(req.listableDirs ? { listableDirs: req.listableDirs } : {}),
    identities,
    forbiddenRoots: deps.profileInventory.roots,
    profileInventoryComplete: deps.profileInventory.complete,
    ...(access ? { executableAccess: access } : {}),
  })
  if (!planned.ok) return await refuse(planned.reasonCode, planned.detail)
  plan = planned
  await emit(RunLifecycle.ScopePlanned, { bindingHash: plan.bindingHash, grants: plan.grants.length, sid, decisionId: req.decisionId })
  await at("after_scope_planned")

  // ── 6. THE GRANTS (P3). The ordered chain brackets the whole operation; the
  // per-object detail is journalled by `applyRunGrants` under `execution_run.*`.
  await emit(RunLifecycle.GrantsRequested, { bindingHash: plan.bindingHash, sid, count: plan.grants.length })
  await at("after_grants_intent_before_mutation")
  await emit(RunLifecycle.GrantsMutating, { bindingHash: plan.bindingHash, sid })
  await assertMayMutate(leaseDeps, heartbeat.current(), "apply ACL grants")
  const applyResult = await applyRunGrants({ store: deps.store, helper: deps.helper }, plan)
  applied = applyResult.applied
  await at("after_grants_applied_before_event")
  if (!applyResult.ok) return await refuse(applyResult.reasonCode ?? "acl_grant_failed", applyResult.detail ?? "the grants were not applied in full")
  await emit(RunLifecycle.GrantsApplied, { bindingHash: plan.bindingHash, count: applied.length })
  await emit(RunLifecycle.GrantsVerified, { bindingHash: plan.bindingHash })
  await at("after_grants_verified")

  // ── 7. THE GATE (P4a). Everything is re-measured HERE, moments before the
  // spawn, and compared with what the decision rested on.
  const grantedPaths = plan.grants.map((g) => g.path)
  const nowObjects = await measureObjects(deps.helper, [...new Set([...scopePaths, ...grantedPaths])])
  const rootNow = await deps.helper({ argv: ["inspect-dir", "--path", dir.runPath] })

  // THE SAME-SID INVARIANT. Asked of the OS again, not carried in a variable.
  const derived = await deps.helper({ argv: ["derive-sid", "--name", profileName] })
  const launchSid = String(derived.sid ?? "")

  // The accessibility evidence is re-gathered WITHOUT the probe. `daclChainHash`
  // covers the DACLs, the file identities, the SID, the helper and the epoch —
  // and NOT the access verdict — so the no-profile call yields a directly
  // comparable value. Re-running the probe would create a second real process to
  // re-answer a question already answered; what the gate needs to know is
  // whether the evidence MOVED, and that is a hash comparison.
  const accessNow = access
    ? await measureExecutableAccess({ helper: deps.helper }, { executablePath: req.executablePath, appContainerSid: sid, helperHash: deps.helperHash, helperProtocol: deps.helperProtocol, stateEpoch })
    : undefined

  const expectation: PreLaunchExpectation = {
    runId,
    stateEpoch,
    decisionId: req.decisionId,
    ...(deps.approvalSnapshot ? { approvalSnapshot: deps.approvalSnapshot } : {}),
    appContainerSid: sid,
    executablePath: req.executablePath,
    executableHash,
    bindingHash: plan.bindingHash,
    rightsModelVersion,
    rightsModelHash: rightsPlanHash(),
    profileInventoryHash: deps.profileInventory.hash,
    helperHash: deps.helperHash,
    helperProtocol: deps.helperProtocol,
    objectIdentities: planTime.identities,
    // The DACLs CHANGED on purpose between planning and now — that is what
    // granting is. The gate compares them against what was observed at the end
    // of the grant phase, which is the state the launch is authorised for.
    objectDaclHashes: daclHashesAfterGrants(planTime.daclHashes, applied),
    runRootIdentity: `${dir.fileId}:${dir.volumeSerial}`,
    ...(access ? { executableAccessHash: access.daclChainHash } : {}),
  }
  const observation: PreLaunchObservation = {
    launchAppContainerSid: launchSid,
    executableHash: executableHashNow(req.executablePath),
    bindingHash: plan.bindingHash,
    stateEpoch,
    ...(deps.approvalSnapshot ? { approvalSnapshot: deps.approvalSnapshot } : {}),
    rightsModelVersion,
    rightsModelHash: rightsPlanHash(),
    profileInventoryHash: deps.profileInventory.hash,
    helperHash: deps.helperHash,
    helperProtocol: deps.helperProtocol,
    objectIdentities: nowObjects.identities,
    objectDaclHashes: nowObjects.daclHashes,
    runRootIdentity: `${String(rootNow.pathFileId ?? "")}:${String(rootNow.pathVolumeSerial ?? "")}`,
    ...(accessNow ? { executableAccessHash: accessNow.daclChainHash } : {}),
    reparseNow: nowObjects.reparseNow,
  }
  const verdict = verifyPreLaunch(expectation, observation)
  await at("after_prelaunch_gate")
  if (!verdict.ok) return await refuse(verdict.reasonCode, verdict.detail)

  // ── 8. THE LAUNCH. Nothing above this line started a process.
  await emit(RunLifecycle.LaunchRequested, { sid: launchSid, checked: verdict.checked.length, commandHash: sha256(JSON.stringify([req.executablePath, ...(req.args ?? [])])) })
  await at("after_launch_intent_before_spawn")
  await assertMayMutate(leaseDeps, heartbeat.current(), "launch a process")
  const timeoutMs = req.timeoutMs ?? 30_000
  const cwd = dir.subdirs[req.cwdSubdir ?? "temp"]

  // ── 8a. THE JOB'S NAME, MINTED AND RECORDED BEFORE ANYTHING EXISTS.
  //
  // This is the whole of P5c's safety property. The name is the ONLY route back
  // to a process tree whose host has died, so it is journalled BEFORE the
  // helper is invoked — not after, and never derived later. `isorun-recovery`
  // reads this aggregate; a name recorded anywhere else is a name recovery
  // cannot reach (finding 14, which cost a whole phase).
  //
  // The session comes from the helper's own envelope rather than from an
  // assumption: `Local\` names resolve per session, so a name without a session
  // is a name that may mean a different object tomorrow.
  const sessionId = Number(derived.sessionId ?? -1)
  const job = newJobIdentity({
    hostSid: deps.hostSid,
    sessionId,
    runId,
    operationId,
    fencingToken: heartbeat.current().fencingToken,
  })
  // Beside the run, not inside a granted subdirectory: the container has no
  // write access to the run root itself, and teardown removes the whole tree,
  // so this transport adds no residue surface of its own. It is a CONVENIENCE —
  // the load-bearing record is the event above, which is already durable.
  const jobEvidencePath = `${dir.runPath}\\job-evidence.jsonl`
  await emitJob(JobEvents.CreateRequested, {
    jobName: job.jobName,
    sessionId,
    operationId,
    fencingToken: job.fencingToken,
    hostSid: deps.hostSid,
    appContainerSid: launchSid,
    helperHash: deps.helperHash,
    helperProtocol: deps.helperProtocol,
  })

  let launched
  try {
    launched = await deps.helper({
      argv: [
        "launch-in-profile",
        "--name",
        profileName,
        "--job-name",
        job.jobName,
        "--expect-session-id",
        String(sessionId),
        // P5c2. The identity the TRUSTED KEEPER is bound to. The helper does not
        // derive the job name from these — the name is recorded durably above
        // and passed whole — but the keeper recomputes the name's prefix from
        // them and refuses to hold a job that does not derive from the identity
        // presented with it. A keeper cannot be pointed at one run's job while
        // carrying another run's evidence.
        "--run-id",
        runId,
        "--operation-id",
        operationId,
        "--fencing-token",
        String(job.fencingToken),
        "--job-evidence-out",
        jobEvidencePath,
        "--timeout-ms",
        String(timeoutMs),
        "--cwd",
        cwd,
        "--",
        req.executablePath,
        ...(req.args ?? []),
      ],
      timeoutMs: timeoutMs + 30_000,
    })
  } catch (e) {
    // The helper died. The INTENT is durable, which is what lets recovery find
    // the profile and the ACEs afterwards.
    return await refuse("helper_died_during_launch", e instanceof Error ? e.message.slice(0, 300) : String(e))
  }
  // ── 8b. THE JOB'S COMPLETIONS, from the helper's own read-back.
  //
  // Emitted in the order the facts became true — `job.created` describes the
  // object as it was inspected BEFORE any process existed, `process.created`
  // the initial process and its PROVEN membership — because the ordering is
  // part of what is being recorded.
  //
  // A refusal from the helper stops here without either event, which is the
  // honest prefix: `named_job_collision` means no job of ours was created and
  // no process was started.
  const evidence = readJobEvidence(jobEvidencePath)
  if (evidence.created) {
    await emitJob(JobEvents.Created, {
      jobName: evidence.created.jobName,
      sessionId: evidence.created.sessionId,
      operationId,
      fencingToken: job.fencingToken,
      securityDescriptorHash: evidence.created.securityDescriptorHash,
      limitsHash: evidence.created.limitsHash,
      limitFlags: evidence.created.limitFlags,
      hostSid: evidence.created.hostSid,
      helperHash: evidence.created.helperBinaryHash,
      helperProtocol: evidence.created.helperProtocolVersion,
    })
  }
  // P5c2. WHO IS HOLDING THE NAME OPEN, recorded before the process event
  // because that is the order in which it became true — the keeper proved itself
  // before the target was created.
  //
  // Without this pair, recovery has a job name and no way to tell whether that
  // name is still backed by anything. With it, a later helper can check the
  // keeper is the same live process (pid AND creation time) before it trusts the
  // name at all, and can distinguish "the tree is gone" from "the keeper died
  // and took the name with it" — which are the two states P5c conflated.
  if (evidence.keeper) {
    await emitJob(JobEvents.KeeperReady, {
      jobName: evidence.keeper.jobName,
      sessionId: evidence.keeper.sessionId,
      operationId,
      fencingToken: job.fencingToken,
      keeperPid: evidence.keeper.keeperPid,
      keeperStartTime: evidence.keeper.keeperStartTime,
      keeperImage: evidence.keeper.keeperImage,
    })
  }
  if (evidence.process) {
    await emitJob(JobEvents.ProcessCreated, {
      jobName: evidence.process.jobName,
      sessionId: evidence.process.sessionId,
      pid: evidence.process.pid,
      startTime: evidence.process.startTime,
      appContainerSid: evidence.process.tokenAppContainerSid,
      isAppContainer: evidence.process.isAppContainer,
      isProcessInJob: evidence.process.isProcessInJob,
      // Whether the trusted keeper ACKNOWLEDGED arming before this process was
      // resumed. Replaces `childKeepAliveHandle`: that field recorded a job
      // handle duplicated into the TARGET, which the target owned and could
      // close, so it recorded an intention rather than a guarantee.
      keeperArmed: evidence.process.keeperArmed === true,
      keeperPid: evidence.process.keeperPid,
      keeperStartTime: evidence.process.keeperStartTime,
    })
  }
  if (launched.stage === "named_job_collision") {
    // A name we recorded was already taken. NOTHING of ours was created, so
    // there is nothing to reclaim — but it must never be silently retried under
    // the same identity, and it must never adopt the existing job.
    return await refuse("named_job_collision", String(launched.detail ?? "the job name this attempt recorded was already in use"))
  }
  await at("after_process_started_before_event")

  const pid = Number(launched.pid ?? 0)
  const startTime = String(launched.startTime ?? "")
  const childStarted = pid > 0 && startTime !== ""
  childPid = pid
  childStartTime = startTime
  await emit(RunLifecycle.ProcessStarted, { pid, startTime, childStarted })
  await at("during_process_running")

  // OBSERVED containment, read back from the helper's own report of what the OS
  // said — `assignedToJob` is the call, `isProcessInJob` is the OS answering.
  await emit(RunLifecycle.ProcessObserved, { assignedToJob: launched.assignedToJob === true, isProcessInJob: launched.isProcessInJob === true, pid })
  await emit(RunLifecycle.ProcessExited, { exitCode: launched.exitCode ?? null, timedOut: launched.timedOut === true })
  await at("after_process_exited")

  const output: IsolatedRunOutput = {
    stdout: String(launched.stdout ?? ""),
    stderr: String(launched.stderr ?? ""),
    exitCode: launched.exitCode === null || launched.exitCode === undefined ? null : Number(launched.exitCode),
    timedOut: launched.timedOut === true,
    childStarted,
    ...(pid > 0 ? { pid } : {}),
    ...(startTime ? { startTime } : {}),
    assignedToJob: launched.assignedToJob === true,
    isProcessInJob: launched.isProcessInJob === true,
  }

  // ── 9. REVOCATION. Every ACE this run added, proved gone by re-reading.
  await emit(RunLifecycle.RevocationRequested, { count: applied.length, sid })
  await at("after_revocation_intent_before_restore")
  await assertMayMutate(leaseDeps, heartbeat.current(), "revoke ACL grants")
  const revoked = await revokeRunGrants({ store: deps.store, helper: deps.helper }, plan.binding, applied)
  await emit(RunLifecycle.RevocationApplied, { restored: revoked.restored, unproven: revoked.unproven.length })
  if (!revoked.ok) {
    // Residue we could not prove gone is NOT a completed run. The teardown still
    // runs — leaving the profile as well would be strictly worse — but the run
    // is reported as failed, with the paths named.
    const { profileDeleted, runDirectoryRemoved } = await teardown(deps, profileName, created)
    await endLease("failed")
    await deps.store.append({
      aggregateKind: "project",
      aggregateId: agg,
      type: RUN_REFUSED,
      version: 1,
      data: { runId, stateEpoch, reasonCode: "acl_restore_evidence_missing", unproven: revoked.unproven.length, stoppedAfter: RunLifecycle.RevocationApplied },
      idempotencyKey: `${runId}:refused`,
    })
    return {
      ok: false,
      runId,
      operationId,
      runPath: dir.runPath,
      appContainerSid: sid,
      bindingHash: plan.bindingHash,
      lifecycle: [...recorded],
      output,
      reasonCode: "acl_restore_evidence_missing",
      detail: `these objects could not be proved free of ${sid}: ${revoked.unproven.join(", ")}`,
      revoked: { restored: revoked.restored, unproven: revoked.unproven },
      profileDeleted,
      runDirectoryRemoved,
    }
  }
  await emit(RunLifecycle.RevocationVerified, { restored: revoked.restored })
  await at("after_revocation_verified")

  // ── 10. CLEANUP: the profile and the directory, both proved gone.
  await emit(RunLifecycle.CleanupRequested, { profileName, runPath: dir.runPath })
  await at("after_cleanup_intent_before_delete")
  const { profileDeleted, runDirectoryRemoved } = await teardown(deps, profileName, created)
  if (!profileDeleted || !runDirectoryRemoved) {
    return await refuse("cleanup_unverified", `after cleanup: profileDeleted=${profileDeleted}, runDirectoryRemoved=${runDirectoryRemoved}`)
  }
  await emit(RunLifecycle.Cleaned, { profileDeleted, runDirectoryRemoved })
  await at("before_completed")

  // THE LAST GATE. `endLease` re-inspects the machine, and a run that cannot
  // prove it left nothing is NOT a completed run — no matter how well the
  // preceding sixteen stages went. Emitting `run.completed` here anyway would be
  // the same class of lie the whole contract exists to prevent: a chain that
  // reads as a clean finish over a machine that still carries the run's
  // resources. The lease stays unreleased, so recovery inherits it.
  const finalProof = await endLease("completed")
  if (finalProof && !finalProof.clean) {
    return {
      ok: false,
      runId,
      operationId,
      runPath: dir.runPath,
      appContainerSid: sid,
      bindingHash: plan.bindingHash,
      lifecycle: [...recorded],
      output,
      reasonCode: "residue_unproven",
      detail:
        `the run finished but could not prove it left nothing behind — dirty ACLs: ${finalProof.aclPathsDirty.join(", ") || "none"}; ` +
        `profileAbsent=${String(finalProof.profileAbsent)}; runRootAbsent=${String(finalProof.runRootAbsent)}; childProcessGone=${String(finalProof.childProcessGone)}. ` +
        `Its lease was deliberately NOT released, so recovery will reclaim it.`,
      revoked: { restored: revoked.restored, unproven: revoked.unproven },
      profileDeleted,
      runDirectoryRemoved,
    }
  }
  await emit(RunLifecycle.Completed, { exitCode: output.exitCode, restored: revoked.restored })
  return {
    ok: true,
    runId,
    operationId,
    runPath: dir.runPath,
    appContainerSid: sid,
    bindingHash: plan.bindingHash,
    lifecycle: [...recorded],
    output,
    revoked: { restored: revoked.restored, unproven: revoked.unproven },
    profileDeleted,
    runDirectoryRemoved,
  }
}

/**
 * Delete the profile and the run directory, and PROVE both — a delete that
 * returned success is not a delete that happened.
 *
 * Ownership is enforced by the helper (it refuses any profile without Abdo's
 * prefix), so this cannot reach a container belonging to something else no matter
 * what it is handed.
 */
/**
 * Read the helper's job evidence, tolerating its absence.
 *
 * A missing file is NORMAL: the helper may have refused before creating
 * anything, or been killed mid-launch — which is the case this whole phase is
 * about. The load-bearing record is `isorun.job.create_requested`, journalled
 * before the helper ever started, so nothing here is required for recovery to
 * reach the tree.
 */
function readJobEvidence(path: string): ReturnType<typeof parseJobEvidence> {
  try {
    return parseJobEvidence(readFileSync(path, "utf8"))
  } catch {
    return {}
  }
}

async function teardown(deps: RunLifecycleDeps, profileName: string, created: RunReady | undefined): Promise<{ profileDeleted: boolean; runDirectoryRemoved: boolean }> {
  let profileDeleted = true
  if (profileName) {
    const del = await deps.helper({ argv: ["delete-profile", "--name", profileName] })
    // `delete-profile` re-checks the profile DIRECTORY after the delete and
    // reports it as `profileExists` (`ops.rs`, the `still` binding). That is an
    // OS observation taken after the mutation, so it is the proof; `ok` and the
    // HRESULT only say the call returned. `derive-sid` cannot answer this — it is
    // a pure computation over the NAME and keeps answering for a profile that no
    // longer exists.
    profileDeleted = del.profileExists === false
  }
  let runDirectoryRemoved = true
  if (created) {
    removeOwnedDirectoryTree(created.runPath)
    const d = await deps.helper({ argv: ["inspect-dir", "--path", created.runPath] })
    runDirectoryRemoved = d.pathExists !== true
  }
  return { profileDeleted, runDirectoryRemoved }
}

/**
 * The DACL hashes the launch is authorised against.
 *
 * Plan time is BEFORE the grants, so comparing the gate's observation against
 * plan-time hashes would report drift on every object we deliberately changed —
 * every run would refuse itself. The authorised state is what `applyRunGrants`
 * OBSERVED after each grant landed, so those hashes replace the plan-time ones
 * for granted objects, and ungranted objects keep theirs.
 */
function daclHashesAfterGrants(planTime: Readonly<Record<string, string>>, applied: readonly AppliedGrant[]): Record<string, string> {
  const out: Record<string, string> = { ...planTime }
  for (const a of applied) out[lower(a.path)] = sha256(a.grantedSddl)
  return out
}

/** Every path a plan could name, so all of them are measured once, together. */
function scopeCandidatePaths(executionRootPath: string, dir: RunReady, req: IsolatedRunRequest): string[] {
  const paths = new Set<string>()
  paths.add(dir.runPath)
  for (const sub of Object.values(dir.subdirs)) paths.add(sub)
  for (const f of req.inputFiles ?? []) paths.add(f)
  for (const d of req.listableDirs ?? []) paths.add(d)
  // The ancestor chain between the execution root and the run, which the planner
  // grants traverse on.
  let cur = lower(dir.runPath)
  const stop = lower(executionRootPath)
  while (cur.includes("\\") && cur !== stop) {
    cur = cur.slice(0, cur.lastIndexOf("\\"))
    if (!cur.includes("\\")) break
    paths.add(cur)
  }
  return [...paths]
}

/** The contract, applied to a finished run. Exported so callers can assert it. */
export const runLifecycleIsLegal = (events: readonly string[]) => validateLifecycleSequence(events)
