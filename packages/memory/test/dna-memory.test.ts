/**
 * Batch 8 GATES — S78 discovery by measurement, S79 the manifest, S80 layers,
 * S81 a budget that cannot be exceeded, S82 real numbers, S83 a repeated
 * failure forces a different strategy, S84 improvement or an honest denial.
 */
import { describe, expect, test } from "bun:test"
import {
  askManifest,
  learn,
  staleness,
  toManifest,
  unknownTrait,
  unknowns,
  weakTraits,
  type ProjectDna,
  type Trait,
} from "../src/dna"
import { assemble, demote, isAssembly, isImpossible, searchArchive, type MemoryItem } from "../src/layers"
import {
  chooseStrategy,
  reportLearning,
  REPEAT_LIMIT,
  statsFor,
  type ExperienceRecord,
  type FailureRecord,
} from "../src/experience"

const trait = <T>(value: T, confidence: Trait<T>["confidence"], evidence: string, at = 1000): Trait<T> => ({
  value,
  confidence,
  evidence,
  at,
})

const DNA: ProjectDna = {
  projectId: "p1",
  packageManager: trait("bun", "inferred", "bun.lock is present"),
  buildCommand: trait("bun run build", "measured", "ran it: exit 0 in 41s"),
  testCommand: unknownTrait("no test script and no suite directory was found"),
  devCommand: trait("bun dev", "declared", "written in the manifest by the owner"),
  deployMethod: trait("docker", "inferred", "a Dockerfile exists at the root"),
  runtimeVersion: trait("v24.3.0", "measured", "node -e printed it"),
  database: unknownTrait("no DATABASE_URL and no docker-compose service"),
  criticalPaths: trait(["checkout"], "declared", "named by the owner"),
  learnedAt: 1000,
}

describe("S78 GATE — discovery measures, and what it did not measure stays unknown", () => {
  test("unknowns are the deliverable, not a failure", () => {
    expect(unknowns(DNA).sort()).toEqual(["database", "testCommand"])
  })

  test("nothing conclusive yields UNKNOWN, never a plausible default", () => {
    const learned = learn({ what: "looked for a test script" }, () => undefined, "measured", 5)
    expect(learned.confidence).toBe("unknown")
    expect(learned.evidence).toContain("a guess wearing a fact's clothes")
  })

  test("inferred is weaker than measured, and the weak ones are listed", () => {
    // a deploy inferred from a Dockerfile is how an agent deploys a project
    // that is actually released through a pipeline the Dockerfile only feeds
    expect(weakTraits(DNA)).toContain("deployMethod")
    expect(weakTraits(DNA)).not.toContain("buildCommand")
  })
})

describe("S79 GATE — a month later, the answer comes from the file", () => {
  const manifest = toManifest(DNA, 1000)
  const monthLater = 1000 + 31 * 24 * 60 * 60 * 1000

  test("the question is answered, with its evidence and its AGE", () => {
    const answer = askManifest(manifest, "buildCommand", monthLater)
    expect(answer.kind).toBe("answer")
    if (answer.kind === "answer") {
      expect(answer.value).toBe("bun run build")
      expect(answer.confidence).toBe("measured")
      expect(answer.evidence).toContain("exit 0")
      // an answer that hid its age would make a stale command look verified
      expect(answer.ageMs).toBeGreaterThan(0)
    }
  })

  test("a trait that was never established stays unknown rather than becoming a guess", () => {
    const answer = askManifest(manifest, "testCommand", monthLater)
    expect(answer.kind).toBe("unknown")
    if (answer.kind === "unknown") expect(answer.why).toContain("no test script")
  })

  test("a human override outranks a measurement", () => {
    const corrected = { ...manifest, humanOverrides: { deployMethod: { value: "github actions", why: "the Dockerfile only feeds the pipeline", by: "owner" } } }
    const answer = askManifest(corrected, "deployMethod", monthLater)
    expect(answer.kind).toBe("answer")
    if (answer.kind === "answer") {
      expect(answer.value).toBe("github actions")
      expect(answer.evidence).toContain("only feeds the pipeline")
    }
  })

  test("an old manifest is reported stale — it is a claim about the project as it was", () => {
    expect(staleness(manifest, monthLater).stale).toBe(true)
    expect(staleness(manifest, 1000 + 1000).stale).toBe(false)
  })
})

