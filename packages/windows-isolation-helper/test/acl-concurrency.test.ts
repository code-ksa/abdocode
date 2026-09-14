/**
 * CL-16A2-D-R §6/§7 — the ACL and concurrency cases the audit found missing.
 *
 * The held-back work proved the two easy ACL shapes (nothing changed; a third
 * party added an ACE) and simulated the dangerous one by FORGING a resource
 * identity in the journal. These do it against the real filesystem: a real
 * junction, a real object replacement, real inheritance changes, and a real
 * parent whose ACL moves under a live child grant.
 *
 * The rule under test is always the same one, and it is the rule that decides
 * whether this subsystem can be trusted with a user's directories:
 *
 *     REMOVE ONLY WHAT ABDO ADDED, PROVE IT, AND OTHERWISE REFUSE.
 *
 * A restore that writes a remembered descriptor back is not a restore; it is an
 * overwrite that happens to look right in the case where nothing else changed.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryEventStore } from "@abdo/event-store"
import { foldRun, runAggregateId } from "../src/journal"
import { executeRun, HostCrashed, profileDirFor, profileNameFor, type LifecycleDeps } from "../src/lifecycle"
import { recover } from "../src/recovery"
import { REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import { OWNERSHIP_PREFIX, harnessHelperRunner, helperBinaryHash, helperBuilt, runDirect } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const CMD = "C:\\Windows\\System32\\cmd.exe"
const ICACLS = "C:\\Windows\\System32\\icacls.exe"
const T = 300_000

const runId = (tag: string) => `${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const deps = (store = new MemoryEventStore()): LifecycleDeps => ({
  store,
  helper: harnessHelperRunner(),
  helperBinaryHash: helperBinaryHash(),
  helperProtocolVersion: REQUIRED_PROTOCOL_VERSION,
})
const sddlOf = (p: string) => String(runDirect(["inspect-acl", "--path", p]).sddl ?? "")
const identityOf = (p: string) => String(runDirect(["inspect-acl", "--path", p]).fileIdentity ?? "")

/** Grant to a fresh container and return everything needed to restore it. */
function grantTo(path: string, tag: string) {
  const name = `${OWNERSHIP_PREFIX}${tag}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 64)
  const sid = String(runDirect(["ensure-profile", "--name", name]).sid)
  const before = sddlOf(path)
  const identity = identityOf(path)
  runDirect(["grant-acl", "--path", path, "--sid", sid, "--rights", "rx"])
  return { name, sid, before, identity, granted: sddlOf(path) }
}

describe.skipIf(!READY)("CL-16A2-D-R section 6 - the ACL cases that were missing", () => {
  test("a path REPLACED BY A DIFFERENT REAL OBJECT is refused, and the impostor is untouched", async () => {
    // Previously simulated by writing a fake resourceIdentity into the journal.
    // Here the directory is genuinely deleted and recreated, so the volume
    // serial / file index really do change - which is the only reason the
    // identity check exists.
    const parent = mkdtempSync(join(tmpdir(), "abdo-swap2-"))
    const target = join(parent, "d")
    mkdirSync(target)
    const g = grantTo(target, "swapreal")
    try {
      const identityBefore = identityOf(target)
      // Replace the object at the same PATH.
      rmSync(target, { recursive: true, force: true })
      mkdirSync(target)
      const identityAfter = identityOf(target)
      expect(identityAfter).not.toBe(identityBefore) // a genuinely different object
      const impostorSddl = sddlOf(target)

      // Restoring against the remembered object must not touch this one.
      const res = runDirect(["restore-acl", "--path", target, "--sid", g.sid, "--expect-granted-sddl", g.granted, "--original-sddl", g.before])
      // Either the helper refuses on identity, or - because this new directory
      // never had Abdo's ACE - it correctly reports there is nothing to remove.
      // What must NEVER happen is the remembered descriptor being written here.
      expect(sddlOf(target)).toBe(impostorSddl)
      expect(String(res.mode ?? "")).not.toBe("restored_to_original")
    } finally {
      runDirect(["delete-profile", "--name", g.name])
      rmSync(parent, { recursive: true, force: true })
    }
  }, T)

  test("RECOVERY refuses a genuinely replaced object with stale_isolation_evidence", async () => {
    // The strongest form, and the one the held-back work only SIMULATED by
    // writing a fake resourceIdentity into the journal. Here a real run grants
    // a real directory, the host dies, the directory is really replaced, and
    // the recovery path - which is where the identity re-check actually lives -
    // has to notice.
    const store = new MemoryEventStore()
    const id = runId("realswap")
    const parent = mkdtempSync(join(tmpdir(), "abdo-rswap-"))
    const target = join(parent, "d")
    mkdirSync(target)
    writeFileSync(join(target, "f.txt"), "x", "utf8")
    try {
      // Die after the grant lands but before its completion event.
      await executeRun(deps(store), {
        runId: id,
        argv: [CMD, "/c", "echo", "x"],
        grants: [{ path: target, rights: "rx" }],
        timeoutMs: 20_000,
        hostCrashAt: "after_acl_granted_before_event",
      }).catch(() => {})

      // Replace the object at that path with a different one.
      rmSync(target, { recursive: true, force: true })
      mkdirSync(target)
      const impostor = sddlOf(target)

      await recover(deps(store))
      const after = foldRun(id, await store.read("project", runAggregateId(id)))
      expect(after.state).toBe("manual_intervention_required")
      expect(after.reasonCodes).toContain("stale_isolation_evidence")
      // AND THE NEW OBJECT WAS NOT TOUCHED.
      expect(sddlOf(target)).toBe(impostor)
    } finally {
      runDirect(["delete-profile", "--name", profileNameFor(id)])
      rmSync(parent, { recursive: true, force: true })
    }
  }, T)

  test("a path turned into a JUNCTION after the grant does not get the real target's ACL rewritten", async () => {
    const base = mkdtempSync(join(tmpdir(), "abdo-junc-"))
    const real = join(base, "real")
    const elsewhere = join(base, "elsewhere")
    mkdirSync(real)
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, "victim.txt"), "do not touch", "utf8")
    const g = grantTo(real, "junc")
    try {
      const elsewhereBefore = sddlOf(elsewhere)
      // Swap the granted path for a junction pointing at the other directory.
      rmSync(real, { recursive: true, force: true })
      const mk = Bun.spawnSync([CMD, "/c", "mklink", "/J", real, elsewhere], { stdout: "pipe", stderr: "pipe" })
      expect(mk.exitCode).toBe(0)

      runDirect(["restore-acl", "--path", real, "--sid", g.sid, "--expect-granted-sddl", g.granted, "--original-sddl", g.before])

      // THE ASSERTION THAT MATTERS: the innocent directory the junction points
      // at still has exactly the descriptor it had before.
      expect(sddlOf(elsewhere)).toBe(elsewhereBefore)
    } finally {
      runDirect(["delete-profile", "--name", g.name])
      Bun.spawnSync([CMD, "/c", "rmdir", real], { stdout: "ignore", stderr: "ignore" })
      rmSync(base, { recursive: true, force: true })
    }
  }, T)

  test("an INHERITANCE change made during the run survives the restore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-inh-"))
    const g = grantTo(dir, "inh")
    try {
      // A third party disables inheritance and converts inherited ACEs to
      // explicit ones - a real, common administrative action.
      const off = Bun.spawnSync([ICACLS, dir, "/inheritance:d"], { stdout: "pipe", stderr: "pipe" })
      expect(off.exitCode).toBe(0)
      const afterExternal = sddlOf(dir)
      expect(afterExternal).not.toBe(g.granted)

      const res = runDirect(["restore-acl", "--path", dir, "--sid", g.sid, "--expect-granted-sddl", g.granted, "--original-sddl", g.before])
      expect(res.ok).toBe(true)
      const now = sddlOf(dir)
      // Abdo's ACE is gone...
      expect(now).not.toContain(g.sid)
      // ...and the descriptor was NOT reverted to the remembered original,
      // which would have silently re-enabled inheritance.
      expect(now).not.toBe(g.before)
    } finally {
      runDirect(["delete-profile", "--name", g.name])
      rmSync(dir, { recursive: true, force: true })
    }
  }, T)

  test("a PARENT ACL change during the run is preserved when the child grant is restored", async () => {
    const parent = mkdtempSync(join(tmpdir(), "abdo-par-"))
    const child = join(parent, "child")
    mkdirSync(child)
    const g = grantTo(child, "par")
    try {
      // The parent gains an inheritable ACE while the child's grant is live; it
      // propagates down to the child.
      const ext = Bun.spawnSync([ICACLS, parent, "/grant", "*S-1-5-32-545:(OI)(CI)(RX)"], { stdout: "pipe", stderr: "pipe" })
      expect(ext.exitCode).toBe(0)
      const childAfterParent = sddlOf(child)

      const res = runDirect(["restore-acl", "--path", child, "--sid", g.sid, "--expect-granted-sddl", g.granted, "--original-sddl", g.before])
      expect(res.ok).toBe(true)
      const now = sddlOf(child)
      expect(now).not.toContain(g.sid) // ours removed
      expect(now).toContain("BU") // the inherited third-party ACE survived
      expect(childAfterParent).toContain("BU")
    } finally {
      runDirect(["delete-profile", "--name", g.name])
      rmSync(parent, { recursive: true, force: true })
    }
  }, T)
})

describe.skipIf(!READY)("CL-16A2-D-R section 7 - the concurrency cases that were missing", () => {
  test("two helpers deleting the SAME profile at once: both succeed, it is gone once", async () => {
    const name = `${OWNERSHIP_PREFIX}dup-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
    runDirect(["ensure-profile", "--name", name])
    expect(existsSync(profileDirFor(name))).toBe(true)
    // Two real helper processes, started together, racing on one resource.
    const [a, b] = await Promise.all([
      (async () => Bun.spawnSync([join(import.meta.dir, "..", "target", "release", "abdo-winiso.exe"), "delete-profile", "--name", name], { stdout: "pipe", stderr: "pipe" }))(),
      (async () => Bun.spawnSync([join(import.meta.dir, "..", "target", "release", "abdo-winiso.exe"), "delete-profile", "--name", name], { stdout: "pipe", stderr: "pipe" }))(),
    ])
    const pa = JSON.parse(a.stdout.toString().trim().split("\n").at(-1) ?? "{}")
    const pb = JSON.parse(b.stdout.toString().trim().split("\n").at(-1) ?? "{}")
    // "Already gone" is a SUCCESS. If the loser reported failure, every
    // concurrent recovery pass would look like a broken one.
    expect(pa.ok).toBe(true)
    expect(pb.ok).toBe(true)
    expect(pa.profileExists).toBe(false)
    expect(pb.profileExists).toBe(false)
    expect(existsSync(profileDirFor(name))).toBe(false)
  }, T)

  test("a normal cleanup running AT THE SAME TIME as a recovery pass", async () => {
    // The audit noted only recovery-vs-recovery was covered. This is the case
    // that actually happens in production: a live host finishing a run while a
    // restarted host sweeps.
    const store = new MemoryEventStore()
    const d = deps(store)
    const id = runId("race")
    const scratch = mkdtempSync(join(tmpdir(), "abdo-race-"))
    writeFileSync(join(scratch, "f.txt"), "x", "utf8")
    const sddlBefore = sddlOf(scratch)
    try {
      const [ran] = await Promise.all([
        executeRun(d, { runId: id, argv: [CMD, "/c", "echo", "x"], grants: [{ path: scratch, rights: "rx" }], timeoutMs: 30_000 }),
        (async () => {
          await Bun.sleep(300)
          return recover(deps(store))
        })(),
      ])
      // The run still completed, exactly once, and the world is back to rest.
      expect(["completed", "manual_intervention_required"]).toContain(ran.state)
      const finalState = foldRun(id, await store.read("project", runAggregateId(id))).state
      expect(["completed", "manual_intervention_required"]).toContain(finalState)
      expect(existsSync(profileDirFor(profileNameFor(id)))).toBe(false)
      if (finalState === "completed") expect(sddlOf(scratch)).toBe(sddlBefore)
    } finally {
      runDirect(["delete-profile", "--name", profileNameFor(id)])
      rmSync(scratch, { recursive: true, force: true })
    }
  }, T)
})
