import { describe, expect, test } from "bun:test"
import { REPERTOIRE, STILLNESS_LIMIT, STRATEGIES, next, stillness, untried, type Attempt, type Strategy } from "../src/strategy"

/**
 * S131 — the three numbers, measured against a naive arm.
 *
 * # Why there are two arms
 *
 * "Repeated failed strategy down 70%" is a comparison, and a comparison needs
 * something to compare against. The naive arm is what an agent does without
 * this module: retry the preferred strategy, and when it keeps failing, keep
 * going. Both arms face the **same simulated tasks with the same seed**, so
 * the only difference between them is whether the run is allowed to notice it
 * is looping.
 *
 * # Why "false stop" is the number that matters most
 *
 * Escalating too late burns budget and is visible. Escalating too early
 * abandons a task that was one attempt from done and is **invisible** — the
 * run reports that it stopped responsibly, and nobody goes back to check. So
 * the simulation knows ground truth: every task has a strategy that would have
 * solved it, and a stop before trying it is counted as a false stop.
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

/**
 * A task with a known answer.
 *
 * `solvedBy` is the strategy that works. `learns` is the set of strategies that
 * produce new evidence even when they fail — the distinction the whole module
 * rests on, and the reason a task can be worth continuing after five failures
 * or worth abandoning after three.
 */
interface Task {
  readonly solvedBy: Strategy
  readonly learns: ReadonlySet<Strategy>
  /** The repertoire this run may use. A task whose answer is outside it cannot be solved. */
  readonly available: readonly Strategy[]
}

/**
 * Tasks, including ones nobody can solve with what they have.
 *
 * The first version of this simulation made every task solvable and both arms
 * finished all ten thousand, which measured nothing at all — the control test
 * below is what caught it. The real phenomenon needs the case where the answer
 * is **not in the repertoire**: that is where a naive agent spends its whole
 * budget, and where the only right move is to stop and say so.
 */
const makeTask = (nextRandom: () => number): Task => {
  const solvedBy = STRATEGIES[Math.floor(nextRandom() * STRATEGIES.length)]!
  const learns = new Set<Strategy>()
  for (const strategy of STRATEGIES) if (nextRandom() < 0.3) learns.add(strategy)
  const unsolvable = nextRandom() < 0.3
  const available = unsolvable ? STRATEGIES.filter((strategy) => strategy !== solvedBy) : [...STRATEGIES]
  return { solvedBy, learns, available }
}

const HARD_CEILING = 40

interface Outcome {
  readonly solved: boolean
  readonly escalated: boolean
  /** Exceeded the ceiling without solving or escalating: an infinite loop. */
  readonly looped: boolean
  /** Escalated while the solving strategy was available and never tried. */
  readonly falseStop: boolean
  /** Attempts that repeated a strategy already known to have failed on this signature. */
  readonly repeatedFailures: number
}

/**
 * One run. `guarded: false` is the naive arm.
 *
 * The naive arm is not a straw man: it retries what it preferred, and after two
 * consecutive failures of the same move it picks another at random. That is a
 * retry budget plus a shuffle, which is what an agent without a memoir does.
 * What it never does is notice that the shuffle taught it nothing.
 */
const run = (task: Task, nextRandom: () => number, guarded: boolean): Outcome => {
  const history: Attempt[] = []
  const failedStrategies = new Set<Strategy>()
  let repeatedFailures = 0
  let evidenceCounter = 0
  let consecutive = 0
  let preferred: Strategy = task.available[Math.floor(nextRandom() * task.available.length)]!

  for (let step = 0; step < HARD_CEILING; step++) {
    let strategy = preferred

    if (guarded) {
      const request = { taskKind: "t", signature: "s", preferred, available: task.available }
      const decision = next(history, request)
      if (decision.kind === "escalate") {
        const solvable = task.available.includes(task.solvedBy)
        return {
          solved: false,
          escalated: true,
          looped: false,
          falseStop: solvable && !history.some((attempt) => attempt.strategy === task.solvedBy),
          repeatedFailures,
        }
      }
      if (decision.kind === "must_change") {
        const alternatives = untried(history, request).filter((candidate) => !decision.forbidden.includes(candidate))
        strategy =
          alternatives[0] ?? task.available.find((candidate) => !decision.forbidden.includes(candidate)) ?? preferred
      } else {
        strategy = decision.strategy
      }
    } else if (consecutive >= 2) {
      strategy = task.available[Math.floor(nextRandom() * task.available.length)]!
      consecutive = 0
    }

    if (failedStrategies.has(strategy)) repeatedFailures += 1

    if (strategy === task.solvedBy) {
      return { solved: true, escalated: false, looped: false, falseStop: false, repeatedFailures }
    }

    consecutive = strategy === preferred ? consecutive + 1 : 1
    failedStrategies.add(strategy)
    // A strategy that learns something yields a fresh evidence key; one that
    // does not repeats the last key, which is what stillness counts.
    if (task.learns.has(strategy)) evidenceCounter += 1
    history.push({
      taskKind: "t",
      signature: "s",
      strategy,
      evidence: `e${evidenceCounter}`,
      runId: "r",
      at: step,
    })
    preferred = strategy
  }

  return { solved: false, escalated: false, looped: true, falseStop: false, repeatedFailures }
}

const sweep = (guarded: boolean, seed: number, rounds: number) => {
  const nextRandom = rng(seed)
  let repeatedFailures = 0
  let looped = 0
  let falseStops = 0
  let escalated = 0
  let solved = 0
  for (let round = 0; round < rounds; round++) {
    const outcome = run(makeTask(nextRandom), nextRandom, guarded)
    repeatedFailures += outcome.repeatedFailures
    if (outcome.looped) looped += 1
    if (outcome.falseStop) falseStops += 1
    if (outcome.escalated) escalated += 1
    if (outcome.solved) solved += 1
  }
  return { repeatedFailures, looped, falseStops, escalated, solved, rounds }
}

