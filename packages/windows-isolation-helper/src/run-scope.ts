/**
 * CL-16A3-B3 / MEGA SPRINT 1 §3 — per-run least privilege, bound to a decision.
 *
 * `windows-scope.ts` plans a scope in COARSE rights (`traverse | rx | modify`).
 * B2B established that `modify` is not usable in a plan — it is an alias, and
 * `expandAlias` forces explicit named rights before any decision or TOCTOU hash.
 * This module is where a run's scope becomes an actual set of ACL grants in the
 * MEASURED vocabulary, and where each grant is bound to the decision that
 * authorised it.
 *
 * TWO RULES SHAPE EVERYTHING HERE.
 *
 * 1. LEAST PRIVILEGE PER OBJECT, NOT PER TREE. An input file is granted
 *    `read_file` ON THAT FILE (`object_self`) — B2A measured that a non-granted
 *    sibling in the same directory then stays denied, and that reading does not
 *    require enumeration. A directory gets `list_directory` only where listing is
 *    genuinely needed, because B2A also measured that read and enumerate are
 *    separable. Ancestors get `traverse` ALONE (`0x001000A0`), which B2 measured
 *    to be sufficient for execution and for both absolute and relative reads.
 *
 * 2. A GRANT IS EVIDENCE, NOT A CONVENIENCE. Every grant carries the runId, the
 *    stateEpoch, the control decision, the approval snapshot, the dialect, the
 *    executable identity, the AppContainer SID, the rights-model version and
 *    hash, the profile-inventory hash and the helper identity — and the file ID
 *    of the object it names. All of it is hashed into `bindingHash`. If any of
 *    it moves between planning and use, the run is refused rather than launched:
 *    a grant that outlives the facts it was derived from is not the same grant.
 *
 * NOTHING HERE GRANTS: Full Control, `modify` as a raw right, a profile root, a
 * drive root, a ProgramData sibling, or a recursive workspace tree. Those are
 * refusals with reason codes, not options.
 */
import { createHash } from "node:crypto"
import { join } from "node:path"
import type { EventStore } from "@abdo/event-store"
import { expandAlias, FORBIDDEN_MASK_BITS, maskOf, RIGHTS_MODEL_VERSION, rightsPlanHash } from "@abdo/tools/windows-acl-matrix"
import type { HelperRunner } from "./helper-runner"
import type { RunSubdir } from "./run-root"

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")

/** The ACE target vocabulary the helper accepts (CL-16A3-B2A protocol v5+). */
export type GrantTarget = "object_self" | "self_and_descendants" | "child_files" | "child_directories" | "immediate_children" | "descendants"

/** Why a grant exists, so an audit reads as a sentence rather than a mask. */
export type GrantPurpose = "ancestor_traverse" | "executable_execute" | "input_file_read" | "input_dir_traverse" | "input_dir_list" | "workspace_read" | "temp_write" | "output_write"

export interface RunGrant {
  readonly path: string
  /** The primary reason. Kept for message and audit compatibility. */
  readonly purpose: GrantPurpose
  /**
   * EVERY reason this object is granted, after merging.
   *
   * One object gets one mutation (see the merge step in `planRunScope`), but it
   * can have more than one reason — `listableDirs` naming the run's `input`
   * wants both traverse and enumeration. Collapsing that to a single purpose
   * would leave an audit reading "ancestor_traverse" over a grant that also
   * carries `list_directory`, which is precisely the kind of log that describes
   * a world slightly different from the real one.
   */
  readonly purposes: readonly GrantPurpose[]
  /** Named rights ONLY — never an alias, never a numeric mask. */
  readonly rights: readonly string[]
  readonly target: GrantTarget
  /** The mask those named rights resolve to, so the plan is auditable as a number. */
  readonly mask: number
  /** The object's identity at plan time. A different file later is drift. */
  readonly fileId?: string
  readonly volumeSerial?: string
}

export interface RunScopeBinding {
  readonly runId: string
  /**
   * WHICH ATTEMPT made this grant, and under which fencing token.
   *
   * Recovery uses these to refuse evidence it cannot explain: a grant whose
   * operation never appears in this run's lease history was written by
   * something that did not hold the run, and undoing it would be acting on a
   * record of unknown provenance.
   */
  readonly operationId?: string
  readonly fencingToken?: number
  readonly stateEpoch: string
  readonly decisionId: string
  readonly approvalSnapshot?: string
  readonly dialect: string
  readonly executablePath: string
  readonly executableHash: string
  readonly workspaceIdentity: string
  readonly appContainerSid: string
  readonly rightsModelVersion: number
  readonly rightsModelHash: string
  readonly profileInventoryHash: string
  readonly helperHash: string
  readonly helperProtocol: number
}

