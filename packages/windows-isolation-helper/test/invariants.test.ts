/**
 * CL-16A2-D-R §3/§4/§8/§9 — the invariants the crash matrix rests on.
 *
 * The matrix in `real-crash.test.ts` kills a host between steps. These tests
 * attack the steps themselves: what happens when the JOURNAL fails rather than
 * the host, whether a recovery generation can be told from a replay, whether a
 * deletion is really guarded, and whether an elevated host is refused BEFORE it
 * changes the machine rather than after.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryEventStore } from "@abdo/event-store"
import type { AppendRequest, EventStore } from "@abdo/event-store"
import { AC, foldRun, runAggregateId } from "../src/journal"
import {
  OWNER_MARKER,
  executeRun,
  profileDirFor,
  profileNameFor,
  readOwnerMarker,
  requestCleanup,
  type LifecycleDeps,
} from "../src/lifecycle"
import { recover } from "../src/recovery"
import { REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import { OWNERSHIP_PREFIX, harnessHelperRunner, helperBinaryHash, helperBuilt, runDirect } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const CMD = "C:\\Windows\\System32\\cmd.exe"
const T = 180_000

const runId = (tag: string) => `${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const deps = (store: EventStore): LifecycleDeps => ({
  store,
  helper: harnessHelperRunner(),
  helperBinaryHash: helperBinaryHash(),
  helperProtocolVersion: REQUIRED_PROTOCOL_VERSION,
})

/** An event store that fails on demand — the §3 sink failure. */
class FailingStore implements EventStore {
  failed = 0
  constructor(
    private readonly inner: EventStore,
    private readonly shouldFail: (req: AppendRequest) => boolean,
  ) {}
  async append(req: AppendRequest) {
    if (this.shouldFail(req)) {
      this.failed++
      throw new Error(`event sink failure on ${req.type}`)
    }
    return this.inner.append(req)
  }
  read(...args: Parameters<EventStore["read"]>) {
    return this.inner.read(...args)
  }
  readAll(...args: Parameters<EventStore["readAll"]>) {
    return this.inner.readAll(...args)
  }
  subscribe(...args: Parameters<EventStore["subscribe"]>) {
    return this.inner.subscribe(...args)
  }
  // Delegated like every other method. `lastSequence` has been on the port
  // since `97d9b56`, so this double was incomplete from the day it was written
  // (`3bb47db`) — it declared `implements EventStore` while any path reaching
  // for `lastSequence` would have hit "not a function" instead of the inner
  // store. Nothing untypechecked ever caught it. No tested path calls it today,
  // so this changes no behaviour; it makes the double faithful to the interface
  // it claims to implement.
  lastSequence(...args: Parameters<EventStore["lastSequence"]>) {
    return this.inner.lastSequence(...args)
  }
}

// ───────────────────────────────────────────────── §4 the epoch is real

