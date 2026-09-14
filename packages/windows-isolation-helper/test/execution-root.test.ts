/**
 * CL-16A3-B2B-ROOT-FIX §1 + §2 — no adoption, and atomic publication.
 *
 * Over a REAL SQLite event store, never `MemoryEventStore`: the whole point of
 * the durable ordering is that it survives a process, and an in-RAM store cannot
 * demonstrate that.
 *
 * This session's shell is ELEVATED and production refuses an elevated host
 * before creating anything — which is itself asserted below. Every other test
 * therefore drives the helper through the measurement harness's de-elevated
 * runner, exactly as the earlier slices do.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RIGHTS_MODEL_VERSION } from "@abdo/tools/windows-acl-matrix"
import {
  ancestorsOf,
  bootstrapExecutionRoot,
  evidenceDrift,
  findForbiddenPrincipals,
  markerHashOf,
  MARKER_NAME,
  protectedDaclFor,
  readMarker,
  RootEvents,
  ROOT_SCHEMA_VERSION,
  sidToDirName,
  STAGING_DIR,
  verifyPublishedRoot,
  type RootDeps,
  type RootEvidence,
  type RootMarker,
} from "../src/execution-root"
import { REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import { harnessHelperRunner, helperBinaryHash, helperBuilt, runDirect, runUnelevated } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const T = 300_000

let hostSid = ""
let programData = ""
let rootPath = ""
const scratchDbs: string[] = []

const inventory = { complete: true, hash: "test-inventory", roots: [{ path: process.env.USERPROFILE ?? "C:\\Users\\nobody" }] }
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")

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
  const dir = mkdtempSync(join(tmpdir(), `abdo-root-${tag}-`))
  scratchDbs.push(dir)
  return new SqliteEventStore(join(dir, "journal.sqlite"))
}

const typesOf = async (store: SqliteEventStore) => (await store.read("project", "winiso:execution-root")).map((e) => e.type)
const wipe = () => rmSync(join(programData, "Abdo"), { recursive: true, force: true })

// MODULE SCOPE, deliberately. Registered inside the first `describe` it runs when
// THAT block finishes, so every later describe's scratch directory was left
// behind — 140 of them survived one 40-run battery. Here it runs after the whole
// file, which is when "clean up after yourself" was always supposed to mean.
afterAll(() => {
  try {
    wipe()
  } catch {
    /* best effort */
  }
  for (const d of scratchDbs) rmSync(d, { recursive: true, force: true })
})

/**
 * Everything about the root that an adoption would have to disturb.
 *
 * Captured before and after a refusal and compared WHOLE, so a refusal that
 * quietly "fixed" one field cannot slip through by the test only naming the
 * fields it happened to think of.
 */
function snapshotWorld(path: string): Record<string, unknown> {
  const acl = runDirect(["inspect-acl", "--path", path])
  const dir = runDirect(["inspect-dir", "--path", path])
  const files: string[] = []
  const contents: Record<string, string> = {}
  try {
    for (const f of readdirSync(path).sort()) {
      files.push(f)
      try {
        contents[f] = readFileSync(join(path, f), "utf8")
      } catch {
        contents[f] = "<not a readable file>"
      }
    }
  } catch {
    /* not a directory */
  }
  return {
    sddl: String(acl.sddl ?? ""),
    owner: String(dir.pathOwnerSid ?? ""),
    fileId: String(dir.pathFileId ?? ""),
    volume: String(dir.pathVolumeSerial ?? ""),
    reparse: dir.pathIsReparsePoint === true,
    files,
    contents,
  }
}

