/**
 * CL-16A3 MEGA-1 §4 — the pre-launch gate, exhaustively.
 *
 * Pure, so every drift can be exercised without a machine. The point of a gate
 * is what it REFUSES, so most of this file is refusals.
 */
import { describe, expect, test } from "bun:test"
import { verifyPreLaunch, type PreLaunchExpectation, type PreLaunchObservation } from "../src/pre-launch"

const SID = "S-1-15-2-1111111111-2222222222"

const expected = (over: Partial<PreLaunchExpectation> = {}): PreLaunchExpectation => ({
  runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  stateEpoch: "epoch-1",
  decisionId: "dec-1",
  appContainerSid: SID,
  executablePath: String.raw`C:\ProgramData\Abdo\Execution\v1\S\runs\r\input\tool.exe`,
  executableHash: "exe-hash",
  bindingHash: "binding-hash",
  rightsModelVersion: 1,
  rightsModelHash: "rights-hash",
  profileInventoryHash: "inv-hash",
  helperHash: "helper-hash",
  helperProtocol: 8,
  objectIdentities: { "c:\\run\\input\\tool.exe": "vol1:file1", "c:\\run\\temp": "vol1:file2" },
  objectDaclHashes: { "c:\\run\\input\\tool.exe": "dacl1", "c:\\run\\temp": "dacl2" },
  runRootIdentity: "vol1:root",
  ...over,
})

const now = (e: PreLaunchExpectation, over: Partial<PreLaunchObservation> = {}): PreLaunchObservation => ({
  launchAppContainerSid: e.appContainerSid,
  executableHash: e.executableHash,
  bindingHash: e.bindingHash,
  stateEpoch: e.stateEpoch,
  approvalSnapshot: e.approvalSnapshot,
  rightsModelVersion: e.rightsModelVersion,
  rightsModelHash: e.rightsModelHash,
  profileInventoryHash: e.profileInventoryHash,
  helperHash: e.helperHash,
  helperProtocol: e.helperProtocol,
  objectIdentities: { ...e.objectIdentities },
  objectDaclHashes: { ...e.objectDaclHashes },
  runRootIdentity: e.runRootIdentity,
  executableAccessHash: e.executableAccessHash,
  ...over,
})

describe("the same-SID invariant", () => {
  test("an unchanged world passes, and says what it checked", () => {
    const e = expected()
    const v = verifyPreLaunch(e, now(e))
    expect(v.ok).toBe(true)
    if (!v.ok) return
    // NON-VACUITY: a gate that checks nothing also never fails.
    expect(v.checked).toContain("appContainerSid")
    expect(v.checked).toContain("bindingHash")
    expect(v.checked).toContain("identity:c:\\run\\input\\tool.exe")
    expect(v.checked).toContain("dacl:c:\\run\\temp")
    expect(v.checked.length).toBeGreaterThan(12)
  })

  test("granting to one SID and launching as another is REFUSED, even though both are valid", () => {
    const e = expected()
    const v = verifyPreLaunch(e, now(e, { launchAppContainerSid: "S-1-15-2-9999999999-8888888888" }))
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.reasonCode).toBe("appcontainer_sid_mismatch")
    expect(v.moved).toEqual(["appContainerSid"])
  })

  test("an EMPTY SID on either side is a mismatch, never a pass", () => {
    const e = expected({ appContainerSid: "" })
    expect(verifyPreLaunch(e, now(e)).ok).toBe(false)
    const e2 = expected()
    expect(verifyPreLaunch(e2, now(e2, { launchAppContainerSid: "" })).ok).toBe(false)
  })

  test("SID comparison is case-insensitive but otherwise exact", () => {
    const e = expected()
    expect(verifyPreLaunch(e, now(e, { launchAppContainerSid: SID.toLowerCase() })).ok).toBe(true)
    // One character different is a different identity.
    expect(verifyPreLaunch(e, now(e, { launchAppContainerSid: SID + "0" })).ok).toBe(false)
  })

  test("the SID is checked FIRST — it is reported alone, not buried among other drift", () => {
    const e = expected()
    const v = verifyPreLaunch(e, now(e, { launchAppContainerSid: "S-1-15-2-other", executableHash: "swapped", bindingHash: "moved" }))
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.reasonCode).toBe("appcontainer_sid_mismatch")
    expect(v.moved).toEqual(["appContainerSid"])
  })
})