const ROUNDS = 10_000

// --- 1. the repertoire is a list somebody can count -------------------------------

describe("S131 the repertoire", () => {
  test("the five moves are declared, each with what it is for", () => {
    // "The agent tried everything" is unfalsifiable unless "everything" is a
    // list, and a repertoire that lives in prompt text is one nobody can count.
    expect(STRATEGIES).toEqual(["direct", "inspect", "debug", "decompose", "recover"])
    for (const strategy of STRATEGIES) expect(REPERTOIRE[strategy].length).toBeGreaterThan(20)
  })
})

// --- 2. evidence, not labels -------------------------------------------------------

describe("S131 stillness is measured on evidence, not on strategy names", () => {
  const attempt = (strategy: Strategy, evidence: string, at: number): Attempt => ({
    taskKind: "t",
    signature: "s",
    strategy,
    evidence,
    runId: "r",
    at,
  })

  test("five different strategies that learned nothing count as a loop", () => {
    // The failure this module exists for: every individual step passes the
    // no-repeat rule and the run is still going in circles.
    const history = STRATEGIES.map((strategy, index) => attempt(strategy, "same", index))
    expect(stillness(history, { taskKind: "t", signature: "s" })).toBe(5)
    const decision = next(history, { taskKind: "t", signature: "s", preferred: "direct" })
    expect(decision.kind).toBe("escalate")
    if (decision.kind === "escalate") expect(decision.why).toContain("identical evidence")
  })

  test("the same strategy twice with new evidence each time is not a loop", () => {
    const history = [attempt("debug", "e1", 0), attempt("debug", "e2", 1)]
    expect(stillness(history, { taskKind: "t", signature: "s" })).toBe(1)
    expect(next(history, { taskKind: "t", signature: "s", preferred: "inspect" }).kind).toBe("proceed")
  })

  test("stopping needs both conditions, never one", () => {
    // Still evidence but an untried move left: keep going.
    const stillWithMoves = [
      attempt("direct", "same", 0),
      attempt("inspect", "same", 1),
      attempt("debug", "same", 2),
    ]
    expect(stillness(stillWithMoves, { taskKind: "t", signature: "s" })).toBeGreaterThanOrEqual(STILLNESS_LIMIT)
    expect(untried(stillWithMoves, { taskKind: "t", signature: "s", preferred: "direct" }).length).toBeGreaterThan(0)
    expect(next(stillWithMoves, { taskKind: "t", signature: "s", preferred: "decompose" }).kind).not.toBe("escalate")

    // Everything tried but evidence still moving: also keep going. A run that
    // is learning has not run out of ideas, it has run out of labels.
    const movingButExhausted = STRATEGIES.flatMap((strategy, index) => [
      attempt(strategy, `e${index}`, index * 2),
      attempt(strategy, `e${index}b`, index * 2 + 1),
    ])
    expect(untried(movingButExhausted, { taskKind: "t", signature: "s", preferred: "direct" })).toEqual([])
    expect(next(movingButExhausted, { taskKind: "t", signature: "s", preferred: "direct" }).kind).not.toBe("escalate")
  })

  test("a different signature is a different problem", () => {
    const history = STRATEGIES.map((strategy, index) => attempt(strategy, "same", index))
    expect(stillness(history, { taskKind: "t", signature: "other" })).toBe(0)
    expect(next(history, { taskKind: "t", signature: "other", preferred: "direct" }).kind).toBe("proceed")
  })
})

// --- 3. the three numbers -----------------------------------------------------------

describe("S131 measured against a naive arm", () => {
  test("repeated failed strategies fall by more than 70%, loops reach zero, false stops stay under 1%", () => {
    const naive = sweep(false, 0x5131, ROUNDS)
    const guarded = sweep(true, 0x5131, ROUNDS)

    const repeatDrop = ((naive.repeatedFailures - guarded.repeatedFailures) / naive.repeatedFailures) * 100
    const falseStopRate = (guarded.falseStops / ROUNDS) * 100

    console.log(
      `[S131] naive: ${naive.repeatedFailures} repeated failures, ${naive.looped} loops, ${naive.solved} solved | ` +
        `guarded: ${guarded.repeatedFailures} repeated failures (−${repeatDrop.toFixed(1)}%), ${guarded.looped} loops, ` +
        `${guarded.escalated} escalations of which ${guarded.falseStops} were early (${falseStopRate.toFixed(2)}%), ${guarded.solved} solved`,
    )

    expect(repeatDrop).toBeGreaterThanOrEqual(70)
    expect(guarded.looped).toBe(0)
    expect(falseStopRate).toBeLessThan(1)
  }, 60_000)

  test("the naive arm really does loop, or the comparison is against nothing", () => {
    // A control that fails here would mean the guarded arm's zero was free.
    const naive = sweep(false, 0x5131, ROUNDS)
    expect(naive.looped).toBeGreaterThan(0)
    expect(naive.repeatedFailures).toBeGreaterThan(ROUNDS)
  }, 60_000)

  test("the guarded arm does not buy its numbers by giving up", () => {
    // The cheapest way to score zero loops and zero repeats is to escalate
    // immediately, so the solve rate has to hold up too.
    const naive = sweep(false, 0x5131, ROUNDS)
    const guarded = sweep(true, 0x5131, ROUNDS)
    console.log(`[S131] solve rate: naive ${((naive.solved / ROUNDS) * 100).toFixed(1)}%, guarded ${((guarded.solved / ROUNDS) * 100).toFixed(1)}%`)
    expect(guarded.solved).toBeGreaterThanOrEqual(naive.solved)
  }, 60_000)
})
