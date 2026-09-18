/**
 * CL-16A3-B2B-ROOT-FIX §5 — the FULL TOCTOU matrix.
 *
 * Every element the bootstrap rests on is inspected, then drifted, then the next
 * mutation is attempted. The requirement for all of them is identical: the
 * mutation does not start, nothing is overwritten, `ready` is never written, and
 * the external resource is untouched.
 *
 * Two kinds of drift, because neither alone is honest:
 *
 *   - OBSERVER drift covers every named element, including the ones that cannot
 *     be moved on demand on a live machine (a volume serial, a token's integrity
 *     RID, ProgramData's file id). It proves the comparison and the refusal path
 *     for each element by name.
 *   - REAL drift mutates the actual directory, DACL and marker on disk between
 *     the inspection and the use, and proves the same refusals against Windows
 *     rather than against a stub.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RIGHTS_MODEL_VERSION } from "@abdo/tools/windows-acl-matrix"
import { bootstrapExecutionRoot, MARKER_NAME, RootEvents, sidToDirName, STAGING_DIR, type RootDeps, type RootEvidence } from "../src/execution-root"
import { REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import { harnessHelperRunner, helperBinaryHash, helperBuilt, runDirect, runUnelevated } from "./harness"

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
  const dir = mkdtempSync(join(tmpdir(), `abdo-toctou-${tag}-`))
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

/** The drift to apply, one named element at a time. */
const ELEMENTS: { name: string; drift: (e: RootEvidence) => RootEvidence }[] = [
  { name: "programDataLexical", drift: (e) => ({ ...e, programDataLexical: "C:\\Elsewhere" }) },
  { name: "programDataFinal", drift: (e) => ({ ...e, programDataFinal: "\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\X" }) },
  { name: "programDataVolume", drift: (e) => ({ ...e, programDataVolume: "deadbeef" }) },
  { name: "programDataFileId", drift: (e) => ({ ...e, programDataFileId: "ffffffffffffffff" }) },
  { name: "programDataReparse", drift: (e) => ({ ...e, programDataReparse: true }) },
  { name: "hostSid", drift: (e) => ({ ...e, hostSid: "S-1-5-21-9-9-9-1001" }) },
  { name: "tokenIntegrity", drift: (e) => ({ ...e, tokenIntegrity: "high" }) },
  { name: "tokenIntegrityRid", drift: (e) => ({ ...e, tokenIntegrityRid: 0x3000 }) },
  { name: "tokenElevated", drift: (e) => ({ ...e, tokenElevated: true }) },
  { name: "ancestors[0]", drift: (e) => ({ ...e, ancestors: e.ancestors.map((a, i) => (i === 0 ? { ...a, fileId: "ffffffffffffffff" } : a)) }) },
  { name: "ancestors[0].isReparsePoint", drift: (e) => ({ ...e, ancestors: e.ancestors.map((a, i) => (i === 0 ? { ...a, isReparsePoint: true } : a)) }) },
  { name: "ancestor owner", drift: (e) => ({ ...e, ancestors: e.ancestors.map((a, i) => (i === 0 ? { ...a, ownerSid: "S-1-5-32-544" } : a)) }) },
  { name: "profileInventoryHash", drift: (e) => ({ ...e, profileInventoryHash: "a-different-inventory" }) },
  { name: "profileInventoryComplete", drift: (e) => ({ ...e, profileInventoryComplete: false }) },
  { name: "rightsModelVersion", drift: (e) => ({ ...e, rightsModelVersion: e.rightsModelVersion + 1 }) },
  { name: "rightsModelHash", drift: (e) => ({ ...e, rightsModelHash: "a-different-rights-model" }) },
  { name: "helperHash", drift: (e) => ({ ...e, helperHash: "0".repeat(64) }) },
  { name: "helperProtocol", drift: (e) => ({ ...e, helperProtocol: e.helperProtocol + 1 }) },
  { name: "stateEpoch", drift: (e) => ({ ...e, stateEpoch: "epoch-99" }) },
]

