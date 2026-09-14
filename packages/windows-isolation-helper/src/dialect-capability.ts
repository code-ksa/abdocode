/**
 * P11 — THE DIALECT CAPABILITY MATRIX, typed and built only from measured
 * behaviour (ADR-0028 fail-closed network denial; ADR-0030 owner decision).
 *
 * The rule, verbatim from ADR-0030: generic shell `deny_all` is unsupported.
 * A dialect may advertise `deny_all` only when that EXACT dialect has a real
 * enforcement mechanism AND that mechanism has measured qualification
 * evidence. An entry in this matrix is therefore a CLAIM WITH A CITATION —
 * an entry without a mechanism or without evidence is malformed and refuses
 * exactly like an unknown dialect. Nothing here is aspirational: if it is not
 * measured in this repository, it is not in the matrix.
 *
 * The refusal contract (enforced at the run driver's first fail-closed
 * precondition): an unsupported, unknown or malformed dialect refuses BEFORE
 * launch — structured reasonCode, no child process, zero filesystem mutation,
 * zero residue. No silent downgrade, no warn-only mode, no
 * unrestricted-network fallback.
 */

export interface DialectCapability {
  /** The requesting dialect's exact label, as bound into run evidence. */
  readonly dialect: string
  /** The only network policy defined today. */
  readonly networkPolicy: "deny_all"
  /** The REAL enforcement mechanism — never a convention, never a hope. */
  readonly enforcement: string
  /** Where the measured qualification evidence lives. Required (ADR-0030). */
  readonly evidence: string
}

/**
 * The measured matrix. ONE entry today, because one dialect is measured:
 *
 * - `cmd` is the dialect label the entire isolated-run corpus executes under
 *   (`run-lifecycle.test.ts`, the live AppContainer round). Its `deny_all`
 *   enforcement is the zero-capability AppContainer token — the child gets NO
 *   network capability, whatever image it is — measured by the egress probes
 *   in `appcontainer.test.ts` (curl and friends refused inside the container).
 *
 * `native`/`powershell` requesting dialects have no measured entry YET and
 * therefore refuse as unknown — fail-closed is the point, not an oversight.
 */
export const DIALECT_CAPABILITIES: readonly DialectCapability[] = [
  {
    dialect: "cmd",
    networkPolicy: "deny_all",
    enforcement: "appcontainer_zero_capability_token",
    evidence: "test/appcontainer.test.ts network egress probes; test/run-lifecycle.test.ts corpus; live round LIVE-OK",
  },
]

/**
 * Dialects that are KNOWN and deliberately unsupported — named so their
 * refusal carries the reason, not just the absence of an entry.
 */
export const KNOWN_UNSUPPORTED_DIALECTS: readonly { readonly dialect: string; readonly why: string }[] = [
  {
    dialect: "msys2-bash",
    why: "MSYS2 bash does not start inside a zero-capability AppContainer; a startup failure is not an enforcement mechanism (ADR-0028, ADR-0030) — unsupported, never a degraded success",
  },
]

export type DialectAssessment =
  | { readonly supported: true; readonly capability: DialectCapability }
  | { readonly supported: false; readonly reasonCode: "dialect_unknown" | "dialect_unsupported" | "dialect_capability_malformed"; readonly detail: string }

/** An entry is well-formed only when every ADR-0030 obligation is present. */
export function capabilityEntryMalformed(c: DialectCapability): string | undefined {
  if (!c.dialect || c.dialect.trim() === "") return "entry has an empty dialect label"
  if ((c.networkPolicy as string) !== "deny_all") return `entry for '${c.dialect}' advertises unknown network policy '${String(c.networkPolicy)}'`
  if (!c.enforcement || c.enforcement.trim() === "") return `entry for '${c.dialect}' advertises deny_all with NO enforcement mechanism`
  if (!c.evidence || c.evidence.trim() === "") return `entry for '${c.dialect}' advertises deny_all with NO measured qualification evidence`
  return undefined
}

/**
 * Decide, fail-closed. The matrix is injectable so the malformed-entry path is
 * testable without shipping a malformed matrix.
 */
export function assessDialect(dialect: string, matrix: readonly DialectCapability[] = DIALECT_CAPABILITIES): DialectAssessment {
  const known = KNOWN_UNSUPPORTED_DIALECTS.find((k) => k.dialect === dialect)
  if (known) return { supported: false, reasonCode: "dialect_unsupported", detail: known.why }

  const entry = matrix.find((c) => c.dialect === dialect)
  if (!entry) {
    return {
      supported: false,
      reasonCode: "dialect_unknown",
      detail: `dialect '${dialect}' has no measured capability entry — an unmeasured dialect refuses before launch (ADR-0030); it gains support only through measured qualification evidence, never by fallback`,
    }
  }
  const malformed = capabilityEntryMalformed(entry)
  if (malformed) {
    // A malformed entry refuses exactly like an unknown dialect: a claim
    // without its obligations is not a capability (ADR-0030 consequence 3).
    return { supported: false, reasonCode: "dialect_capability_malformed", detail: malformed }
  }
  return { supported: true, capability: entry }
}
