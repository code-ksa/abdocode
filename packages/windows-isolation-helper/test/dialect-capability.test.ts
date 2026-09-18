/**
 * P11 — the dialect capability matrix, unit-level (ADR-0028 / ADR-0030).
 *
 * The process-level refusal (no child, zero mutation, run.refused in the
 * journal) is proven in `run-lifecycle.test.ts`'s P11 block; this file pins
 * the DECISION itself: what is supported, what refuses, and why an entry
 * without its obligations is not a capability.
 */
import { describe, expect, test } from "bun:test"
import { assessDialect, capabilityEntryMalformed, DIALECT_CAPABILITIES, KNOWN_UNSUPPORTED_DIALECTS, type DialectCapability } from "../src/dialect-capability"

describe("P11 — the capability matrix is measured, never assumed", () => {
  test("the shipped matrix itself is well-formed — every entry carries mechanism AND evidence", () => {
    expect(DIALECT_CAPABILITIES.length).toBeGreaterThan(0)
    for (const c of DIALECT_CAPABILITIES) expect(capabilityEntryMalformed(c), c.dialect).toBeUndefined()
  })

  test("the one measured dialect is supported, with its enforcement named", () => {
    const d = assessDialect("cmd")
    expect(d.supported).toBe(true)
    if (d.supported) {
      expect(d.capability.networkPolicy).toBe("deny_all")
      expect(d.capability.enforcement).toBe("appcontainer_zero_capability_token")
      expect(d.capability.evidence.length).toBeGreaterThan(0)
    }
  })

  test("an UNKNOWN dialect refuses with dialect_unknown — fail-closed, no fallback", () => {
    const d = assessDialect("fish")
    expect(d.supported).toBe(false)
    if (!d.supported) {
      expect(d.reasonCode).toBe("dialect_unknown")
      expect(d.detail).toContain("no measured capability entry")
    }
  })

  test("MSYS2 bash is UNSUPPORTED by name, not merely absent — the reason travels with the refusal", () => {
    expect(KNOWN_UNSUPPORTED_DIALECTS.map((k) => k.dialect)).toContain("msys2-bash")
    const d = assessDialect("msys2-bash")
    expect(d.supported).toBe(false)
    if (!d.supported) {
      expect(d.reasonCode).toBe("dialect_unsupported")
      expect(d.detail).toContain("not an enforcement mechanism")
    }
  })

  test("support advertised WITHOUT enforcement proof is malformed, and refuses like unknown", () => {
    const noEvidence: DialectCapability = { dialect: "cmd", networkPolicy: "deny_all", enforcement: "appcontainer_zero_capability_token", evidence: "" }
    const noMechanism: DialectCapability = { dialect: "cmd", networkPolicy: "deny_all", enforcement: "", evidence: "somewhere" }
    const wrongPolicy = { dialect: "cmd", networkPolicy: "allow_some", enforcement: "x", evidence: "y" } as unknown as DialectCapability
    const emptyLabel: DialectCapability = { dialect: " ", networkPolicy: "deny_all", enforcement: "x", evidence: "y" }
    for (const [entry, want] of [
      [noEvidence, "NO measured qualification evidence"],
      [noMechanism, "NO enforcement mechanism"],
      [wrongPolicy, "unknown network policy"],
    ] as const) {
      const d = assessDialect("cmd", [entry])
      expect(d.supported).toBe(false)
      if (!d.supported) {
        expect(d.reasonCode).toBe("dialect_capability_malformed")
        expect(d.detail).toContain(want)
      }
    }
    expect(capabilityEntryMalformed(emptyLabel)).toContain("empty dialect label")
  })

  test("there is no downgrade path: an unsupported dialect never resolves to a supported capability", () => {
    // The assessment is a pure function of (dialect, matrix): for every refusal
    // shape the result carries NO capability object at all — nothing downstream
    // can 'fall back' to one that was never returned.
    for (const dialect of ["msys2-bash", "fish", "powershell", "native", ""]) {
      const d = assessDialect(dialect)
      expect(d.supported).toBe(false)
      expect("capability" in d).toBe(false)
    }
  })
})
