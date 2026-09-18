/**
 * CL-16A3 MEGA-1 §5b — THE STARTUP ORDER, and why it is this way round.
 *
 * `reclaimBeforeBootstrap` existed, was tested, and was called by nothing. A
 * capability that compiles, passes its tests and is unreachable is not a
 * feature — it is a claim. This module is the one place that makes it real, and
 * it is the only supported way to obtain an execution root.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORDER
 *
 *     load durable trusted-root evidence
 *       -> recover known isolated runs
 *         -> verify every restored ACL / root identity
 *           -> bootstrapExecutionRoot verification
 *             -> permit new runs
 *
 * MEASURED, in this sprint: a host killed just as its ACEs landed leaves an
 * AppContainer ACE on the SHARED execution root. `bootstrapExecutionRoot` is
 * fail-closed and refuses to adopt a root whose DACL has drifted from its
 * marker — which is correct. But with recovery running only AFTER bootstrap,
 * the host could never get far enough to repair the very thing blocking it.
 * ONE crash disabled every subsequent run on the machine until a human
 * intervened. Reversing the order is what makes the host self-healing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT "RECOVERY THEN TRY ANYWAY"
 *
 * Running a mutating sweep before anything has been proved is exactly how a
 * recovery pass becomes the thing that breaks a machine. So:
 *
 *  - the sweep is SCOPED to the root about to be adopted, and that root must
 *    already carry a readable marker. A root with no durable evidence is not
 *    repaired, it is left completely alone;
 *  - a run outside that root is deferred, never touched;
 *  - **recovery failure BLOCKS bootstrap.** If any run comes back
 *    `manual_intervention_required`, this refuses. It does not "try bootstrap
 *    anyway and see" — that would be the host deciding a human's decision was
 *    optional;
 *  - nothing is inferred: no profile name, no path, no SID is ever
 *    reconstructed from a runId.
 */
import { join } from "node:path"
import type { EventStore } from "@abdo/event-store"
import { bootstrapExecutionRoot, ROOT_LAYOUT_VERSION, sidToDirName, type RootResult } from "./execution-root"
import type { HelperRunner } from "./helper-runner"
import { reclaimBeforeBootstrap, type IsolatedRecoveryOutcome } from "./isorun-recovery"

export const StartupEvents = {
  Requested: "isorun.startup_requested",
  RecoverySwept: "isorun.startup_recovery_swept",
  Blocked: "isorun.startup_blocked",
  Ready: "isorun.startup_ready",
} as const

export interface StartupDeps {
  readonly store: EventStore
  readonly helper: HelperRunner
  readonly helperProtocol: number
  readonly helperHash: string
  readonly profileInventory: { readonly complete: boolean; readonly hash: string; readonly roots: readonly { path: string; resolved?: string }[] }
  readonly rightsModelVersion: number
  readonly now?: () => number
  /** Proves a directory is gone during reclamation. */
  readonly removeDirectory?: (path: string) => void
}

export type StartupResult =
  | {
      readonly ok: true
      readonly rootPath: string
      readonly finalPath: string
      readonly hostSid: string
      /** What the pre-bootstrap sweep did. Empty on a clean machine. */
      readonly recovery: readonly IsolatedRecoveryOutcome[]
    }
  | {
      readonly ok: false
      readonly reasonCode: string
      readonly detail: string
      readonly recovery: readonly IsolatedRecoveryOutcome[]
    }

/**
 * The canonical location of this host's execution root.
 *
 * This is DERIVED FROM THE LAYOUT, not guessed from a run: same expression as
 * `bootstrapExecutionRoot` uses, so the two cannot disagree. It is not the
 * forbidden kind of inference — the forbidden kind is reconstructing a
 * RESOURCE'S IDENTITY (a profile name, a SID) from an id, and that is never
 * done here. Whether this path is actually a trusted root is then decided by
 * its marker, below, not by having computed a plausible string.
 */
export const executionRootPathFor = (programData: string, hostSid: string): string => join(programData, "Abdo", "Execution", ROOT_LAYOUT_VERSION, sidToDirName(hostSid))