const item = (id: string, layer: MemoryItem["layer"], tokens: number, over: Partial<MemoryItem> = {}): MemoryItem => ({
  id,
  layer,
  text: `text of ${id}`,
  tokens,
  at: 1,
  ...over,
})

describe("S80/S81 GATE — a small window finishes the task, and the budget cannot be exceeded", () => {
  const items: MemoryItem[] = [
    item("rules", "L0", 300),
    item("objective", "L0", 100),
    item("dna", "L1", 400),
    item("relevant", "L2", 500, { relevance: 0.9 }),
    item("less", "L2", 500, { relevance: 0.2 }),
    item("old", "L3", 5000),
  ]

  test("L0 is always there, the archive never is, and the total fits", () => {
    const result = assemble(items, { totalTokens: 1400 })
    expect(isAssembly(result)).toBe(true)
    if (!isAssembly(result)) return
    expect(result.included.map((i) => i.id)).toContain("rules")
    expect(result.included.map((i) => i.id)).toContain("objective")
    expect(result.included.map((i) => i.id)).not.toContain("old")
    expect(result.usedTokens).toBeLessThanOrEqual(1400)
  })

  test("L2 is chosen by RELEVANCE, not recency — the oldest item is often the constraint", () => {
    const result = assemble(items, { totalTokens: 1400 })
    expect(isAssembly(result)).toBe(true)
    if (!isAssembly(result)) return
    expect(result.included.map((i) => i.id)).toContain("relevant")
    expect(result.included.map((i) => i.id)).not.toContain("less")
  })

  test("exceeding the budget is IMPOSSIBLE, whatever is asked for", () => {
    for (const budget of [500, 800, 1000, 2000, 10_000]) {
      const result = assemble(items, { totalTokens: budget })
      if (isAssembly(result)) expect(result.usedTokens).toBeLessThanOrEqual(budget)
    }
  })

  test("L0 that does not fit is IMPOSSIBLE, not truncated", () => {
    const result = assemble(items, { totalTokens: 200 })
    expect(isAssembly(result)).toBe(false)
    if (!isAssembly(result)) {
      expect(result.why).toContain("half the rules present is worse than none")
      expect(result.shortfall).toBe(200)
    }
  })

  test("the archive is reached only by an explicit, bounded search", () => {
    const found = searchArchive(items, "old", 10_000)
    expect(found.found.map((i) => i.id)).toEqual(["old"])
    // and the bound holds
    expect(searchArchive(items, "old", 100).found).toEqual([])
    expect(searchArchive(items, "old", 100).truncated).toBe(true)
    // an empty query retrieves nothing rather than everything
    expect(searchArchive(items, "  ", 10_000).found).toEqual([])
  })

  test("demotion never evicts the standing rules automatically", () => {
    expect(demote(item("x", "L2", 1)).layer).toBe("L3")
    expect(demote(item("rules", "L0", 1)).layer).toBe("L0")
  })
})

const run = (over: Partial<ExperienceRecord>): ExperienceRecord => ({
  taskKind: "add_endpoint",
  strategy: "direct_edit",
  outcome: "succeeded",
  attempts: 1,
  tokens: 20_000,
  ms: 60_000,
  runId: "r",
  at: 1,
  ...over,
})

describe("S82 GATE — the numbers come from runs that happened", () => {
  test("stats are computed from records, with a median that one outlier cannot move", () => {
    const records = [
      run({ strategy: "a", tokens: 10_000 }),
      run({ strategy: "a", tokens: 12_000 }),
      run({ strategy: "a", tokens: 400_000 }),
      run({ strategy: "b", tokens: 30_000, outcome: "failed" }),
    ]
    const stats = statsFor(records, "add_endpoint")
    const a = stats.find((s) => s.strategy === "a")!
    expect(a.runs).toBe(3)
    expect(a.successRate).toBe(1)
    // the 400k outlier does not become the estimate
    expect(a.medianTokens).toBe(12_000)
    expect(stats[0]!.strategy).toBe("a")
  })

  test("a task nobody ran has no stats rather than default ones", () => {
    expect(statsFor([], "never_done")).toEqual([])
  })
})