describe("CL-16A2-D-R section 4 - stateEpoch actually constrains the fold", () => {
  const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data: { runId: "r", profileName: "abdo-winiso-r", stateEpoch: 0, ...data } })

  test("within one epoch a replayed event never rewinds the run", () => {
    const p = foldRun("r", [
      ev(AC.RunRequested),
      ev(AC.ProcessStartRequested),
      ev(AC.ProcessStarted, { pid: 7 }),
      ev(AC.ProcessExited, { exitCode: 0 }),
      ev(AC.RunCompleted),
      ev(AC.ProcessStartRequested), // duplicate delivery, same epoch
    ])
    expect(p.state).toBe("completed")
  })

  test("a NEW epoch may legitimately re-enter cleanup - it is a takeover, not a replay", () => {
    // The old fold was monotonic GLOBALLY, so a recovery pass re-running the
    // cleanup stages looked identical to a duplicate event. The epoch is what
    // distinguishes "a second host is doing this now" from "this arrived twice".
    const p = foldRun("r", [
      ev(AC.RunRequested),
      ev(AC.ProfileDeleteRequested), // epoch 0 got as far as deleting
      ev(AC.CleanupRequested, { stateEpoch: 1 }), // a NEW host takes over
    ])
    expect(p.state).toBe("cleanup_pending")
    expect(p.stateEpoch).toBe(1)
  })

  test("an absorbing state OUTRANKS a new epoch", () => {
    // Otherwise a later cleanup pass could quietly promote a run that is waiting
    // for a human back onto the happy path - the one thing the state exists to
    // stop.
    const manual = foldRun("r", [ev(AC.RunRequested), ev(AC.ManualInterventionRequired, { reasonCode: "acl_restore_unproven" }), ev(AC.CleanupRequested, { stateEpoch: 5 })])
    expect(manual.state).toBe("manual_intervention_required")

    const done = foldRun("r", [ev(AC.RunRequested), ev(AC.RunCompleted), ev(AC.CleanupRequested, { stateEpoch: 5 })])
    expect(done.state).toBe("completed")
  })

  test("a stale cleanup pass refuses with recovery_state_conflict", async () => {
    // Two hosts believe they own the same run. The one holding the OLDER epoch
    // must not act, or it deletes resources the newer one is relying on.
    const store = new MemoryEventStore()
    const id = runId("conflict")
    const agg = runAggregateId(id)
    await store.append({ aggregateKind: "project", aggregateId: agg, type: AC.RunRequested, version: 1, data: { runId: id, profileName: profileNameFor(id), stateEpoch: 0 } })
    // A newer host has already advanced the run to epoch 3.
    await store.append({ aggregateKind: "project", aggregateId: agg, type: AC.CleanupRequested, version: 1, data: { runId: id, profileName: profileNameFor(id), stateEpoch: 3 } })

    let helperCalls = 0
    const d: LifecycleDeps = {
      store,
      helper: async () => {
        helperCalls++
        return { ok: true }
      },
      helperBinaryHash: "x",
      helperProtocolVersion: REQUIRED_PROTOCOL_VERSION,
    }
    await requestCleanup(d, id, "", profileNameFor(id), [], undefined, undefined, 1) // stale epoch

    const after = foldRun(id, await store.read("project", agg))
    expect(after.reasonCodes).toContain("recovery_state_conflict")
    // AND IT TOUCHED NOTHING: a losing pass performs no OS operation at all.
    expect(helperCalls).toBe(0)
    expect(after.state).not.toBe("completed")
  })
})

// ───────────────────────────────────────── §3 the event sink itself fails

