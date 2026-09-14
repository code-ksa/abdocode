/**
 * CL-16A3-B2B-ROOT-FIX §3 + §4 + §7 — real kills with DISTINCT proofs, staging
 * recovery that survives pid reuse, and a measurement server the kill cannot take
 * with it.
 *
 * The previous matrix ended `…,7,7,7`: the last three points shared an event
 * count and so proved nothing separately. Every point here carries its own
 * signature — the exact OS state AND the exact set of events that must be present
 * and absent — so no two points can pass each other's assertions.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RIGHTS_MODEL_VERSION } from "@abdo/tools/windows-acl-matrix"
import {
  bootstrapExecutionRoot,
  isProtectedOwnerOnlyDacl,
  liveBootstrapIds,
  MARKER_NAME,
  readMarker,
  readStagingOwner,
  RootEvents,
  sidToDirName,
  STAGING_DIR,
  STAGING_OWNER_NAME,
  sweepNeedsIntervention,
  sweepStaging,
  type RootDeps,
  type StagingOwner,
} from "../src/execution-root"
import { REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import { harnessHelperRunner, helperBinaryHash, helperBuilt, queueDir, runDirect, runUnelevated } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const T = 300_000
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"

let hostSid = ""
let programData = ""
let rootPath = ""
let stagingParent = ""
const scratch: string[] = []

const inventory = { complete: true, hash: "test-inventory", roots: [{ path: process.env.USERPROFILE ?? "C:\\Users\\nobody" }] }

function deps(store: SqliteEventStore, over: Partial<RootDeps> = {}): RootDeps {
  return {
    store,
    helper: harnessHelperRunner(),
    helperProtocol: REQUIRED_PROTOCOL_VERSION,
    helperHash: helperBinaryHash(),
    profileInventory: inventory,
    rightsModelVersion: RIGHTS_MODEL_VERSION,
    ...over,
  }
}

function freshStore(tag: string): SqliteEventStore {
  const dir = mkdtempSync(join(tmpdir(), `abdo-rootx-${tag}-`))
  scratch.push(dir)
  return new SqliteEventStore(join(dir, "journal.sqlite"))
}

const typesOf = async (store: SqliteEventStore) => (await store.read("project", "winiso:execution-root")).map((e) => e.type)
const wipe = () => rmSync(join(programData, "Abdo"), { recursive: true, force: true })

// MODULE SCOPE, deliberately. Registered inside the first `describe` it runs when
// THAT block finishes, so every later describe's scratch directory was left
// behind. Here it runs after the whole file.
afterAll(async () => {
  try {
    wipe()
  } catch {
    /* best effort */
  }
  // Each directory gets its own bounded retry: one straggler's EBUSY (measured
  // in qual-1: a leaked child's open journal) must not abandon the rest. A
  // directory that stays locked after the retries still FAILS the hook — the
  // guard localizes the failure, it does not silence it.
  const stuck: string[] = []
  for (const d of scratch) {
    let removed = false
    for (let attempt = 0; attempt < 5 && !removed; attempt++) {
      try {
        rmSync(d, { recursive: true, force: true })
        removed = true
      } catch {
        await Bun.sleep(250)
      }
    }
    if (!removed && existsSync(d)) stuck.push(d)
  }
  if (stuck.length) throw new Error(`scratch dirs still locked after bounded retries: ${stuck.join(", ")}`)
})

const stagingDirs = (): string[] => {
  try {
    return readdirSync(stagingParent)
  } catch {
    return []
  }
}