describe.skipIf(!READY)("CL-16A3-B2B-ROOT-FIX - discovery and host identity", () => {
  beforeAll(async () => {
    const kf = await runUnelevated(["known-folder", "--id", "ProgramData"])
    hostSid = String(kf.hostUserSid ?? "")
    programData = String(kf.lexicalPath ?? "")
    rootPath = join(programData, "Abdo", "Execution", "v1", sidToDirName(hostSid))
    expect(kf.elevated).toBe(false) // the harness really is medium integrity
  })

  test("ProgramData comes from the Known Folder API, not the environment", async () => {
    const kf = await runUnelevated(["known-folder", "--id", "ProgramData"])
    expect(kf.sourceApi).toBe("SHGetKnownFolderPath")
    expect(kf.knownFolderId).toBe("FOLDERID_ProgramData")
    expect(String(kf.pathFinalPath)).toContain("\\")
    expect(kf.pathIsReparsePoint).toBe(false)
  })

  // ── ELEVATION: A DETERMINISTIC POLICY PROOF, NOT A PROPERTY OF THE TERMINAL ──
  //
  // This was one test named "the ELEVATED production path refuses before creating
  // anything", driving the bootstrap through `runDirect` — the helper in THIS
  // process's context. It therefore asserted a property of the shell: from an
  // elevated terminal it passed, and from the medium-integrity terminal an
  // authoritative round requires it FAILED, because at medium the host is
  // genuinely not elevated and the bootstrap genuinely proceeds. It was one of the
  // 14 failures in the RC2 round.
  //
  // Split the same way `production-e2e.test.ts` documents:
  //   B (here)  a DETERMINISTIC policy proof — an explicit, otherwise-trusted
  //             helper report with only the token flipped to elevated/high.
  //   C         the LIVE elevated proof, in `scripts/live-elevated-refusal.ts`,
  //             which refuses to run unless the host really is elevated.
  //
  // The live MEDIUM path is not re-proved here: every other test in this file
  // already bootstraps successfully at medium integrity, which is that proof.
  test("B. POLICY: an elevated host is refused before any directory, DACL, marker or staging", async () => {
    wipe()
    const store = freshStore("elev")
    try {
      // Real helper responses, with ONE field changed. `bootstrapExecutionRoot`
      // reads elevation from the `known-folder` reply (`src/execution-root.ts:337`
      // -> `tokenElevated`), so flipping exactly that is what makes the refusal
      // attributable to the policy rather than to anything else being wrong.
      const elevatedHelper = async ({ argv }: { argv: readonly string[] }) => {
        const real = await runUnelevated(argv)
        return { ...real, elevated: true, integrity: "high", integrityRid: 12288 }
      }
      const res = await bootstrapExecutionRoot(deps(store, { helper: elevatedHelper }))

      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reasonCode).toBe("elevated_host_not_supported")

      // ZERO MUTATION: refused before any directory, DACL, marker or staging, and
      // before a single journal event.
      expect(existsSync(join(programData, "Abdo"))).toBe(false)
      expect(await typesOf(store)).toEqual([])
      console.log(`[gate] execution-root B policy: elevated=true -> ${res.ok ? "ACCEPTED (wrong)" : res.reasonCode}, zero mutation`)
    } finally {
      store.close()
    }
  }, T)

  // The medium-integrity counterpart, stated explicitly so the pair cannot drift
  // into "only the refusal is tested". Guarded on the host's MEASURED elevation
  // rather than assumed, and the official round's preflight asserts medium.
  test.skipIf(runDirect(["version"]).elevated === true)("A. LIVE: at medium integrity the same bootstrap is NOT refused for elevation", async () => {
    wipe()
    const store = freshStore("elevmed")
    try {
      const res = await bootstrapExecutionRoot(deps(store))
      // It may fail for other reasons on a given machine, but NEVER this one.
      if (!res.ok) expect(res.reasonCode).not.toBe("elevated_host_not_supported")
      console.log(`[gate] execution-root A live medium: ok=${res.ok}${res.ok ? "" : ` reason=${res.reasonCode}`}, not an elevation refusal`)
    } finally {
      store.close()
    }
  }, T)

  test("an INCOMPLETE profile inventory refuses before discovery", async () => {
    wipe()
    const store = freshStore("inv")
    try {
      const res = await bootstrapExecutionRoot(deps(store, { profileInventory: { complete: false, hash: "partial", roots: [] } }))
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reasonCode).toBe("profile_inventory_unknown")
      expect(existsSync(join(programData, "Abdo"))).toBe(false)
      expect(await typesOf(store)).toEqual([])
    } finally {
      store.close()
    }
  }, T)
})

