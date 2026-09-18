/**
 * MS1 P6 slice S4 — XP-07 and XP-11: EXECUTION-ROOT OWNERSHIP UNDER A REAL
 * MID-STAGING PEER, ACROSS REAL OS PROCESSES.
 *
 * THE GAP THIS CLOSES. C-01 proves the first-publish race probabilistically —
 * three identical twins released at once, whoever renames first wins. What it
 * cannot say is what happens in the named interleaving the matrix actually
 * describes: one host provably PARKED MID-STAGING (staged, protected, marked,
 * reconciled — not yet renamed) while a peer runs `bootstrapExecutionRoot` to
 * completion. Here that window is DETERMINISTIC: the production `onPoint` seam
 * (the same one C-02 and the TOCTOU matrix drive in-process) is surfaced by the
 * fixture's `--pause-at`, so the pause is a fact the parent observes, not a
 * coincidence of scheduling.
 *
 * WHAT IS ACTUALLY BEING PROVED, per scenario:
 *
 * XP-07 (same identity, mid-staging loser):
 *   1. While A is parked mid-staging, the root does not exist and A's private
 *      staging is the ONLY staging — a partially initialized root is never
 *      visible at the final path.
 *   2. B, arriving over A's live foreign staging, neither adopts nor deletes
 *      it: B stages privately, publishes, and A's staging survives B's entire
 *      bootstrap byte-identical.
 *   3. Released, A loses the rename ATOMICALLY (`targetTaken`), discards only
 *      its OWN staging, and VERIFIES B's root: `observedExistingVerified=true`.
 *      There is NO refusal in this interleaving — the matrix's
 *      `execution_root_ownership_conflict` row is a counterfactual (B's rename
 *      target is the root path, never A's staging) — and no `Failed` event.
 *
 * XP-11 (different profileInventory identity):
 *   1. B (hash-B) parks mid-staging; A (hash-A) publishes the root, whose
 *      marker binds hash-A.
 *   2. Released, B loses the rename, discards its OWN staging, and then
 *      verification REFUSES: `execution_root_ownership_conflict`, "different
 *      profile inventory" — the one clause of `verifyPublishedRoot`
 *      (execution-root.ts:690) no other test exercises. The journal gains a
 *      `Failed` event carrying that reasonCode (the draft asserted none — that
 *      contradicted production and is corrected here).
 *   3. The refusal mutates NOTHING of A's root: marker hash, fileId and the
 *      protected owner-only DACL are byte-identical after B's refusal. No
 *      repair, no adoption, no overwrite.
 *
 * Ordering is proven on disk, not assumed: each child's journal events form a
 * deterministic sandwich (parked host's pre-pause events → the whole peer
 * bootstrap → the parked host's post-resume events), sequences gapless. OS
 * identities (pid + creation time) are read from Win32_Process while both
 * children are parked at their start barriers — concurrently alive by
 * measurement. Every wait has an exit condition and a bounded deadline; there
 * is no sleep-as-synchronization anywhere.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { MARKER_NAME, RootEvents, STAGING_DIR, STAGING_OWNER_NAME, isProtectedOwnerOnlyDacl, markerHashOf, readMarker, readStagingOwner, sidToDirName } from "../src/execution-root"
import { barrier, waitForFile } from "./barrier"
import { helperBuilt, queueDir, runDirect, runUnelevated } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const FIXTURE = join(import.meta.dir, "fixtures", "root-bootstrap-child.ts")
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const AGG = "winiso:execution-root"
const T = 300_000

let hostSid = ""
let programData = ""
let rootPath = ""
let stagingParent = ""
const scratch: string[] = []

const wipe = () => rmSync(join(programData, "Abdo"), { recursive: true, force: true })

const stagingDirs = (): string[] => {
  try {
    return readdirSync(stagingParent)
  } catch {
    return []
  }
}

/** The root journal as it landed on disk, re-read by a fresh non-participant. */
async function rootEvents(db: string) {
  const store = new SqliteEventStore(db)
  try {
    return await store.read("project", AGG)
  } finally {
    store.close()
  }
}