/** Asked of the OS, because "we killed it" is not an answer. */
function processGone(pid: number): boolean {
  const p = Bun.spawnSync([PS, "-NoProfile", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'ALIVE' } else { 'GONE' }`], { stdout: "pipe", stderr: "pipe" })
  return p.stdout.toString().trim() === "GONE"
}

function hardKill(pid: number): void {
  // /F no politeness, /T the whole tree: no exit hook, no flush, no unwinding.
  Bun.spawnSync(["C:\\Windows\\System32\\taskkill.exe", "/PID", String(pid), "/F", "/T"], { stdout: "ignore", stderr: "ignore" })
}

/**
 * §7 — the measurement server must survive the kill.
 *
 * It is started by `explorer.exe`, so it is NOT a descendant of this test process
 * and NOT a descendant of any crash child; `taskkill /T` on the child therefore
 * cannot reach it. This function asserts that rather than assuming it, and any
 * loss is reported as an explicit HARNESS failure — never absorbed into a retry
 * of the thing under test.
 */
async function serverStillAnswering(): Promise<boolean> {
  const r = await runUnelevated(["known-folder", "--id", "ProgramData"])
  return !(r.ok === false && r.stage === "harness")
}

describe.skipIf(!READY)("CL-16A3-B2B-ROOT-FIX section 4 - a real kill at every point, each proved apart", () => {
  const FIXTURE = join(import.meta.dir, "fixtures", "root-crash-child.ts")

  beforeAll(async () => {
    const kf = await runUnelevated(["known-folder", "--id", "ProgramData"])
    hostSid = String(kf.hostUserSid ?? "")
    programData = String(kf.lexicalPath ?? "")
    rootPath = join(programData, "Abdo", "Execution", "v1", sidToDirName(hostSid))
    stagingParent = join(programData, "Abdo", "Execution", STAGING_DIR)
    expect(kf.elevated).toBe(false)
  })

  /**
   * The signature of each point: what the OS must show, and which events must be
   * present and absent. `finalMarker` and `stagingState` are what make the last
   * three points — which the old matrix could not separate — distinct.
   */
  const POINTS: {
    point: string
    finalExists: boolean
    finalMarker: boolean
    staging: "absent" | "unprotected" | "protected_unmarked" | "marked" | "consumed"
    present: string[]
    absent: string[]
  }[] = [
    { point: "after_root_intent", finalExists: false, finalMarker: false, staging: "absent", present: [RootEvents.Requested], absent: [RootEvents.Inspected, RootEvents.StagingCreated] },
    { point: "after_inspected", finalExists: false, finalMarker: false, staging: "absent", present: [RootEvents.Requested, RootEvents.Inspected], absent: [RootEvents.StagingRequested, RootEvents.StagingCreated] },
    { point: "after_staging_created", finalExists: false, finalMarker: false, staging: "unprotected", present: [RootEvents.StagingCreated], absent: [RootEvents.StagingProtected, RootEvents.StagingMarked] },
    { point: "after_staging_protected", finalExists: false, finalMarker: false, staging: "protected_unmarked", present: [RootEvents.StagingProtected], absent: [RootEvents.StagingMarked, RootEvents.StagingReconciled] },
    { point: "after_marker_temp", finalExists: false, finalMarker: false, staging: "marked", present: [RootEvents.StagingMarked], absent: [RootEvents.StagingReconciled, RootEvents.PublishRequested] },
    { point: "after_staging_reconciled", finalExists: false, finalMarker: false, staging: "marked", present: [RootEvents.StagingReconciled], absent: [RootEvents.PublishRequested, RootEvents.Published] },
    { point: "after_atomic_rename", finalExists: true, finalMarker: true, staging: "consumed", present: [RootEvents.PublishRequested], absent: [RootEvents.Published, RootEvents.MarkerWritten, RootEvents.Ready] },
    { point: "after_marker_completion", finalExists: true, finalMarker: true, staging: "consumed", present: [RootEvents.Published, RootEvents.MarkerWritten], absent: [RootEvents.Reconciled, RootEvents.Ready] },
    { point: "before_ready", finalExists: true, finalMarker: true, staging: "consumed", present: [RootEvents.Reconciled], absent: [RootEvents.Ready] },
  ]

  for (const sig of POINTS) {
    test(`killed at ${sig.point}: its own OS state and its own events`, async () => {
      wipe()
      const dir = mkdtempSync(join(tmpdir(), "abdo-rootcrash-"))
      scratch.push(dir)
      const db = join(dir, "journal.sqlite")
      new SqliteEventStore(db).close() // the parent creates it; the child attaches
      const marker = join(dir, "reached.marker")
      expect(await serverStillAnswering(), "harness_failure: the server was not up before the child started").toBe(true)

      const child = Bun.spawn([process.execPath, FIXTURE, db, sig.point, marker], {
        env: { ...process.env, ABDO_HARNESS_QUEUE: queueDir() },
        stdout: "pipe",
        stderr: "pipe",
      })
      let reached = false
      for (let i = 0; i < 900 && !reached; i++) {
        if (existsSync(marker)) reached = true
        else if (existsSync(`${marker}.missed`) || existsSync(`${marker}.error`)) break
        else await Bun.sleep(100)
      }
      // From here until the kill, NO exit path may leak the child: qual-1 lost a
      // round to a parse throw that skipped the kill, leaving the child holding
      // its scratch dir and cascading into the cleanup hook. The kill is in a
      // finally, so a failed wait, parse or announce-assert still ends it.
      try {
        if (!reached) {
          const why = existsSync(`${marker}.error`) ? readFileSync(`${marker}.error`, "utf8") : existsSync(`${marker}.missed`) ? readFileSync(`${marker}.missed`, "utf8") : "no marker"
          throw new Error(`the child never reached ${sig.point}: ${why} / stderr: ${(await new Response(child.stderr).text()).slice(0, 500)}`)
        }
        // INDEPENDENT PROOF that the child stopped where this test intended.
        // The fixture now renames the marker into place, so existence implies
        // complete content; the bounded re-parse is defense in depth, not a
        // widened assertion — an unparseable marker still FAILS, 2s later.
        let announced: { stage: string; pid: number; path: string[] } | undefined
        for (let i = 0; announced === undefined; i++) {
          try {
            announced = JSON.parse(readFileSync(marker, "utf8")) as { stage: string; pid: number; path: string[] }
          } catch (e) {
            if (i >= 20) throw new Error(`the marker at ${sig.point} never became valid JSON: ${String(e)}`)
            await Bun.sleep(100)
          }
        }
        expect(announced.stage).toBe(sig.point)
        expect(announced.pid).toBe(child.pid)
        expect(announced.path[announced.path.length - 1]).toBe(sig.point)
      } finally {
        // ---- THE KILL. Everything after this depends only on what is on disk.
        hardKill(child.pid)
      }
      await Bun.sleep(400)
      expect(processGone(child.pid)).toBe(true)
      // §7: the shared measurement server is NOT a descendant of the crash child,
      // so `/T` cannot have taken it. Asserted, not assumed.
      expect(await serverStillAnswering(), "harness_failure: taskkill /T reached the measurement server").toBe(true)

      // ---- THE OS SIGNATURE of this point, and no other.
      expect(existsSync(rootPath), `final root at ${sig.point}`).toBe(sig.finalExists)
      expect(existsSync(join(rootPath, MARKER_NAME)), `final marker at ${sig.point}`).toBe(sig.finalMarker)
      const dirs = stagingDirs()
      if (sig.staging === "absent") expect(dirs).toEqual([])
      else if (sig.staging === "consumed") expect(dirs).toEqual([]) // the rename MOVED it
      else {
        expect(dirs).toHaveLength(1)
        const st = join(stagingParent, dirs[0]!)
        const owner = readStagingOwner(join(st, STAGING_OWNER_NAME))
        expect(owner?.pid).toBe(child.pid) // the staging names its dead owner
        expect(owner?.processStartTime).toMatch(/^\d+$/)
        const sddl = String(runDirect(["inspect-acl", "--path", st]).sddl ?? "")
        if (sig.staging === "unprotected") expect(isProtectedOwnerOnlyDacl(sddl, hostSid)).toBe(false)
        else expect(isProtectedOwnerOnlyDacl(sddl, hostSid)).toBe(true)
        expect(existsSync(join(st, MARKER_NAME))).toBe(sig.staging === "marked")
      }

      const store = new SqliteEventStore(db)
      try {
        // ---- THE EVENT SIGNATURE: present AND absent, so no two points match.
        const before = await typesOf(store)
        for (const t of sig.present) expect(before, `${sig.point} must have ${t}`).toContain(t)
        for (const t of sig.absent) expect(before, `${sig.point} must NOT have ${t}`).not.toContain(t)
        expect(before).not.toContain(RootEvents.Ready)

        // ---- STAGING RECOVERY: the dead owner's directory is swept, and the
        //      journal still showing it "in flight" does not keep it for ever.
        const live = await liveBootstrapIds(store)
        if (sig.staging !== "absent" && sig.staging !== "consumed") expect(live.size).toBe(1)
        const swept = await sweepStaging(deps(store), programData, hostSid, live)
        expect(sweepNeedsIntervention(swept), `deferred: ${JSON.stringify(swept)}`).toBe(false)
        expect(stagingDirs()).toEqual([])

        // ---- A re-run over the SAME journal converges, and never adopts.
        const res = await bootstrapExecutionRoot(deps(store))
        expect(res.ok, `re-run after ${sig.point} failed: ${res.ok ? "" : `${res.reasonCode}: ${res.detail}`}`).toBe(true)
        if (!res.ok) return
        // Points that got as far as publishing left a VALID root, so the re-run
        // verifies it; the earlier points had to publish one themselves.
        expect(res.publishedByUs).toBe(!sig.finalExists)
        expect(res.observedExistingVerified).toBe(sig.finalExists)
        expect((await typesOf(store)).filter((t) => t === RootEvents.Ready)).toHaveLength(1)

        expect(readMarker(join(rootPath, MARKER_NAME))?.ownerSid.toLowerCase()).toBe(hostSid.toLowerCase())
        expect(isProtectedOwnerOnlyDacl(String(runDirect(["inspect-acl", "--path", rootPath]).sddl ?? ""), hostSid)).toBe(true)
        expect(stagingDirs()).toEqual([])
        expect(readdirSync(rootPath).filter((f) => f.endsWith(".tmp"))).toEqual([])

        console.log(`[gate] ${sig.point}: events=${before.length} final=${sig.finalExists} staging=${sig.staging} swept=${swept.map((s) => s.reason).join("|") || "none"} -> ready(published=${res.publishedByUs})`)
      } finally {
        store.close()
      }
    }, T)
  }
})

describe.skipIf(!READY)("CL-16A3-B2B-ROOT-FIX section 3 - staging recovery is pid-reuse safe", () => {
  const plant = (tag: string, over: Partial<StagingOwner>): string => {
    const path = join(stagingParent, `plant-${tag}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(path, { recursive: true })
    runDirect(["protect-dir", "--path", path, "--owner-sid", hostSid, "--dacl-sddl", `D:P(A;OICI;FA;;;${hostSid})`])
    const owner: StagingOwner = {
      bootstrapId: `plant-${tag}`,
      operationId: `root-bootstrap:plant-${tag}`,
      pid: process.pid,
      processStartTime: "0",
      hostSid,
      stateEpoch: "epoch-0",
      createdAt: new Date().toISOString(),
      ...over,
    }
    writeFileSync(join(path, STAGING_OWNER_NAME), JSON.stringify(owner), "utf8")
    return path
  }

  /** This process's REAL creation time, so "alive" can be told from "pid reused". */
  const myStartTime = async (): Promise<string> => String((await runUnelevated(["inspect-process", "--pid", String(process.pid)])).startTime ?? "")

  test("a REUSED pid is not mistaken for a live owner", async () => {
    wipe()
    mkdirSync(stagingParent, { recursive: true })
    const real = await myStartTime()
    expect(real).toMatch(/^\d+$/)
    // Same pid as a process that is very much alive (this one), but a creation
    // time that does not match it: the owner is gone and the pid was recycled.
    const stale = plant("reused", { pid: process.pid, processStartTime: "1" })
    const live = plant("live", { pid: process.pid, processStartTime: real })

    const store = freshStore("pidreuse")
    try {
      const swept = await sweepStaging(deps(store), programData, hostSid, new Set())
      const byPath = new Map(swept.map((s) => [s.path.toLowerCase(), s]))
      expect(byPath.get(stale.toLowerCase())?.action).toBe("removed")
      expect(byPath.get(stale.toLowerCase())?.reason).toBe("owner_gone_pid_reused")
      expect(existsSync(stale)).toBe(false)
      // The LIVE one is untouched - the dangerous direction.
      expect(byPath.get(live.toLowerCase())?.action).toBe("kept_live")
      expect(existsSync(live)).toBe(true)
    } finally {
      store.close()
      wipe()
    }
  }, T)

  test("an unreadable owner file is DEFERRED, never deleted", async () => {
    wipe()
    mkdirSync(stagingParent, { recursive: true })
    const path = join(stagingParent, "no-owner-file")
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, "something.txt"), "x", "utf8")
    const store = freshStore("noowner")
    try {
      const swept = await sweepStaging(deps(store), programData, hostSid, new Set())
      expect(swept[0]?.action).toBe("deferred")
      expect(swept[0]?.reason).toBe("staging_owner_unreadable")
      expect(sweepNeedsIntervention(swept)).toBe(true)
      expect(existsSync(path)).toBe(true) // still there for a human
    } finally {
      store.close()
      wipe()
    }
  }, T)

  test("liveness the OS would not answer is DEFERRED, never guessed", async () => {
    wipe()
    mkdirSync(stagingParent, { recursive: true })
    const path = plant("unknown", { pid: 4242, processStartTime: "999" })
    const store = freshStore("unknownliveness")
    try {
      const blind = deps(store, {
        helper: async (inv) => (inv.argv[0] === "inspect-process" ? { ok: false, error: "the helper would not answer" } : harnessHelperRunner()(inv)),
      })
      const swept = await sweepStaging(blind, programData, hostSid, new Set())
      expect(swept[0]?.action).toBe("deferred")
      expect(swept[0]?.reason).toBe("staging_liveness_unknown")
      expect(sweepNeedsIntervention(swept)).toBe(true)
      expect(existsSync(path)).toBe(true)
    } finally {
      store.close()
      wipe()
    }
  }, T)

  test("another host's staging is left alone entirely", async () => {
    wipe()
    mkdirSync(stagingParent, { recursive: true })
    const path = plant("foreign", { hostSid: "S-1-5-21-9-9-9-1001" })
    const store = freshStore("foreignstaging")
    try {
      const swept = await sweepStaging(deps(store), programData, hostSid, new Set())
      expect(swept[0]?.action).toBe("kept_foreign")
      expect(existsSync(path)).toBe(true)
    } finally {
      store.close()
      wipe()
    }
  }, T)

  test("a staging whose owning process is ALIVE and in flight is kept", async () => {
    wipe()
    mkdirSync(stagingParent, { recursive: true })
    const real = await myStartTime()
    const path = plant("inflight", { pid: process.pid, processStartTime: real, bootstrapId: "in-flight-id" })
    const store = freshStore("inflight")
    try {
      const swept = await sweepStaging(deps(store), programData, hostSid, new Set(["in-flight-id"]))
      expect(swept[0]?.action).toBe("kept_live")
      expect(swept[0]?.reason).toBe("owning_process_alive_and_in_flight")
      expect(existsSync(path)).toBe(true)
    } finally {
      store.close()
      wipe()
    }
  }, T)
})
