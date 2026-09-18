/**
 * CL-16A3-B3 / MEGA SPRINT 1 §2 — the per-run execution directory.
 *
 * The execution ROOT (`execution-root.ts`) is one protected directory per host
 * SID, created once. This is the directory a SINGLE RUN gets inside it, and it
 * is built with the same law, for the same reasons:
 *
 *     durable intent -> private staging -> protected DACL -> marker
 *       -> reconciliation -> ATOMIC no-replace publish -> re-verify -> ready
 *
 * WHY NOT JUST `mkdir`. A directory that exists before it is protected is a
 * window in which anything can be planted inside it, and a directory protected
 * after publication is one another process can reach first. Publishing an
 * already-complete, already-protected staging directory with `MoveFileExW` and
 * NO `MOVEFILE_REPLACE_EXISTING` closes both: the path either does not exist, or
 * it is finished. A loser gets 183 ERROR_ALREADY_EXISTS, keeps its hands off the
 * winner, and discards its own work.
 *
 * THE MODEL CANNOT CHOOSE A runId, AND THIS IS STRUCTURAL RATHER THAN POLITE.
 * `newRunId()` is the only way to make one, it uses 128 bits from the OS CSPRNG,
 * and `createRunDirectory` REFUSES any id that does not match the generated
 * shape. So a model-supplied string cannot become a path segment even if it
 * reaches this function, and a caller cannot "reuse" an id from an earlier
 * decision: publication is no-replace, so the second attempt loses the race
 * against its own predecessor and is refused.
 *
 * NO INHERITANCE FROM ProgramData. The staging DACL is PROTECTED (`D:P`) with a
 * single owner-only ACE, so nothing the parent tree grants — and `ProgramData`
 * grants `BU` create rights by design — is inherited into a run.
 */
import { createHash, randomBytes } from "node:crypto"
import { join } from "node:path"
import type { EventStore } from "@abdo/event-store"
import type { HelperRunner } from "./helper-runner"
import { protectedDaclFor, STAGING_DIR } from "./execution-root"
import { removeOwnedDirectoryTree, writeOwnedMarkerFile } from "./controlled-fs"

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")

export const RUN_SCHEMA_VERSION = 1
export const RUN_LAYOUT_VERSION = "v1"
export const RUN_MARKER_NAME = "run.marker"
export const RUNS_DIR = "runs"

/**
 * The fixed interior of every run. Nothing else is created, and the scope
 * planner grants rights per directory rather than to the run root as a whole.
 *
 *  - `input`     read-only fixtures the run may read
 *  - `workspace` the run's own working tree
 *  - `temp`      scratch, the only place a child may create freely
 *  - `output`    what the run produces and the host collects
 *  - `metadata`  host-written facts ABOUT the run; never run-writable
 */
export const RUN_SUBDIRS = ["input", "workspace", "temp", "output", "metadata"] as const
export type RunSubdir = (typeof RUN_SUBDIRS)[number]

export const RunEvents = {
  Requested: "execution_run.requested",
  Inspected: "execution_run.inspected",
  StagingCreated: "execution_run.staging_created",
  StagingProtected: "execution_run.staging_protected",
  StagingPopulated: "execution_run.staging_populated",
  StagingMarked: "execution_run.staging_marked",
  StagingReconciled: "execution_run.staging_reconciled",
  PublishRequested: "execution_run.publish_requested",
  Published: "execution_run.published",
  Reconciled: "execution_run.reconciled",
  StagingDiscarded: "execution_run.staging_discarded",
  Ready: "execution_run.ready",
  Failed: "execution_run.failed",
} as const

export interface RunMarker {
  readonly schemaVersion: number
  readonly layoutVersion: string
  readonly runId: string
  readonly hostSid: string
  readonly executionRootFinalPath: string
  readonly runFinalPath: string
  readonly volumeSerial: string
  readonly runFileId: string
  readonly protectedDaclHash: string
  readonly rightsModelVersion: number
  readonly helperProtocol: number
  readonly helperHash: string
  readonly stateEpoch: string
  readonly createdAt: string
}

export const runMarkerHashOf = (m: RunMarker): string => sha256(JSON.stringify(m))

/**
 * A host-generated run id: `run_` + 26 lowercase base32 characters over 128 bits
 * from the OS CSPRNG.
 *
 * Collision resistance is the easy half. The important half is the SHAPE: the
 * pattern below is what `createRunDirectory` validates, so nothing that did not
 * come from here can become a directory name — a model-chosen id, a traversal
 * (`..`), a device name (`CON`), a stream (`a:b`), an 8.3 alias or a trailing
 * dot all fail the same check, before any path is built from them.
 */