describe("S83 GATE — the same failure twice forces a different strategy on the third", () => {
  const failures: FailureRecord[] = [
    { taskKind: "deploy", signature: "ECONNREFUSED 5432", strategy: "restart_service", runId: "r1", at: 1 },
    { taskKind: "deploy", signature: "ECONNREFUSED 5432", strategy: "restart_service", runId: "r2", at: 2 },
  ]

  test("the twice-failed strategy is FORBIDDEN, not discouraged", () => {
    const decision = chooseStrategy(failures, {
      taskKind: "deploy",
      signature: "ECONNREFUSED 5432",
      preferred: "restart_service",
      available: ["restart_service", "check_credentials"],
    })
    expect(decision.kind).toBe("must_change")
    if (decision.kind === "must_change") {
      expect(decision.forbidden).toEqual(["restart_service"])
      expect(decision.why).toContain("not persistence, it is the same attempt")
    }
  })

  test("a different strategy proceeds, and the ruled-out one is named", () => {
    const decision = chooseStrategy(failures, {
      taskKind: "deploy",
      signature: "ECONNREFUSED 5432",
      preferred: "check_credentials",
      available: ["restart_service", "check_credentials"],
    })
    expect(decision.kind).toBe("proceed")
    if (decision.kind === "proceed") expect(decision.why).toContain("restart_service ruled out")
  })

  test("a DIFFERENT failure signature is not blocked by this one", () => {
    expect(
      chooseStrategy(failures, {
        taskKind: "deploy",
        signature: "permission denied",
        preferred: "restart_service",
        available: ["restart_service"],
      }).kind,
    ).toBe("proceed")
  })

  test("everything exhausted ESCALATES and lists what was tried", () => {
    const all: FailureRecord[] = [
      ...failures,
      { taskKind: "deploy", signature: "ECONNREFUSED 5432", strategy: "check_credentials", runId: "r3", at: 3 },
      { taskKind: "deploy", signature: "ECONNREFUSED 5432", strategy: "check_credentials", runId: "r4", at: 4 },
    ]
    const decision = chooseStrategy(all, {
      taskKind: "deploy",
      signature: "ECONNREFUSED 5432",
      preferred: "restart_service",
      available: ["restart_service", "check_credentials"],
    })
    expect(decision.kind).toBe("escalate")
    if (decision.kind === "escalate") {
      expect([...decision.tried].sort()).toEqual(["check_credentials", "restart_service"])
      expect(decision.why).toContain("run out of ideas and keeps going")
    }
    expect(REPEAT_LIMIT).toBe(2)
  })
})

describe("S84 GATE — measured improvement, or an explicit statement that there was none", () => {
  test("a task that got cheaper says so with the numbers", () => {
    const records: ExperienceRecord[] = [
      ...Array.from({ length: 3 }, (_, i) => run({ at: i + 1, tokens: 40_000, outcome: "failed" })),
      ...Array.from({ length: 3 }, (_, i) => run({ at: i + 10, tokens: 15_000, outcome: "succeeded" })),
    ]
    const report = reportLearning(records, "add_endpoint")
    expect(report.improved).toBe(true)
    expect(report.statement).toContain("median tokens 40000 -> 15000")
  })

  test("a task that did NOT improve says that, and that sentence is the result", () => {
    const records = Array.from({ length: 8 }, (_, i) => run({ at: i + 1, tokens: 20_000 }))
    const report = reportLearning(records, "add_endpoint")
    expect(report.improved).toBe(false)
    expect(report.statement).toContain("did NOT improve")
    expect(report.statement).toContain("saying so is the result")
  })

  test("too few runs makes no claim in either direction", () => {
    const report = reportLearning([run({}), run({})], "add_endpoint")
    expect(report.statement).toContain("no claim either way")
    expect(report.improved).toBe(false)
  })
})
