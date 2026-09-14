/**
 * CL-16A2-D §6 — startup recovery.
 *
 * Rebuild every unfinished run from the log, look at what the OS actually has,
 * and finish the cleanup that a dead host could not. It calls THE SAME
 * `requestCleanup` a live host calls: one cleanup path, one set of behaviours.
 * A separate "recovery cleanup" would be a second implementation of the rules
 * that matter most, tested less.
 *
 * THREE REFUSALS, each one a way this could destroy something:
 *
 *  1. **Never touch a profile without Abdo's ownership prefix.** Enforced twice
 *     — here, and again inside the helper, which will not delete an unmarked
 *     profile whatever it is told. A journal entry is not authority over
 *     somebody else's AppContainer.
 *  2. **Never clean up a run whose process is still alive.** The journal cannot
 *     tell a crashed host from a slow one; the OS can, so the OS is asked.
 *  3. **Never treat "already gone" as failure.** Recovery runs repeatedly and
 *     concurrently with normal cleanup; if idempotence were only approximate,
 *     the second run would report failures that are actually successes.
 */
import type { EventStore } from "@abdo/event-store"
import { AC, appendAc, foldRun, isIncomplete, runAggregateId, type RunProjection } from "./journal"
import { OWNERSHIP_PREFIX, inFlightRuns, profileNameFor, readOwnerMarker, requestCleanup, type LifecycleDeps } from "./lifecycle"

export interface RecoveryOutcome {
  readonly runId: string
  readonly profileName: string
  readonly stateBefore: string
  readonly stateAfter: string
  readonly action: "cleaned" | "skipped_alive" | "skipped_not_owned" | "already_complete" | "manual_intervention_required" | "nothing_to_do"
  readonly detail?: string
}

export interface RecoveryReport {
  readonly scanned: number
  readonly outcomes: readonly RecoveryOutcome[]
  readonly orphanProfilesRemoved: readonly string[]
  readonly orphanProfilesSkipped: readonly string[]
}

/** Every run aggregate in the log, with its folded state. */
export async function scanRuns(store: EventStore): Promise<RunProjection[]> {
  const all = await store.readAll()
  const byRun = new Map<string, { type: string; data: unknown }[]>()
  for (const e of all) {
    if (!e.aggregateId.startsWith("winiso:run:")) continue
    const runId = e.aggregateId.slice("winiso:run:".length)
    const list = byRun.get(runId) ?? []
    list.push({ type: e.type, data: e.data })
    byRun.set(runId, list)
  }
  return [...byRun.entries()].map(([runId, events]) => foldRun(runId, events))
}

/**
 * Recover everything unfinished.
 *
 * Safe to call twice, and safe to call while another host is cleaning up
 * normally: every step it takes is idempotent, and the lease ledger is what
 * stops two cleaners from both deciding they are the last holder.
 */
