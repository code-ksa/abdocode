/**
 * CL-16A3-B2B-ROOT-FIX — discovery, atomic publication and a root that is never
 * adopted.
 *
 * THE ROOT IS THE ONE DIRECTORY WHOSE LOCATION MUST NOT BE INFLUENCED BY THE
 * RUN. So it is not read from `%ProgramData%` (an inherited variable is settable
 * by whoever launched us) and it is not hard-coded: it comes from
 * `SHGetKnownFolderPath(FOLDERID_ProgramData)`, and everything after that is
 * re-derived from a HANDLE opened with `FILE_FLAG_OPEN_REPARSE_POINT`, so a
 * junction cannot silently redirect it.
 *
 * TWO LAWS, and the earlier version of this file broke both.
 *
 * 1. NOTHING EXISTING IS ADOPTED, REPAIRED OR OVERWRITTEN. The previous code met
 *    a root carrying `Everyone: full control` by overwriting its DACL and
 *    carrying on. That is indistinguishable from an attacker handing us a
 *    directory and having us bless it. A root that exists must now prove itself
 *    ENTIRELY — marker, owner, DACL, identity, versions — and if any part fails
 *    it is a conflict, left exactly as found. There is no repair path.
 *
 * 2. THE FINAL PATH NEVER EXISTS IN A PARTIAL STATE. It is not created and then
 *    protected; there is no instant at which it is visible and writable. It is
 *    built under a private staging name, protected, marked and fully reconciled
 *    there, and then PUBLISHED by `MoveFileExW` WITHOUT
 *    `MOVEFILE_REPLACE_EXISTING`.
 *
 *    MEASURED, because the design depends on it: publishing into a free path
 *    moves the directory and leaves the source gone; publishing into a taken path
 *    fails with 183 ERROR_ALREADY_EXISTS, leaves the winner's content byte-for-
 *    byte intact and leaves the loser's staging in place to clean up. The loser
 *    therefore never overwrites and never adopts — it verifies what was published
 *    and discards its own work.
 *
 * ORDERING, enforced for every mutation:
 *
 *     durable intent -> re-verify evidence -> OS mutation -> INSPECT -> durable completion
 *
 * `ready` is never written from a return code.
 */
import { createHash, randomBytes } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { removeOwnedDirectoryTree, writeOwnedMarkerFile } from "./controlled-fs"
import { join } from "node:path"
import type { EventStore } from "@abdo/event-store"
import type { HelperRunner } from "./helper-runner"

export const ROOT_SCHEMA_VERSION = 2
export const ROOT_LAYOUT_VERSION = "v1"
export const STAGING_DIR = ".staging"
export const MARKER_NAME = "root.marker"
export const STAGING_OWNER_NAME = "staging.owner.json"

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")

export const RootEvents = {
  Requested: "execution_root.requested",
  Inspected: "execution_root.inspected",
  VerifiedExisting: "execution_root.verified_existing",
  Rebaselined: "execution_root.evidence_rebaselined",
  StagingRequested: "execution_root.staging_requested",
  StagingCreated: "execution_root.staging_created",
  StagingProtected: "execution_root.staging_protected",
  StagingMarked: "execution_root.staging_marked",
  StagingReconciled: "execution_root.staging_reconciled",
  PublishRequested: "execution_root.publish_requested",
  Published: "execution_root.published",
  MarkerWritten: "execution_root.marker_written",
  Reconciled: "execution_root.reconciled",
  StagingDiscarded: "execution_root.staging_discarded",
  Ready: "execution_root.ready",
  Failed: "execution_root.failed",
} as const

export interface RootMarker {
  readonly schemaVersion: number
  readonly rightsModelVersion: number
  readonly ownerSid: string
  readonly rootFinalPath: string
  readonly volumeSerial: string
  readonly rootFileId: string
  readonly protectedDaclHash: string
  readonly profileInventoryHash: string
  readonly helperProtocol: number
  readonly createdAt: string
}

/**
 * Who owns a staging directory, recorded INSIDE it.
 *
 * A pid alone is not an identity — Windows reuses them — so the creation time is
 * recorded as decimal digits (a FILETIME exceeds 2^53 and would lose its low
 * digits as a JSON number). `bootstrapId` ties the directory to a durable
 * operation in the journal, so liveness can be asked of the log as well as of
 * the OS.
 */
export interface StagingOwner {
  readonly bootstrapId: string
  readonly operationId: string
  readonly pid: number
  readonly processStartTime: string
  readonly hostSid: string
  readonly stateEpoch: string
  readonly createdAt: string
}

/**
 * Every element the bootstrap's decisions rest on, in one addressable record.
 *
 * It is re-captured and compared before EVERY mutation. Anything that moved
 * between the inspection and the use makes the plan stale — the mutation is
 * abandoned rather than applied to a world that is no longer the one we looked
 * at.
 */