export interface RunScopePlan {
  readonly ok: true
  readonly grants: readonly RunGrant[]
  readonly binding: RunScopeBinding
  /** sha256 over the binding AND every grant. The whole plan, in one value. */
  readonly bindingHash: string
}

export interface RunScopeRefusal {
  readonly ok: false
  readonly reasonCode: string
  readonly detail: string
}

export type RunScopeResult = RunScopePlan | RunScopeRefusal

export interface RunScopeRequest {
  readonly binding: RunScopeBinding
  readonly runPath: string
  readonly runSubdirs: Readonly<Record<RunSubdir, string>>
  readonly executionRootPath: string
  /** Absolute files inside the run the child may READ. Granted per FILE. */
  readonly inputFiles?: readonly string[]
  /** Directories the child must ENUMERATE. Separate from reading, deliberately. */
  readonly listableDirs?: readonly string[]
  /** Measured identity of each object, from `inspect-dir`. */
  readonly identities?: Readonly<Record<string, { fileId?: string; volumeSerial?: string; isReparsePoint?: boolean }>>
  /** Profile roots that may never be granted (from the fail-closed inventory). */
  readonly forbiddenRoots: readonly string[]
  readonly profileInventoryComplete: boolean
  /**
   * For an executable OUTSIDE the execution root: the measured proof that this
   * AppContainer can actually run it. Absent or anything but
   * `existing_access_verified` is a refusal — location never implies access.
   */
  readonly executableAccess?: ExecutableAccessEvidence
}

const lower = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()

/** Every ancestor of `p` up to and including `stopAt`, nearest last. */
export function ancestorChain(p: string, stopAt: string): string[] {
  const out: string[] = []
  let cur = lower(p)
  const stop = lower(stopAt)
  while (cur.includes("\\") && cur !== stop) {
    cur = cur.slice(0, cur.lastIndexOf("\\"))
    if (!cur.includes("\\")) break // a bare drive letter is never granted
    out.push(cur)
    if (cur === stop) break
  }
  return out.reverse()
}

/** A drive root (`c:\`) or a bare device. Never grantable, on any volume. */
export const isDriveRoot = (p: string): boolean => /^[a-z]:\\?$/i.test(p.trim())

/**
 * Is `p` at or below `root`? Lexical, on already-normalised absolute paths — the
 * caller supplies measured identities for the resolution half, and a reparse
 * point anywhere in the plan is refused outright.
 */
export const isInside = (root: string, p: string): boolean => {
  const r = lower(root)
  const c = lower(p)
  return c === r || c.startsWith(`${r}\\`)
}

/**
 * Plan the ACL grants for one run. PURE — it performs no IO and mutates nothing;
 * the identities it binds are measured by the caller and passed in.
 */