/**
 * Prepare an execution root, recovering first. **The only supported entry
 * point** for obtaining one.
 *
 * Returns a refusal rather than throwing, because "a human must look at this"
 * is an outcome a caller has to be able to report, not an exception to swallow.
 */
export async function prepareExecutionRoot(deps: StartupDeps): Promise<StartupResult> {
  const emit = async (type: string, data: Record<string, unknown>) => {
    await deps.store.append({ aggregateKind: "project", aggregateId: "winiso:startup", type, version: 1, data })
  }

  // ---- 1. WHO ARE WE, and where would this host's root be?
  const kf = await deps.helper({ argv: ["known-folder", "--id", "ProgramData"] })
  const programData = String(kf.lexicalPath ?? "")
  const hostSid = String(kf.hostUserSid ?? "")
  if (!programData || !hostSid) {
    const detail = "the host SID and ProgramData location could not be measured; nothing can be trusted without them"
    await emit(StartupEvents.Blocked, { reasonCode: "startup_identity_unknown", detail })
    return { ok: false, reasonCode: "startup_identity_unknown", detail, recovery: [] }
  }
  const rootPath = executionRootPathFor(programData, hostSid)
  await emit(StartupEvents.Requested, { hostSid, rootPath })

  // ---- 2. DURABLE TRUSTED-ROOT EVIDENCE.
  //
  // A root we may sweep inside is one that EXISTS and carries a readable
  // marker. Absent either, there is nothing to recover into and — critically —
  // nothing to repair: an unknown root is left completely alone and bootstrap
  // proceeds to create one from scratch.
  const rootDir = await deps.helper({ argv: ["inspect-dir", "--path", rootPath] })
  const markerReadable = rootDir.pathExists === true && (await deps.helper({ argv: ["inspect-dir", "--path", join(rootPath, "root.marker")] })).pathExists === true

  // ---- 3. RECOVER, scoped to that root only.
  let recovery: IsolatedRecoveryOutcome[] = []
  if (markerReadable) {
    recovery = [...(await reclaimBeforeBootstrap({ store: deps.store, helper: deps.helper, ...(deps.now ? { now: deps.now } : {}), ...(deps.removeDirectory ? { removeDirectory: deps.removeDirectory } : {}) }, rootPath))]
    await emit(StartupEvents.RecoverySwept, {
      rootPath,
      swept: recovery.length,
      reclaimed: recovery.filter((o) => o.action === "reclaimed").length,
      deferred: recovery.filter((o) => o.action === "manual_intervention_required").length,
    })
  }

  // ---- 4. RECOVERY FAILURE BLOCKS BOOTSTRAP.
  //
  // Not a warning. A run that needs a human is a machine whose state we do not
  // understand, and starting new work on top of it would bury the evidence
  // under fresh runs.
  const blocked = recovery.filter((o) => o.action === "manual_intervention_required")
  if (blocked.length > 0) {
    const detail =
      `${blocked.length} isolated run(s) need manual intervention, so no new run may start: ` +
      blocked.map((b) => `${b.runId} (${b.detail})`).join(" | ")
    await emit(StartupEvents.Blocked, { reasonCode: "recovery_requires_intervention", rootPath, runs: blocked.map((b) => b.runId), detail })
    return { ok: false, reasonCode: "recovery_requires_intervention", detail, recovery }
  }

  // ---- 5. ONLY NOW: the root's own fail-closed verification.
  const root: RootResult = await bootstrapExecutionRoot({
    store: deps.store,
    helper: deps.helper,
    helperProtocol: deps.helperProtocol,
    helperHash: deps.helperHash,
    profileInventory: deps.profileInventory,
    rightsModelVersion: deps.rightsModelVersion,
  })
  if (!root.ok) {
    await emit(StartupEvents.Blocked, { reasonCode: root.reasonCode, rootPath, detail: root.detail })
    return { ok: false, reasonCode: root.reasonCode, detail: root.detail, recovery }
  }

  await emit(StartupEvents.Ready, { rootPath: root.rootPath, finalPath: root.finalPath, hostSid, recovered: recovery.filter((o) => o.action === "reclaimed").length })
  return { ok: true, rootPath: root.rootPath, finalPath: root.finalPath, hostSid, recovery }
}
