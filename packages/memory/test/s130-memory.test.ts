import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FactStore } from "../src/store"
import { SqliteFactStore } from "../src/sqlite-store"
import { recall, report, FALSE_MEMORY_BUDGET } from "../src/recall"
import { assemble } from "../src/layers"
import type { Fact, RecordFactInput } from "../src/types"
import type { MemoryItem } from "../src/layers"

/**
 * S130 — scope, TTL, a declared false-memory rate, and verified compaction.
 *
 * # The two stores are tested by the same suite
 *
 * The in-memory reference and the `bun:sqlite` durable store must not be able
 * to disagree, because a disagreement would be invisible: each would pass its
 * own tests while answering the same question differently depending on which
 * one the run happened to be holding. So the behavioural suite below is
 * parameterised over both, and the invariants live in `validity.ts` where both
 * read them.
 *
 * # The false-memory rate is measured against an independent judgement
 *
 * Auditing the filter with the filter proves the filter agrees with itself. The
 * audit here re-derives validity for every served fact from the scope and the
 * clock, which is the question the caller actually cares about: *was the run
 * entitled to this?*
 */

interface StoreUnderTest {
  readonly name: string
  readonly make: (now: () => number) => {
    readonly record: (input: RecordFactInput) => Fact
    readonly verify: (id: string) => Fact
    readonly supersede: (id: string, input: RecordFactInput) => Fact
    readonly invalidate: (id: string) => Fact
    readonly all: () => Fact[]
    readonly current: (
      projectId: string,
      kind?: Fact["kind"],
      options?: { readonly now?: number; readonly sessionId?: string },
    ) => Fact[]
  }
}

const STORES: readonly StoreUnderTest[] = [
  { name: "in-memory", make: (now) => new FactStore(now) },
  { name: "bun:sqlite", make: (now) => new SqliteFactStore(":memory:", now) },
]