export function planRunScope(req: RunScopeRequest): RunScopeResult {
  const refuse = (reasonCode: string, detail: string): RunScopeRefusal => ({ ok: false, reasonCode, detail })

  // FAIL-CLOSED: an incomplete profile inventory means "we do not know what a
  // profile is", and a grant planned in that state could name one.
  if (!req.profileInventoryComplete) {
    return refuse("profile_inventory_unknown", "the profile inventory is incomplete; no grant can be planned against an unknown set of profile roots")
  }
  if (!req.binding.appContainerSid) return refuse("appcontainer_sid_unknown", "a grant needs the AppContainer SID it is granted to")
  if (!req.binding.executablePath || !req.binding.executableHash) return refuse("executable_identity_unknown", "the executable's path and hash are part of the binding")
  if (req.binding.rightsModelVersion !== RIGHTS_MODEL_VERSION) {
    return refuse("rights_model_version_mismatch", `the plan was built for rights model v${req.binding.rightsModelVersion}, this host speaks v${RIGHTS_MODEL_VERSION}`)
  }

  const forbidden = req.forbiddenRoots.map(lower)
  const guard = (p: string, what: string): RunScopeRefusal | undefined => {
    const l = lower(p)
    if (isDriveRoot(p)) return refuse("scope_drive_root_forbidden", `${what} would grant a drive root (${p})`)
    for (const f of forbidden) {
      if (l === f || l.startsWith(`${f}\\`)) return refuse("scope_profile_root_forbidden", `${what} falls inside the profile root ${f}`)
    }
    const id = req.identities?.[l] ?? req.identities?.[p]
    if (id?.isReparsePoint === true) return refuse("scope_reparse_point_forbidden", `${what} is a reparse point (${p}); a junction can redirect a grant after it is planned`)
    return undefined
  }

  const grants: RunGrant[] = []
  const push = (path: string, purpose: GrantPurpose, rights: readonly string[], target: GrantTarget): RunScopeRefusal | undefined => {
    const bad = guard(path, purpose)
    if (bad) return bad
    // Named rights only. `expandAlias` turns a legacy alias into explicit names
    // and passes an unknown name THROUGH, so a typo fails loudly at the helper
    // instead of silently weakening the grant.
    const named = expandAlias(rights)
    const mask = maskOf(named)
    if ((mask & FORBIDDEN_MASK_BITS) !== 0) {
      return refuse("scope_forbidden_right", `${purpose} on ${path} resolves to a mask containing GENERIC_*/WRITE_DAC/WRITE_OWNER (0x${mask.toString(16)})`)
    }
    const id = req.identities?.[lower(path)] ?? req.identities?.[path]
    grants.push({
      path,
      purpose,
      purposes: [purpose],
      rights: named,
      target,
      mask,
      ...(id?.fileId ? { fileId: id.fileId } : {}),
      ...(id?.volumeSerial ? { volumeSerial: id.volumeSerial } : {}),
    })
    return undefined
  }

  // ---- 1. ANCESTORS: traverse ONLY. B2 measured 0x001000A0 to be sufficient —
  // the container still executes, and reads by absolute AND relative path — while
  // granting neither list nor read on the chain itself.
  for (const a of ancestorChain(req.runPath, req.executionRootPath)) {
    const bad = push(a, "ancestor_traverse", ["traverse"], "object_self")
    if (bad) return bad
  }
  {
    const bad = push(req.runPath, "ancestor_traverse", ["traverse"], "object_self")
    if (bad) return bad
  }

  // ---- 2. THE EXECUTABLE — and this rule was CORRECTED after being written too
  // broadly, which is worth recording because the broad version looked safe.
  //
  // Attempt 1 granted `execute` on whatever executable it was handed. Applying
  // that to `C:\Windows\System32\cmd.exe` FAILED — a medium-integrity user cannot
  // rewrite a system binary's DACL — and aborted the whole sequence.
  //
  // Attempt 2 concluded "anything outside the execution root needs no grant".
  // That was an OVER-GENERALISATION of the evidence. What B2 measured is that
  // `C:\Windows` and `C:\Program Files` carry `ALL APPLICATION PACKAGES`; it says
  // nothing about whether a PARTICULAR file grants EXECUTE to a PARTICULAR
  // container, and nothing at all about Git, Node, PowerShell 7, or a tool a
  // workspace brings with it. Location is not a capability.
  //
  // So: inside the root, we own it and grant it. Outside the root, accessibility
  // must have been MEASURED by running the image inside the container
  // (`measureExecutableAccess`), and anything short of a proof is refused. We
  // never modify the ACL of a file we do not own, and we never assume access
  // from a path.
  if (isInside(req.executionRootPath, req.binding.executablePath)) {
    const bad = push(req.binding.executablePath, "executable_execute", ["traverse", "read_attributes", "read_file", "execute"], "object_self")
    if (bad) return bad
  } else {
    const access = req.executableAccess?.access
    if (access !== "existing_access_verified") {
      return refuse(
        "executable_not_accessible_to_appcontainer",
        `${req.binding.executablePath} lies outside the execution root and its accessibility to ${req.binding.appContainerSid} is ${access ?? "unmeasured"}. ` +
          `Measure it with measureExecutableAccess, or stage a copy inside the run root; its ACL is never modified.`,
      )
    }
    if (req.executableAccess && lower(req.executableAccess.executablePath) !== lower(req.binding.executablePath)) {
      return refuse("executable_access_evidence_mismatch", "the accessibility evidence describes a different executable than the binding")
    }
    if (req.executableAccess && req.executableAccess.appContainerSid.toLowerCase() !== req.binding.appContainerSid.toLowerCase()) {
      return refuse("executable_access_evidence_mismatch", "the accessibility evidence was measured for a different AppContainer SID")
    }
  }

  // ---- 3. INPUT FILES: read, per file, on the file itself. B2A §4 measured that
  // a non-granted sibling then stays denied (err 5) and that enumeration is not
  // required to open a file by name.
  for (const f of req.inputFiles ?? []) {
    const bad = push(f, "input_file_read", ["read_attributes", "read_file"], "object_self")
    if (bad) return bad
  }
  {
    const bad = push(req.runSubdirs.input, "input_dir_traverse", ["traverse"], "object_self")
    if (bad) return bad
  }

  // ---- 4. ENUMERATION, only where asked for. B2A §5 measured `list_directory`
  // on `object_self` enables FindFirstFileW and leaks nothing else.
  for (const d of req.listableDirs ?? []) {
    const bad = push(d, "input_dir_list", ["traverse", "list_directory"], "object_self")
    if (bad) return bad
  }

  // ---- 5. TEMP: the only place a child may create freely. Creation rights are
  // inherited to children so files the child makes are usable; DELETE is granted
  // on the directory's children, not on the run root.
  {
    const bad = push(req.runSubdirs.temp, "temp_write", ["traverse", "read_attributes", "read_file", "list_directory", "create_file", "create_directory", "write_file", "append", "delete_child"], "self_and_descendants")
    if (bad) return bad
  }

  // ---- 6. OUTPUT: create and write, no delete. The host collects it.
  {
    const bad = push(req.runSubdirs.output, "output_write", ["traverse", "read_attributes", "create_file", "write_file", "append"], "self_and_descendants")
    if (bad) return bad
  }

  // ---- 7. `metadata` and `workspace` are DELIBERATELY NOT GRANTED here.
  // `metadata` is host-written facts ABOUT the run and a run may not touch it.
  // A workspace grant must be requested per object by a caller that has measured
  // it: a recursive tree grant is exactly the broad grant this slice forbids.

  // ---- 8. ONE MUTATION PER CANONICAL OBJECT.
  //
  // Two purposes can legitimately name the same directory — `listableDirs`
  // containing the run's `input` is the obvious case, which wants
  // `input_dir_traverse` AND `input_dir_list`. Left as two grants they become
  // two SEPARATE mutations of one object, and the second captures an
  // `originalSddl` that ALREADY CONTAINS the first ACE. That chaining is not
  // cosmetic:
  //
  //   - `revokeRunGrants` re-reads after each restore and refuses to call an
  //     object clean while the container's SID is still on it. Restoring the
  //     second grant puts the object back to "original + first ACE", the SID is
  //     still there, and the object is reported `unproven` — a run that cleaned
  //     up perfectly is recorded as having left residue.
  //   - recovery folds grants BY PATH, so the second record silently overwrites
  //     the first and the true original is lost from the projection entirely.
  //
  // So the rights are merged and the object is mutated once, with one original
  // captured before the only mutation and one granted descriptor observed after
  // it. Conflicting inheritance is a REFUSAL rather than a silent pick: two
  // targets mean two different intents about descendants, and guessing which one
  // the caller meant is how a scope quietly becomes broader than anyone asked.
  const merged = new Map<string, RunGrant>()
  for (const g of grants) {
    const key = lower(g.path)
    const prev = merged.get(key)
    if (!prev) {
      merged.set(key, g)
      continue
    }
    if (prev.target !== g.target) {
      return refuse(
        "scope_conflicting_targets",
        `${g.path} is claimed by both ${prev.purpose} (${prev.target}) and ${g.purpose} (${g.target}); two inheritance targets for one object are two different intents about its descendants, and this refuses rather than choosing one`,
      )
    }
    const rights = [...new Set([...prev.rights, ...g.rights])]
    const mask = maskOf(rights)
    if ((mask & FORBIDDEN_MASK_BITS) !== 0) {
      return refuse("scope_forbidden_right", `merging ${prev.purpose} with ${g.purpose} on ${g.path} resolves to a forbidden mask (0x${mask.toString(16)})`)
    }
    merged.set(key, { ...prev, purpose: prev.purpose, purposes: [...new Set([...prev.purposes, ...g.purposes])], rights, mask })
  }
  grants.length = 0
  grants.push(...merged.values())

  const binding = req.binding
  const bindingHash = sha256(
    JSON.stringify({
      binding,
      grants: grants.map((g) => ({ p: lower(g.path), r: g.rights, t: g.target, m: g.mask, f: g.fileId ?? "", v: g.volumeSerial ?? "" })),
      rightsPlan: rightsPlanHash(),
    }),
  )
  return { ok: true, grants, binding, bindingHash }
}

