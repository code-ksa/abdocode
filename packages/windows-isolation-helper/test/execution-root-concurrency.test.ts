/**
 * CL-16A3-B2B-ROOT-FIX §8 + §6 — contended publication with no adoption, and the
 * two production integrity paths.
 *
 * §8 runs three real processes over one SQLite file, released by a barrier, so
 * the first-ever bootstrap is genuinely contended. Exactly one may publish; the
 * others must verify the published root and throw their own work away.
 *
 * §6 proves the two production paths separately: a medium-integrity host that
 * succeeds and reports itself honestly, and an elevated host that refuses before
 * touching anything. `explorer.exe` and the linked token belong to the
 * MEASUREMENT harness — they exist to create a medium-integrity context for
 * tests — and a test here asserts they are absent from the production path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RIGHTS_MODEL_VERSION } from "@abdo/tools/windows-acl-matrix"
import { bootstrapExecutionRoot, isProtectedOwnerOnlyDacl, MARKER_NAME, readMarker, RootEvents, sidToDirName, STAGING_DIR, type RootDeps } from "../src/execution-root"
import { REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import { harnessHelperRunner, helperBinaryHash, helperBuilt, queueDir, runDirect, runUnelevated } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const T = 300_000

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
  const dir = mkdtempSync(join(tmpdir(), `abdo-conc-${tag}-`))
  scratch.push(dir)
  return new SqliteEventStore(join(dir, "journal.sqlite"))
}

const typesOf = async (store: SqliteEventStore) => (await store.read("project", "winiso:execution-root")).map((e) => e.type)
const wipe = () => rmSync(join(programData, "Abdo"), { recursive: true, force: true })

// MODULE SCOPE, deliberately. Registered inside the first `describe` it runs when
// THAT block finishes, so every later describe's scratch directory was left
// behind. Here it runs after the whole file.
afterAll(() => {
  try {
    wipe()
  } catch {
    /* best effort */
  }
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

const stagingDirs = (): string[] => {
  try {
    return readdirSync(stagingParent)
  } catch {
    return []
  }
}