describe.skipIf(!READY)("CL-16A3-B2B-ROOT-FIX section 2 - the final path is published, never assembled", () => {
  test("a first bootstrap stages, protects, marks and PUBLISHES, in that order", async () => {
    wipe()
    const store = freshStore("order")
    try {
      const res = await bootstrapExecutionRoot(deps(store))
      expect(res.ok, res.ok ? "" : `${res.reasonCode}: ${res.detail}`).toBe(true)
      if (!res.ok) return
      expect(res.publishedByUs).toBe(true)
      expect(res.observedExistingVerified).toBe(false)

      const types = await typesOf(store)
      const at = (t: string) => types.indexOf(t)
      expect(at(RootEvents.Requested)).toBeGreaterThanOrEqual(0)
      expect(at(RootEvents.StagingRequested)).toBeLessThan(at(RootEvents.StagingCreated))
      expect(at(RootEvents.StagingCreated)).toBeLessThan(at(RootEvents.StagingProtected))
      expect(at(RootEvents.StagingProtected)).toBeLessThan(at(RootEvents.StagingMarked))
      expect(at(RootEvents.StagingMarked)).toBeLessThan(at(RootEvents.StagingReconciled))
      expect(at(RootEvents.StagingReconciled)).toBeLessThan(at(RootEvents.PublishRequested))
      expect(at(RootEvents.PublishRequested)).toBeLessThan(at(RootEvents.Published))
      expect(at(RootEvents.Published)).toBeLessThan(at(RootEvents.Reconciled))
      expect(at(RootEvents.Reconciled)).toBeLessThan(at(RootEvents.Ready))
      expect(types[types.length - 1]).toBe(RootEvents.Ready)
      expect(types).not.toContain(RootEvents.Failed)

      // The staging is GONE: publication MOVED it, it was not copied.
      expect(existsSync(res.stagingPath)).toBe(false)
      expect(existsSync(join(rootPath, MARKER_NAME))).toBe(true)
    } finally {
      store.close()
    }
  }, T)

  test("the published DACL is PROTECTED and grants no general principal", () => {
    const sddl = String(runDirect(["inspect-acl", "--path", rootPath]).sddl ?? "")
    expect(sddl).toContain(hostSid)
    expect(findForbiddenPrincipals(sddl, hostSid)).toEqual([])
    // `AI` coexists with `P`, so `D:PAI` proves nothing. The real evidence is
    // that no ACE carries the INHERITED flag.
    for (const ace of sddl.match(/\(([^)]*)\)/g) ?? []) expect(ace.split(";")[1] ?? "").not.toContain("ID")
    expect(sddl.startsWith("D:P")).toBe(true)
  })

  test("ProgramData's OWN DACL was not modified", () => {
    const sddl = String(runDirect(["inspect-acl", "--path", programData]).sddl ?? "")
    expect(sddl).toContain("(A;OICI;FA;;;SY)")
    expect(sddl).toContain("(A;OICI;FA;;;BA)")
    expect(sddl).not.toContain(`;${hostSid})`)
  })

  test("the marker describes THIS root and contains no secret", () => {
    const m = readMarker(join(rootPath, MARKER_NAME))
    expect(m).toBeDefined()
    if (!m) return
    const dir = runDirect(["inspect-dir", "--path", rootPath])
    expect(m.ownerSid).toBe(hostSid)
    expect(m.rootFileId).toBe(String(dir.pathFileId ?? ""))
    expect(m.volumeSerial).toBe(String(dir.pathVolumeSerial ?? ""))
    expect(m.schemaVersion).toBe(ROOT_SCHEMA_VERSION)
    const blob = JSON.stringify(m).toLowerCase()
    for (const bad of ["password", "token", "secret", "authorization"]) expect(blob).not.toContain(bad)
  })

  test("a SECOND bootstrap VERIFIES the published root and mutates nothing", async () => {
    const before = snapshotWorld(rootPath)
    const store = freshStore("idem")
    try {
      const res = await bootstrapExecutionRoot(deps(store))
      expect(res.ok, res.ok ? "" : `${res.reasonCode}: ${res.detail}`).toBe(true)
      if (!res.ok) return
      expect(res.observedExistingVerified).toBe(true)
      expect(res.publishedByUs).toBe(false)
      expect(res.stagingPath).toBe("") // no staging was even created
      const types = await typesOf(store)
      expect(types).toContain(RootEvents.VerifiedExisting)
      expect(types).not.toContain(RootEvents.StagingRequested)
      expect(types).not.toContain(RootEvents.PublishRequested)
      expect(snapshotWorld(rootPath)).toEqual(before)
    } finally {
      store.close()
    }
  }, T)
})

