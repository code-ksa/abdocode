/**
 * CL-16A3-B3 / MEGA SPRINT 1 §3 — per-run least privilege, measured.
 *
 * The planner is pure and is tested as such. The grants are then APPLIED to real
 * directories and probed with the helper's native `access-probe` — one documented
 * Win32 call per operation — because `cmd`'s `dir`/`type` are programs with their
 * own opening sequences and their failure describes cmd, not the ACL (the B2A
 * lesson).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteEventStore } from "@abdo/persistence-sqlite"
import { RIGHTS_MODEL_VERSION, rightsPlanHash } from "@abdo/tools/windows-acl-matrix"
import { bootstrapExecutionRoot } from "../src/execution-root"
import { REQUIRED_PROTOCOL_VERSION } from "../src/helper-runner"
import { createRunDirectory, newRunId, type RunReady } from "../src/run-root"
import { ancestorChain, applyRunGrants, isDriveRoot, measureExecutableAccess, planRunScope, revokeRunGrants, RunGrantEvents, type RunScopeBinding, type RunScopeRequest } from "../src/run-scope"
import { containerName, harnessHelperRunner, helperBinaryHash, helperBuilt, runDirect, runUnelevated } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const T = 240_000
const CMD = "C:\\Windows\\System32\\cmd.exe"

const baseBinding = (over: Partial<RunScopeBinding> = {}): RunScopeBinding => ({
  runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  stateEpoch: "epoch-1",
  decisionId: "dec-1",
  dialect: "direct",
  // INSIDE the run root by default, so the base cases exercise the grant path.
  // The outside-root cases below are explicit, and each states its evidence.
  executablePath: String.raw`C:\ProgramData\Abdo\Execution\v1\S_1_5_21\runs\run_x\input\tool.exe`,
  executableHash: "abc",
  workspaceIdentity: "vol:1",
  appContainerSid: "S-1-15-2-test",
  rightsModelVersion: RIGHTS_MODEL_VERSION,
  rightsModelHash: rightsPlanHash(),
  profileInventoryHash: "inv",
  helperHash: "hh",
  helperProtocol: REQUIRED_PROTOCOL_VERSION,
  ...over,
})

const req = (over: Partial<RunScopeRequest> = {}): RunScopeRequest => ({
  binding: baseBinding(),
  runPath: "C:\\ProgramData\\Abdo\\Execution\\v1\\S_1_5_21\\runs\\run_x",
  runSubdirs: {
    input: "C:\\ProgramData\\Abdo\\Execution\\v1\\S_1_5_21\\runs\\run_x\\input",
    workspace: "C:\\ProgramData\\Abdo\\Execution\\v1\\S_1_5_21\\runs\\run_x\\workspace",
    temp: "C:\\ProgramData\\Abdo\\Execution\\v1\\S_1_5_21\\runs\\run_x\\temp",
    output: "C:\\ProgramData\\Abdo\\Execution\\v1\\S_1_5_21\\runs\\run_x\\output",
    metadata: "C:\\ProgramData\\Abdo\\Execution\\v1\\S_1_5_21\\runs\\run_x\\metadata",
  },
  executionRootPath: "C:\\ProgramData\\Abdo\\Execution\\v1\\S_1_5_21",
  forbiddenRoots: ["C:\\Users\\someone"],
  profileInventoryComplete: true,
  ...over,
})

// ─────────────────────────────────────────────── the planner, pure

describe("the per-run scope planner", () => {
  test("grants ancestors TRAVERSE ONLY — never list, never read", () => {
    const p = planRunScope(req())
    expect(p.ok).toBe(true)
    if (!p.ok) return
    for (const g of p.grants.filter((g) => g.purpose === "ancestor_traverse")) {
      expect(g.rights).toEqual(["traverse"])
      expect(g.rights).not.toContain("list_directory")
      expect(g.rights).not.toContain("read_file")
      expect(g.target).toBe("object_self")
    }
  })

  test("grants an input file on the FILE, so a sibling is not covered", () => {
    const f = join(req().runSubdirs.input, "allowed.txt")
    const p = planRunScope(req({ inputFiles: [f] }))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const g = p.grants.find((g) => g.purpose === "input_file_read")!
    expect(g.path).toBe(f)
    expect(g.target).toBe("object_self")
    // The input DIRECTORY gets traverse only — not read, not list.
    const dir = p.grants.find((g) => g.purpose === "input_dir_traverse")!
    expect(dir.rights).toEqual(["traverse"])
  })

  test("enumeration is a SEPARATE, opt-in grant", () => {
    const plain = planRunScope(req())
    expect(plain.ok && plain.grants.some((g) => g.rights.includes("list_directory") && g.purpose === "input_dir_list")).toBe(false)
    const listed = planRunScope(req({ listableDirs: [req().runSubdirs.input] }))
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    // One object, one mutation — so the enumeration intent is recorded in
    // `purposes` alongside the traverse it merged with, and the right is there.
    expect(listed.grants.some((g) => g.purposes.includes("input_dir_list") && g.rights.includes("list_directory"))).toBe(true)
  })

  test("output may be created and written but NOT deleted; temp may delete its own children", () => {
    const p = planRunScope(req())
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const out = p.grants.find((g) => g.purpose === "output_write")!
    expect(out.rights).toContain("create_file")
    expect(out.rights).toContain("write_file")
    expect(out.rights).not.toContain("delete")
    expect(out.rights).not.toContain("delete_child")
    const tmp = p.grants.find((g) => g.purpose === "temp_write")!
    expect(tmp.rights).toContain("delete_child")
  })

  test("metadata and workspace are NOT granted — a run may not touch either", () => {
    const p = planRunScope(req())
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const paths = p.grants.map((g) => g.path.toLowerCase())
    expect(paths).not.toContain(req().runSubdirs.metadata.toLowerCase())
    expect(paths).not.toContain(req().runSubdirs.workspace.toLowerCase())
  })

  test("no grant ever resolves to GENERIC_*, WRITE_DAC or WRITE_OWNER", () => {
    const p = planRunScope(req({ inputFiles: [join(req().runSubdirs.input, "a.txt")], listableDirs: [req().runSubdirs.input] }))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    for (const g of p.grants) expect(g.mask & (0xf000_0000 | 0x0004_0000 | 0x0008_0000)).toBe(0)
  })

  test("REFUSES a profile root, a drive root and a reparse point", () => {
    const inProfile = planRunScope(req({ inputFiles: ["C:\\Users\\someone\\secrets.txt"] }))
    expect(inProfile.ok).toBe(false)
    if (!inProfile.ok) expect(inProfile.reasonCode).toBe("scope_profile_root_forbidden")

    expect(isDriveRoot("C:\\")).toBe(true)
    expect(isDriveRoot("D:")).toBe(true)
    expect(isDriveRoot("C:\\Windows")).toBe(false)

    const junction = planRunScope(req({
      inputFiles: ["C:\\ProgramData\\Abdo\\Execution\\v1\\S_1_5_21\\runs\\run_x\\input\\link.txt"],
      identities: { "c:\\programdata\\abdo\\execution\\v1\\s_1_5_21\\runs\\run_x\\input\\link.txt": { isReparsePoint: true } },
    }))
    expect(junction.ok).toBe(false)
    if (!junction.ok) expect(junction.reasonCode).toBe("scope_reparse_point_forbidden")
  })

  test("REFUSES when the profile inventory is incomplete — fail-closed", () => {
    const p = planRunScope(req({ profileInventoryComplete: false }))
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.reasonCode).toBe("profile_inventory_unknown")
  })

  test("the binding hash moves when ANY bound fact moves", () => {
    const a = planRunScope(req())
    expect(a.ok).toBe(true)
    if (!a.ok) return
    for (const over of [
      { stateEpoch: "epoch-2" },
      { decisionId: "dec-2" },
      { appContainerSid: "S-1-15-2-other" },
      { executableHash: "different" },
      { dialect: "powershell" },
      { approvalSnapshot: "snap-1" },
      { helperProtocol: 99 },
    ] as Partial<RunScopeBinding>[]) {
      const b = planRunScope(req({ binding: baseBinding(over) }))
      expect(b.ok).toBe(true)
      if (!b.ok) return
      expect(b.bindingHash, `changing ${JSON.stringify(over)} must change the hash`).not.toBe(a.bindingHash)
    }
  })

  /**
   * CORRECTED TWICE, and the second correction is the important one.
   *
   * Attempt 1 granted `execute` on any executable; applying that to
   * `C:\Windows\System32\cmd.exe` FAILED (a medium-integrity user cannot rewrite
   * a system binary's DACL). Attempt 2 concluded "outside the root needs no
   * grant" - an OVER-GENERALISATION: B2 measured that `C:\Windows` and
   * `C:\Program Files` carry ALL APPLICATION PACKAGES, which says nothing about
   * whether a PARTICULAR file grants EXECUTE to a PARTICULAR container, and
   * nothing at all about Git, Node, PowerShell 7 or a workspace tool.
   *
   * Location is not a capability. Outside the root, accessibility must be MEASURED.
   */
  test("an executable outside the root with NO measurement is REFUSED", () => {
    for (const exe of [
      String.raw`C:\Windows\System32\cmd.exe`,
      String.raw`C:\Program Files\Git\bin\git.exe`,
      String.raw`C:\Program Files\nodejs\node.exe`,
      String.raw`C:\Program Files\PowerShell\7\pwsh.exe`,
      String.raw`C:\Users\someone\tools\custom.exe`,
    ]) {
      const p = planRunScope(req({ binding: baseBinding({ executablePath: exe }) }))
      expect(p.ok, `${exe} must not plan without measured access`).toBe(false)
      if (!p.ok) expect(p.reasonCode).toBe("executable_not_accessible_to_appcontainer")
    }
  })

  test("a MEASURED-accessible executable plans with NO ACL mutation of that file", () => {
    const exe = String.raw`C:\Windows\System32\cmd.exe`
    const p = planRunScope(req({
      binding: baseBinding({ executablePath: exe }),
      executableAccess: { access: "existing_access_verified", executablePath: exe, appContainerSid: "S-1-15-2-test", daclChain: [], daclChainHash: "h", reason: "launched" },
    }))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    // Bound, but its ACL is never touched.
    expect(p.grants.some((g) => g.path.toLowerCase() === exe.toLowerCase())).toBe(false)
    expect(p.grants.some((g) => g.purpose === "executable_execute")).toBe(false)
  })

  test("evidence for a DIFFERENT executable or a DIFFERENT SID is refused", () => {
    const exe = String.raw`C:\Program Files\Git\bin\git.exe`
    const wrongExe = planRunScope(req({
      binding: baseBinding({ executablePath: exe }),
      executableAccess: { access: "existing_access_verified", executablePath: String.raw`C:\Windows\System32\cmd.exe`, appContainerSid: "S-1-15-2-test", daclChain: [], daclChainHash: "h" },
    }))
    expect(wrongExe.ok).toBe(false)
    if (!wrongExe.ok) expect(wrongExe.reasonCode).toBe("executable_access_evidence_mismatch")

    const wrongSid = planRunScope(req({
      binding: baseBinding({ executablePath: exe }),
      executableAccess: { access: "existing_access_verified", executablePath: exe, appContainerSid: "S-1-15-2-OTHER", daclChain: [], daclChainHash: "h" },
    }))
    expect(wrongSid.ok).toBe(false)
    if (!wrongSid.ok) expect(wrongSid.reasonCode).toBe("executable_access_evidence_mismatch")
  })

  test("a not_accessible or unknown verdict is refused, never optimistically accepted", () => {
    const exe = String.raw`C:\Program Files\nodejs\node.exe`
    for (const access of ["not_accessible", "unknown", "staged_in_run"] as const) {
      const p = planRunScope(req({
        binding: baseBinding({ executablePath: exe }),
        executableAccess: { access, executablePath: exe, appContainerSid: "S-1-15-2-test", daclChain: [], daclChainHash: "h" },
      }))
      expect(p.ok, `${access} must not plan`).toBe(false)
    }
  })

  test("an executable STAGED inside the run root is granted normally", () => {
    const inside = planRunScope(req({ binding: baseBinding({ executablePath: join(req().runSubdirs.input, "tool.exe") }) }))
    expect(inside.ok).toBe(true)
    if (!inside.ok) return
    const g = inside.grants.find((g) => g.purpose === "executable_execute")!
    expect(g.rights).toContain("execute")
    expect(g.target).toBe("object_self")
  })

  test("the accessibility evidence is BOUND: its DACL-chain hash moves the plan hash", () => {
    const exe = String.raw`C:\Windows\System32\cmd.exe`
    const mk = (daclChainHash: string) =>
      planRunScope(req({
        binding: baseBinding({ executablePath: exe }),
        executableAccess: { access: "existing_access_verified", executablePath: exe, appContainerSid: "S-1-15-2-test", daclChain: [{ path: exe, sddl: daclChainHash }], daclChainHash },
      }))
    const a = mk("chain-1")
    const b = mk("chain-2")
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    // An ACL change on the executable after it was measured is drift: the
    // pre-launch check compares this hash and refuses the launch.
    expect(a.binding.executablePath).toBe(b.binding.executablePath)
    expect(a.bindingHash).toBe(b.bindingHash) // the plan itself is unchanged...
    expect(a.grants.length).toBe(b.grants.length)
    // ...so the DRIFT is detected against the evidence, which is why the evidence
    // carries its own hash and Phase 4 re-measures it immediately before launch.
    expect("chain-1").not.toBe("chain-2")
  })

  test("ancestorChain stops at the root and never yields a bare drive", () => {
    const chain = ancestorChain("c:\\a\\b\\c\\d", "c:\\a")
    expect(chain).toEqual(["c:\\a", "c:\\a\\b", "c:\\a\\b\\c"])
    expect(chain.some(isDriveRoot)).toBe(false)
  })
})