describe.skipIf(!READY)("CL-16A3-B2B-ROOT-FIX section 8 - three processes, one publication", () => {
  beforeAll(async () => {
    const kf = await runUnelevated(["known-folder", "--id", "ProgramData"])
    hostSid = String(kf.hostUserSid ?? "")
    programData = String(kf.lexicalPath ?? "")
    rootPath = join(programData, "Abdo", "Execution", "v1", sidToDirName(hostSid))
    stagingParent = join(programData, "Abdo", "Execution", STAGING_DIR)
    expect(kf.elevated).toBe(false)
  })

  test("exactly ONE publishes; the rest verify and discard their own staging", async () => {
    wipe()
    const dir = mkdtempSync(join(tmpdir(), "abdo-root-conc-"))
    scratch.push(dir)
    const db = join(dir, "journal.sqlite")
    new SqliteEventStore(db).close() // the HOST creates the store; workers attach
    const log = join(dir, "results.jsonl")
    writeFileSync(log, "", "utf8")
    const fixture = join(import.meta.dir, "fixtures", "root-bootstrap-child.ts")
    await runUnelevated(["known-folder", "--id", "ProgramData"]) // warm the shared server

    const procs = ["a", "b", "c"].map((me) =>
      Bun.spawn([process.execPath, fixture, "--db", db, "--log", log, "--barrier", join(dir, "barrier"), "--me", me, "--peers", "3"], {
        env: { ...process.env, ABDO_HARNESS_QUEUE: queueDir() },
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
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
    expect(lines).toHaveLength(3)
    for (const l of lines) expect(l.ok, `worker ${String(l.me)} failed: ${String(l.reasonCode ?? l.error)} ${String(l.detail ?? "")}`).toBe(true)

    // EXACTLY ONE published. The other two verified what it published.
    expect(lines.filter((l) => l.publishedByUs === true)).toHaveLength(1)
    expect(lines.filter((l) => l.observedExistingVerified === true)).toHaveLength(2)

    // Each process staged SEPARATELY - they did not share a staging directory.
    expect(new Set(lines.map((l) => String(l.bootstrapId))).size).toBe(3)
    expect(new Set(lines.map((l) => String(l.stagingPath).toLowerCase())).size).toBe(3)
    // Three DIFFERENT processes really did the work.
    expect(new Set(lines.map((l) => Number(l.pid))).size).toBe(3)

    // ONE root: everyone agrees on path, identity, marker, DACL - and on the
    // publisher's creation time, which proves the losers did not rewrite it.
    expect(new Set(lines.map((l) => String(l.rootPath).toLowerCase())).size).toBe(1)
    expect(new Set(lines.map((l) => String(l.fileId))).size).toBe(1)
    expect(new Set(lines.map((l) => String(l.markerHash))).size).toBe(1)
    expect(new Set(lines.map((l) => String(l.daclHash))).size).toBe(1)
    expect(new Set(lines.map((l) => String(l.createdAt))).size).toBe(1)

    // The losers' staging directories are GONE, not left as residue.
    expect(stagingDirs()).toEqual([])

    // The world holds exactly one marker, and it is ours and protected.
    expect(readMarker(join(rootPath, MARKER_NAME))?.ownerSid.toLowerCase()).toBe(hostSid.toLowerCase())
    expect(isProtectedOwnerOnlyDacl(String(runDirect(["inspect-acl", "--path", rootPath]).sddl ?? ""), hostSid)).toBe(true)

    const store = new SqliteEventStore(db)
    try {
      const types = await typesOf(store)
      // One publication, three readinesses, two discarded stagings, no failure.
      expect(types.filter((t) => t === RootEvents.Published)).toHaveLength(1)
      expect(types.filter((t) => t === RootEvents.Ready)).toHaveLength(3)
      expect(types.filter((t) => t === RootEvents.StagingDiscarded)).toHaveLength(2)
      expect(types).not.toContain(RootEvents.Failed)
    } finally {
      store.close()
    }
  }, T)

  test("an ATTACKER planting the final root between staging and rename wins nothing", async () => {
    wipe()
    const store = freshStore("attacker")
    const planted = "planted by someone who is not us"
    try {
      const res = await bootstrapExecutionRoot(
        deps(store, {
          onPoint: (p) => {
            if (p !== "after_staging_reconciled") return
            // The final path is free right up to this instant. Take it.
            runDirect(["create-dir", "--path", rootPath])
            writeFileSync(join(rootPath, "attacker.txt"), planted, "utf8")
          },
        }),
      )
      // The rename FAILED, and the planted directory did not become ours.
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reasonCode).toBe("execution_root_ownership_conflict")

      const types = await typesOf(store)
      expect(types).toContain(RootEvents.PublishRequested) // we did attempt it
      expect(types).not.toContain(RootEvents.Published) // and it did not succeed
      expect(types).not.toContain(RootEvents.Ready)
      expect(types).toContain(RootEvents.StagingDiscarded)

      // The planted resource is UNTOUCHED: same file, same contents, no marker
      // of ours, no DACL of ours.
      expect(readFileSync(join(rootPath, "attacker.txt"), "utf8")).toBe(planted)
      expect(existsSync(join(rootPath, MARKER_NAME))).toBe(false)
      expect(isProtectedOwnerOnlyDacl(String(runDirect(["inspect-acl", "--path", rootPath]).sddl ?? ""), hostSid)).toBe(false)
      // And our own staging is gone.
      expect(stagingDirs()).toEqual([])
    } finally {
      store.close()
      wipe()
    }
  }, T)
})

describe.skipIf(!READY)("CL-16A3-B2B-ROOT-FIX section 6 - the two production integrity paths", () => {
  test("MEDIUM integrity: the bootstrap succeeds and reports itself honestly", async () => {
    wipe()
    const self = await runUnelevated(["known-folder", "--id", "ProgramData"])
    expect(self.elevated).toBe(false)
    expect(self.integrity).toBe("medium")
    expect(Number(self.integrityRid)).toBe(0x2000)

    const store = freshStore("medium")
    try {
      const res = await bootstrapExecutionRoot(deps(store))
      expect(res.ok, res.ok ? "" : `${res.reasonCode}: ${res.detail}`).toBe(true)
      if (res.ok) expect(res.publishedByUs).toBe(true)
      expect(await typesOf(store)).toContain(RootEvents.Ready)
    } finally {
      store.close()
      wipe()
    }
  }, T)

  // ── A DETERMINISTIC POLICY PROOF, NOT A PROPERTY OF THE TERMINAL ──────────
  //
  // This test used to open with `expect(self.elevated).toBe(true)` — asserting
  // that the SHELL RUNNING THE SUITE was elevated. It therefore passed only from
  // an elevated terminal and failed outright at the medium integrity an
  // authoritative round requires, and it was one of the 14 failures in the RC2
  // round. The claim being tested is a property of the policy; the terminal is
  // irrelevant to it.
  //
  // The live elevated measurement still exists, in
  // `scripts/live-elevated-refusal.ts`, which refuses to run unless the host
  // really is elevated and so can never pass vacuously.
  test("B. POLICY: an elevated host is refused before any directory, DACL, marker or staging", async () => {
    wipe()
    // Real helper responses with ONE field changed. `bootstrapExecutionRoot` reads
    // elevation from the `known-folder` reply (`src/execution-root.ts:337` ->
    // `tokenElevated`), so flipping exactly that makes the refusal attributable to
    // the elevation policy and to nothing else.
    const elevatedHelper = async ({ argv }: { argv: readonly string[] }) => {
      const real = await runUnelevated(argv)
      return { ...real, elevated: true, integrity: "high", integrityRid: 12288 }
    }
    // The injected report really does represent an elevated, high-integrity host.
    const probe = await elevatedHelper({ argv: ["known-folder", "--id", "ProgramData"] })
    expect(probe.elevated).toBe(true)
    expect(probe.integrity).toBe("high")
    expect(probe.integrityRid).toBe(12288)

    const store = freshStore("elevated")
    try {
      const res = await bootstrapExecutionRoot(deps(store, { helper: elevatedHelper }))
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reasonCode).toBe("elevated_host_not_supported")
      // Nothing at all: no root, no staging, no ancestor, no event.
      expect(existsSync(join(programData, "Abdo"))).toBe(false)
      expect(stagingDirs()).toEqual([])
      expect(await typesOf(store)).toEqual([])
    } finally {
      store.close()
    }
  }, T)

  test("the PRODUCTION path contains no Explorer and no linked-token de-elevation", () => {
    // Those belong to the measurement harness, which uses them to create a
    // medium-integrity context for tests. If the bootstrap itself ever reached
    // for them it would be silently escaping the integrity level it was given,
    // which is the opposite of refusing.
    const production = readFileSync(join(import.meta.dir, "..", "src", "execution-root.ts"), "utf8").toLowerCase()
    for (const forbidden of ["explorer", "deelevate", "linked_token", "linkedtoken", "createprocesswithtoken", "runas"]) {
      expect(production, `production code must not reach for ${forbidden}`).not.toContain(forbidden)
    }
  })
})
