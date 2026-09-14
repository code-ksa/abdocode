import { describe, expect, test } from "bun:test"
import { estimateTokens } from "@abdo/schema/tokens"
import { ContextCompiler } from "../src/compiler"

/**
 * S129 — the three numbers, and the workload they are measured on.
 *
 * **Pinned retention = 100%** is structural rather than statistical: the
 * compiler refuses when the pinned set does not fit, so there is no path on
 * which a pin is dropped. The sweep below confirms it across ten thousand
 * randomized workloads anyway, because "structurally impossible" is a claim
 * about code somebody can change.
 *
 * **Relevant recall ≥ 98%** and **input tokens −35%** are properties of a
 * workload, not of the compiler alone, and that has to be said out loud: with
 * a budget larger than the input, savings are zero and recall is perfect; with
 * a budget of one token, the reverse. So the numbers are measured on a mix
 * chosen to look like an actual session — mostly low-relevance history and
 * files, a handful of instructions, a few pinned constraints — and the same
 * measurement is then run across a **range** of budgets and printed, so the
 * one asserted point can be read in context instead of standing alone.
 */

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

const filler = (chars: number, salt: string) => `${salt} `.repeat(Math.max(1, Math.ceil(chars / (salt.length + 1))))

/**
 * A workload shaped like a session rather than like a test fixture.
 *
 * Real context is dominated by history and files that are mostly irrelevant to
 * the turn in hand; the instructions are few and short; the constraints are
 * fewer and shorter still. A fixture with a uniform relevance distribution
 * would make any selector look good.
 */
const workload = (next: () => number) => {
  const candidates: ContextCompiler.Candidate[] = []
  for (let index = 0; index < 4; index++) {
    candidates.push({
      key: `constraint/${index}`,
      text: filler(120, "never touch the session store"),
      kind: "constraint",
      pinned: true,
      relevance: 1,
    })
  }
  for (let index = 0; index < 6; index++) {
    candidates.push({
      key: `instruction/${index}`,
      text: filler(300, "match the surrounding style"),
      kind: "instruction",
      relevance: 0.6 + next() * 0.4,
    })
  }
  for (let index = 0; index < 20; index++) {
    candidates.push({
      key: `file/${index}`,
      text: filler(400 + Math.floor(next() * 3_000), `file body ${index}`),
      kind: "file",
      relevance: next() < 0.25 ? 0.6 + next() * 0.4 : next() * 0.5,
    })
  }
  for (let index = 0; index < 40; index++) {
    candidates.push({
      key: `history/${index}`,
      text: filler(200 + Math.floor(next() * 900), `turn ${index}`),
      kind: "history",
      relevance: next() < 0.1 ? 0.6 + next() * 0.4 : next() * 0.4,
    })
  }
  return candidates
}

const compiledOr = (candidates: readonly ContextCompiler.Candidate[], budgetTokens: number) => {
  const result = ContextCompiler.compile(candidates, { budgetTokens })
  if (!result.ok) throw new Error(result.why)
  return result.compiled
}

const percent = (part: number, whole: number) => (whole === 0 ? 100 : (part / whole) * 100)

// --- 1. one estimator ------------------------------------------------------------

describe("S129 one estimator", () => {
  test("the compiler's token count is the tree's token count, not a second opinion", () => {
    // The defect this forbids is not hypothetical: four estimators, three
    // dividing by 4 and one by 3, sized the same text 33% apart.
    const candidate: ContextCompiler.Candidate = {
      key: "k",
      text: "abcdefghij",
      kind: "file",
      relevance: 0.5,
    }
    expect(ContextCompiler.tokensOf(candidate)).toBe(estimateTokens(candidate.text))
    expect(estimateTokens("abc")).toBe(1)
    expect(estimateTokens("abcd")).toBe(2)
  })
})

// --- 2. pinned retention -----------------------------------------------------------