test("S130 reopening SQLite advances ids instead of replacing history", () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-memory-reopen-"))
  const path = join(dir, "facts.sqlite")
  try {
    const first = new SqliteFactStore(path, () => 1_000)
    const recorded = first.record({ projectId: "p", kind: "project_fact", key: "one", value: 1, sourceEventIds: ["e1"] })
    first.close()
    const reopened = new SqliteFactStore(path, () => 2_000)
    const next = reopened.record({ projectId: "p", kind: "project_fact", key: "two", value: 2, sourceEventIds: ["e2"] })
    expect(next.id).not.toBe(recorded.id)
    expect(reopened.all().map((fact) => fact.key)).toEqual(["one", "two"])
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const base = (patch: Partial<RecordFactInput> = {}): RecordFactInput => ({
  projectId: "p1",
  kind: "project_fact",
  key: "runtime",
  value: "bun",
  ...patch,
})

describe.each(STORES.map((store) => [store.name, store] as const))("S130 %s store", (_name, store) => {
  test("an expired fact is not served after its TTL", () => {
    let clock = 1_000
    const memory = store.make(() => clock)
    memory.record(base({ key: "short-lived", expiresAt: 2_000 }))
    memory.record(base({ key: "permanent" }))

    expect(memory.current("p1").map((fact) => fact.key).sort()).toEqual(["permanent", "short-lived"])
    clock = 2_000
    // At exactly the expiry, not after it: a TTL that grants one more use is a
    // TTL nobody can reason about.
    expect(memory.current("p1").map((fact) => fact.key)).toEqual(["permanent"])
  })

  test("a session-scoped fact is invisible to another session", () => {
    const memory = store.make(() => 1_000)
    memory.record(base({ key: "session-only", sessionId: "s1" }))
    memory.record(base({ key: "project-wide" }))

    expect(memory.current("p1", undefined, { sessionId: "s1" }).map((f) => f.key).sort()).toEqual([
      "project-wide",
      "session-only",
    ])
    expect(memory.current("p1", undefined, { sessionId: "s2" }).map((f) => f.key)).toEqual(["project-wide"])
    // And with no session at all, a session-scoped fact stays hidden. The most
    // common false memory is not an expired fact — it is one that was true in
    // another conversation.
    expect(memory.current("p1").map((f) => f.key)).toEqual(["project-wide"])
  })

  test("another project's facts are never served", () => {
    const memory = store.make(() => 1_000)
    memory.record(base({ projectId: "p2", key: "theirs" }))
    memory.record(base({ key: "ours" }))
    expect(memory.current("p1").map((f) => f.key)).toEqual(["ours"])
  })

  test("retired facts are kept and not served", () => {
    let clock = 1_000
    const memory = store.make(() => clock)
    const first = memory.record(base({ key: "port", value: 3000 }))
    clock = 2_000
    memory.supersede(first.id, base({ key: "port", value: 4000 }))
    clock = 3_000

    expect(memory.current("p1").map((f) => f.value)).toEqual([4000])
    // History survives: "why it changed" is the thing a summary loses.
    expect(memory.all().length).toBe(2)
    expect(memory.all().find((f) => f.id === first.id)?.status).toBe("superseded")
  })

  test("verification still requires provenance, in both stores", () => {
    const memory = store.make(() => 1_000)
    const bare = memory.record(base({ key: "guess" }))
    expect(() => memory.verify(bare.id)).toThrow(/no documented source/)
    const sourced = memory.record(base({ key: "measured", sourceEventIds: ["evt_1"] }))
    expect(memory.verify(sourced.id).status).toBe("verified")
  })

  test("a credential must be a reference, in both stores", () => {
    const memory = store.make(() => 1_000)
    expect(() => memory.record(base({ kind: "credential_reference", value: "hunter2" }))).toThrow()
    expect(memory.record(base({ kind: "credential_reference", value: "vault://db/password" })).status).toBe(
      "candidate",
    )
  })
})

// --- the declared rate -------------------------------------------------------------

describe("S130 the false-memory rate is measured and declared", () => {
  const rng = (seed: number) => {
    let state = seed >>> 0 || 1
    return () => {
      state ^= state << 13
      state >>>= 0
      state ^= state >>> 17
      state ^= state << 5
      state >>>= 0
      return state / 0x100000000
    }
  }

  test("across 20,000 recalls over a deliberately messy store, the rate is inside the budget", () => {
    const next = rng(0x5130)
    const memory = new SqliteFactStore(":memory:", () => 1_000)
    // A store built to be dangerous: expired facts, other projects, other
    // sessions, retired rows. A clean store would produce a 0% rate that meant
    // nothing.
    for (let index = 0; index < 400; index++) {
      const projectId = next() < 0.7 ? "p1" : `p${2 + Math.floor(next() * 3)}`
      const sessionId = next() < 0.4 ? `s${Math.floor(next() * 3)}` : undefined
      const expiresAt = next() < 0.4 ? 1_000 + Math.floor(next() * 4_000) : undefined
      const fact = memory.record(base({ projectId, sessionId, key: `k${index}`, expiresAt }))
      if (next() < 0.2) memory.invalidate(fact.id)
    }

    const results = []
    for (let round = 0; round < 20_000; round++) {
      results.push(
        memory.query({
          projectId: "p1",
          sessionId: next() < 0.5 ? `s${Math.floor(next() * 3)}` : undefined,
          now: 1_000 + Math.floor(next() * 6_000),
          minConfidence: next() < 0.3 ? 0.4 : undefined,
        }),
      )
    }

    const declared = report(results)
    console.log(
      `[S130] ${declared.recalls} recalls served ${declared.served} facts; false memories ${declared.falseMemories} (${declared.rate.toFixed(3)}%, budget ${declared.budget}%)`,
    )
    expect(declared.withinBudget).toBe(true)
    expect(declared.rate).toBeLessThanOrEqual(FALSE_MEMORY_BUDGET)
    // A rate of zero over zero served facts is not a low error rate, it is no
    // measurement — so the sweep has to have actually served something.
    expect(declared.served).toBeGreaterThan(10_000)
    // And the store really was dangerous: most candidate rows were refused.
    const refused = results.reduce((sum, result) => sum + result.rejected.length, 0)
    expect(refused).toBeGreaterThan(declared.served)
    memory.close()
  }, 60_000)

  test("the audit reports a false memory when it is given one", () => {
    // The check that makes the number above worth reading: a served fact that
    // is not intrinsically valid must be counted, not explained away.
    const now = 5_000
    const expired: Fact = {
      id: "f1",
      projectId: "p1",
      kind: "project_fact",
      key: "k",
      value: 1,
      status: "candidate",
      confidence: 1,
      sourceEventIds: [],
      sourceFilePaths: [],
      validFrom: 0,
      expiresAt: 1_000,
      createdAt: 0,
    }
    const honest = recall([expired], { projectId: "p1", now })
    expect(honest.facts).toEqual([])
    expect(honest.rejected[0]?.why).toContain("expired")

    // Force the failure the audit exists to catch: a serving path that let it
    // through anyway.
    const forged = { ...honest, facts: [expired], falseMemories: [{ id: "f1", why: "expired" }] }
    const declared = report([forged])
    expect(declared.falseMemories).toBe(1)
    expect(declared.rate).toBe(100)
    expect(declared.withinBudget).toBe(false)
  })

  test("a report over nothing does not claim a clean record", () => {
    const empty = report([])
    expect(empty.rate).toBe(0)
    expect(empty.served).toBe(0)
    // The distinction the flag exists for: 0% of nothing is not a pass.
    expect(empty.withinBudget).toBe(false)
  })
})

// --- compaction ---------------------------------------------------------------------

describe("S130 compaction keeps what must not be lost", () => {
  const items = (count: number): MemoryItem[] => {
    const list: MemoryItem[] = [
      { id: "rule-1", layer: "L0", text: "never touch the session store", tokens: 20, at: 0 },
      { id: "goal", layer: "L0", text: "add the export endpoint", tokens: 20, at: 0 },
      { id: "dna-1", layer: "L1", text: "runtime is bun", tokens: 15, at: 0 },
    ]
    for (let index = 0; index < count; index++) {
      list.push({
        id: `hist-${index}`,
        layer: "L2",
        text: `turn ${index}`,
        tokens: 60,
        relevance: (index % 10) / 10,
        at: index,
      })
    }
    return list
  }

  test("compression is at least 60% and every pinned item survives", () => {
    const all = items(200)
    const before = all.reduce((sum, item) => sum + item.tokens, 0)
    const result = assemble(all, { totalTokens: Math.floor(before * 0.35) })
    expect(result.impossible).toBeFalsy()
    if (result.impossible === true) return

    const saved = ((before - result.usedTokens) / before) * 100
    const pinned = all.filter((item) => item.layer === "L0")
    const keptIds = new Set(result.included.map((item) => item.id))
    console.log(
      `[S130] compaction: ${before} → ${result.usedTokens} tokens (−${saved.toFixed(1)}%), ${result.included.length} of ${all.length} items kept`,
    )

    expect(saved).toBeGreaterThanOrEqual(60)
    // The condition that matters more than the ratio: an agent that compresses
    // away the constraint it was given has not saved anything.
    for (const item of pinned) expect(keptIds.has(item.id), item.id).toBe(true)
    expect(result.droppedForBudget.every((entry) => entry.layer !== "L0")).toBe(true)
  })

  test("a budget too small for the pinned layer is impossible, not lossy", () => {
    const result = assemble(items(10), { totalTokens: 5 })
    expect(result.impossible).toBe(true)
    if (result.impossible !== true) return
    expect(result.why.length).toBeGreaterThan(0)
    expect(result.shortfall).toBeGreaterThan(0)
  })
})