// ─────────────────────────────────────────────────── applying and revoking

export const RunGrantEvents = {
  ScopePlanned: "execution_run.scope_planned",
  GrantsRequested: "execution_run.grants_requested",
  GrantsMutating: "execution_run.grants_mutating",
  /** Per object, AFTER the OS was re-read: what it now carries. */
  GrantObserved: "execution_run.grant_observed",
  GrantsApplied: "execution_run.grants_applied",
  GrantsVerified: "execution_run.grants_verified",
  RevocationRequested: "execution_run.revocation_requested",
  RevocationApplied: "execution_run.revocation_applied",
  RevocationVerified: "execution_run.revocation_verified",
  GrantsFailed: "execution_run.grants_failed",
} as const

export interface AppliedGrant {
  readonly path: string
  readonly purpose: GrantPurpose
  readonly grantedMask: number
  readonly originalSddl: string
  readonly grantedSddl: string
}

export interface GrantDeps {
  readonly store: EventStore
  readonly helper: HelperRunner
  readonly onPoint?: (point: string) => void | Promise<void>
}

/**
 * ACL EVIDENCE BELONGS TO THE RUN THAT CREATED IT, and this line was a defect.
 *
 * These events used to go to one shared aggregate, `winiso:execution-run`, while
 * isolated-run recovery reads `winiso:isorun:<runId>`. MEASURED: after a host was
 * killed just as its grants landed, the journal showed **zero** ACL mutations for
 * that run while the execution root visibly carried a live AppContainer ACE. So
 * recovery had nothing to restore, restored nothing, and reported `reclaimed` —
 * a clean bill of health over an ACE that was still on disk. One crash then left
 * the SHARED execution root unadoptable, and `bootstrapExecutionRoot` is
 * fail-closed, so no further run could start on that host.
 *
 * It is the mirror of the earlier namespace defect: that one had the driver
 * writing INTO a namespace the old sweep read; this one had the grants writing
 * into one the new sweep does not. Both come from deciding where an event lives
 * separately from deciding who needs to read it.
 *
 * The per-object descriptors are the only record of how to undo a grant, so they
 * go with the run.
 */
