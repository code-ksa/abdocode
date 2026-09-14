/**
 * CL-16A3 MEGA-1 §4 — the last gate before a process starts.
 *
 * Everything Phase 3 produced was true WHEN IT WAS MEASURED. This is where it is
 * re-checked against the world as it is NOW, immediately before the spawn, and
 * where the run is refused rather than launched if anything moved.
 *
 * THE SAME-SID INVARIANT IS THE POINT. ACLs were granted to one AppContainer
 * SID; the process must start as THAT SID. Two valid profiles are not
 * interchangeable — launching as SID B with grants written for SID A produces a
 * container that either cannot read its own inputs or, far worse, is running
 * under an identity nobody authorised while A's ACEs sit on disk unrevoked. It
 * is checked as a byte comparison, not by construction, because "we passed the
 * same variable" is exactly the kind of assumption that stops being true after a
 * refactor.
 *
 * PURE ON PURPOSE. It takes the binding and a set of FRESHLY MEASURED facts and
 * returns a verdict; it performs no IO, so it can be exhaustively tested without
 * a machine, and the caller cannot accidentally let it "fix" anything. A gate
 * that can mutate is not a gate.
 */

/** What was true at plan time — the values Phase 3 hashed into `bindingHash`. */
export interface PreLaunchExpectation {
  readonly runId: string
  readonly stateEpoch: string
  readonly decisionId: string
  readonly approvalSnapshot?: string
  readonly appContainerSid: string
  readonly executablePath: string
  readonly executableHash: string
  readonly bindingHash: string
  readonly rightsModelVersion: number
  readonly rightsModelHash: string
  readonly profileInventoryHash: string
  readonly helperHash: string
  readonly helperProtocol: number
  /** file id + volume serial + reparse flag per granted object, at plan time. */
  readonly objectIdentities: Readonly<Record<string, string>>
  /** SDDL hash per granted object, at plan time. */
  readonly objectDaclHashes: Readonly<Record<string, string>>
  /** The run root's own identity. */
  readonly runRootIdentity: string
  /** The accessibility evidence chain hash, for an outside-root executable. */
  readonly executableAccessHash?: string
}

/** What is true RIGHT NOW, measured moments ago by the caller. */
export interface PreLaunchObservation {
  /** The SID the launch is ACTUALLY about to use. */
  readonly launchAppContainerSid: string
  readonly executableHash: string
  readonly bindingHash: string
  readonly stateEpoch: string
  readonly approvalSnapshot?: string
  readonly rightsModelVersion: number
  readonly rightsModelHash: string
  readonly profileInventoryHash: string
  readonly helperHash: string
  readonly helperProtocol: number
  readonly objectIdentities: Readonly<Record<string, string>>
  readonly objectDaclHashes: Readonly<Record<string, string>>
  readonly runRootIdentity: string
  readonly executableAccessHash?: string
  /** Objects that are reparse points NOW, whatever they were before. */
  readonly reparseNow?: readonly string[]
}

export type PreLaunchVerdict =
  | { readonly ok: true; readonly checked: readonly string[] }
  | { readonly ok: false; readonly reasonCode: string; readonly moved: readonly string[]; readonly detail: string }

/**
 * Re-verify everything the decision rested on. Any drift refuses the launch.
 *
 * The reason code distinguishes two situations that look identical in the data
 * and are not the same to a human: with no approval, drift is
 * `stale_isolation_evidence` — the world moved, re-derive and try again. WITH an
 * approval, the same drift is `approval_snapshot_stale`, because a human
 * authorised a specific state of the world and that is no longer the state they
 * saw. Collapsing them would send an operator looking for a swap that never
 * happened, or hide one that did.
 */
export function verifyPreLaunch(expected: PreLaunchExpectation, now: PreLaunchObservation): PreLaunchVerdict {
  const moved: string[] = []
  const checked: string[] = []

  const cmp = (name: string, a: unknown, b: unknown) => {
    checked.push(name)
    if (a !== b) moved.push(name)
  }

  // THE SAME-SID INVARIANT, first and by byte comparison.
  checked.push("appContainerSid")
  const sidMatches = expected.appContainerSid !== "" && expected.appContainerSid.toLowerCase() === now.launchAppContainerSid.toLowerCase()
  if (!sidMatches) {
    return {
      ok: false,
      reasonCode: "appcontainer_sid_mismatch",
      moved: ["appContainerSid"],
      detail:
        `the ACLs were granted to ${expected.appContainerSid || "(none)"} but the launch would use ${now.launchAppContainerSid || "(none)"}. ` +
        `Two valid profiles are not interchangeable: the grants would be on one identity and the process on another.`,
    }
  }

  cmp("bindingHash", expected.bindingHash, now.bindingHash)
  cmp("stateEpoch", expected.stateEpoch, now.stateEpoch)
  cmp("executableHash", expected.executableHash, now.executableHash)
  cmp("rightsModelVersion", expected.rightsModelVersion, now.rightsModelVersion)
  cmp("rightsModelHash", expected.rightsModelHash, now.rightsModelHash)
  cmp("profileInventoryHash", expected.profileInventoryHash, now.profileInventoryHash)
  cmp("helperHash", expected.helperHash, now.helperHash)
  cmp("helperProtocol", expected.helperProtocol, now.helperProtocol)
  cmp("runRootIdentity", expected.runRootIdentity, now.runRootIdentity)
  cmp("approvalSnapshot", expected.approvalSnapshot ?? "", now.approvalSnapshot ?? "")
  cmp("executableAccessHash", expected.executableAccessHash ?? "", now.executableAccessHash ?? "")

  // Per-object identity and DACL. A file swapped for another with the same name,
  // or an ACE added since the grant, are both drift.
  for (const [path, id] of Object.entries(expected.objectIdentities)) {
    checked.push(`identity:${path}`)
    if (now.objectIdentities[path] !== id) moved.push(`identity:${path}`)
  }
  for (const [path, hash] of Object.entries(expected.objectDaclHashes)) {
    checked.push(`dacl:${path}`)
    if (now.objectDaclHashes[path] !== hash) moved.push(`dacl:${path}`)
  }
  // An object that has BECOME a reparse point is drift even if its recorded
  // identity string happens to match — a junction is a redirection, and the
  // whole plan was built on where these paths pointed.
  for (const p of now.reparseNow ?? []) {
    checked.push(`reparse:${p}`)
    moved.push(`reparse:${p}`)
  }
  // An object that has DISAPPEARED is drift too: a missing key must never read
  // as "unchanged".
  for (const path of Object.keys(expected.objectIdentities)) {
    if (!(path in now.objectIdentities)) moved.push(`missing:${path}`)
  }

  if (moved.length === 0) return { ok: true, checked }
  const approved = Boolean(expected.approvalSnapshot)
  return {
    ok: false,
    reasonCode: approved ? "approval_snapshot_stale" : "stale_isolation_evidence",
    moved,
    detail: approved
      ? `a human approved a specific state of the world and it has since moved: ${moved.join(", ")}. The approval is not transferable to this one.`
      : `the evidence the decision rested on moved before the launch: ${moved.join(", ")}. Re-derive rather than proceed.`,
  }
}
