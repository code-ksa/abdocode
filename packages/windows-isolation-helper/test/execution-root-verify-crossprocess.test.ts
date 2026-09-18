/**
 * MS1 P6 slice S3 — XP-01: VERIFY-EXISTING EXECUTION ROOT, ACROSS REAL OS PROCESSES.
 *
 * THE GAP THIS CLOSES. C-01 (`execution-root-concurrency.test.ts`) proves the
 * FIRST-EVER bootstrap under contention: one publisher, the rest verify. What it
 * never exercises is the steady state every later host lives in — the root
 * already exists, and two hosts enter the VERIFY-EXISTING path
 * (`execution-root.ts` step 4) at the same instant. That path is where Law 1
 * ("nothing existing is adopted, repaired or overwritten") has to hold with no
 * publication race to hide behind: not one byte may be written, by either host.
 *
 * WHAT IS ACTUALLY BEING PROVED, stated precisely so the assertions can be
 * checked against it:
 *
 *   1. Two hosts calling `bootstrapExecutionRoot` against an already-published
 *      root BOTH succeed, idempotently. There is no creator/adopter split, no
 *      winner, no refusal — production has no such contract on this path and
 *      none is imposed here.
 *   2. Neither host publishes, stages, or mutates anything: both report
 *      `observedExistingVerified === true` and `publishedByUs === false`, both
 *      bind the SETUP publisher's marker (hash, fileId, createdAt), the staging
 *      parent stays empty, and the DACL is byte-identical to what the marker
 *      recorded at publication. There is no reference count in this contract —
 *      nothing increments, so the proof is that nothing CHANGED.
 *   3. Each host's journal trace is exactly
 *      [Requested, Inspected, VerifiedExisting, Ready] — readiness is derived
 *      from verification, never emitted ahead of it, so a partially initialized
 *      root can never be reported ready.
 *
 * The interleaving is forced by the qualified XP-03/XP-12 pattern: the children
 * park at a count-based file barrier with `--peers 3`, the parent measures their
 * OS identities from Win32_Process WHILE both are provably alive and parked,
 * asserts the shared journal is still EMPTY (nothing bootstrapped early), and
 * only then joins the barrier as the third participant. Release is a parent
 * decision, not a timing accident, and there is no sleep-as-synchronization
 * anywhere — every wait has an exit condition and a bounded deadline.
 *
 * The children run the UNMODIFIED production fixture
 * (`fixtures/root-bootstrap-child.ts`), which calls the real
 * `bootstrapExecutionRoot` with the real helper over one real SQLite file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RIGHTS_MODEL_VERSION } from "@abdo/tools/windows-acl-matrix"
import { bootstrapExecutionRoot, MARKER_NAME, RootEvents, STAGING_DIR, isProtectedOwnerOnlyDacl, readMarker, sidToDirName } from "../src/execution-root"
import { REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import { barrier, waitForFile } from "./barrier"
import { harnessHelperRunner, helperBinaryHash, helperBuilt, queueDir, runDirect, runUnelevated } from "./harness"

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

const inventory = { complete: true, hash: "test-inventory", roots: [{ path: process.env.USERPROFILE ?? "C:\\Users\\nobody" }] }

const wipe = () => rmSync(join(programData, "Abdo"), { recursive: true, force: true })

const stagingDirs = (): string[] => {
  try {
    return readdirSync(stagingParent)
  } catch {
    return []
  }
}

/** The root journal as it really landed on disk, re-read by a fresh reader. */
async function rootEvents(db: string) {
  const store = new SqliteEventStore(db)
  try {
    return await store.read("project", AGG)
  } finally {
    store.close()
  }
}

// MODULE SCOPE, deliberately — mirrors execution-root-concurrency.test.ts: runs
// after the whole file, so the machine root and every scratch dir are cleaned up.
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
 * still alive — they are parked at the barrier waiting for this parent to
 * arrive, so this is not a race against a process that may already have exited.
 *
 * A pid alone is not an identity (Windows reuses them); the creation time is
 * what makes "these were two different processes" a fact rather than an
 * inference. Same helper as `run-lease-fencing-crossprocess.test.ts`.
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