export interface RootEvidence {
  readonly programDataLexical: string
  readonly programDataFinal: string
  readonly programDataVolume: string
  readonly programDataFileId: string
  readonly programDataReparse: boolean
  readonly hostSid: string
  readonly tokenIntegrity: string
  readonly tokenIntegrityRid: number
  readonly tokenElevated: boolean
  readonly ancestors: readonly { path: string; exists: boolean; fileId: string; volumeSerial: string; isReparsePoint: boolean; ownerSid: string }[]
  readonly profileInventoryHash: string
  readonly profileInventoryComplete: boolean
  readonly rightsModelVersion: number
  readonly rightsModelHash: string
  readonly helperHash: string
  readonly helperProtocol: number
  readonly stateEpoch: string
}

export const evidenceHashOf = (e: RootEvidence): string => sha256(JSON.stringify(e))

/** Which named elements differ. Used to name the drift, never to tolerate it. */
export function evidenceDrift(a: RootEvidence, b: RootEvidence): string[] {
  const out: string[] = []
  for (const k of Object.keys(a) as (keyof RootEvidence)[]) {
    if (k === "ancestors") continue
    if (a[k] !== b[k]) out.push(k)
  }
  const an = a.ancestors
  const bn = b.ancestors
  if (an.length !== bn.length) out.push("ancestors")
  else {
    for (let i = 0; i < an.length; i++) {
      const x = an[i]!
      const y = bn[i]!
      if (x.path !== y.path || x.exists !== y.exists || x.fileId !== y.fileId || x.volumeSerial !== y.volumeSerial || x.ownerSid !== y.ownerSid) out.push(`ancestors[${i}]`)
      if (x.isReparsePoint !== y.isReparsePoint) out.push(`ancestors[${i}].isReparsePoint`)
    }
  }
  return out
}

export interface RootRefusal {
  readonly ok: false
  readonly reasonCode: string
  readonly detail: string
}
export interface RootReady {
  readonly ok: true
  readonly rootPath: string
  readonly finalPath: string
  readonly volumeSerial: string
  readonly fileId: string
  readonly ownerSid: string
  readonly daclHash: string
  readonly markerHash: string
  readonly marker: RootMarker
  /** True when the root already existed and proved itself; NEVER for a root we repaired. */
  readonly observedExistingVerified: boolean
  /** True when this process is the one that published the root. */
  readonly publishedByUs: boolean
  readonly bootstrapId: string
  readonly stagingPath: string
  readonly evidenceHash: string
}
export type RootResult = RootReady | RootRefusal

export interface RootDeps {
  readonly store: EventStore
  readonly helper: HelperRunner
  readonly helperProtocol: number
  readonly helperHash: string
  /** Fail-closed: an incomplete inventory refuses before anything is created. */
  readonly profileInventory: { complete: boolean; hash: string; roots: readonly { path: string; resolved?: string }[] }
  readonly rightsModelVersion: number
  readonly rightsModelHash?: string
  /** The world model this plan belongs to; a change means the plan is not ours. */
  readonly stateEpoch?: string
  /** Once an approval exists, stale evidence is reported as a stale APPROVAL. */
  readonly approvalIssued?: boolean
  /** Points at which a test kills the process, between the beats. */
  readonly onPoint?: (point: string) => void | Promise<void>
  /** Drift injection for the evidence matrix. Production never sets it. */
  readonly onObserve?: (stage: string, e: RootEvidence) => RootEvidence
  /** The workspace, so a root inside it can be refused. */
  readonly workspace?: string
}

const AGG = "winiso:execution-root"
const lower = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()

async function emit(deps: RootDeps, type: string, data: Record<string, unknown>, idem?: string): Promise<void> {
  await deps.store.append({
    aggregateKind: "project",
    aggregateId: AGG,
    type,
    version: ROOT_SCHEMA_VERSION,
    data: { ...data, schemaVersion: ROOT_SCHEMA_VERSION },
    ...(idem ? { idempotencyKey: idem } : {}),
  })
}

/** A SID rendered safely for use as a directory name. */
export const sidToDirName = (sid: string): string => sid.replace(/[^A-Za-z0-9-]/g, "_")

/** The DACL the root gets: owner only, protected, nothing inherited. */
export const protectedDaclFor = (ownerSid: string): string => `D:P(A;OICI;FA;;;${ownerSid})`

export const markerHashOf = (m: RootMarker): string => sha256(JSON.stringify(m))

/**
 * Is this OBSERVED descriptor the protected, owner-only form?
 *
 * Compared STRUCTURALLY, never as a string against what was requested.
 * MEASURED: asking for `D:P(A;OICI;FA;;;<sid>)` reads back as
 * `D:PAI(A;OICI;FA;;;<sid>)` — Windows adds the auto-inherit flag itself. A hash
 * comparison of the two therefore always fails, which would have made every root
 * we correctly created look like a root somebody had tampered with.
 *
 * `AI` is permitted because it only says auto-inheritance is enabled; `P` is what
 * severs the parent, and no ACE may carry `ID` (actually inherited).
 */