describe.skipIf(!READY)("CL-16A3-B2B-ROOT-FIX section 1 - an existing root is NEVER adopted or repaired", () => {
  /** Plant a root, bootstrap over it, and prove nothing about it changed. */
  const plantAndRefuse = async (tag: string, plant: () => void, expectCode: string, expectDetail?: string) => {
    wipe()
    mkdirSync(rootPath, { recursive: true })
    plant()
    const before = snapshotWorld(rootPath)
    const store = freshStore(tag)
    try {
      const res = await bootstrapExecutionRoot(deps(store))
      expect(res.ok, "expected a refusal, got ready").toBe(false)
      if (!res.ok) {
        expect(res.reasonCode).toBe(expectCode)
        if (expectDetail) expect(res.detail).toContain(expectDetail)
      }
      const types = await typesOf(store)
      expect(types).not.toContain(RootEvents.Ready)
      // NOTHING was staged, protected, marked or published.
      expect(types).not.toContain(RootEvents.StagingRequested)
      expect(types).not.toContain(RootEvents.PublishRequested)
      expect(types).not.toContain(RootEvents.MarkerWritten)
      // The planted world is EXACTLY as it was left.
      expect(snapshotWorld(rootPath)).toEqual(before)
      expect(existsSync(join(programData, "Abdo", "Execution", STAGING_DIR))).toBe(false)
    } finally {
      store.close()
    }
  }

  test("a root with NO marker is a conflict - not something to take over", async () => {
    await plantAndRefuse("nomarker", () => writeFileSync(join(rootPath, "someone-elses-file.txt"), "hello", "utf8"), "execution_root_ownership_conflict", "not ours to adopt")
  }, T)

  test("a root granting EVERYONE write is refused, and its DACL is left alone", async () => {
    // The exact case the previous version overwrote and carried on from.
    await plantAndRefuse(
      "everyone",
      () => {
        runDirect(["protect-dir", "--path", rootPath, "--owner-sid", hostSid, "--dacl-sddl", `D:P(A;OICI;FA;;;${hostSid})(A;OICI;FA;;;WD)`])
        expect(findForbiddenPrincipals(String(runDirect(["inspect-acl", "--path", rootPath]).sddl ?? ""), hostSid).length).toBeGreaterThan(0)
      },
      "execution_root_ownership_conflict",
    )
  }, T)

  test("a root with a FOREIGN marker is a conflict, and is NOT repaired", async () => {
    await plantAndRefuse(
      "foreign",
      () => {
        const foreign: RootMarker = {
          schemaVersion: ROOT_SCHEMA_VERSION,
          rightsModelVersion: RIGHTS_MODEL_VERSION,
          ownerSid: "S-1-5-21-9-9-9-1001",
          rootFinalPath: rootPath,
          volumeSerial: "0",
          rootFileId: "0",
          protectedDaclHash: "0",
          profileInventoryHash: inventory.hash,
          helperProtocol: REQUIRED_PROTOCOL_VERSION,
          createdAt: "2020-01-01T00:00:00.000Z",
        }
        writeFileSync(join(rootPath, MARKER_NAME), JSON.stringify(foreign), "utf8")
      },
      "execution_root_ownership_conflict",
      "S-1-5-21-9-9-9-1001",
    )
  }, T)

  test("a root whose marker is OURS but whose DACL is wide is refused, unrepaired", async () => {
    await plantAndRefuse(
      "widedacl",
      () => {
        runDirect(["protect-dir", "--path", rootPath, "--owner-sid", hostSid, "--dacl-sddl", `D:P(A;OICI;FA;;;${hostSid})(A;OICI;FA;;;BU)`])
        const dir = runDirect(["inspect-dir", "--path", rootPath])
        const mine: RootMarker = {
          schemaVersion: ROOT_SCHEMA_VERSION,
          rightsModelVersion: RIGHTS_MODEL_VERSION,
          ownerSid: hostSid,
          rootFinalPath: rootPath,
          volumeSerial: String(dir.pathVolumeSerial ?? ""),
          rootFileId: String(dir.pathFileId ?? ""),
          // The marker VOUCHES for the wide descriptor, so the only thing that
          // catches this is comparing against the protected FORM itself.
          protectedDaclHash: sha256(String(dir.pathDacl ?? "")),
          profileInventoryHash: inventory.hash,
          helperProtocol: REQUIRED_PROTOCOL_VERSION,
          createdAt: "2020-01-01T00:00:00.000Z",
        }
        writeFileSync(join(rootPath, MARKER_NAME), JSON.stringify(mine), "utf8")
      },
      "execution_root_dacl_conflict",
      "dacl_not_the_protected_form",
    )
  }, T)

  test("a root whose marker was written by a DIFFERENT model version is refused", async () => {
    await plantAndRefuse(
      "oldmodel",
      () => {
        const dir = runDirect(["inspect-dir", "--path", rootPath])
        const old: RootMarker = {
          schemaVersion: ROOT_SCHEMA_VERSION,
          rightsModelVersion: RIGHTS_MODEL_VERSION + 99,
          ownerSid: hostSid,
          rootFinalPath: rootPath,
          volumeSerial: String(dir.pathVolumeSerial ?? ""),
          rootFileId: String(dir.pathFileId ?? ""),
          protectedDaclHash: "0",
          profileInventoryHash: inventory.hash,
          helperProtocol: REQUIRED_PROTOCOL_VERSION,
          createdAt: "2020-01-01T00:00:00.000Z",
        }
        writeFileSync(join(rootPath, MARKER_NAME), JSON.stringify(old), "utf8")
      },
      "execution_root_ownership_conflict",
      "different model",
    )
  }, T)

  test("a JUNCTION planted where an ancestor belongs is refused, and not followed", async () => {
    wipe()
    const elsewhere = mkdtempSync(join(tmpdir(), "abdo-junction-target-"))
    scratchDbs.push(elsewhere)
    mkdirSync(join(programData, "Abdo"), { recursive: true })
    const mk = Bun.spawnSync(["C:\\Windows\\System32\\cmd.exe", "/c", "mklink", "/J", join(programData, "Abdo", "Execution"), elsewhere], { stdout: "pipe", stderr: "pipe" })
    expect(mk.exitCode, `mklink failed: ${mk.stderr.toString()}`).toBe(0)

    const store = freshStore("junction")
    try {
      const res = await bootstrapExecutionRoot(deps(store))
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.reasonCode).toBe("execution_root_ancestor_conflict")
        expect(res.detail).toContain("reparse point")
      }
      expect(await typesOf(store)).not.toContain(RootEvents.Ready)
      // The junction was NOT followed: nothing was created through it.
      expect(readdirSync(elsewhere)).toEqual([])
    } finally {
      store.close()
      wipe()
    }
  }, T)

  test("a FILE where an ancestor directory belongs is refused", async () => {
    wipe()
    mkdirSync(join(programData, "Abdo"), { recursive: true })
    writeFileSync(join(programData, "Abdo", "Execution"), "not a directory", "utf8")
    const store = freshStore("ancfile")
    try {
      const res = await bootstrapExecutionRoot(deps(store))
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reasonCode).toBe("execution_root_ancestor_conflict")
      expect(await typesOf(store)).not.toContain(RootEvents.Ready)
    } finally {
      store.close()
      wipe()
    }
  }, T)
})

