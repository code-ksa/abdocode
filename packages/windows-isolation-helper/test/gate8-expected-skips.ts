/**
 * P5c2-FINAL-RC3 §5 — THE MEDIUM GATE 8 EXPECTED-SKIP ALLOWLIST.
 *
 * A count is not a measurement. "2 skip" tells a reader nothing about WHICH two
 * tests did not run, and a suite that silently swaps one skip for another keeps
 * reporting the same reassuring number while its coverage changes underneath.
 * Gate 8 therefore compares IDENTITIES, not totals: the set of tests bun
 * actually skipped must equal the set named here, exactly — no unnamed skip, no
 * new skip, and no allowlisted test that quietly started running without anyone
 * noticing the allowlist is now stale.
 *
 * THE ADMISSION RULE, and it is the whole point of this file: an entry is
 * legitimate ONLY if the proof it omits is supplied somewhere else, and that
 * somewhere is named in `liveProofGate` and must REFUSE to run in the wrong
 * environment rather than skip. A skip whose proof exists nowhere is an unproven
 * claim that looks proven, which is worse than a red test.
 *
 * `todo` is not represented here at all. Gate 8 requires `todo = 0`: a todo is a
 * test that was written down and never made to work, and it must not be able to
 * ride along inside a green round.
 */

export interface ExpectedSkip {
  /** The file, relative to the package root. */
  readonly file: string
  /** The FULL identity bun reports: every enclosing describe, then the test name. */
  readonly identity: string
  /** Why it cannot run at medium integrity. */
  readonly reason: string
  /** The environment it does require. */
  readonly requiredEnvironment: string
  /** The separate gate that supplies the omitted live proof. It never skips. */
  readonly liveProofGate: string
}

export const EXPECTED_SKIPS: readonly ExpectedSkip[] = [
  {
    file: "test/harness-invariants.test.ts",
    identity: "harness failure modes are fast and explicit > killing the server mid-flight fails FAST, not after a long timeout",
    reason:
      "At medium integrity there is no server to kill. `runUnelevated` uses the de-elevation queue server only when the shell is elevated; at medium it calls `runDirect`, which spawns the helper as an ordinary child with no server, no readiness heartbeat and no fail-fast path. Run at medium it would kill a process that does not exist and time nothing.",
    requiredEnvironment: "an ELEVATED, high-integrity shell (RID 12288), where the harness de-elevates through the queue server",
    liveProofGate: "scripts/live-elevated-harness-server.ts — refuses with exit 2 unless the host is really elevated, so it can never pass vacuously",
  },
]

/** The identities only, for set comparison. */
export const expectedSkipIdentities = (): string[] => EXPECTED_SKIPS.map((s) => s.identity).sort()

/**
 * Compare what bun ACTUALLY skipped against what is allowed.
 *
 * Both directions are violations, and the second is the one that rots quietly:
 * an allowlisted test that has started running again means this file is stale
 * and is now excusing a skip that no longer happens — the next real skip would
 * inherit its excuse.
 */
export function compareSkips(actual: readonly string[]): { ok: boolean; unexpected: string[]; missing: string[] } {
  const expected = new Set(expectedSkipIdentities())
  const seen = new Set(actual)
  const unexpected = [...seen].filter((s) => !expected.has(s)).sort()
  const missing = [...expected].filter((s) => !seen.has(s)).sort()
  return { ok: unexpected.length === 0 && missing.length === 0, unexpected, missing }
}

export function formatSkipComparison(c: { unexpected: string[]; missing: string[] }): string[] {
  const problems: string[] = []
  for (const s of c.unexpected) problems.push(`UNNAMED SKIP: "${s}" is not in the expected-skip allowlist. Either repair it to run at medium, or add it WITH the separate gate that proves what it omits.`)
  for (const s of c.missing) problems.push(`STALE ALLOWLIST ENTRY: "${s}" is allowlisted but did NOT skip. It now runs at medium; remove the entry.`)
  return problems
}