export function isProtectedOwnerOnlyDacl(sddl: string, ownerSid: string): boolean {
  const head = /^D:([A-Z]*)\(/.exec(sddl)
  if (!head || !head[1]!.includes("P")) return false
  const aces = sddl.match(/\(([^)]*)\)/g) ?? []
  if (aces.length !== 1) return false
  const p = aces[0]!.slice(1, -1).split(";")
  return p[0] === "A" && p[1] === "OICI" && p[2] === "FA" && (p[5] ?? "").trim().toLowerCase() === ownerSid.toLowerCase()
}

/** Ancestors of the root BELOW ProgramData; ProgramData itself is never created. */
export function ancestorsOf(rootPath: string, programData: string): string[] {
  const rel = rootPath.slice(programData.length).replace(/^\\+/, "")
  const parts = rel.split("\\").filter(Boolean)
  const out: string[] = []
  let cur = programData
  for (let i = 0; i < parts.length - 1; i++) {
    cur = join(cur, parts[i]!)
    out.push(cur)
  }
  return out
}

export function readMarker(path: string): RootMarker | undefined {
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as RootMarker
    if (typeof m.ownerSid !== "string" || typeof m.rootFileId !== "string") return undefined
    return m
  } catch {
    return undefined
  }
}

export function readStagingOwner(path: string): StagingOwner | undefined {
  try {
    const o = JSON.parse(readFileSync(path, "utf8")) as StagingOwner
    if (typeof o.pid !== "number" || typeof o.processStartTime !== "string" || typeof o.hostSid !== "string") return undefined
    return o
  } catch {
    return undefined
  }
}

/**
 * Principals in an observed descriptor that the root must never grant.
 *
 * Checked on the descriptor as READ BACK, not as requested. An ACE carrying the
 * `ID` (inherited) flag is reported too: it is the real evidence that the
 * protected DACL took, since `P` and the auto-inherited `AI` flag coexist and
 * `D:PAI` alone proves nothing.
 */
export function findForbiddenPrincipals(sddl: string, ownerSid: string): string[] {
  const bad: string[] = []
  const aces = sddl.match(/\(([^)]*)\)/g) ?? []
  for (const ace of aces) {
    const parts = ace.slice(1, -1).split(";")
    const flags = parts[1] ?? ""
    const trustee = (parts[5] ?? "").trim()
    if (!trustee) continue
    if (flags.includes("ID")) bad.push(`inherited:${trustee}`)
    if (trustee.toLowerCase() === ownerSid.toLowerCase()) continue
    bad.push(trustee)
  }
  return bad
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