describe.skipIf(!READY)("CL-16A3-B2B-ROOT-FIX - pure helpers", () => {
  test("ancestorsOf lists only what must be created, never ProgramData", () => {
    const pd = "C:\\ProgramData"
    expect(ancestorsOf(join(pd, "Abdo", "Execution", "v1", "S-1-5-x"), pd)).toEqual([join(pd, "Abdo"), join(pd, "Abdo", "Execution"), join(pd, "Abdo", "Execution", "v1")])
  })

  test("the protected DACL names the owner and nothing else", () => {
    expect(protectedDaclFor("S-1-5-21-1-2-3-1001")).toBe("D:P(A;OICI;FA;;;S-1-5-21-1-2-3-1001)")
  })

  test("forbidden principals are detected in an observed descriptor", () => {
    const me = "S-1-5-21-1-2-3-1001"
    expect(findForbiddenPrincipals(`D:P(A;OICI;FA;;;${me})`, me)).toEqual([])
    expect(findForbiddenPrincipals(`D:P(A;OICI;FA;;;${me})(A;OICI;FA;;;BU)`, me)).toEqual(["BU"])
    expect(findForbiddenPrincipals(`D:PAI(A;OICIID;FA;;;${me})`, me)).toContain(`inherited:${me}`)
  })

  test("a SID is rendered safely as a directory name", () => {
    expect(sidToDirName("S-1-5-21-1-2-3-1001")).toBe("S-1-5-21-1-2-3-1001")
    expect(sidToDirName("S-1-5-21\\..\\evil")).toBe("S-1-5-21____evil") // four unsafe chars, four underscores
  })

  test("the marker hash changes when any field changes", () => {
    const base: RootMarker = {
      schemaVersion: ROOT_SCHEMA_VERSION,
      rightsModelVersion: 1,
      ownerSid: "S-1-5-21-1-2-3-1001",
      rootFinalPath: "\\\\?\\Volume{x}\\r",
      volumeSerial: "abc",
      rootFileId: "1",
      protectedDaclHash: "h",
      profileInventoryHash: "p",
      helperProtocol: REQUIRED_PROTOCOL_VERSION,
      createdAt: "2026-01-01T00:00:00.000Z",
    }
    expect(markerHashOf(base)).toBe(markerHashOf({ ...base }))
    expect(markerHashOf({ ...base, rootFileId: "2" })).not.toBe(markerHashOf(base))
  })

  test("evidenceDrift names the field that moved, including a reparse tag", () => {
    const a: RootEvidence = {
      programDataLexical: "C:\\ProgramData",
      programDataFinal: "f",
      programDataVolume: "v",
      programDataFileId: "i",
      programDataReparse: false,
      hostSid: "S-1",
      tokenIntegrity: "medium",
      tokenIntegrityRid: 0x2000,
      tokenElevated: false,
      ancestors: [{ path: "a", exists: true, fileId: "1", volumeSerial: "v", isReparsePoint: false, ownerSid: "S-1" }],
      profileInventoryHash: "p",
      profileInventoryComplete: true,
      rightsModelVersion: 1,
      rightsModelHash: "r",
      helperHash: "h",
      helperProtocol: REQUIRED_PROTOCOL_VERSION,
      stateEpoch: "e",
    }
    expect(evidenceDrift(a, a)).toEqual([])
    expect(evidenceDrift(a, { ...a, hostSid: "S-2" })).toEqual(["hostSid"])
    expect(evidenceDrift(a, { ...a, ancestors: [{ ...a.ancestors[0]!, isReparsePoint: true }] })).toContain("ancestors[0].isReparsePoint")
  })

  test("verifyPublishedRoot refuses a directory with no marker, without touching it", () => {
    const v = verifyPublishedRoot({ pathIsDirectory: true }, join(tmpdir(), "no-such-root"), "S-1-5-21-1-2-3-1001", {
      helperProtocol: REQUIRED_PROTOCOL_VERSION,
      rightsModelVersion: RIGHTS_MODEL_VERSION,
      profileInventory: inventory,
    })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reasonCode).toBe("execution_root_ownership_conflict")
  })
})