describe("S129 a pin is not a preference", () => {
  test("10,000 randomized workloads keep every pin, at every budget", () => {
    const next = rng(0x5129)
    let sweeps = 0
    let refusals = 0
    let keptRelevant = 0
    let totalRelevant = 0

    for (let round = 0; round < 10_000; round++) {
      const candidates = workload(next)
      const all = candidates.reduce((sum, candidate) => sum + ContextCompiler.tokensOf(candidate), 0)
      // Budgets from far below the pinned set to comfortably large. The first
      // run of this sweep never refused once — the pinned set is small and even
      // a 2% budget cleared it — so the guarantee that matters most was the one
      // path never taken. The floor is now a handful of tokens.
      const budget = round % 4 === 0 ? 1 + Math.floor(next() * 120) : Math.floor(all * (0.05 + next() * 0.9))
      const result = ContextCompiler.compile(candidates, { budgetTokens: budget })
      if (!result.ok) {
        refusals += 1
        expect(result.why).toContain("pinned context needs")
        continue
      }
      sweeps += 1
      const score = ContextCompiler.recall(candidates, result.compiled)
      if (score.pinnedKept !== score.pinnedTotal) {
        throw new Error(`round ${round}: kept ${score.pinnedKept} of ${score.pinnedTotal} pins at budget ${budget}`)
      }
      if (result.compiled.tokensAfter > budget) {
        throw new Error(`round ${round}: used ${result.compiled.tokensAfter} tokens of a ${budget} budget`)
      }
      keptRelevant += score.relevantKept
      totalRelevant += score.relevantTotal
    }

    console.log(
      `[S129] ${sweeps} compilations kept 100% of pins; ${refusals} refused for a budget below the pinned set; relevant recall across the sweep ${percent(keptRelevant, totalRelevant).toFixed(1)}%`,
    )
    // Both paths have to have been taken, or one of the two guarantees was
    // never actually exercised.
    expect(sweeps).toBeGreaterThan(1_000)
    expect(refusals).toBeGreaterThan(100)
  })

  test("a budget below the pinned set is refused, not trimmed", () => {
    const candidates: readonly ContextCompiler.Candidate[] = [
      { key: "c1", text: filler(600, "never log the token"), kind: "constraint", pinned: true, relevance: 1 },
      { key: "f1", text: filler(600, "body"), kind: "file", relevance: 0.9 },
    ]
    const result = ContextCompiler.compile(candidates, { budgetTokens: 10 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.why).toContain("pinned context needs")
    // The failure this forbids: quietly dropping "never log the token" and
    // proceeding, confidently, to log the token.
  })

  test("the sweep would notice a dropped pin, so its silence means something", () => {
    // Same comparison the sweep makes, against a compilation that really did
    // lose a pin.
    const candidates: readonly ContextCompiler.Candidate[] = [
      { key: "c1", text: "x", kind: "constraint", pinned: true, relevance: 1 },
      { key: "c2", text: "y", kind: "constraint", pinned: true, relevance: 1 },
    ]
    const compiled = compiledOr(candidates, 100)
    const damaged = { ...compiled, kept: compiled.kept.slice(1) }
    const score = ContextCompiler.recall(candidates, damaged)
    expect(score.pinnedKept).toBe(1)
    expect(score.pinnedTotal).toBe(2)
  })
})

// --- 3. recall and saving, on a stated workload ----------------------------------------

describe("S129 recall and saving", () => {
  const measure = (fraction: number, rounds = 200) => {
    const next = rng(0xc0ffee)
    let keptRelevant = 0
    let totalRelevant = 0
    let before = 0
    let after = 0
    for (let round = 0; round < rounds; round++) {
      const candidates = workload(next)
      const all = candidates.reduce((sum, candidate) => sum + ContextCompiler.tokensOf(candidate), 0)
      const compiled = compiledOr(candidates, Math.floor(all * fraction))
      const score = ContextCompiler.recall(candidates, compiled)
      keptRelevant += score.relevantKept
      totalRelevant += score.relevantTotal
      before += compiled.tokensBefore
      after += compiled.tokensAfter
    }
    return { recall: percent(keptRelevant, totalRelevant), saved: ((before - after) / before) * 100 }
  }

  test("there is a budget where both conditions hold at once, and it is found rather than chosen", () => {
    // The two conditions pull against each other, so asserting them at a budget
    // picked in advance measures the choice of budget. The first attempt did
    // exactly that — 45% gave recall 95.5% with savings 55.2%, failing the
    // recall condition — which is the useful finding: below roughly a 55%
    // budget the two are not simultaneously satisfiable on this workload. So
    // the test searches for the tightest budget that satisfies both and reports
    // it, and the assertion is that such a budget exists and is not absurd.
    let operating: { readonly fraction: number; readonly recall: number; readonly saved: number } | undefined
    for (let fraction = 0.3; fraction <= 0.8; fraction += 0.05) {
      const { recall: recallPercent, saved } = measure(fraction)
      if (recallPercent >= 98 && saved >= 35) {
        operating = { fraction, recall: recallPercent, saved }
        break
      }
    }

    if (operating === undefined) throw new Error("no budget satisfies both conditions on this workload")
    console.log(
      `[S129] operating point: budget ${(operating.fraction * 100).toFixed(0)}% of raw context → relevant recall ${operating.recall.toFixed(1)}%, input tokens −${operating.saved.toFixed(1)}%`,
    )
    expect(operating.recall).toBeGreaterThanOrEqual(98)
    expect(operating.saved).toBeGreaterThanOrEqual(35)
    // A compiler that only met both at a 95% budget would be meeting them by
    // not compiling.
    expect(operating.fraction).toBeLessThanOrEqual(0.7)
  })

  test("below that point the trade is real, not a bug", () => {
    // Stated so the operating point above cannot be read as "the compiler is
    // perfect": tighten the budget and recall genuinely falls. That is the
    // trade, and it is the caller's to make with a number in hand.
    const tight = measure(0.3)
    console.log(`[S129] at a 30% budget: relevant recall ${tight.recall.toFixed(1)}%, input tokens −${tight.saved.toFixed(1)}%`)
    expect(tight.saved).toBeGreaterThan(60)
    expect(tight.recall).toBeLessThan(98)
  })

  test("the same measurement across a range of budgets, printed rather than asserted", () => {
    // Recall and saving trade against each other by construction, so a single
    // point proves little on its own. The curve is what makes the asserted
    // point readable — and if it ever stops being monotone, something is wrong
    // with the ranking rather than with the budget.
    const rows: string[] = []
    for (const fraction of [0.2, 0.3, 0.45, 0.6, 0.8]) {
      const next = rng(0xc0ffee)
      let keptRelevant = 0
      let totalRelevant = 0
      let before = 0
      let after = 0
      for (let round = 0; round < 200; round++) {
        const candidates = workload(next)
        const all = candidates.reduce((sum, candidate) => sum + ContextCompiler.tokensOf(candidate), 0)
        const compiled = compiledOr(candidates, Math.floor(all * fraction))
        const score = ContextCompiler.recall(candidates, compiled)
        keptRelevant += score.relevantKept
        totalRelevant += score.relevantTotal
        before += compiled.tokensBefore
        after += compiled.tokensAfter
      }
      rows.push(
        `${(fraction * 100).toFixed(0)}%→ recall ${percent(keptRelevant, totalRelevant).toFixed(1)}% / saved ${(((before - after) / before) * 100).toFixed(1)}%`,
      )
    }
    console.log(`[S129] budget curve: ${rows.join(" | ")}`)
    expect(rows).toHaveLength(5)
  })
})

// --- 4. the compilation itself ----------------------------------------------------------

describe("S129 what the compiler returns", () => {
  const candidates: readonly ContextCompiler.Candidate[] = [
    { key: "pin", text: filler(30, "pinned"), kind: "constraint", pinned: true, relevance: 1 },
    { key: "small-good", text: filler(30, "small and relevant"), kind: "instruction", relevance: 0.9 },
    { key: "huge-good", text: filler(3_000, "large and relevant"), kind: "file", relevance: 0.95 },
    { key: "small-poor", text: filler(30, "small and irrelevant"), kind: "history", relevance: 0.05 },
  ]

  test("value per token beats raw relevance, which is the point of a compiler", () => {
    // A filter ranking by relevance alone spends the whole window on
    // `huge-good` and starves everything else.
    const compiled = compiledOr(candidates, ContextCompiler.tokensOf(candidates[0]!) + 40)
    const keys = compiled.kept.map((candidate) => candidate.key)
    expect(keys).toContain("pin")
    expect(keys).toContain("small-good")
    expect(keys).not.toContain("huge-good")
  })

  test("everything dropped says why", () => {
    const compiled = compiledOr(candidates, ContextCompiler.tokensOf(candidates[0]!) + 40)
    expect(compiled.dropped.length).toBeGreaterThan(0)
    for (const entry of compiled.dropped) expect(entry.why).toMatch(/needs \d+ tokens/)
    // Nothing vanishes: every candidate is either kept or explained.
    expect(compiled.kept.length + compiled.dropped.length).toBe(candidates.length)
  })

  test("the same input compiles the same way whatever order it arrives in", () => {
    const budget = ContextCompiler.tokensOf(candidates[0]!) + 40
    const forward = compiledOr(candidates, budget)
    const backward = compiledOr([...candidates].reverse(), budget)
    expect([...forward.kept.map((entry) => entry.key)].sort()).toEqual(
      [...backward.kept.map((entry) => entry.key)].sort(),
    )
    expect(forward.tokensAfter).toBe(backward.tokensAfter)
  })

  test("a nonsense budget is refused rather than interpreted", () => {
    for (const budgetTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = ContextCompiler.compile(candidates, { budgetTokens })
      expect(result.ok, String(budgetTokens)).toBe(false)
    }
  })
})