async function capture(deps: RootDeps, stage: string, rootPath?: string, programData?: string): Promise<RootEvidence | RootRefusal> {
  const kf = await deps.helper({ argv: ["known-folder", "--id", "ProgramData"] })
  if (kf.ok !== true) return { ok: false, reasonCode: "windows_execution_root_unknown", detail: `SHGetKnownFolderPath did not yield a usable ProgramData: ${JSON.stringify(kf).slice(0, 200)}` }
  const pd = programData ?? String(kf.lexicalPath ?? "")
  // A MUTABLE local of the same element type. Annotating it as
  // `RootEvidence["ancestors"]` typed the accumulator as `readonly [...]`, which
  // has no `push` — the field is deliberately readonly for callers, so the
  // accumulator must be the mutable form and is assigned into it below.
  const ancestors: RootEvidence["ancestors"][number][] = []
  if (rootPath) {
    for (const a of ancestorsOf(rootPath, pd)) {
      const i = await deps.helper({ argv: ["inspect-dir", "--path", a] })
      ancestors.push({
        path: a,
        exists: i.pathExists === true,
        fileId: String(i.pathFileId ?? ""),
        volumeSerial: String(i.pathVolumeSerial ?? ""),
        isReparsePoint: i.pathIsReparsePoint === true,
        ownerSid: String(i.pathOwnerSid ?? ""),
      })
    }
  }
  const raw: RootEvidence = {
    programDataLexical: String(kf.lexicalPath ?? ""),
    programDataFinal: String(kf.pathFinalPath ?? ""),
    programDataVolume: String(kf.pathVolumeSerial ?? ""),
    programDataFileId: String(kf.pathFileId ?? ""),
    programDataReparse: kf.pathIsReparsePoint === true,
    hostSid: String(kf.hostUserSid ?? ""),
    tokenIntegrity: String(kf.integrity ?? ""),
    tokenIntegrityRid: Number(kf.integrityRid ?? 0),
    tokenElevated: kf.elevated === true,
    ancestors,
    profileInventoryHash: deps.profileInventory.hash,
    profileInventoryComplete: deps.profileInventory.complete,
    rightsModelVersion: deps.rightsModelVersion,
    rightsModelHash: deps.rightsModelHash ?? `rights-model-v${deps.rightsModelVersion}`,
    helperHash: deps.helperHash,
    helperProtocol: deps.helperProtocol,
    stateEpoch: deps.stateEpoch ?? "epoch-0",
  }
  return deps.onObserve ? deps.onObserve(stage, raw) : raw
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export async function bootstrapExecutionRoot(deps: RootDeps): Promise<RootResult> {
  const fail = async (reasonCode: string, detail: string): Promise<RootRefusal> => {
    await emit(deps, RootEvents.Failed, { reasonCode, detail })
    return { ok: false, reasonCode, detail }
  }

  // ---- 0. FAIL-CLOSED on an inventory we could not read. "We do not know where
  //         the profiles are" can never mean "there are none".
  if (!deps.profileInventory.complete) {
    return { ok: false, reasonCode: "profile_inventory_unknown", detail: "the profile inventory is incomplete, so no path can be shown to sit outside every profile" }
  }

  // ---- 1. DISCOVER and capture the baseline evidence.
  const first = await capture(deps, "discovery")
  if ("ok" in first) return first
  let bound: RootEvidence = first

  if (!bound.programDataLexical || !bound.hostSid) return { ok: false, reasonCode: "windows_execution_root_unknown", detail: "the probe returned no path or no host SID" }
  if (bound.programDataReparse) return { ok: false, reasonCode: "windows_execution_root_unknown", detail: "ProgramData is a reparse point" }

  // ---- 2. HOST IDENTITY. Production is medium-integrity only, and the refusal
  //         precedes every directory, DACL and marker.
  if (bound.tokenElevated) {
    return { ok: false, reasonCode: "elevated_host_not_supported", detail: "the execution root is only created by a non-elevated host; it will not silently de-elevate" }
  }

  const programData = bound.programDataLexical
  const hostSid = bound.hostSid
  const rootPath = join(programData, "Abdo", "Execution", ROOT_LAYOUT_VERSION, sidToDirName(hostSid))
  const insideProfile = deps.profileInventory.roots.some((r) => {
    for (const p of [r.path, r.resolved].filter(Boolean) as string[]) {
      if (lower(rootPath) === lower(p) || lower(rootPath).startsWith(`${lower(p)}\\`)) return true
    }
    return false
  })
  if (insideProfile) return { ok: false, reasonCode: "windows_execution_root_unknown", detail: "the derived root lies inside a known profile root" }
  if (deps.workspace && lower(rootPath).startsWith(`${lower(deps.workspace)}\\`)) {
    return { ok: false, reasonCode: "windows_execution_root_unknown", detail: "the derived root lies inside the workspace" }
  }

  // Re-capture WITH ancestors now that the path is known.
  const withAncestors = await capture(deps, "baseline", rootPath, programData)
  if ("ok" in withAncestors) return withAncestors
  bound = withAncestors

  const bootstrapId = randomBytes(16).toString("hex")
  const operationId = `root-bootstrap:${bootstrapId}`
  const evidenceBase = {
    bootstrapId,
    operationId,
    programData,
    programDataFinal: bound.programDataFinal,
    programDataVolume: bound.programDataVolume,
    programDataFileId: bound.programDataFileId,
    hostSid,
    rootPath,
    profileInventoryHash: deps.profileInventory.hash,
    helperHash: deps.helperHash,
    helperProtocol: deps.helperProtocol,
    rightsModelVersion: deps.rightsModelVersion,
    evidenceHash: evidenceHashOf(bound),
  }

  /**
   * Re-verify the world immediately before a mutation.
   *
   * The bound snapshot is the one the plan was made against. Anything that moved
   * since makes the plan stale, and a plan that is stale is abandoned — never
   * applied to a world it does not describe. After an approval has been issued
   * the same drift is reported as a stale APPROVAL, because what went stale is
   * the thing a human said yes to.
   */
  const fresh = async (stage: string): Promise<RootRefusal | undefined> => {
    const now = await capture(deps, stage, rootPath, programData)
    if ("ok" in now) return now
    const drift = evidenceDrift(bound, now)
    if (drift.length === 0) return undefined
    const code = deps.approvalIssued ? "approval_snapshot_stale" : "stale_isolation_evidence"
    return await fail(code, `the evidence changed between inspection and use at ${stage}: ${drift.join(", ")}`)
  }

  const rebaseline = async (stage: string): Promise<RootRefusal | undefined> => {
    const now = await capture(deps, stage, rootPath, programData)
    if ("ok" in now) return now
    bound = now
    await emit(deps, RootEvents.Rebaselined, { ...evidenceBase, stage, evidenceHash: evidenceHashOf(now) })
    return undefined
  }

  await emit(deps, RootEvents.Requested, evidenceBase, operationId)
  await deps.onPoint?.("after_root_intent")

  // ---- 3. INSPECT. A junction or a file where a directory belongs ends it here.
  for (const a of bound.ancestors) {
    if (!a.exists) continue
    if (a.isReparsePoint) return await fail("execution_root_ancestor_conflict", `${a.path} is a reparse point`)
  }
  for (const a of ancestorsOf(rootPath, programData)) {
    const i = await deps.helper({ argv: ["inspect-dir", "--path", a] })
    if (i.pathExists === true && i.pathIsDirectory !== true) return await fail("execution_root_ancestor_conflict", `${a} exists and is not a directory`)
  }
  const existing = await deps.helper({ argv: ["inspect-dir", "--path", rootPath] })
  await emit(deps, RootEvents.Inspected, { ...evidenceBase, existed: existing.pathExists === true, ownerSid: String(existing.pathOwnerSid ?? "") })
  await deps.onPoint?.("after_inspected")

  // ---- 4. A ROOT THAT ALREADY EXISTS IS VERIFIED, NEVER REPAIRED.
  //
  //        Not one byte is written on this path. Anything that fails to prove
  //        itself is a conflict and is left exactly as it was found — including
  //        its DACL, its owner, its marker and every file planted inside it.
  if (existing.pathExists === true) {
    const verdict = verifyPublishedRoot(existing, rootPath, hostSid, deps)
    if (!verdict.ok) return await fail(verdict.reasonCode, verdict.detail)
    await emit(deps, RootEvents.VerifiedExisting, { ...evidenceBase, markerHash: verdict.markerHash, daclHash: verdict.daclHash, fileId: verdict.fileId })
    await deps.onPoint?.("before_ready")
    await emit(deps, RootEvents.Ready, { ...evidenceBase, markerHash: verdict.markerHash, daclHash: verdict.daclHash, publishedByUs: false })
    return {
      ok: true,
      rootPath,
      finalPath: String(existing.pathFinalPath ?? ""),
      volumeSerial: String(existing.pathVolumeSerial ?? ""),
      fileId: verdict.fileId,
      ownerSid: hostSid,
      daclHash: verdict.daclHash,
      markerHash: verdict.markerHash,
      marker: verdict.marker,
      observedExistingVerified: true,
      publishedByUs: false,
      bootstrapId,
      stagingPath: "",
      evidenceHash: evidenceBase.evidenceHash,
    }
  }

  // ---- 5. STAGING. The final path is not touched until it is publishable.
  const stagingParent = join(programData, "Abdo", "Execution", STAGING_DIR)
  const stagingPath = join(stagingParent, bootstrapId)
  await emit(deps, RootEvents.StagingRequested, { ...evidenceBase, stagingPath }, `${operationId}:staging`)

  let stale = await fresh("before_create")
  if (stale) return stale
  for (const dir of ancestorsOf(rootPath, programData).concat([stagingParent, stagingPath])) {
    const c = await deps.helper({ argv: ["create-dir", "--path", dir] })
    if (c.ok !== true) return await fail("execution_root_ancestor_conflict", `could not establish ${dir}: ${String(c.errorCode ?? "")}`)
  }
  const selfPid = process.pid
  const selfProc = await deps.helper({ argv: ["inspect-process", "--pid", String(selfPid)] })
  const owner: StagingOwner = {
    bootstrapId,
    operationId,
    pid: selfPid,
    processStartTime: String(selfProc.startTime ?? ""),
    hostSid,
    stateEpoch: bound.stateEpoch,
    createdAt: new Date().toISOString(),
  }
  writeOwnedMarkerFile(stagingPath, STAGING_OWNER_NAME, owner)
  const stagedFacts = await deps.helper({ argv: ["inspect-dir", "--path", stagingPath] })
  if (stagedFacts.pathExists !== true || stagedFacts.pathIsDirectory !== true || stagedFacts.pathIsReparsePoint === true) {
    return await fail("execution_root_ancestor_conflict", "the staging directory is not a plain directory after creation")
  }
  await emit(deps, RootEvents.StagingCreated, { ...evidenceBase, stagingPath, stagingFileId: String(stagedFacts.pathFileId ?? ""), pid: selfPid, processStartTime: owner.processStartTime })
  const rebase1 = await rebaseline("after_staging_created")
  if (rebase1) return rebase1
  await deps.onPoint?.("after_staging_created")

  const discard = async (reasonCode: string, detail: string): Promise<RootRefusal> => {
    // Never mask the real refusal: if this fails the sweep reclaims it later.
    removeOwnedDirectoryTree(stagingPath)
    await emit(deps, RootEvents.StagingDiscarded, { ...evidenceBase, stagingPath, reasonCode })
    return await fail(reasonCode, detail)
  }

  // ---- 6. PROTECT THE STAGING, not the final path.
  const dacl = protectedDaclFor(hostSid)
  stale = await fresh("before_protect")
  if (stale) return await discard(stale.reasonCode, stale.detail)
  const applied = await deps.helper({ argv: ["protect-dir", "--path", stagingPath, "--owner-sid", hostSid, "--dacl-sddl", dacl] })
  if (applied.ok !== true) return await discard("execution_root_dacl_conflict", `the protected DACL was not applied: ${JSON.stringify(applied).slice(0, 200)}`)
  const observedDacl = String(applied.pathDacl ?? "")
  const forbidden = findForbiddenPrincipals(observedDacl, hostSid)
  if (forbidden.length > 0) return await discard("execution_root_dacl_conflict", `the staging DACL grants unexpected principals: ${forbidden.join(", ")}`)
  await emit(deps, RootEvents.StagingProtected, { ...evidenceBase, stagingPath, observedDaclHash: sha256(observedDacl), ownerSid: String(applied.pathOwnerSid ?? "") })
  await deps.onPoint?.("after_staging_protected")

  // ---- 7. MARKER, written complete inside the staging. There is no temp file in
  //         the final root because the STAGING IS the temp.
  const marker: RootMarker = {
    schemaVersion: ROOT_SCHEMA_VERSION,
    rightsModelVersion: deps.rightsModelVersion,
    ownerSid: hostSid,
    rootFinalPath: rootPath,
    volumeSerial: String(applied.pathVolumeSerial ?? ""),
    rootFileId: String(applied.pathFileId ?? ""),
    protectedDaclHash: sha256(observedDacl),
    profileInventoryHash: deps.profileInventory.hash,
    helperProtocol: deps.helperProtocol,
    createdAt: new Date().toISOString(),
  }
  stale = await fresh("before_marker")
  if (stale) return await discard(stale.reasonCode, stale.detail)
  writeOwnedMarkerFile(stagingPath, MARKER_NAME, marker)
  await emit(deps, RootEvents.StagingMarked, { ...evidenceBase, stagingPath, markerHash: markerHashOf(marker) })
  await deps.onPoint?.("after_marker_temp")

  // ---- 8. FULL RECONCILIATION OF THE STAGING, before it is publishable.
  const staged = await deps.helper({ argv: ["inspect-dir", "--path", stagingPath] })
  const stagedDacl = String(staged.pathDacl ?? "")
  const problems = stagingProblems(staged, hostSid, marker, join(stagingPath, MARKER_NAME), bound.programDataVolume)
  if (problems.length > 0) return await discard("execution_root_dacl_conflict", `the staging did not reconcile: ${problems.join(", ")}`)
  await emit(deps, RootEvents.StagingReconciled, { ...evidenceBase, stagingPath, markerHash: markerHashOf(marker), daclHash: sha256(stagedDacl) })
  await deps.onPoint?.("after_staging_reconciled")

  // ---- 9. PUBLISH. Atomic, and it FAILS rather than replaces.
  stale = await fresh("before_publish")
  if (stale) return await discard(stale.reasonCode, stale.detail)
  // THE STAGING ITSELF IS RE-VERIFIED HERE, not just the world around it.
  // `fresh` compares the discovery evidence; it says nothing about the directory
  // we are about to publish. Without this, a DACL widened or a marker swapped
  // between reconciliation and the rename would be published as if it had been
  // proved — the whole point of staging is that only a verified directory ever
  // becomes the root.
  const recheck = await deps.helper({ argv: ["inspect-dir", "--path", stagingPath] })
  const drifted = stagingProblems(recheck, hostSid, marker, join(stagingPath, MARKER_NAME), bound.programDataVolume)
  if (drifted.length > 0) return await discard("stale_isolation_evidence", `the staging changed between reconciliation and publication: ${drifted.join(", ")}`)
  await emit(deps, RootEvents.PublishRequested, { ...evidenceBase, stagingPath, markerHash: markerHashOf(marker) }, `${operationId}:publish`)
  const pub = await deps.helper({ argv: ["publish-dir", "--from", stagingPath, "--to", rootPath] })
  await deps.onPoint?.("after_atomic_rename")

  if (pub.ok !== true) {
    // Somebody else published first, or planted something there. Either way this
    // process discards its own work and PROVES the published root — it does not
    // touch it, and it does not fall back to repairing it.
    const taken = pub.targetTaken === true
    removeOwnedDirectoryTree(stagingPath)
    await emit(deps, RootEvents.StagingDiscarded, { ...evidenceBase, stagingPath, reasonCode: taken ? "publish_lost_race" : "publish_failed" })
    if (!taken) return await fail("execution_root_ownership_conflict", `the root could not be published: error ${String(pub.errorCode ?? "")}`)

    const published = await deps.helper({ argv: ["inspect-dir", "--path", rootPath] })
    const verdict = verifyPublishedRoot(published, rootPath, hostSid, deps)
    if (!verdict.ok) return await fail(verdict.reasonCode, verdict.detail)
    await emit(deps, RootEvents.VerifiedExisting, { ...evidenceBase, markerHash: verdict.markerHash, daclHash: verdict.daclHash, fileId: verdict.fileId })
    await deps.onPoint?.("before_ready")
    await emit(deps, RootEvents.Ready, { ...evidenceBase, markerHash: verdict.markerHash, daclHash: verdict.daclHash, publishedByUs: false })
    return {
      ok: true,
      rootPath,
      finalPath: String(published.pathFinalPath ?? ""),
      volumeSerial: String(published.pathVolumeSerial ?? ""),
      fileId: verdict.fileId,
      ownerSid: hostSid,
      daclHash: verdict.daclHash,
      markerHash: verdict.markerHash,
      marker: verdict.marker,
      observedExistingVerified: true,
      publishedByUs: false,
      bootstrapId,
      stagingPath,
      evidenceHash: evidenceBase.evidenceHash,
    }
  }

  const final = await deps.helper({ argv: ["inspect-dir", "--path", rootPath] })
  await emit(deps, RootEvents.Published, { ...evidenceBase, stagingPath, fileId: String(final.pathFileId ?? ""), finalPath: String(final.pathFinalPath ?? "") })
  await emit(deps, RootEvents.MarkerWritten, { ...evidenceBase, markerHash: markerHashOf(marker) })
  await deps.onPoint?.("after_marker_completion")

  // ---- 10. RECONCILE THE PUBLISHED ROOT, then and only then `ready`.
  const verdict = verifyPublishedRoot(final, rootPath, hostSid, deps)
  if (!verdict.ok) return await fail(verdict.reasonCode, verdict.detail)
  await emit(deps, RootEvents.Reconciled, { ...evidenceBase, markerHash: verdict.markerHash, daclHash: verdict.daclHash, fileId: verdict.fileId })
  await deps.onPoint?.("before_ready")

  await emit(deps, RootEvents.Ready, { ...evidenceBase, markerHash: verdict.markerHash, daclHash: verdict.daclHash, publishedByUs: true })
  return {
    ok: true,
    rootPath,
    finalPath: String(final.pathFinalPath ?? ""),
    volumeSerial: String(final.pathVolumeSerial ?? ""),
    fileId: verdict.fileId,
    ownerSid: hostSid,
    daclHash: verdict.daclHash,
    markerHash: verdict.markerHash,
    marker: verdict.marker,
    observedExistingVerified: false,
    publishedByUs: true,
    bootstrapId,
    stagingPath,
    evidenceHash: evidenceBase.evidenceHash,
  }
}

/**
 * Everything that must still be true of a staging directory before it may become
 * the root. Called at reconciliation AND again immediately before the rename,
 * because the gap between the two is exactly where a swap would be invisible.
 */
function stagingProblems(facts: Record<string, unknown>, hostSid: string, marker: RootMarker, markerPath: string, rootVolume: string): string[] {
  const dacl = String(facts.pathDacl ?? "")
  const problems: string[] = []
  if (facts.pathExists !== true || facts.pathIsDirectory !== true) problems.push("staging_missing")
  if (facts.pathIsReparsePoint === true) problems.push("staging_is_reparse_point")
  if (String(facts.pathOwnerSid ?? "").toLowerCase() !== hostSid.toLowerCase()) problems.push("owner_mismatch")
  if (sha256(dacl) !== marker.protectedDaclHash) problems.push("dacl_changed_since_apply")
  if (findForbiddenPrincipals(dacl, hostSid).length > 0) problems.push("unexpected_principal")
  if (!isProtectedOwnerOnlyDacl(dacl, hostSid)) problems.push("dacl_not_the_protected_form")
  const onDisk = readMarker(markerPath)
  if (!onDisk || markerHashOf(onDisk) !== markerHashOf(marker)) problems.push("marker_changed")
  // Same volume, or `MoveFileExW` is not an atomic rename at all.
  if (String(facts.pathVolumeSerial ?? "") !== rootVolume) problems.push("staging_not_on_root_volume")
  return problems
}

type Verdict = { ok: true; marker: RootMarker; markerHash: string; daclHash: string; fileId: string } | { ok: false; reasonCode: string; detail: string }

/**
 * Prove a root that already exists, WITHOUT touching it.
 *
 * Every check is a refusal, never a repair. This is the function the previous
 * version did not have: it met a wide DACL by overwriting it, which meant a
 * directory planted by anyone became ours the moment we looked at it.
 */
export function verifyPublishedRoot(facts: Record<string, unknown>, rootPath: string, hostSid: string, deps: Pick<RootDeps, "helperProtocol" | "rightsModelVersion" | "profileInventory">): Verdict {
  if (facts.pathIsDirectory !== true) return { ok: false, reasonCode: "execution_root_ownership_conflict", detail: "the root path exists and is not a directory" }
  if (facts.pathIsReparsePoint === true) return { ok: false, reasonCode: "execution_root_ownership_conflict", detail: "the root path is a reparse point" }

  const marker = readMarker(join(rootPath, MARKER_NAME))
  if (!marker) {
    return { ok: false, reasonCode: "execution_root_ownership_conflict", detail: "the root exists but carries no readable marker; a directory we did not create is not ours to adopt" }
  }
  if (marker.ownerSid.toLowerCase() !== hostSid.toLowerCase()) {
    return { ok: false, reasonCode: "execution_root_ownership_conflict", detail: `the root carries a marker owned by ${marker.ownerSid}` }
  }
  if (marker.schemaVersion !== ROOT_SCHEMA_VERSION || marker.rightsModelVersion !== deps.rightsModelVersion || marker.helperProtocol !== deps.helperProtocol) {
    return { ok: false, reasonCode: "execution_root_ownership_conflict", detail: `the marker was written by a different model (schema ${marker.schemaVersion}, rights ${marker.rightsModelVersion}, protocol ${marker.helperProtocol})` }
  }
  if (marker.profileInventoryHash !== deps.profileInventory.hash) {
    return { ok: false, reasonCode: "execution_root_ownership_conflict", detail: "the marker was written against a different profile inventory" }
  }

  const observedOwner = String(facts.pathOwnerSid ?? "")
  const observedDacl = String(facts.pathDacl ?? "")
  const observedFileId = String(facts.pathFileId ?? "")
  const reasons: string[] = []
  if (observedOwner.toLowerCase() !== hostSid.toLowerCase()) reasons.push("owner_mismatch")
  if (sha256(observedDacl) !== marker.protectedDaclHash) reasons.push("dacl_changed_since_apply")
  if (!isProtectedOwnerOnlyDacl(observedDacl, hostSid)) reasons.push("dacl_not_the_protected_form")
  if (observedFileId !== marker.rootFileId) reasons.push("root_identity_changed")
  if (String(facts.pathVolumeSerial ?? "") !== marker.volumeSerial) reasons.push("volume_changed")
  if (findForbiddenPrincipals(observedDacl, hostSid).length > 0) reasons.push("unexpected_principal")
  if (reasons.length > 0) {
    return { ok: false, reasonCode: "execution_root_dacl_conflict", detail: `the existing root did not prove itself: ${reasons.join(", ")} (nothing was modified)` }
  }
  return { ok: true, marker, markerHash: markerHashOf(marker), daclHash: sha256(observedDacl), fileId: observedFileId }
}

// ---------------------------------------------------------------------------
// Staging recovery
// ---------------------------------------------------------------------------

export interface SweepOutcome {
  readonly path: string
  readonly action: "removed" | "kept_live" | "deferred" | "kept_foreign"
  readonly reason: string
}

/**
 * Remove staging directories whose owner is provably gone — and NOTHING else.
 *
 * A pid is not an identity. `inspect-process` compares the recorded creation time
 * as well, so a REUSED pid reports `pidReused` and its staging is correctly
 * treated as abandoned rather than live. The dangerous direction is the other
 * one: deleting a directory a live bootstrap is still filling. So anything that
 * cannot be established — an unreadable owner file, a helper that would not
 * answer, a bootstrap the journal still shows as in flight — is DEFERRED, never
 * deleted, and reported for a human.
 */
export async function sweepStaging(deps: RootDeps, programData: string, hostSid: string, liveBootstrapIds: ReadonlySet<string>): Promise<SweepOutcome[]> {
  const parent = join(programData, "Abdo", "Execution", STAGING_DIR)
  const out: SweepOutcome[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(parent)
  } catch {
    return out
  }
  for (const name of entries) {
    const path = join(parent, name)
    const owner = readStagingOwner(join(path, STAGING_OWNER_NAME))
    if (!owner) {
      out.push({ path, action: "deferred", reason: "staging_owner_unreadable" })
      continue
    }
    if (owner.hostSid.toLowerCase() !== hostSid.toLowerCase()) {
      out.push({ path, action: "kept_foreign", reason: "staging_owned_by_another_host" })
      continue
    }
    const facts = await deps.helper({ argv: ["inspect-dir", "--path", path] })
    if (facts.pathExists !== true || facts.pathIsReparsePoint === true || String(facts.pathOwnerSid ?? "").toLowerCase() !== hostSid.toLowerCase()) {
      out.push({ path, action: "deferred", reason: "staging_ownership_unproven" })
      continue
    }
    // LIVENESS IS ASKED OF THE OS FIRST, and it is authoritative.
    //
    // The journal is a secondary guard, not the primary one: a host killed mid
    // bootstrap leaves its `requested` event with no conclusion for ever, so a
    // journal-first rule would read "in flight" about a process that died days
    // ago and would never free the directory. What the journal CAN do is stop a
    // deletion when the OS could not answer at all.
    const proc = await deps.helper({ argv: ["inspect-process", "--pid", String(owner.pid), "--expect-start", owner.processStartTime] })
    if (proc.ok !== true || typeof proc.alive !== "boolean") {
      out.push({ path, action: "deferred", reason: "staging_liveness_unknown" })
      continue
    }
    if (proc.alive === true) {
      out.push({ path, action: "kept_live", reason: liveBootstrapIds.has(owner.bootstrapId) ? "owning_process_alive_and_in_flight" : "owning_process_alive" })
      continue
    }
    const removal = removeOwnedDirectoryTree(path)
    if (removal.removed) {
      out.push({ path, action: "removed", reason: proc.pidReused === true ? "owner_gone_pid_reused" : liveBootstrapIds.has(owner.bootstrapId) ? "owner_gone_journal_stale" : "owner_gone" })
    } else {
      out.push({ path, action: "deferred", reason: `staging_removal_failed:${removal.code}` })
    }
  }
  return out
}

/** Bootstrap ids the journal still shows in flight: requested, never concluded. */
export async function liveBootstrapIds(store: EventStore): Promise<Set<string>> {
  const events = await store.read("project", AGG)
  const started = new Set<string>()
  for (const e of events) {
    const d = e.data as Record<string, unknown>
    const id = typeof d.bootstrapId === "string" ? d.bootstrapId : undefined
    if (!id) continue
    if (e.type === RootEvents.Requested) started.add(id)
    if (e.type === RootEvents.Ready || e.type === RootEvents.Failed || e.type === RootEvents.StagingDiscarded) started.delete(id)
  }
  return started
}

/** True when a sweep left anything a human has to look at. */
export const sweepNeedsIntervention = (o: readonly SweepOutcome[]): boolean => o.some((x) => x.action === "deferred")