describe.skipIf(!READY)("CL-16A3-B2B-ROOT-FIX section 5 - every element, drifted between inspection and use", () => {
  beforeAll(async () => {
    const kf = await runUnelevated(["known-folder", "--id", "ProgramData"])
    hostSid = String(kf.hostUserSid ?? "")
    programData = String(kf.lexicalPath ?? "")
    rootPath = join(programData, "Abdo", "Execution", "v1", sidToDirName(hostSid))
    stagingParent = join(programData, "Abdo", "Execution", STAGING_DIR)
    expect(kf.elevated).toBe(false)
  })

  for (const el of ELEMENTS) {
    test(`${el.name} drifts before publication: stale_isolation_evidence, and nothing happens`, async () => {
      wipe()
      const store = freshStore(el.name.replace(/\W/g, ""))
      try {
        // Drift ONLY at the last check before the rename, so everything up to it
        // really did run: this is a genuine time-of-use gap, not an early exit.
        const res = await bootstrapExecutionRoot(deps(store, { onObserve: (stage, e) => (stage === "before_publish" ? el.drift(e) : e) }))
        expect(res.ok, "expected a refusal").toBe(false)
        if (!res.ok) {
          expect(res.reasonCode).toBe("stale_isolation_evidence")
          expect(res.detail).toContain(el.name.split("[")[0]!.split(" ")[0]!)
        }
        const types = await typesOf(store)
        // The mutation never started.
        expect(types).not.toContain(RootEvents.PublishRequested)
        expect(types).not.toContain(RootEvents.Published)
        expect(types).not.toContain(RootEvents.Ready)
        expect(types).toContain(RootEvents.Failed)
        // The external resource does not exist: nothing was published or left.
        expect(existsSync(rootPath)).toBe(false)
        // And the abandoned staging was discarded, not left as residue.
        expect(types).toContain(RootEvents.StagingDiscarded)
        expect(stagingDirs()).toEqual([])
      } finally {
        store.close()
      }
    }, T)
  }

  test("after an APPROVAL, the same drift is reported as a stale APPROVAL", async () => {
    wipe()
    const store = freshStore("approval")
    try {
      const res = await bootstrapExecutionRoot(
        deps(store, {
          approvalIssued: true,
          onObserve: (stage, e) => (stage === "before_publish" ? { ...e, stateEpoch: "epoch-99" } : e),
        }),
      )
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reasonCode).toBe("approval_snapshot_stale")
      const types = await typesOf(store)
      expect(types).not.toContain(RootEvents.Ready)
      expect(existsSync(rootPath)).toBe(false)
      expect(stagingDirs()).toEqual([])
    } finally {
      store.close()
    }
  }, T)

  test("NON-VACUITY: with no drift the very same path publishes", async () => {
    // Without this, a bootstrap that refused unconditionally would pass every
    // test above.
    wipe()
    const store = freshStore("nonvacuous")
    try {
      const res = await bootstrapExecutionRoot(deps(store, { onObserve: (_s, e) => e }))
      expect(res.ok, res.ok ? "" : `${res.reasonCode}: ${res.detail}`).toBe(true)
      if (res.ok) expect(res.publishedByUs).toBe(true)
      expect(await typesOf(store)).toContain(RootEvents.Ready)
    } finally {
      store.close()
      wipe()
    }
  }, T)
})