const aggregateForRun = (runId: string): string => `winiso:isorun:${runId}`

async function emit(deps: GrantDeps, runId: string, type: string, data: Record<string, unknown>, idempotencyKey?: string): Promise<void> {
  await deps.store.append({ aggregateKind: "project", aggregateId: aggregateForRun(runId), type, version: 1, data, ...(idempotencyKey ? { idempotencyKey } : {}) })
}

export interface ApplyResult {
  readonly ok: boolean
  readonly applied: readonly AppliedGrant[]
  readonly reasonCode?: string
  readonly detail?: string
}

/**
 * Apply a plan's grants, recording intent before each mutation and completion
 * only after RE-READING what the OS now says.
 *
 * A partial application is reported WITH the grants that did land, so the caller
 * can revoke them: leaving an ACE behind because the sequence failed halfway is
 * the residue this whole slice exists to prevent.
 */
export async function applyRunGrants(deps: GrantDeps, plan: RunScopePlan): Promise<ApplyResult> {
  const { binding } = plan
  await emit(deps, binding.runId, RunGrantEvents.ScopePlanned, { runId: binding.runId, stateEpoch: binding.stateEpoch, decisionId: binding.decisionId, bindingHash: plan.bindingHash, grants: plan.grants.length })
  await emit(deps, binding.runId, RunGrantEvents.GrantsRequested, { runId: binding.runId, stateEpoch: binding.stateEpoch, bindingHash: plan.bindingHash, sid: binding.appContainerSid }, `${plan.bindingHash}:grants`)
  await deps.onPoint?.("after_grants_intent")

  const applied: AppliedGrant[] = []
  for (const g of plan.grants) {
    const before = String((await deps.helper({ argv: ["inspect-acl", "--path", g.path] })).sddl ?? "")
    // THE ORIGINAL DESCRIPTOR IS RECORDED BEFORE THE MUTATION, AND THAT IS THE
    // WHOLE POINT OF WRITING IT HERE RATHER THAN AT `GrantsApplied`.
    //
    // This event used to carry only the path, purpose, rights, target and mask.
    // `AppliedGrant.originalSddl` therefore existed ONLY in the memory of the
    // process doing the granting — so a host that died between the ACE landing
    // and the run finishing took the one value needed to undo it to the grave.
    // `restore-acl` rejects an empty `--original-sddl` (measured in B2A), so
    // recovery could not have put the object back even in principle: the ACE
    // would have been permanent.
    //
    // The original lifecycle already got this right (`AC.AclGrantRequested`
    // carries `originalSddl`), which is why its crash matrix can report
    // `acl=restored_identical` at all ten kill points. This path is now durable
    // in the same way, and for the same reason.
    await emit(deps, binding.runId, RunGrantEvents.GrantsMutating, {
      runId: binding.runId,
      path: g.path,
      purpose: g.purpose,
      rights: g.rights,
      target: g.target,
      mask: g.mask,
      sid: binding.appContainerSid,
      operationId: binding.operationId ?? "",
      fencingToken: binding.fencingToken ?? 0,
      originalSddl: before,
      originalSddlHash: sha256(before),
      // THE OBJECT'S IDENTITY, so a later reclaim can prove it is restoring the
      // descriptor of the SAME file. A path is a name, not an identity: between
      // the crash and the sweep the name can be pointing at something else, and
      // writing a stale descriptor onto an unrelated object is a worse outcome
      // than leaving an ACE behind.
      fileId: g.fileId ?? "",
      volumeSerial: g.volumeSerial ?? "",
    })
    const r = await deps.helper({ argv: ["grant-acl", "--path", g.path, "--sid", binding.appContainerSid, "--rights", g.rights.join("+"), "--target", g.target] })
    if (r.ok !== true) {
      await emit(deps, binding.runId, RunGrantEvents.GrantsFailed, { runId: binding.runId, path: g.path, reasonCode: "acl_grant_failed", detail: String(r.error ?? r.errorCode ?? "") })
      return { ok: false, applied, reasonCode: "acl_grant_failed", detail: `${g.purpose} on ${g.path} was not applied` }
    }
    // THE COMPLETION IS AN OBSERVATION. `ok:true` says the call returned; the
    // SDDL says what the object now carries.
    const after = String((await deps.helper({ argv: ["inspect-acl", "--path", g.path] })).sddl ?? "")
    if (!after.toLowerCase().includes(binding.appContainerSid.toLowerCase())) {
      await emit(deps, binding.runId, RunGrantEvents.GrantsFailed, { runId: binding.runId, path: g.path, reasonCode: "acl_grant_unobserved" })
      return { ok: false, applied, reasonCode: "acl_grant_unobserved", detail: `${g.path} does not carry an ACE for ${binding.appContainerSid} after a successful grant` }
    }
    applied.push({ path: g.path, purpose: g.purpose, grantedMask: Number(r.grantedMask ?? g.mask), originalSddl: before, grantedSddl: after })
    // The OBSERVED result, per object. Recovery needs this as well as the
    // original: `restore-acl` is given `--expect-granted-sddl` so it refuses to
    // act on an object that no longer carries what we put there — without it, a
    // reclaim would happily overwrite a descriptor somebody else has since
    // changed.
    await emit(deps, binding.runId, RunGrantEvents.GrantObserved, {
      runId: binding.runId,
      path: g.path,
      purpose: g.purpose,
      sid: binding.appContainerSid,
      operationId: binding.operationId ?? "",
      fencingToken: binding.fencingToken ?? 0,
      grantedMask: Number(r.grantedMask ?? g.mask),
      originalSddl: before,
      grantedSddl: after,
    })
    await deps.onPoint?.("after_partial_grants")
  }
  await emit(deps, binding.runId, RunGrantEvents.GrantsApplied, { runId: binding.runId, stateEpoch: binding.stateEpoch, bindingHash: plan.bindingHash, count: applied.length })
  await deps.onPoint?.("after_grants_applied")

  // A separate VERIFY pass over the whole set, so a grant that was undone while
  // later ones were being applied is caught before anything launches.
  for (const a of applied) {
    const now = String((await deps.helper({ argv: ["inspect-acl", "--path", a.path] })).sddl ?? "")
    if (now !== a.grantedSddl) {
      await emit(deps, binding.runId, RunGrantEvents.GrantsFailed, { runId: binding.runId, path: a.path, reasonCode: "acl_drift_before_launch" })
      return { ok: false, applied, reasonCode: "acl_drift_before_launch", detail: `${a.path} changed between being granted and being verified` }
    }
  }
  await emit(deps, binding.runId, RunGrantEvents.GrantsVerified, { runId: binding.runId, stateEpoch: binding.stateEpoch, bindingHash: plan.bindingHash })
  await deps.onPoint?.("after_grants_verified")
  return { ok: true, applied }
}