const B32 = "abcdefghijklmnopqrstuvwxyz234567"
export const RUN_ID_PATTERN = /^run_[a-z2-7]{26}$/

export function newRunId(): string {
  const bytes = randomBytes(16)
  let bits = 0
  let value = 0
  let out = ""
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return `run_${out.slice(0, 26)}`
}

export const isHostGeneratedRunId = (id: string): boolean => RUN_ID_PATTERN.test(id)

export interface RunRefusal {
  readonly ok: false
  readonly reasonCode: string
  readonly detail: string
}

export interface RunReady {
  readonly ok: true
  readonly runId: string
  readonly runPath: string
  readonly finalPath: string
  readonly volumeSerial: string
  readonly fileId: string
  readonly ownerSid: string
  readonly daclHash: string
  readonly markerHash: string
  readonly marker: RunMarker
  readonly subdirs: Readonly<Record<RunSubdir, string>>
  readonly stagingPath: string
  readonly bootstrapId: string
}

export type RunResult = RunReady | RunRefusal

export interface RunDeps {
  readonly store: EventStore
  readonly helper: HelperRunner
  readonly helperProtocol: number
  readonly helperHash: string
  /** The PROVEN execution root this run lives inside (from bootstrapExecutionRoot). */
  readonly executionRootPath: string
  readonly executionRootFinalPath: string
  readonly hostSid: string
  readonly rightsModelVersion: number
  readonly stateEpoch?: string
  /** Kill points for the crash matrix. Production never sets this. */
  readonly onPoint?: (point: string) => void | Promise<void>
}

const AGG = "winiso:execution-run"

async function emit(deps: RunDeps, type: string, data: Record<string, unknown>, idempotencyKey?: string): Promise<void> {
  await deps.store.append({
    aggregateKind: "project",
    aggregateId: AGG,
    type,
    version: 1,
    data,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  })
}

/** The paths a published run exposes. Pure. */
export function runSubdirPaths(runPath: string): Readonly<Record<RunSubdir, string>> {
  const out = {} as Record<RunSubdir, string>
  for (const d of RUN_SUBDIRS) out[d] = join(runPath, d)
  return out
}

/** Where a run lives, given a proven execution root. Pure. */
export const runPathFor = (executionRootPath: string, runId: string): string => join(executionRootPath, RUNS_DIR, runId)

/**
 * Create ONE run directory, or refuse.
 *
 * Every OS mutation is bracketed by a durable intent before it and a durable
 * completion after it, and the completion is written from an INSPECTION of the
 * result — never from the helper's return code. A helper that says `ok:true`
 * about a directory that is not there, or is a reparse point, or carries the
 * wrong owner, is treated as a conflict.
 */
