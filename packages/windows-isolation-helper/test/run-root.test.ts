/**
 * CL-16A3-B3 / MEGA SPRINT 1 §2 — per-run execution directories.
 *
 * The pure half (run ids) needs no Windows. The rest creates REAL directories
 * under the REAL execution root through the de-elevated measurement harness, and
 * asserts what Windows actually reports rather than what the helper returned.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RIGHTS_MODEL_VERSION } from "@abdo/tools/windows-acl-matrix"
import { bootstrapExecutionRoot } from "../src/execution-root"
import { REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import {
  createRunDirectory,
  isHostGeneratedRunId,
  newRunId,
  RUN_ID_PATTERN,
  RUN_MARKER_NAME,
  RUN_SUBDIRS,
  RunEvents,
  runPathFor,
  type RunDeps,
} from "../src/run-root"
import { harnessHelperRunner, helperBinaryHash, helperBuilt, runDirect, runUnelevated } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const T = 180_000

// ───────────────────────────────── the id is the first line of defence

describe("run ids are host-generated, and that is structural", () => {
  test("the generated shape is exactly what the validator accepts", () => {
    for (let i = 0; i < 200; i++) expect(RUN_ID_PATTERN.test(newRunId())).toBe(true)
  })

  test("1000 ids, no repeat — 128 bits from the OS CSPRNG", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(newRunId())
    expect(seen.size).toBe(1000)
  })

  test("everything a caller might supply instead is REFUSED by shape", () => {
    // Each of these is a real Windows path hazard, and none of them can become a
    // directory name because none matches the generated form.
    for (const hostile of [
      "..",
      "../escape",
      "..\\escape",
      "CON",
      "PRN",
      "NUL",
      "COM1",
      "run_with:stream",
      "run_trailing.",
      "run_trailing ",
      "RUN_UPPERCASE0000000000000",
      "run_short",
      "run_0000000000000000000000001", // too long
      "run_1llegal8charset0000000",
      "",
      "run_" + "a".repeat(26) + "/..",
      "\\\\server\\share",
      "C:\\Windows",
    ]) {
      expect(isHostGeneratedRunId(hostile)).toBe(false)
    }
  })

  test("NON-VACUITY: a real generated id passes the same check", () => {
    expect(isHostGeneratedRunId(newRunId())).toBe(true)
  })
})

// ───────────────────────────────── the real thing, on the real root

describe.skipIf(!READY)("a published run directory", () => {
  let scratch = ""
  let deps: RunDeps
  let programData = ""
  let hostSid = ""
  const made: string[] = []

  beforeAll(async () => {
    const kf = await runUnelevated(["known-folder", "--id", "ProgramData"])
    expect(kf.elevated).toBe(false)
    programData = String(kf.lexicalPath ?? "")
    hostSid = String(kf.hostUserSid ?? "")
    scratch = mkdtempSync(join(tmpdir(), "abdo-runroot-"))
    const store = new SqliteEventStore(join(scratch, "journal.sqlite"))
    const root = await bootstrapExecutionRoot({
      store,
      helper: harnessHelperRunner(),
      helperProtocol: REQUIRED_PROTOCOL_VERSION,
      helperHash: helperBinaryHash(),
      profileInventory: { complete: true, hash: "test-inventory", roots: [{ path: process.env.USERPROFILE ?? "" }] },
      rightsModelVersion: RIGHTS_MODEL_VERSION,
    })
    if (!root.ok) throw new Error(`the execution root would not bootstrap: ${root.reasonCode} — ${root.detail}`)
    deps = {
      store,
      helper: harnessHelperRunner(),
      helperProtocol: REQUIRED_PROTOCOL_VERSION,
      helperHash: helperBinaryHash(),
      executionRootPath: root.rootPath,
      executionRootFinalPath: root.finalPath,
      hostSid,
      rightsModelVersion: RIGHTS_MODEL_VERSION,
    }
  }, T)

  afterAll(() => {
    try {
      rmSync(join(programData, "Abdo"), { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  test("is published complete: every subdirectory and a marker, owned by the host", async () => {
    const runId = newRunId()
    const r = await createRunDirectory(deps, runId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    made.push(r.runPath)

    // What WINDOWS says, not what the helper returned.
    const d = runDirect(["inspect-dir", "--path", r.runPath])
    expect(d.pathExists).toBe(true)
    expect(d.pathIsDirectory).toBe(true)
    expect(d.pathIsReparsePoint).toBe(false)
    expect(String(d.pathOwnerSid).toLowerCase()).toBe(hostSid.toLowerCase())

    for (const sub of RUN_SUBDIRS) {
      const s = runDirect(["inspect-dir", "--path", join(r.runPath, sub)])
      expect(s.pathExists, `${sub} must exist`).toBe(true)
      expect(s.pathIsDirectory).toBe(true)
    }
    const marker = JSON.parse(readFileSync(join(r.runPath, RUN_MARKER_NAME), "utf8"))
    expect(marker.runId).toBe(runId)
    expect(marker.hostSid).toBe(hostSid)
    expect(marker.helperProtocol).toBe(REQUIRED_PROTOCOL_VERSION)
  }, T)

  test("carries a PROTECTED owner-only DACL — nothing is inherited from ProgramData", async () => {
    const r = await createRunDirectory(deps, newRunId())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    made.push(r.runPath)
    const sddl = String(runDirect(["inspect-acl", "--path", r.runPath]).sddl ?? "")
    // `P` = protected: inheritance from the parent chain is severed. ProgramData
    // grants BU create rights by design, and none of it may reach a run.
    expect(sddl).toContain("D:P")
    for (const principal of [";;;BU)", ";;;WD)", ";;;AU)"]) expect(sddl).not.toContain(principal)
    // No ACE carrying the INHERITED flag.
    const inherited = (sddl.match(/\(([^)]*)\)/g) ?? []).filter((a) => (a.split(";")[1] ?? "").includes("ID"))
    expect(inherited).toEqual([])
  }, T)

  test("records the full durable sequence, intent before effect", async () => {
    const store = new SqliteEventStore(join(scratch, "seq.sqlite"))
    const r = await createRunDirectory({ ...deps, store }, newRunId())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    made.push(r.runPath)
    const types = (await store.read("project", "winiso:execution-run")).map((e) => e.type)
    store.close()
    // The order is the law: every mutation is bracketed.
    expect(types).toEqual([
      RunEvents.Requested,
      RunEvents.Inspected,
      RunEvents.StagingCreated,
      RunEvents.StagingProtected,
      RunEvents.StagingPopulated,
      RunEvents.StagingMarked,
      RunEvents.StagingReconciled,
      RunEvents.PublishRequested,
      RunEvents.Published,
      RunEvents.Reconciled,
      RunEvents.Ready,
    ])
  }, T)

  test("a run id is used ONCE — the second attempt is refused, and the first is untouched", async () => {
    const runId = newRunId()
    const first = await createRunDirectory(deps, runId)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    made.push(first.runPath)
    const before = String(runDirect(["inspect-acl", "--path", first.runPath]).sddl ?? "")

    const second = await createRunDirectory(deps, runId)
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.reasonCode).toBe("run_directory_already_exists")
    // AND IT LEFT THE WINNER EXACTLY AS IT WAS.
    expect(String(runDirect(["inspect-acl", "--path", first.runPath]).sddl ?? "")).toBe(before)
    expect(existsSync(join(first.runPath, RUN_MARKER_NAME))).toBe(true)
  }, T)

  test("a caller-chosen id creates NOTHING — refused before any path is built", async () => {
    for (const hostile of ["../escape", "CON", "run_with:stream", "attacker-run"]) {
      const r = await createRunDirectory(deps, hostile)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reasonCode).toBe("run_id_not_host_generated")
      // Nothing under runs/ bears any resemblance to the requested name.
      expect(existsSync(runPathFor(deps.executionRootPath, hostile))).toBe(false)
    }
  }, T)

  test("two runs are independent directories", async () => {
    const a = await createRunDirectory(deps, newRunId())
    const b = await createRunDirectory(deps, newRunId())
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    made.push(a.runPath, b.runPath)
    expect(a.runPath).not.toBe(b.runPath)
    expect(a.fileId).not.toBe(b.fileId)
  }, T)
})
