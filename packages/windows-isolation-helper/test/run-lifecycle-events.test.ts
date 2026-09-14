/**
 * CL-16A3 MEGA-1 §4 — the lifecycle contract, held to its own rules.
 *
 * Pure, so the driver can be checked against it later without a machine. The
 * value is in what it REJECTS: a completion nobody asked for, a skipped stage,
 * a reorder, a repeat.
 */
import { describe, expect, test } from "bun:test"
import { crashResidueExpected, INTENT_OF, LIFECYCLE_ORDER, MUTATING_STAGES, RunLifecycle, validateLifecycleSequence } from "../src/run-lifecycle-events"

const full = [...LIFECYCLE_ORDER]

describe("the lifecycle contract", () => {
  test("the canonical order is the seventeen events, once each", () => {
    expect(LIFECYCLE_ORDER).toHaveLength(17)
    expect(new Set(LIFECYCLE_ORDER).size).toBe(17)
    expect(LIFECYCLE_ORDER[0]).toBe(RunLifecycle.Requested)
    expect(LIFECYCLE_ORDER[16]).toBe(RunLifecycle.Completed)
  })

  test("a full run validates and is reported COMPLETE", () => {
    const v = validateLifecycleSequence(full)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.complete).toBe(true)
  })

  test("every PREFIX validates — a crash is legal, it just is not complete", () => {
    for (let i = 1; i < full.length; i++) {
      const v = validateLifecycleSequence(full.slice(0, i))
      expect(v.ok, `prefix of ${i} must be legal: ${JSON.stringify(v)}`).toBe(true)
      if (v.ok) expect(v.complete).toBe(false)
    }
  })

  test("a SKIPPED stage is rejected — a gap means a mutation with no bracket", () => {
    const gapped = full.filter((e) => e !== RunLifecycle.GrantsMutating)
    const v = validateLifecycleSequence(gapped)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.problems.some((p) => p.includes(`skipped ${RunLifecycle.GrantsMutating}`))).toBe(true)
  })

  test("a REORDER is rejected", () => {
    const swapped = [...full]
    swapped[3] = full[4]!
    swapped[4] = full[3]!
    const v = validateLifecycleSequence(swapped)
    expect(v.ok).toBe(false)
  })

  test("a REPEAT is rejected", () => {
    const v = validateLifecycleSequence([...full, RunLifecycle.Completed])
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.problems.some((p) => p.startsWith("duplicate"))).toBe(true)
  })

  test("an unknown event is rejected, never ignored", () => {
    const v = validateLifecycleSequence([RunLifecycle.Requested, "run.something_invented"])
    expect(v.ok).toBe(false)
  })

  /**
   * THE ONE THAT MATTERS. A completion without its intent means a side effect
   * happened that nothing durably asked for — the single failure this whole
   * architecture exists to make impossible.
   */
  test.each(Object.entries(INTENT_OF))("%s without %s is rejected", (completion, intent) => {
    const seq = full.filter((e) => e !== intent)
    const v = validateLifecycleSequence(seq)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.problems.some((p) => p.includes(`${completion} recorded without its intent ${intent}`)) || v.problems.some((p) => p.includes(`skipped ${intent}`))).toBe(true)
  })

  test("every intent precedes its completion in the canonical order", () => {
    for (const [completion, intent] of Object.entries(INTENT_OF)) {
      expect(LIFECYCLE_ORDER.indexOf(intent), `${intent} must precede ${completion}`).toBeLessThan(LIFECYCLE_ORDER.indexOf(completion as never))
    }
  })

  test("every mutating stage is a real event, and the list is not empty", () => {
    expect(MUTATING_STAGES.length).toBeGreaterThan(0)
    for (const m of MUTATING_STAGES) expect(LIFECYCLE_ORDER).toContain(m)
  })
})

describe("what a crash implies about the machine", () => {
  test("stopping before any mutation implies NO OS state to reclaim", () => {
    const r = crashResidueExpected([RunLifecycle.Requested, RunLifecycle.RootReady].slice(0, 1))
    expect(r.osStateExpected).toBe(false)
  })

  test("stopping after a mutating stage implies state recovery MUST reclaim", () => {
    for (const m of MUTATING_STAGES) {
      const upto = full.slice(0, LIFECYCLE_ORDER.indexOf(m) + 1)
      expect(crashResidueExpected(upto).osStateExpected, `${m} leaves OS state`).toBe(true)
    }
  })

  test("a COMPLETED run leaves nothing — that is what completed means", () => {
    const r = crashResidueExpected(full)
    expect(r.osStateExpected).toBe(false)
    expect(r.stoppedAfter).toBe(RunLifecycle.Completed)
  })
})