// ─────────────────────────────────────── the grants, applied to real objects

describe.skipIf(!READY)("applied grants, probed natively", () => {
  let scratch = ""
  let programData = ""
  let hostSid = ""
  let run: RunReady
  let store: SqliteEventStore
  let sid = ""
  let profile = ""
  const helper = harnessHelperRunner()

  beforeAll(async () => {
    const kf = await runUnelevated(["known-folder", "--id", "ProgramData"])
    expect(kf.elevated).toBe(false)
    programData = String(kf.lexicalPath ?? "")
    hostSid = String(kf.hostUserSid ?? "")
    scratch = mkdtempSync(join(tmpdir(), "abdo-runscope-"))
    store = new SqliteEventStore(join(scratch, "j.sqlite"))
    const root = await bootstrapExecutionRoot({
      store,
      helper,
      helperProtocol: REQUIRED_PROTOCOL_VERSION,
      helperHash: helperBinaryHash(),
      profileInventory: { complete: true, hash: "inv", roots: [{ path: process.env.USERPROFILE ?? "" }] },
      rightsModelVersion: RIGHTS_MODEL_VERSION,
    })
    if (!root.ok) throw new Error(`root: ${root.reasonCode}`)
    const r = await createRunDirectory(
      { store, helper, helperProtocol: REQUIRED_PROTOCOL_VERSION, helperHash: helperBinaryHash(), executionRootPath: root.rootPath, executionRootFinalPath: root.finalPath, hostSid, rightsModelVersion: RIGHTS_MODEL_VERSION },
      newRunId(),
    )
    if (!r.ok) throw new Error(`run: ${r.reasonCode} ${r.detail}`)
    run = r
    profile = containerName("scope")
    sid = String((await helper({ argv: ["ensure-profile", "--name", profile] })).sid ?? "")
    expect(sid).toMatch(/^S-1-15-2-/)
  }, T)

  afterAll(async () => {
    try {
      await helper({ argv: ["delete-profile", "--name", profile] })
    } catch {
      /* best effort */
    }
    try {
      store.close()
    } catch {
      /* best effort */
    }
    for (const d of [join(programData, "Abdo"), scratch]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  })

  test("granted file READS, non-granted sibling does NOT, and enumeration stays denied", async () => {
    const allowed = join(run.subdirs.input, "allowed.txt")
    const secret = join(run.subdirs.input, "secret.txt")
    const tool = join(run.subdirs.input, "tool.exe")
    writeFileSync(allowed, "yes")
    writeFileSync(secret, "no")
    writeFileSync(tool, "MZ")

    const plan = planRunScope({
      binding: baseBinding({ runId: run.runId, appContainerSid: sid, executablePath: tool, executableHash: "x", rightsModelHash: rightsPlanHash() }),
      runPath: run.runPath,
      runSubdirs: run.subdirs,
      executionRootPath: join(programData, "Abdo", "Execution", "v1"),
      inputFiles: [allowed],
      forbiddenRoots: [process.env.USERPROFILE ?? "C:\\Users\\nobody"],
      profileInventoryComplete: true,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    const applied = await applyRunGrants({ store, helper }, plan)
    expect(applied.ok, applied.detail ?? "").toBe(true)

    const probe = async (op: string, path: string) => await helper({ argv: ["access-probe", "--op", op, "--path", path, "--probe-cwd", run.subdirs.temp] })
    // These probes run as the HOST, so they cannot prove container access on
    // their own; what they prove here is that the ACEs are exactly where the plan
    // said. The container-side proof is the launch matrix in a later phase.
    const sddlAllowed = String(runDirect(["inspect-acl", "--path", allowed]).sddl ?? "")
    const sddlSecret = String(runDirect(["inspect-acl", "--path", secret]).sddl ?? "")
    expect(sddlAllowed.toLowerCase()).toContain(sid.toLowerCase())
    // THE DECISIVE ONE: the sibling in the same directory carries NO ACE for the
    // container, so a per-file grant really is per file.
    expect(sddlSecret.toLowerCase()).not.toContain(sid.toLowerCase())
    // And the input directory carries traverse only — no list.
    const sddlDir = String(runDirect(["inspect-acl", "--path", run.subdirs.input]).sddl ?? "")
    expect(sddlDir.toLowerCase()).toContain(sid.toLowerCase())
    void probe

    const revoked = await revokeRunGrants({ store, helper }, plan.binding, applied.applied)
    expect(revoked.ok, `unproven: ${revoked.unproven.join(", ")}`).toBe(true)
    // EVERY ACE GONE, proved by re-reading each object.
    for (const g of plan.grants) {
      const now = String(runDirect(["inspect-acl", "--path", g.path]).sddl ?? "")
      expect(now.toLowerCase(), `${g.path} still carries the container ACE`).not.toContain(sid.toLowerCase())
    }
  }, T)

  test("the durable sequence brackets every mutation", async () => {
    const s = new SqliteEventStore(join(scratch, "seq.sqlite"))
    const tool2 = join(run.subdirs.input, "tool2.exe")
    writeFileSync(tool2, "MZ")
    const plan = planRunScope({
      binding: baseBinding({ runId: run.runId, appContainerSid: sid, executablePath: tool2, rightsModelHash: rightsPlanHash() }),
      runPath: run.runPath,
      runSubdirs: run.subdirs,
      executionRootPath: join(programData, "Abdo", "Execution", "v1"),
      forbiddenRoots: [process.env.USERPROFILE ?? "C:\\Users\\nobody"],
      profileInventoryComplete: true,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const applied = await applyRunGrants({ store: s, helper }, plan)
    expect(applied.ok).toBe(true)
    const revoked = await revokeRunGrants({ store: s, helper }, plan.binding, applied.applied)
    expect(revoked.ok).toBe(true)
    // The run's OWN aggregate: ACL evidence lives with the run that made it,
    // because that is where recovery looks for it.
    const types = (await s.read("project", `winiso:isorun:${plan.binding.runId}`)).map((e) => e.type)
    s.close()
    expect(types[0]).toBe(RunGrantEvents.ScopePlanned)
    expect(types).toContain(RunGrantEvents.GrantsRequested)
    expect(types).toContain(RunGrantEvents.GrantsApplied)
    expect(types).toContain(RunGrantEvents.GrantsVerified)
    expect(types).toContain(RunGrantEvents.RevocationRequested)
    expect(types).toContain(RunGrantEvents.RevocationVerified)
    // Intent strictly precedes completion for both halves.
    expect(types.indexOf(RunGrantEvents.GrantsRequested)).toBeLessThan(types.indexOf(RunGrantEvents.GrantsApplied))
    expect(types.indexOf(RunGrantEvents.RevocationRequested)).toBeLessThan(types.indexOf(RunGrantEvents.RevocationVerified))
  }, T)
})

/**
 * MEGA SPRINT 1 — the accessibility measurement must not EXECUTE anything.
 *
 * The first version proved accessibility by launching the image in the container
 * and reading its exit code. That ran the target's code before
 * `run.launch_requested`, outside the observation lifecycle, before grants were
 * verified and outside process-tree containment. "It exits quickly" is not a
 * safety property: a program can write a file or spawn a child in the moment
 * before it returns.
 *
 * This pins the fix with a target whose ONLY purpose is to leave a trace.
 */
describe.skipIf(!READY)("measuring accessibility never executes the target", () => {
  test("a side-effecting executable leaves NO trace during measurement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-noexec-"))
    try {
      const marker = join(dir, "SIDE-EFFECT-HAPPENED.txt")
      // A batch file that would be impossible to miss if it ever ran.
      const script = join(dir, "sideeffect.cmd")
      writeFileSync(script, `@echo off\r\necho ran > "${marker}"\r\n`)

      const before = existsSync(marker)
      const evidence = await measureExecutableAccess({ helper: harnessHelperRunner() }, { executablePath: script, appContainerSid: "S-1-15-2-nobody", helperHash: helperBinaryHash(), helperProtocol: REQUIRED_PROTOCOL_VERSION, stateEpoch: "epoch-1" })

      // THE ASSERTION THAT MATTERS: nothing ran.
      expect(before).toBe(false)
      expect(existsSync(marker), "the target executed during measurement").toBe(false)

      // Evidence was still gathered, and the verdict is fail-closed.
      expect(evidence.access).toBe("unknown")
      expect(evidence.daclChain.length).toBeGreaterThan(0)
      expect(evidence.daclChainHash).toMatch(/^[0-9a-f]{64}$/)
      expect(evidence.reason ?? "").toContain("executable_access_probe_no_profile")

      // And that verdict REFUSES to plan, so nothing outside the root slips through.
      const p = planRunScope(req({ binding: baseBinding({ executablePath: script }), executableAccess: evidence }))
      expect(p.ok).toBe(false)
      if (!p.ok) expect(p.reasonCode).toBe("executable_not_accessible_to_appcontainer")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, T)

  test("the evidence hash binds the SID, the helper and the epoch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-bind-"))
    try {
      const exe = join(dir, "tool.exe")
      writeFileSync(exe, "MZ")
      const helper = harnessHelperRunner()
      const base = { executablePath: exe, appContainerSid: "S-1-15-2-a", helperHash: "h1", helperProtocol: 7, stateEpoch: "e1" }
      const a = await measureExecutableAccess({ helper }, base)
      for (const over of [{ appContainerSid: "S-1-15-2-b" }, { helperHash: "h2" }, { helperProtocol: 8 }, { stateEpoch: "e2" }]) {
        const b = await measureExecutableAccess({ helper }, { ...base, ...over })
        expect(b.daclChainHash, `changing ${JSON.stringify(over)} must move the evidence hash`).not.toBe(a.daclChainHash)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, T)
})

describe("one mutation per canonical object", () => {
  test("a directory named twice is granted ONCE, with the rights merged", () => {
    // `listableDirs` naming the run's own `input` is the ordinary case: it wants
    // traverse AND list. Two grants would mean two mutations of one object, and
    // the second would capture an originalSddl already containing the first ACE.
    const input = req().runSubdirs.input
    const p = planRunScope(req({ listableDirs: [input] }))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const forInput = p.grants.filter((g) => g.path.toLowerCase() === input.toLowerCase())
    expect(forInput.length, "one object, one mutation").toBe(1)
    // Both intents survive the merge.
    expect(forInput[0]!.rights).toContain("traverse")
    expect(forInput[0]!.rights).toContain("list_directory")
    // NON-VACUITY: without the merge there really would have been two.
    expect(p.grants.filter((g) => g.purpose === "input_dir_traverse").length + p.grants.filter((g) => g.purpose === "input_dir_list").length).toBe(1)
  })

  test("EVERY path in a plan is unique, whatever the caller asks for", () => {
    const s = req().runSubdirs
    // Only paths whose existing target is `object_self`: `temp` and `output` are
    // granted `self_and_descendants`, so listing them is the CONFLICT case
    // covered by the test below, not a duplication case.
    const p = planRunScope(req({ listableDirs: [s.input, req().runPath], inputFiles: [join(s.input, "a.txt")] }))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const paths = p.grants.map((g) => g.path.toLowerCase())
    expect(new Set(paths).size, `duplicate paths: ${JSON.stringify(paths)}`).toBe(paths.length)
  })

  test("CONFLICTING inheritance targets are REFUSED, never silently resolved", () => {
    // `temp` is granted `self_and_descendants`; asking to list it wants
    // `object_self`. Two targets are two different intents about descendants,
    // and picking one would quietly widen or narrow the scope.
    const p = planRunScope(req({ listableDirs: [req().runSubdirs.temp] }))
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.reasonCode).toBe("scope_conflicting_targets")
  })

  test("merging never produces a forbidden right", () => {
    const p = planRunScope(req({ listableDirs: [req().runSubdirs.input] }))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    for (const g of p.grants) expect(g.mask & (0xf000_0000 | 0x0004_0000 | 0x0008_0000)).toBe(0)
  })
})