describe("drift refuses the launch", () => {
  const drifts: [string, Partial<PreLaunchObservation>][] = [
    ["bindingHash", { bindingHash: "different" }],
    ["stateEpoch", { stateEpoch: "epoch-2" }],
    ["executableHash", { executableHash: "swapped" }],
    ["rightsModelVersion", { rightsModelVersion: 2 }],
    ["rightsModelHash", { rightsModelHash: "moved" }],
    ["profileInventoryHash", { profileInventoryHash: "moved" }],
    ["helperHash", { helperHash: "rebuilt" }],
    ["helperProtocol", { helperProtocol: 9 }],
    ["runRootIdentity", { runRootIdentity: "vol1:other" }],
  ]

  test.each(drifts)("%s moving alone refuses with stale_isolation_evidence", (name, over) => {
    const e = expected()
    const v = verifyPreLaunch(e, now(e, over))
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.reasonCode).toBe("stale_isolation_evidence")
    expect(v.moved).toContain(name)
  })

  test("an object SWAPPED for another with the same name is caught by identity", () => {
    const e = expected()
    const v = verifyPreLaunch(e, now(e, { objectIdentities: { ...e.objectIdentities, "c:\\run\\input\\tool.exe": "vol1:DIFFERENT" } }))
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.moved).toContain("identity:c:\\run\\input\\tool.exe")
  })

  test("an ACE added after the grant is caught by the DACL hash", () => {
    const e = expected()
    const v = verifyPreLaunch(e, now(e, { objectDaclHashes: { ...e.objectDaclHashes, "c:\\run\\temp": "widened" } }))
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.moved).toContain("dacl:c:\\run\\temp")
  })

  test("an object that BECAME a reparse point is drift even if its identity string matches", () => {
    const e = expected()
    const v = verifyPreLaunch(e, now(e, { reparseNow: ["c:\\run\\temp"] }))
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.moved).toContain("reparse:c:\\run\\temp")
  })

  test("a VANISHED object is drift — a missing key never reads as unchanged", () => {
    const e = expected()
    const partial = { "c:\\run\\temp": "vol1:file2" }
    const v = verifyPreLaunch(e, now(e, { objectIdentities: partial }))
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.moved).toContain("missing:c:\\run\\input\\tool.exe")
  })

  test("the executable's accessibility evidence is bound too", () => {
    const e = expected({ executableAccessHash: "chain-1" })
    expect(verifyPreLaunch(e, now(e)).ok).toBe(true)
    const v = verifyPreLaunch(e, now(e, { executableAccessHash: "chain-2" }))
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.moved).toContain("executableAccessHash")
  })
})

describe("an approval changes what the same drift MEANS", () => {
  test("with no approval, drift is stale_isolation_evidence", () => {
    const e = expected()
    const v = verifyPreLaunch(e, now(e, { stateEpoch: "epoch-2" }))
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.reasonCode).toBe("stale_isolation_evidence")
  })

  test("WITH an approval, the identical drift is approval_snapshot_stale", () => {
    const e = expected({ approvalSnapshot: "snap-1" })
    const v = verifyPreLaunch(e, now(e, { stateEpoch: "epoch-2" }))
    expect(v.ok).toBe(false)
    if (v.ok) return
    // A human authorised a specific state of the world; it is no longer that
    // state, and the approval is not transferable to this one.
    expect(v.reasonCode).toBe("approval_snapshot_stale")
  })

  test("an approval that itself changed is drift", () => {
    const e = expected({ approvalSnapshot: "snap-1" })
    const v = verifyPreLaunch(e, now(e, { approvalSnapshot: "snap-2" }))
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.moved).toContain("approvalSnapshot")
    expect(v.reasonCode).toBe("approval_snapshot_stale")
  })

  test("an approval APPEARING where there was none is drift, not a silent upgrade", () => {
    const e = expected()
    const v = verifyPreLaunch(e, now(e, { approvalSnapshot: "snap-appeared" }))
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.moved).toContain("approvalSnapshot")
  })
})