// MODULE SCOPE, deliberately — mirrors the sibling execution-root test files.
afterAll(() => {
  try {
    wipe()
  } catch {
    /* best effort */
  }
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

interface OsIdentity {
  pid: number
  name: string
  created: string
}

/**
 * The REAL OS identity of each child, read from Windows while they are provably
 * still alive — parked at their start barriers awaiting this parent. Same
 * helper as the qualified XP-03/XP-12 and XP-01 files: a pid alone is not an
 * identity, the creation time is what makes distinctness a fact.
 */
async function osIdentities(pids: readonly number[], timeoutMs = 60_000): Promise<OsIdentity[]> {
  const filter = pids.map((p) => `ProcessId=${p}`).join(" or ")
  const cmd = `@(Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId, Name, @{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const out = Bun.spawnSync([PS, "-NoProfile", "-NonInteractive", "-Command", cmd], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()
    if (out) {
      const parsed = JSON.parse(out) as unknown
      const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { ProcessId: number; Name: string; Created: string }[]
      if (rows.length === pids.length) return rows.map((r) => ({ pid: r.ProcessId, name: r.Name, created: r.Created }))
    }
    await Bun.sleep(25)
  }
  throw new Error(`could not read OS identities for pids ${pids.join(", ")} within ${timeoutMs}ms`)
}

interface ChildResult {
  me: string
  pid: number
  ok: boolean
  rootPath?: string
  fileId?: string
  markerHash?: string
  daclHash?: string
  createdAt?: string
  publishedByUs?: boolean
  observedExistingVerified?: boolean
  bootstrapId?: string
  stagingPath?: string
  reasonCode?: string
  detail?: string
  error?: string
}

/** One scratch world per test; each child gets its OWN barrier dir so the parent releases them independently. */
function world(tag: string) {
  const dir = mkdtempSync(join(tmpdir(), `abdo-own-${tag}-`))
  scratch.push(dir)
  const db = join(dir, "journal.sqlite")
  new SqliteEventStore(db).close() // the HOST creates the store; children attach (WAL lesson)
  const log = join(dir, "results.jsonl")
  writeFileSync(log, "", "utf8")
  return { dir, db, log, barrierOf: (me: string) => join(dir, `barrier-${me}`) }
}

function spawnChild(w: ReturnType<typeof world>, me: string, extra: string[] = []) {
  return Bun.spawn([process.execPath, FIXTURE, "--db", w.db, "--log", w.log, "--barrier", w.barrierOf(me), "--me", me, "--peers", "2", ...extra], {
    env: { ...process.env, ABDO_HARNESS_QUEUE: queueDir() },
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function expectChildOk(p: ReturnType<typeof spawnChild>, log: string) {
  const code = await p.exited
  if (code !== 0) {
    throw new Error(`child exited ${code}\nstderr: ${(await new Response(p.stderr).text()).slice(0, 800)}\nlog: ${existsSync(log) ? readFileSync(log, "utf8").slice(0, 800) : "(none)"}`)
  }
}

const readResults = (log: string): ChildResult[] =>
  readFileSync(log, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ChildResult)

const seqsOf = (events: Awaited<ReturnType<typeof rootEvents>>, pick: (e: (typeof events)[number]) => boolean) => events.filter(pick).map((e) => Number(e.sequence))

describe.skipIf(!READY)("MS1 P6 XP-07/XP-11 - execution-root ownership across a live mid-staging peer", () => {
  beforeAll(async () => {
    const kf = await runUnelevated(["known-folder", "--id", "ProgramData"])
    hostSid = String(kf.hostUserSid ?? "")
    programData = String(kf.lexicalPath ?? "")
    rootPath = join(programData, "Abdo", "Execution", "v1", sidToDirName(hostSid))
    stagingParent = join(programData, "Abdo", "Execution", STAGING_DIR)
    expect(kf.elevated).toBe(false)
  })

  test("XP-07: the peer of a host parked mid-staging publishes; the parked host loses atomically and verifies - no refusal, nothing adopted", async () => {
    wipe()
    const w = world("xp07")
    await runUnelevated(["known-folder", "--id", "ProgramData"]) // warm the shared server

    const a = spawnChild(w, "a", ["--pause-at", "after_staging_reconciled"])
    const b = spawnChild(w, "b")

    // ── both parked at their start barriers; identities read while both alive.
    expect(await waitForFile(join(w.barrierOf("a"), "bootstrap.a"))).toBe(true)
    expect(await waitForFile(join(w.barrierOf("b"), "bootstrap.b"))).toBe(true)
    const identities = await osIdentities([a.pid, b.pid])
    expect(new Set(identities.map((i) => `${i.pid}@${i.created}`)).size).toBe(2)

    // ── release ONLY A; it stages and parks INSIDE the bootstrap, mid-staging.
    await barrier(w.barrierOf("a"), "bootstrap", "parent", 2)
    expect(await waitForFile(join(w.barrierOf("a"), "pause.a"))).toBe(true)

    // ── the mid-staging window, measured: A's private staging is the only one,
    //    it is owned by A's OS identity, and the FINAL PATH DOES NOT EXIST — no
    //    partially initialized root is ever visible where the root belongs.
    const staged = stagingDirs()
    expect(staged).toHaveLength(1)
    const aStagingPath = join(stagingParent, staged[0]!)
    const aOwner = readStagingOwner(join(aStagingPath, STAGING_OWNER_NAME))
    expect(aOwner?.pid).toBe(a.pid)
    expect(aOwner?.hostSid.toLowerCase()).toBe(hostSid.toLowerCase())
    const aOwnerBytes = readFileSync(join(aStagingPath, STAGING_OWNER_NAME), "utf8")
    expect(existsSync(rootPath)).toBe(false)
    const midEvents = await rootEvents(w.db)
    expect(midEvents.map((e) => e.type)).toEqual([
      RootEvents.Requested,
      RootEvents.Inspected,
      RootEvents.StagingRequested,
      RootEvents.StagingCreated,
      RootEvents.Rebaselined,
      RootEvents.StagingProtected,
      RootEvents.StagingMarked,
      RootEvents.StagingReconciled,
    ])

    // ── with A provably parked, release B and let it run to COMPLETION.
    await barrier(w.barrierOf("b"), "bootstrap", "parent", 2)
    await expectChildOk(b, w.log)

    // ── B published; and A's live foreign staging was NEITHER ADOPTED NOR
    //    DELETED — it survives B's entire bootstrap byte-identical.
    expect(existsSync(join(rootPath, MARKER_NAME))).toBe(true)
    expect(existsSync(aStagingPath)).toBe(true)
    expect(readFileSync(join(aStagingPath, STAGING_OWNER_NAME), "utf8")).toBe(aOwnerBytes)

    // ── resume A: it must lose the rename atomically and VERIFY B's root.
    writeFileSync(join(w.barrierOf("a"), "resume.a"), String(Date.now()), "utf8")
    await expectChildOk(a, w.log)

    const byMe = Object.fromEntries(readResults(w.log).map((r) => [r.me, r]))
    const A = byMe.a!
    const B = byMe.b!
    for (const r of [A, B]) expect(r.ok, `worker ${r.me} failed: ${String(r.reasonCode ?? r.error)} ${String(r.detail ?? "")}`).toBe(true)

    // ── THE CLAIM: exactly one publisher (B), one verifier (A), no refusal.
    expect(B.publishedByUs).toBe(true)
    expect(A.publishedByUs).toBe(false)
    expect(A.observedExistingVerified).toBe(true)
    expect([A.pid, B.pid].sort((x, y) => x - y)).toEqual(identities.map((i) => i.pid).sort((x, y) => x - y))
    expect(A.bootstrapId).not.toBe(B.bootstrapId)
    expect(String(A.stagingPath).toLowerCase()).toBe(aStagingPath.toLowerCase())

    // ── one root, B's root: agreement on identity, marker, DACL, creation time.
    expect(String(A.rootPath).toLowerCase()).toBe(rootPath.toLowerCase())
    expect(String(B.rootPath).toLowerCase()).toBe(rootPath.toLowerCase())
    expect(A.fileId).toBe(B.fileId)
    expect(A.markerHash).toBe(B.markerHash)
    expect(A.daclHash).toBe(B.daclHash)
    expect(A.createdAt).toBe(B.createdAt)
    const onDisk = readMarker(join(rootPath, MARKER_NAME))
    expect(onDisk && markerHashOf(onDisk)).toBe(B.markerHash!)
    expect(onDisk?.ownerSid.toLowerCase()).toBe(hostSid.toLowerCase())
    expect(String(runDirect(["inspect-dir", "--path", rootPath]).pathFileId ?? "")).toBe(B.fileId!)
    expect(isProtectedOwnerOnlyDacl(String(runDirect(["inspect-acl", "--path", rootPath]).sddl ?? ""), hostSid)).toBe(true)

    // ── A's losing staging was discarded — ITS OWN, and nothing else remains.
    expect(stagingDirs()).toEqual([])

    // ── the journal: 25 events, gapless, and the deterministic SANDWICH — A's
    //    8 pre-pause events, then B's complete 13-event publisher trace, then
    //    A's 4 post-resume events. One StagingDiscarded (A's own, lost race),
    //    no Failed, no ownership conflict anywhere in this interleaving.
    const events = await rootEvents(w.db)
    expect(events.map((e) => Number(e.sequence))).toEqual(events.map((_, i) => i))
    expect(events).toHaveLength(25)
    const aSeqs = seqsOf(events, (e) => (e.data as { bootstrapId?: string }).bootstrapId === A.bootstrapId)
    const bSeqs = seqsOf(events, (e) => (e.data as { bootstrapId?: string }).bootstrapId === B.bootstrapId)
    expect(aSeqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 21, 22, 23, 24])
    expect(bSeqs).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
    const aTrace = events.filter((e) => (e.data as { bootstrapId?: string }).bootstrapId === A.bootstrapId).map((e) => e.type)
    const bTrace = events.filter((e) => (e.data as { bootstrapId?: string }).bootstrapId === B.bootstrapId).map((e) => e.type)
    expect(aTrace).toEqual([
      RootEvents.Requested,
      RootEvents.Inspected,
      RootEvents.StagingRequested,
      RootEvents.StagingCreated,
      RootEvents.Rebaselined,
      RootEvents.StagingProtected,
      RootEvents.StagingMarked,
      RootEvents.StagingReconciled,
      RootEvents.PublishRequested,
      RootEvents.StagingDiscarded,
      RootEvents.VerifiedExisting,
      RootEvents.Ready,
    ])
    expect(bTrace).toEqual([
      RootEvents.Requested,
      RootEvents.Inspected,
      RootEvents.StagingRequested,
      RootEvents.StagingCreated,
      RootEvents.Rebaselined,
      RootEvents.StagingProtected,
      RootEvents.StagingMarked,
      RootEvents.StagingReconciled,
      RootEvents.PublishRequested,
      RootEvents.Published,
      RootEvents.MarkerWritten,
      RootEvents.Reconciled,
      RootEvents.Ready,
    ])
    expect(events.map((e) => e.type)).not.toContain(RootEvents.Failed)
    const aDiscard = events.find((e) => e.type === RootEvents.StagingDiscarded)!
    expect((aDiscard.data as { reasonCode?: string }).reasonCode).toBe("publish_lost_race")
    const aReady = events.filter((e) => e.type === RootEvents.Ready).map((e) => (e.data as { publishedByUs?: boolean }).publishedByUs)
    expect(aReady.sort()).toEqual([false, true])

    console.log(`[gate] XP-07: pids ${identities.map((i) => `${i.pid}@${i.created}`).join(", ")} - A parked mid-staging (8 events, root absent), B published over the live foreign staging without touching it, A lost atomically and verified - 1 Published, 1 StagingDiscarded(publish_lost_race), 0 Failed`)
  }, T)

  test("XP-11: the publish-race loser with a DIFFERENT profileInventory hash is refused execution_root_ownership_conflict, and the winner's root is untouched", async () => {
    wipe()
    const w = world("xp11")
    await runUnelevated(["known-folder", "--id", "ProgramData"]) // warm the shared server

    // B carries the CONFLICTING identity and parks mid-staging; A publishes.
    const b = spawnChild(w, "b", ["--inventory-hash", "hash-B", "--pause-at", "after_staging_reconciled"])
    const a = spawnChild(w, "a", ["--inventory-hash", "hash-A"])

    expect(await waitForFile(join(w.barrierOf("a"), "bootstrap.a"))).toBe(true)
    expect(await waitForFile(join(w.barrierOf("b"), "bootstrap.b"))).toBe(true)
    const identities = await osIdentities([a.pid, b.pid])
    expect(new Set(identities.map((i) => `${i.pid}@${i.created}`)).size).toBe(2)

    // ── release ONLY B; it stages under hash-B and parks before the rename.
    await barrier(w.barrierOf("b"), "bootstrap", "parent", 2)
    expect(await waitForFile(join(w.barrierOf("b"), "pause.b"))).toBe(true)
    const staged = stagingDirs()
    expect(staged).toHaveLength(1)
    const bStagingPath = join(stagingParent, staged[0]!)
    const bOwner = readStagingOwner(join(bStagingPath, STAGING_OWNER_NAME))
    expect(bOwner?.pid).toBe(b.pid)
    // The refused child logs no bootstrapId (only success lines carry one), so
    // B's durable identity is captured HERE, from its live staging owner file.
    const bId = bOwner!.bootstrapId
    expect(bId).toBeTruthy()
    expect(existsSync(rootPath)).toBe(false)

    // ── with B provably parked, A runs to COMPLETION and publishes hash-A.
    await barrier(w.barrierOf("a"), "bootstrap", "parent", 2)
    await expectChildOk(a, w.log)
    const aRes = readResults(w.log).find((r) => r.me === "a")!
    expect(aRes.ok, `publisher failed: ${String(aRes.reasonCode)} ${String(aRes.detail ?? "")}`).toBe(true)
    expect(aRes.publishedByUs).toBe(true)
    const publishedMarker = readMarker(join(rootPath, MARKER_NAME))
    expect(publishedMarker?.profileInventoryHash).toBe("hash-A")
    expect(publishedMarker && markerHashOf(publishedMarker)).toBe(aRes.markerHash!)
    // B's live staging survived A's bootstrap too — same law as XP-07.
    expect(existsSync(bStagingPath)).toBe(true)

    // ── resume B: it loses the rename, discards its OWN staging, and is then
    //    REFUSED at verification — the marker binds an inventory that is not
    //    B's. This is the one clause of verifyPublishedRoot nothing else tests.
    writeFileSync(join(w.barrierOf("b"), "resume.b"), String(Date.now()), "utf8")
    await expectChildOk(b, w.log)
    const bRes = readResults(w.log).find((r) => r.me === "b")!
    expect(bRes.ok).toBe(false)
    expect(bRes.reasonCode).toBe("execution_root_ownership_conflict")
    expect(String(bRes.detail)).toContain("different profile inventory")
    expect([aRes.pid, bRes.pid].sort((x, y) => x - y)).toEqual(identities.map((i) => i.pid).sort((x, y) => x - y))

    // ── THE REFUSAL MUTATED NOTHING: A's root is byte-identical — marker hash,
    //    file identity and the protected owner-only DACL all unchanged. No
    //    repair, no adoption, no overwrite; B's own staging is gone.
    const after = readMarker(join(rootPath, MARKER_NAME))
    expect(after && markerHashOf(after)).toBe(aRes.markerHash!)
    expect(after?.profileInventoryHash).toBe("hash-A")
    expect(String(runDirect(["inspect-dir", "--path", rootPath]).pathFileId ?? "")).toBe(aRes.fileId!)
    expect(isProtectedOwnerOnlyDacl(String(runDirect(["inspect-acl", "--path", rootPath]).sddl ?? ""), hostSid)).toBe(true)
    expect(stagingDirs()).toEqual([])

    // ── the journal: 24 events, gapless; B's pre-pause 8, A's complete 13-event
    //    publisher trace, then B's PublishRequested + StagingDiscarded and the
    //    terminal Failed carrying the EXACT production reasonCode. (The Failed
    //    event is emitted without a bootstrapId by production's fail path, so it
    //    is asserted by type, position and payload.)
    const events = await rootEvents(w.db)
    expect(events.map((e) => Number(e.sequence))).toEqual(events.map((_, i) => i))
    expect(events).toHaveLength(24)
    const aSeqs = seqsOf(events, (e) => (e.data as { bootstrapId?: string }).bootstrapId === aRes.bootstrapId)
    const bSeqs = seqsOf(events, (e) => (e.data as { bootstrapId?: string }).bootstrapId === bId)
    expect(bSeqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 21, 22])
    expect(aSeqs).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
    const bTrace = events.filter((e) => (e.data as { bootstrapId?: string }).bootstrapId === bId).map((e) => e.type)
    expect(bTrace).toEqual([
      RootEvents.Requested,
      RootEvents.Inspected,
      RootEvents.StagingRequested,
      RootEvents.StagingCreated,
      RootEvents.Rebaselined,
      RootEvents.StagingProtected,
      RootEvents.StagingMarked,
      RootEvents.StagingReconciled,
      RootEvents.PublishRequested,
      RootEvents.StagingDiscarded,
    ])
    const last = events[23]!
    expect(last.type).toBe(RootEvents.Failed)
    expect((last.data as { reasonCode?: string }).reasonCode).toBe("execution_root_ownership_conflict")
    const discard = events.find((e) => e.type === RootEvents.StagingDiscarded)!
    expect((discard.data as { reasonCode?: string }).reasonCode).toBe("publish_lost_race")
    expect(events.filter((e) => e.type === RootEvents.Published)).toHaveLength(1)
    expect(events.filter((e) => e.type === RootEvents.Ready)).toHaveLength(1)
    expect((events.find((e) => e.type === RootEvents.Ready)!.data as { publishedByUs?: boolean }).publishedByUs).toBe(true)

    console.log(`[gate] XP-11: pids ${identities.map((i) => `${i.pid}@${i.created}`).join(", ")} - hash-A published, hash-B loser refused execution_root_ownership_conflict at verification; winner's marker/fileId/DACL byte-identical; 1 Published, 1 StagingDiscarded, 1 Failed`)
  }, T)
})