export interface RevokeResult {
  readonly ok: boolean
  readonly restored: number
  readonly unproven: readonly string[]
}

/**
 * Remove every ACE this run added, and PROVE each removal by re-reading.
 *
 * `restore-acl` requires a non-empty `--original-sddl` (measured in B2A: passing
 * "" is rejected at the args stage and silently does nothing), so a grant whose
 * original descriptor was never captured is reported as unproven rather than
 * quietly skipped.
 */
export async function revokeRunGrants(deps: GrantDeps, binding: RunScopeBinding, applied: readonly AppliedGrant[]): Promise<RevokeResult> {
  await emit(deps, binding.runId, RunGrantEvents.RevocationRequested, { runId: binding.runId, stateEpoch: binding.stateEpoch, sid: binding.appContainerSid, count: applied.length }, `${binding.runId}:revoke`)
  await deps.onPoint?.("after_revoke_intent")
  const unproven: string[] = []
  let restored = 0
  // Reverse order: the ancestors granted first are released last, so nothing is
  // made unreachable while a later removal still needs to traverse to it.
  for (const a of [...applied].reverse()) {
    if (!a.originalSddl) {
      unproven.push(a.path)
      continue
    }
    const r = await deps.helper({ argv: ["restore-acl", "--path", a.path, "--sid", binding.appContainerSid, "--expect-granted-sddl", a.grantedSddl, "--original-sddl", a.originalSddl] })
    const now = String((await deps.helper({ argv: ["inspect-acl", "--path", a.path] })).sddl ?? "")
    if (r.ok !== true || now.toLowerCase().includes(binding.appContainerSid.toLowerCase())) {
      unproven.push(a.path)
      continue
    }
    restored++
    await deps.onPoint?.("after_partial_revoke")
  }
  await emit(deps, binding.runId, RunGrantEvents.RevocationApplied, { runId: binding.runId, restored, unproven: unproven.length })
  if (unproven.length > 0) {
    await emit(deps, binding.runId, RunGrantEvents.GrantsFailed, { runId: binding.runId, reasonCode: "acl_restore_evidence_missing", paths: unproven.length })
    return { ok: false, restored, unproven }
  }
  await emit(deps, binding.runId, RunGrantEvents.RevocationVerified, { runId: binding.runId, stateEpoch: binding.stateEpoch, restored })
  return { ok: true, restored, unproven }
}