export async function createRunDirectory(deps: RunDeps, runId: string): Promise<RunResult> {
  const stateEpoch = deps.stateEpoch ?? "epoch-0"
  const bootstrapId = `runboot_${randomBytes(8).toString("hex")}`

  const fail = async (reasonCode: string, detail: string): Promise<RunRefusal> => {
    await emit(deps, RunEvents.Failed, { runId, bootstrapId, stateEpoch, reasonCode, detail })
    return { ok: false, reasonCode, detail }
  }

  // ---- 0. THE ID IS OURS, OR NOTHING HAPPENS. Before any path is built.
  if (!isHostGeneratedRunId(runId)) {
    return await fail("run_id_not_host_generated", `"${runId.slice(0, 64)}" is not a host-generated run id; a run directory is never named by a caller`)
  }
  if (!deps.executionRootPath || !deps.hostSid) {
    return await fail("execution_root_unknown", "a proven execution root and host SID are required before a run directory can exist")
  }

  const runPath = runPathFor(deps.executionRootPath, runId)
  const runsParent = join(deps.executionRootPath, RUNS_DIR)
  const stagingParent = join(deps.executionRootPath, STAGING_DIR)
  const stagingPath = join(stagingParent, bootstrapId)

  await emit(deps, RunEvents.Requested, { runId, bootstrapId, stateEpoch, runPath, helperProtocol: deps.helperProtocol, helperHash: deps.helperHash }, `${bootstrapId}:requested`)
  await deps.onPoint?.("after_run_intent")

  // ---- 1. IS THE TARGET FREE? A run id is never reused, so an occupied path is
  // a conflict and NEVER something to adopt, repair or overwrite.
  const existing = await deps.helper({ argv: ["inspect-dir", "--path", runPath] })
  if (existing.pathExists === true) {
    return await fail("run_directory_already_exists", `${runPath} already exists; a run id is used exactly once`)
  }
  await emit(deps, RunEvents.Inspected, { runId, bootstrapId, stateEpoch, runPath, exists: false })
  await deps.onPoint?.("after_inspected")

  // ---- 2. The containers. `runs/` and the staging parent are ordinary
  // directories inside the ALREADY-PROTECTED root; the run itself is not created
  // here, it is published in one step at the end.
  for (const dir of [runsParent, stagingParent]) {
    const c = await deps.helper({ argv: ["create-dir", "--path", dir] })
    if (c.ok !== true) return await fail("run_container_conflict", `could not establish ${dir}: ${String(c.errorCode ?? "")}`)
  }

  const discard = async (reasonCode: string, detail: string): Promise<RunRefusal> => {
    removeOwnedDirectoryTree(stagingPath)
    await emit(deps, RunEvents.StagingDiscarded, { runId, bootstrapId, stateEpoch, stagingPath, reasonCode })
    return await fail(reasonCode, detail)
  }

  // ---- 3. Private staging.
  const made = await deps.helper({ argv: ["create-dir", "--path", stagingPath] })
  if (made.ok !== true) return await fail("run_staging_conflict", `the staging directory was not created: ${String(made.errorCode ?? "")}`)
  await emit(deps, RunEvents.StagingCreated, { runId, bootstrapId, stateEpoch, stagingPath })
  await deps.onPoint?.("after_staging_created")

  // ---- 4. PROTECT IT BEFORE ANYTHING IS PUT INSIDE. `D:P` with one owner ACE:
  // no inheritance from ProgramData, which grants BU create rights by design.
  const dacl = protectedDaclFor(deps.hostSid)
  const applied = await deps.helper({ argv: ["protect-dir", "--path", stagingPath, "--owner-sid", deps.hostSid, "--dacl-sddl", dacl] })
  if (applied.ok !== true) return await discard("run_dacl_conflict", `the protected DACL was not applied: ${JSON.stringify(applied).slice(0, 200)}`)
  await emit(deps, RunEvents.StagingProtected, { runId, bootstrapId, stateEpoch, stagingPath, daclHash: sha256(dacl) })
  await deps.onPoint?.("after_staging_protected")

  // ---- 5. The fixed interior, created INSIDE the protected staging.
  for (const sub of RUN_SUBDIRS) {
    const c = await deps.helper({ argv: ["create-dir", "--path", join(stagingPath, sub)] })
    if (c.ok !== true) return await discard("run_subdir_conflict", `could not create ${sub}: ${String(c.errorCode ?? "")}`)
  }
  await emit(deps, RunEvents.StagingPopulated, { runId, bootstrapId, stateEpoch, stagingPath, subdirs: [...RUN_SUBDIRS] })
  await deps.onPoint?.("after_staging_populated")

  // ---- 6. The marker, written into the staging so it is published atomically
  // WITH the directory. A run directory therefore never exists unmarked.
  const staged = await deps.helper({ argv: ["inspect-dir", "--path", stagingPath] })
  const marker: RunMarker = {
    schemaVersion: RUN_SCHEMA_VERSION,
    layoutVersion: RUN_LAYOUT_VERSION,
    runId,
    hostSid: deps.hostSid,
    executionRootFinalPath: deps.executionRootFinalPath,
    runFinalPath: runPath,
    volumeSerial: String(staged.pathVolumeSerial ?? ""),
    runFileId: String(staged.pathFileId ?? ""),
    protectedDaclHash: sha256(dacl),
    rightsModelVersion: deps.rightsModelVersion,
    helperProtocol: deps.helperProtocol,
    helperHash: deps.helperHash,
    stateEpoch,
    createdAt: new Date().toISOString(),
  }
  writeOwnedMarkerFile(stagingPath, RUN_MARKER_NAME, marker)
  await emit(deps, RunEvents.StagingMarked, { runId, bootstrapId, stateEpoch, stagingPath, markerHash: runMarkerHashOf(marker) })
  await deps.onPoint?.("after_marker_temp")

  // ---- 7. RECONCILE THE STAGING FROM THE OS, not from what we intended.
  const problems = await reconcileStaging(deps, stagingPath)
  if (problems.length > 0) return await discard("run_staging_unreconciled", `the staging directory is not what was intended: ${problems.join(", ")}`)
  await emit(deps, RunEvents.StagingReconciled, { runId, bootstrapId, stateEpoch, stagingPath, markerHash: runMarkerHashOf(marker) })
  await deps.onPoint?.("after_staging_reconciled")

  // ---- 8. ATOMIC PUBLICATION, no replace.
  await emit(deps, RunEvents.PublishRequested, { runId, bootstrapId, stateEpoch, stagingPath, runPath }, `${bootstrapId}:publish`)
  const pub = await deps.helper({ argv: ["publish-dir", "--from", stagingPath, "--to", runPath] })
  await deps.onPoint?.("after_atomic_rename")
  if (pub.ok !== true) {
    const taken = pub.targetTaken === true
    removeOwnedDirectoryTree(stagingPath)
    await emit(deps, RunEvents.StagingDiscarded, { runId, bootstrapId, stateEpoch, stagingPath, reasonCode: taken ? "run_publish_lost_race" : "run_publish_failed" })
    return await fail(taken ? "run_publish_lost_race" : "run_publish_failed", `publication of ${runPath} did not succeed: ${JSON.stringify(pub).slice(0, 200)}`)
  }
  await emit(deps, RunEvents.Published, { runId, bootstrapId, stateEpoch, runPath })
  await deps.onPoint?.("after_publish")

  // ---- 9. RE-VERIFY WHAT IS ACTUALLY THERE. The rename returning success says
  // the call succeeded; it does not say what the published directory now is.
  const after = await deps.helper({ argv: ["inspect-dir", "--path", runPath] })
  if (after.pathExists !== true || after.pathIsDirectory !== true || after.pathIsReparsePoint === true) {
    return await fail("run_publish_unverified", `${runPath} is not a plain directory after publication`)
  }
  const sddl = String((await deps.helper({ argv: ["inspect-acl", "--path", runPath] })).sddl ?? "")
  const owner = String(after.pathOwnerSid ?? "")
  if (owner.toLowerCase() !== deps.hostSid.toLowerCase()) {
    return await fail("run_owner_conflict", `the published run is owned by ${owner}, not ${deps.hostSid}`)
  }
  await emit(deps, RunEvents.Reconciled, { runId, bootstrapId, stateEpoch, runPath, ownerSid: owner, daclSddlHash: sha256(sddl) })
  await deps.onPoint?.("before_ready")

  await emit(deps, RunEvents.Ready, { runId, bootstrapId, stateEpoch, runPath, markerHash: runMarkerHashOf(marker) })
  return {
    ok: true,
    runId,
    runPath,
    finalPath: String(after.pathFinalPath ?? runPath),
    volumeSerial: String(after.pathVolumeSerial ?? ""),
    fileId: String(after.pathFileId ?? ""),
    ownerSid: owner,
    daclHash: sha256(sddl),
    markerHash: runMarkerHashOf(marker),
    marker,
    subdirs: runSubdirPaths(runPath),
    stagingPath,
    bootstrapId,
  }
}

