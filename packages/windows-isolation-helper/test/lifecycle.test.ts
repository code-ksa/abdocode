/**
 * CL-16A2-D §3/§4/§7 — journal, state machine, leases and ACL correctness.
 *
 * These drive the REAL helper against the REAL OS through the harness runner.
 * The state machine tests that need no OS at all run against a fold, so the
 * monotonicity rules are checked exhaustively without a container each time.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryEventStore } from "@abdo/event-store"
import { AC, canTransition, foldRun, FORBIDDEN_EVENT_FIELDS, isIncomplete, leaseKey, runAggregateId } from "../src/journal"
import { acquireLease, leaseHolders, releaseLease } from "../src/leases"
import { executeRun, profileNameFor, readRun, type LifecycleDeps } from "../src/lifecycle"
import { REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import { OWNERSHIP_PREFIX, harnessHelperRunner, helperBinaryHash, helperBuilt } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const CMD = "C:\\Windows\\System32\\cmd.exe"
const T = 180_000

const runId = (tag: string) => `${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const deps = (): LifecycleDeps => ({
  store: new MemoryEventStore(),
  helper: harnessHelperRunner(),
  helperBinaryHash: helperBinaryHash(),
  helperProtocolVersion: REQUIRED_PROTOCOL_VERSION,
})

// ------------------------------------------------------------ the state machine

describe("CL-16A2-D section 4 — the state machine is monotonic and rebuildable", () => {
  const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data: { runId: "r", profileName: "abdo-winiso-r", ...data } })

  test("a fold reproduces the happy path exactly", () => {
    const p = foldRun("r", [
      ev(AC.RunRequested, { grants: [{ path: "C:\\x", rights: "rx" }] }),
      ev(AC.ProfileCreateRequested),
      ev(AC.ProfileCreated, { sid: "S-1-15-2-1", profileExists: true }),
      ev(AC.ProcessStartRequested),
      ev(AC.ProcessStarted, { pid: 42 }),
      ev(AC.ProcessExited, { exitCode: 0 }),
      ev(AC.CleanupRequested),
      ev(AC.ProfileDeleteRequested),
      ev(AC.ProfileDeleted, { profileExists: false }),
      ev(AC.RunCompleted),
    ])
    expect(p.state).toBe("completed")
    expect(p.sid).toBe("S-1-15-2-1")
    expect(p.pid).toBe(42)
    expect(p.profileCreated).toBe(true)
    expect(p.profileDeleted).toBe(true)
    expect(isIncomplete(p)).toBe(false)
  })

  test("a REPLAYED event never rewinds a run — no second spawn", () => {
    // The failure this prevents: a duplicated `process_start_requested` after
    // completion putting the run back into `process_starting`, which a recovery
    // pass would then act on by launching the command a second time.
    const p = foldRun("r", [
      ev(AC.RunRequested),
      ev(AC.ProcessStartRequested),
      ev(AC.ProcessStarted, { pid: 7 }),
      ev(AC.ProcessExited, { exitCode: 0 }),
      ev(AC.RunCompleted),
      ev(AC.ProcessStartRequested), // duplicate delivery
      ev(AC.ProfileCreateRequested), // out-of-order replay
    ])
    expect(p.state).toBe("completed")
  })

  test("manual_intervention_required is ABSORBING", () => {
    const p = foldRun("r", [ev(AC.RunRequested), ev(AC.ManualInterventionRequired, { reasonCode: "acl_restore_unproven" }), ev(AC.RunCompleted)])
    expect(p.state).toBe("manual_intervention_required")
    expect(p.reasonCodes).toContain("acl_restore_unproven")
    // And it is NOT incomplete: recovery must not keep retrying a run that is
    // waiting for a human.
    expect(isIncomplete(p)).toBe(false)
  })

  test("a grant replayed twice yields ONE record, so restore cannot run twice", () => {
    const g = { path: "C:\\x", resourceIdentity: "vol:1", rights: "rx", originalSddl: "D:", originalSddlHash: "h1", grantedSddl: "D:(A;;;;;S)", grantedSddlHash: "h2" }
    const p = foldRun("r", [ev(AC.RunRequested), ev(AC.AclGranted, g), ev(AC.AclGranted, g)])
    expect(p.grants).toHaveLength(1)
  })

  test("transitions only ever move forward", () => {
    expect(canTransition("requested", "profile_creating")).toBe(true)
    expect(canTransition("completed", "process_starting")).toBe(false)
    expect(canTransition("process_running", "process_running")).toBe(false)
  })
})

// -------------------------------------------------------------------- leases

describe("CL-16A2-D section 7 — leases decide who may revoke", () => {
  test("the first holder grants; the second does not; the LAST one revokes", async () => {
    const store = new MemoryEventStore()
    const ref = { resourceIdentity: "vol:42", sid: "S-1-15-2-shared", rights: "rx" }
    const a = await acquireLease(store, ref, "runA")
    const b = await acquireLease(store, ref, "runB")
    expect(a.mustGrant).toBe(true)
    expect(b.mustGrant).toBe(false)

    // runA finishing FIRST must not pull the grant out from under runB.
    const relA = await releaseLease(store, a.ref.key, "runA")
    expect(relA.mustRevoke).toBe(false)
    const relB = await releaseLease(store, b.ref.key, "runB")
    expect(relB.mustRevoke).toBe(true)
  })

  test("acquiring twice is idempotent — a retry cannot double-count itself", async () => {
    const store = new MemoryEventStore()
    const ref = { resourceIdentity: "vol:1", sid: "S-1-15-2-x", rights: "rx" }
    await acquireLease(store, ref, "runA")
    await acquireLease(store, ref, "runA")
    expect(await leaseHolders(store, leaseKey(ref.resourceIdentity, ref.sid, ref.rights))).toEqual(["runA"])
  })

  test("releasing twice does not revoke a live grant", async () => {
    const store = new MemoryEventStore()
    const ref = { resourceIdentity: "vol:1", sid: "S-1-15-2-x", rights: "rx" }
    const a = await acquireLease(store, ref, "runA")
    await acquireLease(store, ref, "runB")
    expect((await releaseLease(store, a.ref.key, "runA")).mustRevoke).toBe(false)
    expect((await releaseLease(store, a.ref.key, "runA")).mustRevoke).toBe(false)
    expect(await leaseHolders(store, a.ref.key)).toEqual(["runB"])
  })

  test("different rights on the same resource are DIFFERENT leases", async () => {
    const store = new MemoryEventStore()
    const rx = await acquireLease(store, { resourceIdentity: "vol:1", sid: "S-1-15-2-x", rights: "rx" }, "runA")
    const mod = await acquireLease(store, { resourceIdentity: "vol:1", sid: "S-1-15-2-x", rights: "modify" }, "runB")
    expect(rx.ref.key).not.toBe(mod.ref.key)
    expect(rx.mustGrant).toBe(true)
    expect(mod.mustGrant).toBe(true)
  })

  test("20 concurrent acquires all land, and exactly one release revokes", async () => {
    const store = new MemoryEventStore()
    const ref = { resourceIdentity: "vol:99", sid: "S-1-15-2-many", rights: "rx" }
    const ids = Array.from({ length: 20 }, (_, i) => `run${i}`)
    const acquired = await Promise.all(ids.map((id) => acquireLease(store, ref, id)))
    expect(acquired.filter((a) => a.mustGrant)).toHaveLength(1) // exactly one granter
    const key = acquired[0]!.ref.key
    expect((await leaseHolders(store, key)).length).toBe(20)
    const released = await Promise.all(ids.map((id) => releaseLease(store, key, id)))
    expect(released.filter((r) => r.mustRevoke)).toHaveLength(1) // exactly one revoker
    expect(await leaseHolders(store, key)).toEqual([])
  }, T)
})

// ------------------------------------------------------- the real thing, end to end

describe.skipIf(!READY)("CL-16A2-D section 3 — intent before mutation, against the real OS", () => {
  test("a clean run walks the whole journal and ends completed with nothing left behind", async () => {
    const d = deps()
    const id = runId("clean")
    const p = await executeRun(d, { runId: id, argv: [CMD, "/c", "echo", "hello"], grants: [], timeoutMs: 20_000 })
    expect(p.state).toBe("completed")
    expect(p.profileCreated).toBe(true)
    expect(p.profileDeleted).toBe(true)
    expect(p.exitCode).toBe(0)

    const types = (await d.store.read("project", runAggregateId(id))).map((e) => e.type)
    // INTENT ALWAYS PRECEDES ITS MUTATION. This is §3 as an assertion rather
    // than as a comment.
    expect(types.indexOf(AC.ProfileCreateRequested)).toBeLessThan(types.indexOf(AC.ProfileCreated))
    expect(types.indexOf(AC.ProcessStartRequested)).toBeLessThan(types.indexOf(AC.ProcessStarted))
    expect(types.indexOf(AC.CleanupRequested)).toBeLessThan(types.indexOf(AC.ProfileDeleted))
    expect(types.indexOf(AC.ProfileDeleteRequested)).toBeLessThan(types.indexOf(AC.ProfileDeleted))
    expect(types.at(-1)).toBe(AC.RunCompleted)
  }, T)

  test("the profile name is DERIVED from the runId, which is what makes recovery possible", async () => {
    const id = runId("derive")
    expect(profileNameFor(id)).toBe(`${OWNERSHIP_PREFIX}${id}`)
    expect(profileNameFor(id).startsWith(OWNERSHIP_PREFIX)).toBe(true)
  })

  test("no journal event carries file content, an environment value or a secret", async () => {
    const d = deps()
    const id = runId("secret")
    const scratch = mkdtempSync(join(tmpdir(), "abdo-j-"))
    writeFileSync(join(scratch, "f.txt"), "TOP-SECRET-FILE-CONTENT", "utf8")
    try {
      await executeRun(d, { runId: id, argv: [CMD, "/c", "echo", "x"], grants: [{ path: scratch, rights: "rx" }], timeoutMs: 20_000 })
      const events = await d.store.read("project", runAggregateId(id))
      const blob = JSON.stringify(events)
      expect(blob).not.toContain("TOP-SECRET-FILE-CONTENT")
      // Not just this one string: no event may carry a field whose NAME belongs
      // to the categories that must never be journalled. Process output is on
      // that list — a command's stdout is exactly where a secret shows up.
      for (const e of events) {
        for (const key of Object.keys((e.data ?? {}) as Record<string, unknown>)) {
          expect(FORBIDDEN_EVENT_FIELDS as readonly string[]).not.toContain(key)
        }
      }
      // The SDDL IS present, deliberately and boundedly — without it no restore
      // is possible after a crash. It is access-control structure, not content.
      expect(blob).toContain("originalSddl")
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, T)

  test("a granted path is readable during the run and denied again afterwards", async () => {
    const d = deps()
    const id = runId("grant")
    const scratch = mkdtempSync(join(tmpdir(), "abdo-g-"))
    const file = join(scratch, "readme.txt")
    writeFileSync(file, "granted-content", "utf8")
    try {
      const p = await executeRun(d, { runId: id, argv: [CMD, "/c", "type", file], grants: [{ path: scratch, rights: "rx" }], timeoutMs: 20_000 })
      expect(p.state).toBe("completed")
      expect(p.exitCode).toBe(0)
      expect(p.grants).toHaveLength(1)
      expect(p.grants[0]!.restored).toBe(true)
      // Abdo's ACE was removed and the descriptor came back to the original —
      // proven by comparison, not by writing the original back.
      expect(p.grants[0]!.restoreMode).toBe("restored_to_original")

      // And the grant really is gone: a NEW run without it cannot read the file.
      const p2 = await executeRun(deps(), { runId: runId("nogrant"), argv: [CMD, "/c", "type", file], grants: [], timeoutMs: 20_000 })
      expect(p2.exitCode).not.toBe(0)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, T)
})

// --------------------------------------------------- external ACL modification

describe.skipIf(!READY)("CL-16A2-D section 7 — an external ACL change is PRESERVED", () => {
  test("a third party's ACE added mid-run survives the restore; only Abdo's ACE goes", async () => {
    const d = deps()
    const id = runId("extacl")
    const scratch = mkdtempSync(join(tmpdir(), "abdo-ext-"))
    writeFileSync(join(scratch, "f.txt"), "x", "utf8")
    const helper = harnessHelperRunner()
    try {
      // Grant, then let a "user" add their own ACE while the run is live.
      const before = await helper({ argv: ["inspect-acl", "--path", scratch] })
      const sid = String((await helper({ argv: ["ensure-profile", "--name", profileNameFor(id)] })).sid)
      await helper({ argv: ["grant-acl", "--path", scratch, "--sid", sid, "--rights", "rx"] })
      const granted = await helper({ argv: ["inspect-acl", "--path", scratch] })

      // The external change: Users get read. Done with icacls precisely because
      // it is NOT this code — a genuine third party.
      const ext = Bun.spawnSync(["C:\\Windows\\System32\\icacls.exe", scratch, "/grant", "*S-1-5-32-545:(OI)(CI)(RX)"], { stdout: "pipe", stderr: "pipe" })
      expect(ext.exitCode).toBe(0)
      const external = await helper({ argv: ["inspect-acl", "--path", scratch] })
      expect(external.sddl).not.toBe(granted.sddl)

      // Restore against the descriptor we REMEMBER granting — which no longer
      // matches. A blind restore here would delete the user's ACE.
      const restored = await helper({
        argv: ["restore-acl", "--path", scratch, "--sid", sid, "--expect-granted-sddl", String(granted.sddl), "--original-sddl", String(before.sddl)],
      })
      expect(restored.ok).toBe(true)
      expect(restored.mode).toBe("ace_removed") // removed, and NOT back to the original
      expect(restored.externalChangePreserved).toBe(true)
      expect(restored.descriptorUnchangedSinceGrant).toBe(false)

      const after = await helper({ argv: ["inspect-acl", "--path", scratch] })
      expect(String(after.sddl)).not.toContain(sid) // ours is gone
      // Theirs is not. SDDL ABBREVIATES well-known SIDs, so S-1-5-32-545 comes
      // back as `BU` — asserting on the raw SID here failed at first and the
      // code was right. AppContainer SIDs (S-1-15-2-...) have no abbreviation,
      // which is why the substring check for OUR ace above is exact.
      expect(String(after.sddl)).toContain("BU)")
      // The decisive assertion: the descriptor is NOT the one we remembered.
      // A blind `set original` would have made these equal and silently
      // destroyed the third party's change.
      expect(String(after.sddl)).not.toBe(String(before.sddl))
      await helper({ argv: ["delete-profile", "--name", profileNameFor(id)] })
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, T)

  test("restoring twice is safe — the second time reports already_absent", async () => {
    const d = deps()
    const id = runId("twice")
    const scratch = mkdtempSync(join(tmpdir(), "abdo-tw-"))
    const helper = harnessHelperRunner()
    try {
      const before = await helper({ argv: ["inspect-acl", "--path", scratch] })
      const sid = String((await helper({ argv: ["ensure-profile", "--name", profileNameFor(id)] })).sid)
      await helper({ argv: ["grant-acl", "--path", scratch, "--sid", sid, "--rights", "rx"] })
      const granted = await helper({ argv: ["inspect-acl", "--path", scratch] })
      const args = ["restore-acl", "--path", scratch, "--sid", sid, "--expect-granted-sddl", String(granted.sddl), "--original-sddl", String(before.sddl)]
      const first = await helper({ argv: args })
      const second = await helper({ argv: args })
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      expect(second.mode).toBe("already_absent")
      await helper({ argv: ["delete-profile", "--name", profileNameFor(id)] })
      void d
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, T)
})