// ──────────────────────────── measuring an executable we do not own

/**
 * CL-16A3 MEGA SPRINT 1 §3 (corrected) — accessibility is MEASURED, never
 * inferred from where a file happens to live.
 *
 * The first version of this planner said "an executable outside the execution
 * root needs no grant". That was a real over-generalisation, and it is the kind
 * that quietly becomes a security hole: what was actually measured (B2) is that
 * `C:\Windows` and `C:\Program Files` carry `ALL APPLICATION PACKAGES` — and even
 * that says nothing about whether a PARTICULAR file grants EXECUTE to a
 * particular container, nor about Git, Node, PowerShell 7, or any tool a
 * workspace brings with it. Location is not a capability.
 *
 * So every executable outside the run root is now proved by RUNNING IT INSIDE THE
 * CONTAINER, with the same AppContainer SID the grants use. The DACLs of the file
 * and of every ancestor are captured as evidence alongside the launch result, but
 * they are corroboration — the launch is the proof.
 */
export type ExecutableAccess = "existing_access_verified" | "staged_in_run" | "not_accessible" | "unknown"

export interface ExecutableAccessEvidence {
  readonly access: ExecutableAccess
  readonly executablePath: string
  readonly appContainerSid: string
  /** SDDL of the executable and of each ancestor, at measurement time. */
  readonly daclChain: readonly { path: string; sddl: string }[]
  /** sha256 over the whole chain — any ACL change after the measurement moves it. */
  readonly daclChainHash: string
  readonly probePid?: number
  readonly probeStartTime?: string
  readonly probeExitCode?: number
  readonly reason?: string
}

/**
 * NO ENTRY POINT IS EVER EXECUTED TO MEASURE ACCESS.
 *
 * The first version of this function proved accessibility by LAUNCHING the image
 * inside the container and looking at how it exited. That was a real defect, and
 * a subtle one: it ran the target's code BEFORE `run.launch_requested`, outside
 * the observation lifecycle, before any grants were verified and before the
 * process-tree containment that a real launch is wrapped in. "It exits quickly"
 * is not a safety property — a program may write a file, spawn a child, or touch
 * the network in the microseconds before it returns, and a measurement that can
 * do damage is not a measurement.
 *
 * So this function no longer runs the target's code. It captures the identity and
 * DACL chain of the executable and every ancestor as bound evidence, and then
 * answers the access question with the `probe-exec-access` helper verb
 * (protocol 8), which:
 *
 *   - refuses anything that is not a NATIVE PE, by header and not by extension —
 *     a script would mean running an interpreter, and no code may run;
 *   - creates the process SUSPENDED inside the SAME AppContainer the grants use;
 *   - assigns it to a job before it could spawn anything;
 *   - verifies `TokenIsAppContainer`, that the token's AppContainer SID is the
 *     expected one, and that the image THE KERNEL IS RUNNING is the requested
 *     file — which is how IFEO, a registered debugger or an image substitution
 *     are caught, since none of them appear in the argv we passed;
 *   - NEVER calls `ResumeThread` on any path;
 *   - terminates the job and the process and waits for an OS-CONFIRMED exit.
 *
 * Proved against a native PE whose first actions are to write a file and spawn a
 * child: neither happens (`probe-exec-access.test.ts`). Anything short of a
 * clean probe stays `unknown` or `not_accessible`, and the planner refuses both.
 */
const ACCESS_PROBE_NO_PROFILE = "executable_access_probe_no_profile"

/**
 * The probe's working directory.
 *
 * `String.raw` IS LOAD-BEARING, and this line is the reason the rule is now
 * enforced by a test rather than by discipline. It was written as a plain
 * `"C:\Windows\Temp"`, in which `\W` and `\T` are not escape sequences JavaScript
 * knows — so it silently became the string `C:WindowsTemp`, a path that does not
 * exist. Nothing caught it, because no test ever called this function WITH a
 * `profileName`, so the entire probe branch — the only path that can return
 * `existing_access_verified` — had never executed. A broken constant in dead code
 * is invisible right up to the moment the code stops being dead.
 *
 * That is the THIRD recurrence of this exact trap in this package (B2A §0, the
 * P3 correction, and here). Writing "remember to use String.raw" in a document
 * has now failed three times, so `windows-path-literals.test.ts` scans the source
 * and fails the suite instead.
 */
