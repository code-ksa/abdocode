import { describe, expect, test } from "bun:test"
import { Compactor, CompactionError, EMPTY_STATE, type StructuredState, type Summarizer, type SummarizeInput } from "../src/index"

const fakeSummarizer = (fn: (input: SummarizeInput) => { stateJson: string; humanSummary: string }): Summarizer => ({
  async summarize(input) {
    return fn(input)
  },
})

const stateJson = (over: Partial<StructuredState> = {}) => JSON.stringify({ objective: "obj", ...over })

const history = [
  { eventId: "evt_1", role: "user", text: "do the thing" },
  { eventId: "evt_2", role: "assistant", text: "did part of it" },
]

describe("Compactor.decideKind", () => {
  const c = new Compactor({ summarizer: fakeSummarizer(() => ({ stateJson: stateJson(), humanSummary: "" })), rebaseEvery: 5 })
  test("incremental by default", () => {
    expect(c.decideKind({ history, compactionCount: 1 })).toBe("incremental")
  })
  test("rebase every 5th compaction", () => {
    expect(c.decideKind({ history, compactionCount: 4 })).toBe("incremental")
    expect(c.decideKind({ history, compactionCount: 5 })).toBe("rebase")
    expect(c.decideKind({ history, compactionCount: 10 })).toBe("rebase")
  })
  test("rebase on objective change or conflict", () => {
    expect(c.decideKind({ history, compactionCount: 1, objectiveChanged: true })).toBe("rebase")
    expect(c.decideKind({ history, compactionCount: 1, conflict: true })).toBe("rebase")
  })
  test("rebase when the prior human summary grows too large", () => {
    expect(c.decideKind({ history, compactionCount: 1, priorSummary: "x".repeat(9000) })).toBe("rebase")
  })
})

describe("Compactor.compact", () => {
  test("incremental merges into the prior state; provenance keeps source event ids", async () => {
    const prior: StructuredState = { ...EMPTY_STATE, completed: ["setup"] }
    const c = new Compactor({ summarizer: fakeSummarizer(() => ({ stateJson: stateJson({ completed: ["parser"] }), humanSummary: "did parser" })) })
    const r = await c.compact({ history, priorState: prior, compactionCount: 1 })
    expect(r.kind).toBe("incremental")
    expect([...r.state.completed].sort()).toEqual(["parser", "setup"]) // merged
    expect(r.provenance.sourceEventIds).toEqual(["evt_1", "evt_2"])
    expect(r.usedFallback).toBe(false)
  })

  test("rebase rebuilds from history and does NOT inherit prior drift", async () => {
    const prior: StructuredState = { ...EMPTY_STATE, completed: ["stale-a", "stale-b"] }
    const c = new Compactor({ summarizer: fakeSummarizer(() => ({ stateJson: stateJson({ completed: ["real"] }), humanSummary: "" })) })
    const r = await c.compact({ history, priorState: prior, compactionCount: 5 }) // 5 => rebase
    expect(r.kind).toBe("rebase")
    expect(r.state.completed).toEqual(["real"]) // replaced, not unioned with stale
  })

  test("a malformed state JSON is rejected and corrected on retry", async () => {
    let calls = 0
    const c = new Compactor({
      summarizer: fakeSummarizer((input) => {
        calls++
        if (calls === 1) return { stateJson: "{ broken", humanSummary: "" }
        expect(input.retryNote).toBeDefined() // the retry was told why
        return { stateJson: stateJson({ active: ["fixed"] }), humanSummary: "ok" }
      }),
    })
    const r = await c.compact({ history, compactionCount: 1 })
    expect(calls).toBe(2)
    expect(r.state.active).toEqual(["fixed"])
    expect(r.usedFallback).toBe(false)
  })

  test("persistently invalid JSON -> fallback keeps the run alive with prior state", async () => {
    const prior: StructuredState = { ...EMPTY_STATE, objective: "keep me", completed: ["x"] }
    const c = new Compactor({ summarizer: fakeSummarizer(() => ({ stateJson: "nope", humanSummary: "" })), onError: "fallback" })
    const r = await c.compact({ history, priorState: prior, compactionCount: 1 })
    expect(r.usedFallback).toBe(true)
    expect(r.state).toEqual(prior) // authoritative state never invented
    expect(r.humanSummary).toContain("mechanical fallback")
  })

  test("persistently invalid JSON with onError=throw fails loudly", async () => {
    const c = new Compactor({ summarizer: fakeSummarizer(() => ({ stateJson: "nope", humanSummary: "" })), onError: "throw" })
    await expect(c.compact({ history, compactionCount: 1 })).rejects.toBeInstanceOf(CompactionError)
  })

  test("a throwing summarizer degrades to fallback (does not crash the run)", async () => {
    const c = new Compactor({
      summarizer: {
        async summarize() {
          throw new Error("model down")
        },
      },
      onError: "fallback",
    })
    const r = await c.compact({ history, compactionCount: 1 })
    expect(r.usedFallback).toBe(true)
  })

  test("five incremental compactions then a full rebase", async () => {
    const c = new Compactor({ summarizer: fakeSummarizer((i) => ({ stateJson: stateJson({ completed: [`turn-${i.mode}`] }), humanSummary: "" })), rebaseEvery: 5 })
    const kinds: string[] = []
    for (let count = 0; count < 6; count++) {
      const r = await c.compact({ history, compactionCount: count })
      kinds.push(r.kind)
    }
    expect(kinds).toEqual(["incremental", "incremental", "incremental", "incremental", "incremental", "rebase"])
  })
})