describe.skipIf(!READY)("CL-16A3-B2B-ROOT-FIX section 5 - REAL drift on disk between reconciliation and publication", () => {
  /** Drift the staging for real at the last moment, and prove the publish stopped. */
  const realDrift = async (tag: string, mutate: (stagingPath: string) => void, expectDetail: string) => {
    wipe()
    const store = freshStore(tag)
    try {
      const res = await bootstrapExecutionRoot(
        deps(store, {
          onPoint: (p) => {
            if (p !== "after_staging_reconciled") return
            const dirs = stagingDirs()
            expect(dirs).toHaveLength(1)
            mutate(join(stagingParent, dirs[0]!))
          },
        }),
      )
      expect(res.ok, "expected a refusal").toBe(false)
      if (!res.ok) {
        expect(res.reasonCode).toBe("stale_isolation_evidence")
        expect(res.detail).toContain(expectDetail)
      }
      const types = await typesOf(store)
      expect(types).toContain(RootEvents.StagingReconciled) // it really got that far
      expect(types).not.toContain(RootEvents.PublishRequested) // and stopped before the rename
      expect(types).not.toContain(RootEvents.Ready)
      expect(existsSync(rootPath)).toBe(false) // the final path was never created
      expect(stagingDirs()).toEqual([])
    } finally {
      store.close()
      wipe()
    }
  }

  test("the staging DACL is WIDENED after it was reconciled", async () => {
    await realDrift(
      "realdacl",
      (st) => {
        runDirect(["protect-dir", "--path", st, "--owner-sid", hostSid, "--dacl-sddl", `D:P(A;OICI;FA;;;${hostSid})(A;OICI;FA;;;WD)`])
      },
      "dacl_changed_since_apply",
    )
  }, T)

  test("the staging MARKER is replaced after it was reconciled", async () => {
    await realDrift(
      "realmarker",
      (st) => {
        writeFileSync(join(st, MARKER_NAME), JSON.stringify({ ownerSid: "S-1-5-21-9-9-9-1001", rootFileId: "0" }), "utf8")
      },
      "marker_changed",
    )
  }, T)

  // ── RC4 §3: A DETERMINISTIC PROOF, BECAUSE THE REAL DRIFT IS IMPOSSIBLE HERE ─
  //
  // This case used to hand the staging directory to Administrators with
  // `protect-dir --owner-sid S-1-5-32-544`, and its own comment said "this shell
  // is elevated, so it can". At the medium integrity an authoritative round runs
  // at, it is not — and the failure was NOT that the refusal is broken but that
  // there was no drift to refuse, so `ok: true` was correct and the test was
  // measuring nothing.
  //
  // MEASURED rather than assumed, across every plausible target SID:
  //
  //   S-1-5-32-544 Administrators      -> SetNamedSecurityInfoW error 1307
  //   S-1-5-32-545 Users               -> 1307
  //   S-1-5-11     Authenticated Users -> 1307
  //   S-1-1-0      Everyone            -> 1307
  //   S-1-5-18     SYSTEM              -> 1307
  //   the host user itself (control)   -> SUCCEEDS
  //
  // 1307 is ERROR_INVALID_OWNER: a medium token may not assign any owner but
  // itself. So no amount of effort makes this drift happen at medium, and the
  // sibling cases below (DACL, marker, deletion) pass precisely because they need
  // no privilege.
  //
  // It is therefore proved the way `production-e2e.test.ts` proves the elevation
  // policy: REAL helper responses with exactly ONE field changed. The owner the
  // refusal reads comes from `inspect-dir`'s `pathOwnerSid`
  // (`src/execution-root.ts` -> `stagingProblems`), so flipping only that, only
  // for the staging path, and only AFTER reconciliation, makes the refusal
  // attributable to the ownership check and to nothing else.
  //
  // It is NOT allowlisted as an elevated-only skip: the property is fully
  // measurable here, and a skip would have removed it from the round.
  test("the staging OWNER is changed after it was reconciled", async () => {
    wipe()
    const store = freshStore("realowner")
    const FOREIGN = "S-1-5-21-9-9-9-1001"
    let armed = false
    const base = harnessHelperRunner()
    try {
      const res = await bootstrapExecutionRoot(
        deps(store, {
          // Arm at the same instant the real-drift cases mutate the directory.
          onPoint: (p) => {
            if (p === "after_staging_reconciled") armed = true
          },
          helper: async (inv) => {
            const r = await base(inv)
            const isStagingInspect = inv.argv[0] === "inspect-dir" && String(inv.argv[2] ?? "").includes(STAGING_DIR)
            if (!armed || !isStagingInspect) return r
            // Everything else about this response is the real thing — existence,
            // directory-ness, reparse status, DACL, file id, volume. Only the
            // owner moves.
            return { ...r, pathOwnerSid: FOREIGN }
          },
        }),
      )

      expect(res.ok, "expected a refusal").toBe(false)
      if (!res.ok) {
        expect(res.reasonCode).toBe("stale_isolation_evidence")
        expect(res.detail).toContain("owner_mismatch")
      }
      // Stopped exactly where the real-drift cases stop: reconciled, then refused
      // before the rename, with nothing published and nothing left behind.
      const types = await typesOf(store)
      expect(types).toContain(RootEvents.StagingReconciled)
      expect(types).not.toContain(RootEvents.PublishRequested)
      expect(types).not.toContain(RootEvents.Ready)
      expect(existsSync(rootPath)).toBe(false)
      expect(stagingDirs()).toEqual([])
      console.log(`[gate] toctou staging owner: observed ${FOREIGN} != host ${hostSid} -> ${res.ok ? "ACCEPTED (wrong)" : res.reasonCode}`)
    } finally {
      store.close()
      wipe()
    }
  }, T)

  test("NON-VACUITY: the same run WITHOUT the owner flip publishes", async () => {
    // Without this the test above would pass against a bootstrap that refused
    // unconditionally, which is exactly how an injected-drift proof goes wrong.
    wipe()
    const store = freshStore("realowner-nonvacuous")
    const base = harnessHelperRunner()
    try {
      const res = await bootstrapExecutionRoot(deps(store, { helper: async (inv) => base(inv) }))
      expect(res.ok, res.ok ? "" : `${res.reasonCode}: ${res.detail}`).toBe(true)
      expect(await typesOf(store)).toContain(RootEvents.Ready)
    } finally {
      store.close()
      wipe()
    }
  }, T)

  test("the staging is DELETED after it was reconciled", async () => {
    await realDrift("realgone", (st) => rmSync(st, { recursive: true, force: true }), "staging_missing")
  }, T)
})