describe.skipIf(!READY)("CL-16A2-D-R section 3 - when the JOURNAL fails, not the host", () => {
  test("sink fails BEFORE the first mutation: nothing was created", async () => {
    // The control-plane law is "no side effect before a durable intent". If the
    // intent cannot be recorded, the side effect must not happen at all.
    const id = runId("sink0")
    const store = new FailingStore(new MemoryEventStore(), (r) => r.type === AC.RunRequested)
    let threw = false
    try {
      await executeRun(deps(store), { runId: id, argv: [CMD, "/c", "echo", "x"], grants: [], timeoutMs: 20_000 })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(store.failed).toBe(1)
    // The decisive assertion: the OS was never touched.
    expect(runDirect(["inspect-profile", "--name", profileNameFor(id)]).profileExists).toBe(false)
    expect(existsSync(profileDirFor(profileNameFor(id)))).toBe(false)
  }, T)

  test("sink fails AFTER the profile exists: recovery finds it by OBSERVING, not by reading a completion", async () => {
    const id = runId("sink1")
    const inner = new MemoryEventStore()
    const store = new FailingStore(inner, (r) => r.type === AC.ProfileCreated)
    try {
      await executeRun(deps(store), { runId: id, argv: [CMD, "/c", "echo", "x"], grants: [], timeoutMs: 20_000 }).catch(() => {})
      // The profile IS on the machine and the journal has no completion for it.
      expect(runDirect(["inspect-profile", "--name", profileNameFor(id)]).profileExists).toBe(true)
      const stranded = foldRun(id, await inner.read("project", runAggregateId(id)))
      expect(stranded.state).toBe("profile_creating")
      expect(stranded.profileCreated).toBe(false) // the log does NOT know it exists

      // Recovery works from the derived name and what the OS says, so it
      // reclaims a resource the journal never recorded.
      await recover(deps(inner))
      expect(existsSync(profileDirFor(profileNameFor(id)))).toBe(false)
      expect(foldRun(id, await inner.read("project", runAggregateId(id))).state).toBe("completed")
    } finally {
      runDirect(["delete-profile", "--name", profileNameFor(id)])
    }
  }, T)

  test("sink fails AFTER the ACL grant: the unrecorded ACE is still removed", async () => {
    // The lost-update shape, caused by the journal rather than by a crash.
    const id = runId("sink2")
    const inner = new MemoryEventStore()
    const store = new FailingStore(inner, (r) => r.type === AC.AclGranted)
    const scratch = mkdtempSync(join(tmpdir(), "abdo-sink-"))
    writeFileSync(join(scratch, "f.txt"), "x", "utf8")
    const sddlBefore = String(runDirect(["inspect-acl", "--path", scratch]).sddl ?? "")
    try {
      await executeRun(deps(store), { runId: id, argv: [CMD, "/c", "echo", "x"], grants: [{ path: scratch, rights: "rx" }], timeoutMs: 20_000 }).catch(() => {})
      // NON-VACUITY: the ACE really is on disk, and the journal never recorded it.
      const sddlStranded = String(runDirect(["inspect-acl", "--path", scratch]).sddl ?? "")
      expect(sddlStranded).not.toBe(sddlBefore)
      const stranded = foldRun(id, await inner.read("project", runAggregateId(id)))
      expect(stranded.grants).toHaveLength(1)
      expect(stranded.grants[0]!.grantedSddl).toBe("") // pending: recorded by the INTENT only

      await recover(deps(inner))
      expect(String(runDirect(["inspect-acl", "--path", scratch]).sddl ?? "")).toBe(sddlBefore)
    } finally {
      runDirect(["delete-profile", "--name", profileNameFor(id)])
      rmSync(scratch, { recursive: true, force: true })
    }
  }, T)
})

// ─────────────────────────────────────────────── §8 ownership and deletion

describe.skipIf(!READY)("CL-16A2-D-R section 8 - what may be deleted, and what may not", () => {
  test("a name that merely RESEMBLES Abdo's is refused", async () => {
    for (const name of ["abdo-winiso", "abdo-winisoX-thing", "not-abdo-winiso-thing", "Abdo-Winiso-thing"]) {
      const res = runDirect(["delete-profile", "--name", name])
      expect(res.ok).toBe(false)
      expect(res.stage).toBe("ownership")
    }
  })

  test("deleting something already gone is an idempotent SUCCESS, recorded as observed_absent", async () => {
    const id = runId("absent")
    const name = profileNameFor(id)
    runDirect(["ensure-profile", "--name", name])
    const first = runDirect(["delete-profile", "--name", name])
    const second = runDirect(["delete-profile", "--name", name])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.existedBefore).toBe(false)
    expect(second.profileExists).toBe(false)
  }, T)

  test("a run stamps an owner marker on its profile", async () => {
    const store = new MemoryEventStore()
    const id = runId("mark")
    try {
      // The marker is written at creation; capture it while the profile lives by
      // reading it during the run's own command.
      await executeRun(deps(store), { runId: id, argv: [CMD, "/c", "echo", "x"], grants: [], timeoutMs: 20_000 })
      // After a clean run the profile (and its marker) are gone - which is the
      // correct end state. The marker's real job is tested below.
      expect(existsSync(profileDirFor(profileNameFor(id)))).toBe(false)
    } finally {
      runDirect(["delete-profile", "--name", profileNameFor(id)])
    }
  }, T)

  test("THE SWEEP SPARES A PROFILE WHOSE OWNER IS ALIVE, even with no journal at all", async () => {
    // The defect this closes: `recover()` with an empty journal deleted EVERY
    // abdo-winiso-* profile on the machine, guarded only by the name prefix. A
    // second host - or one whose log was lost - would have had its live
    // container destroyed by another host's routine startup sweep.
    const name = `${OWNERSHIP_PREFIX}liveowner-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
    runDirect(["ensure-profile", "--name", name])
    try {
      // Claim it for THIS process, which is definitively alive.
      const self = runDirect(["inspect-process", "--pid", String(process.pid)])
      mkdirSync(profileDirFor(name), { recursive: true })
      // THE DIGITS, NOT A NUMBER. Writing `Number(self.startTime)` here is the
      // very bug this slice found in the production path: a FILETIME is ~1.3e17
      // and loses its low digits in a JS number, after which the live owner
      // looks dead and its container is swept. Keeping it a string is the fix,
      // and this test is written the way the caller must write it.
      writeFileSync(join(profileDirFor(name), OWNER_MARKER), JSON.stringify({ runId: "someone-elses-run", hostPid: process.pid, hostStartTime: String(self.startTime ?? ""), stateEpoch: 0 }), "utf8")
      expect(readOwnerMarker(name)?.hostPid).toBe(process.pid)

      const report = await recover(deps(new MemoryEventStore()))
      expect(report.orphanProfilesRemoved).not.toContain(name)
      expect(report.orphanProfilesSkipped).toContain(name)
      expect(existsSync(profileDirFor(name))).toBe(true)
    } finally {
      runDirect(["delete-profile", "--name", name])
    }
  }, T)

  test("but a profile whose owner is DEAD is swept", async () => {
    // The other half: the guard must not become a way for stale markers to keep
    // orphans alive for ever. A pid with the wrong creation time is exactly the
    // reused-pid case, and it must read as dead.
    const name = `${OWNERSHIP_PREFIX}deadowner-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
    runDirect(["ensure-profile", "--name", name])
    try {
      mkdirSync(profileDirFor(name), { recursive: true })
      writeFileSync(join(profileDirFor(name), OWNER_MARKER), JSON.stringify({ runId: "dead-run", hostPid: process.pid, hostStartTime: 1, stateEpoch: 0 }), "utf8")
      const report = await recover(deps(new MemoryEventStore()))
      expect(report.orphanProfilesRemoved).toContain(name)
      expect(existsSync(profileDirFor(name))).toBe(false)
    } finally {
      runDirect(["delete-profile", "--name", name])
    }
  }, T)
})

// ─────────────────────────────────── §9 elevated refusal BEFORE any mutation

// ─────────────────────────── §9 MOVED OUT — see scripts/live-elevated-refusal.ts
//
// This file used to end with "CL-16A2-D-R section 9 - an elevated host refuses
// before it changes anything": two tests that each opened with
// `if (!selfElevated()) return`.
//
// At MEDIUM integrity — which is the only integrity an authoritative round runs
// at — both returned before asserting anything and bun counted them as PASSES.
// That is strictly worse than a skip: a skip is visible in the totals, whereas a
// vacuous pass makes "an elevated host refuses before it changes anything" look
// PROVEN by a round that never executed a single assertion of it. Two of the
// suite's green results were measuring nothing.
//
// Both proofs are LIVE ELEVATED proofs (proof class C), so they now live in
// `scripts/live-elevated-refusal.ts`, which refuses to run unless the host is
// genuinely elevated and can therefore never pass vacuously. The three classes
// are documented in the header of `test/production-e2e.test.ts`.
//
// What this file keeps proving at medium integrity is unchanged; it simply no
// longer claims the elevated refusal among its results.