describe.skipIf(!READY)("MS1 P6 XP-01 - two processes verify an existing execution root", () => {
  beforeAll(async () => {
    const kf = await runUnelevated(["known-folder", "--id", "ProgramData"])
    hostSid = String(kf.hostUserSid ?? "")
    programData = String(kf.lexicalPath ?? "")
    rootPath = join(programData, "Abdo", "Execution", "v1", sidToDirName(hostSid))
    stagingParent = join(programData, "Abdo", "Execution", STAGING_DIR)
    expect(kf.elevated).toBe(false)
  })

  test("both hosts verify the SAME published root; neither publishes, stages or repairs", async () => {
    wipe()

    // ── PRECONDITION: a PRIOR RUN publishes the root through the real production
    //    path (the one C-03 proves), on its own store so the contention journal
    //    below holds ONLY the two contenders' events. What it returns is the
    //    ground truth the verifiers must be measured against.
    const setupDir = mkdtempSync(join(tmpdir(), "abdo-xp01-setup-"))
    scratch.push(setupDir)
    const setupStore = new SqliteEventStore(join(setupDir, "journal.sqlite"))
    let publisher: { markerHash: string; fileId: string; daclHash: string; createdAt: string }
    try {
      const prior = await bootstrapExecutionRoot({
        store: setupStore,
        helper: harnessHelperRunner(),
        helperProtocol: REQUIRED_PROTOCOL_VERSION,
        helperHash: helperBinaryHash(),
        profileInventory: inventory,
        rightsModelVersion: RIGHTS_MODEL_VERSION,
      })
      expect(prior.ok, prior.ok ? "" : `${prior.reasonCode}: ${prior.detail}`).toBe(true)
      if (!prior.ok) throw new Error("unreachable")
      expect(prior.publishedByUs).toBe(true)
      publisher = { markerHash: prior.markerHash, fileId: prior.fileId, daclHash: prior.daclHash, createdAt: prior.marker.createdAt }
    } finally {
      setupStore.close()
    }

    // ── the contention world: one shared SQLite file, created by the HOST before
    //    any child attaches (several processes racing the WAL conversion is the
    //    lesson already recorded in lease-crossprocess.test.ts).
    const dir = mkdtempSync(join(tmpdir(), "abdo-xp01-"))
    scratch.push(dir)
    const db = join(dir, "journal.sqlite")
    new SqliteEventStore(db).close()
    const log = join(dir, "results.jsonl")
    writeFileSync(log, "", "utf8")
    const bar = join(dir, "barrier")
    await runUnelevated(["known-folder", "--id", "ProgramData"]) // warm the shared server

    // ── `--peers 3`: the two children arrive and PARK; the parent is the third
    //    participant, so release happens exactly when the parent decides.
    const procs = ["a", "b"].map((me) =>
      Bun.spawn([process.execPath, FIXTURE, "--db", db, "--log", log, "--barrier", bar, "--me", me, "--peers", "3"], {
        env: { ...process.env, ABDO_HARNESS_QUEUE: queueDir() },
        stdout: "pipe",
        stderr: "pipe",
      }),
    )

    // ── both children provably parked (their arrival files exist, the barrier
    //    still holds at 2 of 3) …
    expect(await waitForFile(join(bar, "bootstrap.a"))).toBe(true)
    expect(await waitForFile(join(bar, "bootstrap.b"))).toBe(true)
    const arrivedAt = { a: Number(readFileSync(join(bar, "bootstrap.a"), "utf8")), b: Number(readFileSync(join(bar, "bootstrap.b"), "utf8")) }

    // ── … so their OS identities are read while BOTH are alive, concurrently.
    const identities = await osIdentities(procs.map((p) => p.pid))
    expect(identities).toHaveLength(2)
    expect(new Set(identities.map((i) => i.pid)).size).toBe(2)
    expect(new Set(identities.map((i) => `${i.pid}@${i.created}`)).size).toBe(2)

    // ── NON-VACUITY OF THE RELEASE: while they are parked, NOTHING has been
    //    bootstrapped — zero events in the shared journal, zero result lines. If
    //    the barrier ever stopped blocking, dual success could come from
    //    sequential execution — a pass for the wrong reason.
    expect(await rootEvents(db)).toHaveLength(0)
    expect(readFileSync(log, "utf8")).toBe("")

    // ── the deterministic release: the parent arrives, all three are present,
    //    and only now may either child enter `bootstrapExecutionRoot`.
    const releasedAt = Date.now()
    await barrier(bar, "bootstrap", "parent", 3)

    for (const p of procs) {
      const code = await p.exited
      if (code !== 0) {
        throw new Error(`worker exited ${code}\nstderr: ${(await new Response(p.stderr).text()).slice(0, 600)}\nlog: ${existsSync(log) ? readFileSync(log, "utf8").slice(0, 600) : "(none)"}`)
      }
    }

    const lines = readFileSync(log, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    for (const l of lines) expect(l.ok, `worker ${String(l.me)} failed: ${String(l.reasonCode ?? l.error)} ${String(l.detail ?? "")}`).toBe(true)

    // ── THE CLAIM: idempotent dual success. NOBODY published — there is no
    //    creator here, no adopter, no winner and no refusal — and BOTH verified.
    expect(lines.filter((l) => l.publishedByUs === true)).toHaveLength(0)
    expect(lines.filter((l) => l.observedExistingVerified === true)).toHaveLength(2)

    // ── the result lines came from exactly the two processes measured alive.
    expect(lines.map((l) => Number(l.pid)).sort((x, y) => x - y)).toEqual(identities.map((i) => i.pid).sort((x, y) => x - y))

    // ── two REAL attempts (distinct durable bootstrap identities), and the
    //    verify path staged NOTHING — production returns an empty stagingPath.
    expect(new Set(lines.map((l) => String(l.bootstrapId))).size).toBe(2)
    for (const l of lines) expect(l.stagingPath).toBe("")

    // ── both bound the PUBLISHER'S root, not merely the same one: path, file
    //    identity, marker, DACL and creation time all equal the setup
    //    publication's values. Nothing was rewritten by either verifier.
    expect(new Set(lines.map((l) => String(l.rootPath).toLowerCase()))).toEqual(new Set([rootPath.toLowerCase()]))
    expect(new Set(lines.map((l) => String(l.fileId)))).toEqual(new Set([publisher.fileId]))
    expect(new Set(lines.map((l) => String(l.markerHash)))).toEqual(new Set([publisher.markerHash]))
    expect(new Set(lines.map((l) => String(l.daclHash)))).toEqual(new Set([publisher.daclHash]))
    expect(new Set(lines.map((l) => String(l.createdAt)))).toEqual(new Set([publisher.createdAt]))

    // ── the world: no staging residue, one marker owned by us, and the DACL as
    //    read back from the OS is still the protected owner-only form the marker
    //    recorded at publication (there is no refcount to change; the proof is
    //    that nothing changed).
    expect(stagingDirs()).toEqual([])
    const marker = readMarker(join(rootPath, MARKER_NAME))
    expect(marker?.ownerSid.toLowerCase()).toBe(hostSid.toLowerCase())
    expect(marker?.protectedDaclHash).toBe(publisher.daclHash)
    expect(isProtectedOwnerOnlyDacl(String(runDirect(["inspect-acl", "--path", rootPath]).sddl ?? ""), hostSid)).toBe(true)

    // ── the journal, re-read by a process that was not in the race: exactly the
    //    two verify traces, gapless, correctly ordered, and READY IS NEVER
    //    EMITTED BEFORE VERIFICATION — the order below is what makes "a partially
    //    initialized root is never exposed as ready" a measured fact.
    const events = await rootEvents(db)
    expect(events.map((e) => Number(e.sequence))).toEqual(events.map((_, i) => i))
    const types = events.map((e) => e.type)
    expect(types.filter((t) => t === RootEvents.Requested)).toHaveLength(2)
    expect(types.filter((t) => t === RootEvents.Inspected)).toHaveLength(2)
    expect(types.filter((t) => t === RootEvents.VerifiedExisting)).toHaveLength(2)
    expect(types.filter((t) => t === RootEvents.Ready)).toHaveLength(2)
    expect(types).toHaveLength(8) // and NOTHING else: no publish, no staging, no discard, no failure
    for (const l of lines) {
      const mine = events.filter((e) => (e.data as { bootstrapId?: string }).bootstrapId === l.bootstrapId)
      expect(mine.map((e) => e.type)).toEqual([RootEvents.Requested, RootEvents.Inspected, RootEvents.VerifiedExisting, RootEvents.Ready])
    }
    for (const e of events.filter((x) => x.type === RootEvents.Ready)) {
      expect((e.data as { publishedByUs?: boolean }).publishedByUs).toBe(false)
    }

    console.log(
      `[gate] XP-01: pids ${identities.map((i) => `${i.pid}@${i.created}`).join(", ")} - parked at ${arrivedAt.a}/${arrivedAt.b}, released ${releasedAt} - both observedExistingVerified, 0 published, 0 staged, journal 2x[requested,inspected,verified_existing,ready]`,
    )
  }, T)
})