const DEFAULT_PROBE_CWD = String.raw`C:\Windows\Temp`

export interface ExecutableProbeDeps {
  readonly helper: HelperRunner
}

/**
 * Gather the BOUND EVIDENCE about an executable, WITHOUT running it.
 *
 * Reads only: the identity and DACL of the file and of every ancestor. It starts
 * no process, so it can have no side effect — which is the whole point of the
 * correction described above.
 *
 * The access VERDICT is deliberately `unknown` until a non-executing container
 * probe exists, and `unknown` is a refusal. This is fail-closed on purpose: it is
 * better to refuse an executable we could have run than to run one in order to
 * find out whether we may.
 */
export async function measureExecutableAccess(
  deps: ExecutableProbeDeps,
  input: { executablePath: string; appContainerSid: string; helperHash?: string; helperProtocol?: number; stateEpoch?: string; profileName?: string; probeCwd?: string },
): Promise<ExecutableAccessEvidence> {
  const chain: { path: string; sddl: string }[] = []
  const identities: { path: string; fileId: string; volumeSerial: string; isReparsePoint: boolean }[] = []
  for (const p of [...ancestorChain(input.executablePath, ""), input.executablePath]) {
    if (!p || isDriveRoot(p)) continue
    const acl = await deps.helper({ argv: ["inspect-acl", "--path", p] })
    chain.push({ path: p, sddl: String(acl.sddl ?? "") })
    const d = await deps.helper({ argv: ["inspect-dir", "--path", p] })
    identities.push({
      path: p,
      fileId: String(d.pathFileId ?? ""),
      volumeSerial: String(d.pathVolumeSerial ?? ""),
      isReparsePoint: d.pathIsReparsePoint === true,
    })
  }
  // The hash covers the DACLs AND the identities AND the helper/epoch the
  // measurement was taken under, so a swap of the image, a re-ACL of any
  // ancestor, a junction appearing in the chain, or a different helper all move
  // it — and the pre-launch check refuses on `stale_isolation_evidence`.
  const daclChainHash = sha256(
    JSON.stringify({
      dacls: chain.map((c) => [lower(c.path), c.sddl]),
      identities: identities.map((i) => [lower(i.path), i.fileId, i.volumeSerial, i.isReparsePoint]),
      sid: input.appContainerSid.toLowerCase(),
      helperHash: input.helperHash ?? "",
      helperProtocol: input.helperProtocol ?? 0,
      stateEpoch: input.stateEpoch ?? "",
    }),
  )
  const reparse = identities.find((i) => i.isReparsePoint)
  if (reparse) {
    return {
      access: "unknown",
      executablePath: input.executablePath,
      appContainerSid: input.appContainerSid,
      daclChain: chain,
      daclChainHash,
      reason: `a reparse point in the chain (${reparse.path}) makes the target unprovable`,
    }
  }

  // THE PROBE. It creates the process SUSPENDED in the container, verifies the
  // token's AppContainer SID and the image the KERNEL is running, and terminates
  // it from a suspended state. `ResumeThread` is never called, so the target's
  // entry point never executes — proved against a native PE whose first action
  // is to write a file and spawn a child (`probe-exec-access.test.ts`).
  if (input.profileName) {
    const r = await deps.helper({ argv: ["probe-exec-access", "--name", input.profileName, "--cwd", input.probeCwd ?? DEFAULT_PROBE_CWD, "--", input.executablePath] })
    const verified = r.ok === true && r.probeOnly === true && r.resumed === false && r.isAppContainer === true && r.sidMatches === true && r.imageMatches === true && r.processExited === true
    return {
      access: verified ? "existing_access_verified" : r.stage === "probe_process_identity_mismatch" ? "not_accessible" : "unknown",
      executablePath: input.executablePath,
      appContainerSid: input.appContainerSid,
      daclChain: chain,
      daclChainHash,
      probePid: typeof r.pid === "number" ? r.pid : undefined,
      probeStartTime: typeof r.startTime === "string" ? r.startTime : undefined,
      probeExitCode: typeof r.exitCode === "number" ? r.exitCode : undefined,
      reason: verified ? "created suspended in the container, identity verified, never resumed" : String(r.stage ?? r.error ?? "probe did not complete"),
    }
  }

  // No profile to probe with: evidence is gathered, but the access question is
  // UNPROVEN and therefore refused. A caller that wants a verdict must supply
  // the AppContainer the grants will use, because "can some container run this"
  // is not the question — "can THIS one" is.
  return {
    access: "unknown",
    executablePath: input.executablePath,
    appContainerSid: input.appContainerSid,
    daclChain: chain,
    daclChainHash,
    reason: `${ACCESS_PROBE_NO_PROFILE}: no AppContainer profile was supplied to probe with; accessibility is unproven`,
  }
}