/** What the OS says about the staging, compared with what was intended. */
async function reconcileStaging(deps: RunDeps, stagingPath: string): Promise<string[]> {
  const problems: string[] = []
  const d = await deps.helper({ argv: ["inspect-dir", "--path", stagingPath] })
  if (d.pathExists !== true) problems.push("staging_missing")
  if (d.pathIsDirectory !== true) problems.push("staging_not_a_directory")
  if (d.pathIsReparsePoint === true) problems.push("staging_is_reparse_point")
  if (String(d.pathOwnerSid ?? "").toLowerCase() !== deps.hostSid.toLowerCase()) problems.push("staging_owner_mismatch")
  const acl = await deps.helper({ argv: ["inspect-acl", "--path", stagingPath] })
  const sddl = String(acl.sddl ?? "")
  if (!/D:P/.test(sddl)) problems.push("staging_dacl_not_protected")
  for (const forbidden of [";;;BU)", ";;;WD)", ";;;AU)"]) {
    if (sddl.includes(forbidden)) problems.push(`staging_dacl_grants_${forbidden.replace(/[^A-Z]/g, "")}`)
  }
  for (const sub of RUN_SUBDIRS) {
    const s = await deps.helper({ argv: ["inspect-dir", "--path", join(stagingPath, sub)] })
    if (s.pathExists !== true || s.pathIsDirectory !== true) problems.push(`missing_${sub}`)
    if (s.pathIsReparsePoint === true) problems.push(`reparse_${sub}`)
  }
  return problems
}