export async function recover(deps: LifecycleDeps): Promise<RecoveryReport> {
  const { store } = deps
  const runs = await scanRuns(store)
  const outcomes: RecoveryOutcome[] = []

  for (const run of runs) {
    const profileName = run.profileName || profileNameFor(run.runId)
    const record = (action: RecoveryOutcome["action"], stateAfter: string, detail?: string) =>
      outcomes.push({ runId: run.runId, profileName, stateBefore: run.state, stateAfter, action, ...(detail ? { detail } : {}) })

    if (!isIncomplete(run)) {
      record("already_complete", run.state)
      continue
    }
    if (!profileName.startsWith(OWNERSHIP_PREFIX)) {
      record("skipped_not_owned", run.state, `${profileName} does not carry ${OWNERSHIP_PREFIX}`)
      continue
    }
    // IS THE RUN'S OWNER STILL ALIVE?
    //
    // Asked BEFORE the child-process question, because a run spends its early
    // life with no child pid at all. Without this, a recovery pass that started
    // while a host sat between `run_requested` and `process_started` classified
    // a perfectly healthy run as abandoned and deleted its profile and ACLs
    // underneath it — measured as a real failure by the §7 "normal cleanup
    // concurrent with recovery" case, which is exactly why that case exists.
    //
    // It takes two checks because the journal cannot answer either alone:
    //   (a) THIS host is executing it right now. An in-flight run and an
    //       abandoned one look identical in the log, so only the host's own
    //       in-flight set can tell them apart.
    //   (b) ANOTHER host is executing it, answered by the recorded hostPid and
    //       creation time. Not applied to our own pid, because a run of ours
    //       that is NOT in flight has been abandoned and SHOULD be reclaimed.
    if (inFlightRuns.has(run.runId)) {
      record("skipped_alive", run.state, "this host is executing this run right now")
      continue
    }
    if (run.hostPid && run.hostPid !== process.pid) {
      const owner = await deps.helper({
        argv: ["inspect-process", "--pid", String(run.hostPid), ...(run.hostStartTime ? ["--expect-start", run.hostStartTime] : [])],
      })
      if (owner.alive === true) {
        record("skipped_alive", run.state, `host pid ${run.hostPid} is still running this run`)
        continue
      }
    }
    // Is the run's process STILL RUNNING? A host restart does not mean the work
    // stopped; the child is in its own job and may well have outlived us.
    if (run.pid) {
      // The creation time goes WITH the pid. Without it a reused pid reads as
      // "still running" and the run's profile and ACLs are never reclaimed —
      // MEASURED during a full-suite run, where a crashed run stayed stuck in
      // `profile_deleting` because some unrelated process had inherited its pid.
      //
      // A run journalled before start times were recorded has no expectation to
      // check; it is treated as ALIVE, which errs toward leaving resources alone
      // rather than deleting something in use.
      const alive = await deps.helper({
        argv: ["inspect-process", "--pid", String(run.pid), ...(run.processStartTime ? ["--expect-start", String(run.processStartTime)] : [])],
      })
      if (alive.alive === true) {
        record("skipped_alive", run.state, `pid ${run.pid} is still running`)
        continue
      }
      // `alive.pidReused === true` is NOT an error — it proves the original
      // process is gone, so cleanup proceeds below.
    }
    // The profile may not exist at all — the host may have died before creating
    // it. Deriving the name from the runId is what lets us even ask.
    const inspected = await deps.helper({ argv: ["inspect-profile", "--name", profileName] })
    const sid = run.sid || String(inspected.sid ?? "")
    if (inspected.profileExists !== true && run.grants.length === 0) {
      // Nothing was ever created and nothing was granted: close the run honestly
      // rather than leaving it to be re-scanned forever.
      await appendAc({ store }, runAggregateId(run.runId), AC.RunCompleted, {
        runId: run.runId,
        profileName,
        sid,
        stateEpoch: run.stateEpoch,
        reasonCode: "recovered_nothing_to_clean",
      }, `run-completed:${run.runId}`)
      record("nothing_to_do", "completed")
      continue
    }
    // A RECOVERY PASS IS A NEW EPOCH. The dead host's events belong to the
    // epoch it died in; this pass takes the run over and stamps its own, which
    // is what lets the fold re-enter cleanup stages without treating them as a
    // rewind, and what lets a LATER pass detect that it has been superseded
    // (`recovery_state_conflict`).
    await requestCleanup(deps, run.runId, sid, profileName, run.grants.map((g) => ({ key: "", path: g.path })), undefined, undefined, run.stateEpoch + 1)
    const after = foldRun(run.runId, await store.read("project", runAggregateId(run.runId)))
    record(after.state === "manual_intervention_required" ? "manual_intervention_required" : "cleaned", after.state)
  }

  // Orphan sweep: profiles carrying Abdo's marker that NO run claims. These come
  // from a host that died between the OS mutation and its completion event and
  // then lost its journal entirely — the last line of defence.
  const removed: string[] = []
  const skipped: string[] = []
  const known = new Set(runs.map((r) => r.profileName || profileNameFor(r.runId)))
  const live = new Set(runs.filter((r) => isIncomplete(r)).map((r) => r.profileName || profileNameFor(r.runId)))
  for (const name of await listOwnedProfiles()) {
    if (live.has(name)) {
      skipped.push(name) // a run still owns it
      continue
    }
    if (known.has(name)) {
      // A completed run's profile that survived deletion: still ours, still safe
      // to remove, and the helper re-checks ownership before it does.
      const res = await deps.helper({ argv: ["delete-profile", "--name", name] })
      if (res.profileExists === false) removed.push(name)
      else skipped.push(name)
      continue
    }
    // NO JOURNAL CLAIMS THIS PROFILE — but "no journal entry" is not the same
    // as "nobody is using it". A host with its own journal, or one whose log was
    // lost, can still be running inside this container right now. The owner
    // marker on disk is the only evidence that survives a lost journal, and it
    // carries pid AND creation time because a pid alone is not an identity.
    const marker = readOwnerMarker(name)
    if (marker?.hostPid) {
      const owner = await deps.helper({
        argv: ["inspect-process", "--pid", String(marker.hostPid), ...(marker.hostStartTime ? ["--expect-start", String(marker.hostStartTime)] : [])],
      })
      if (owner.alive === true) {
        skipped.push(name) // a live host owns it; deleting it would break a running container
        continue
      }
    }
    const res = await deps.helper({ argv: ["delete-profile", "--name", name] })
    if (res.profileExists === false) removed.push(name)
    else skipped.push(name)
  }

  const report: RecoveryReport = { scanned: runs.length, outcomes, orphanProfilesRemoved: removed, orphanProfilesSkipped: skipped }
  // The recovery result is itself durable (§6.6), on its own aggregate so it
  // cannot disturb any run's monotonic state.
  await store.append({
    aggregateKind: "project",
    aggregateId: "winiso:recovery",
    type: AC.RecoveryCompleted,
    version: 1,
    data: {
      scanned: report.scanned,
      cleaned: outcomes.filter((o) => o.action === "cleaned").length,
      skippedAlive: outcomes.filter((o) => o.action === "skipped_alive").length,
      manual: outcomes.filter((o) => o.action === "manual_intervention_required").length,
      orphanProfilesRemoved: removed,
      orphanProfilesSkipped: skipped,
    },
  })
  return report
}

/**
 * AppContainer profiles on this machine that carry Abdo's marker.
 *
 * Reading the package directory is an OBSERVATION of the OS, which is what
 * recovery needs; a list derived from the journal alone could not, by
 * definition, contain the orphan a lost journal left behind.
 */
export async function listOwnedProfiles(): Promise<string[]> {
  const { readdirSync } = await import("node:fs")
  const { join } = await import("node:path")
  const root = join(process.env.LOCALAPPDATA ?? "", "Packages")
  try {
    return readdirSync(root).filter((d) => d.startsWith(OWNERSHIP_PREFIX))
  } catch {
    return []
  }
}
