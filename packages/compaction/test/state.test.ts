import { describe, expect, test } from "bun:test"
import { EMPTY_STATE, mergeState, parseStructuredState, type StructuredState } from "../src/index"

describe("parseStructuredState", () => {
  test("a valid payload parses with all fields", () => {
    const r = parseStructuredState(
      JSON.stringify({
        objective: "ship compaction",
        completed: ["manifest"],
        active: ["budget"],
        decisions: [{ id: "d1", decision: "Use SQLite WAL", verified: true, sourceEventIds: ["evt_120"] }],
      }),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.state.objective).toBe("ship compaction")
      expect(r.state.completed).toEqual(["manifest"])
      expect(r.state.decisions[0]?.decision).toBe("Use SQLite WAL")
      expect(r.state.decisions[0]?.sourceEventIds).toEqual(["evt_120"])
    }
  })

  test("invalid JSON is rejected, not silently accepted", () => {
    const r = parseStructuredState("{ not json ")
    expect(r.ok).toBe(false)
  })

  test("a non-object root is rejected", () => {
    expect(parseStructuredState("[1,2,3]").ok).toBe(false)
    expect(parseStructuredState('"a string"').ok).toBe(false)
  })

  test("a non-string objective is rejected", () => {
    expect(parseStructuredState(JSON.stringify({ objective: 42 })).ok).toBe(false)
  })

  test("a decision without an id gets a stable derived id", () => {
    const r = parseStructuredState(JSON.stringify({ decisions: [{ decision: "Prefer async/await", verified: false }] }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.state.decisions[0]?.id).toMatch(/^d_/)
  })
})

describe("mergeState (incremental)", () => {
  const base: StructuredState = {
    ...EMPTY_STATE,
    objective: "build V2",
    completed: ["A"],
    decisions: [{ id: "d1", decision: "Use SQLite", verified: true }],
  }

  test("durable facts accumulate; current views replace", () => {
    const merged = mergeState(base, { ...EMPTY_STATE, completed: ["B"], active: ["C"], pendingTools: ["shell"] })
    expect([...merged.completed].sort()).toEqual(["A", "B"]) // union
    expect(merged.active).toEqual(["C"]) // replaced
    expect(merged.pendingTools).toEqual(["shell"])
  })

  test("a decision with the same id supersedes the old one without deleting it", () => {
    const merged = mergeState(base, { ...EMPTY_STATE, decisions: [{ id: "d1", decision: "Use SQLite WAL", verified: true }] })
    expect(merged.decisions.find((d) => d.id === "d1")?.decision).toBe("Use SQLite WAL")
    expect(merged.superseded).toHaveLength(1)
    expect(merged.superseded[0]?.decision).toBe("Use SQLite")
    expect(merged.superseded[0]?.supersededBy).toBe("d1")
  })

  test("a new decision id is appended, not superseded", () => {
    const merged = mergeState(base, { ...EMPTY_STATE, decisions: [{ id: "d2", decision: "Reserve output tokens", verified: false }] })
    expect(merged.decisions.map((d) => d.id).sort()).toEqual(["d1", "d2"])
    expect(merged.superseded).toHaveLength(0)
  })
})
