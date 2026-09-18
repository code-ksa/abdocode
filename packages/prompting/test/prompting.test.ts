/**
 * Batch 4 GATES — S45 an instruction change is measured before adoption, S46 a
 * narrowing that does not help is reverted, S47 zero parse failures with the
 * repairs counted, S48 a prompt that did not fit is never silently truncated.
 */
import { describe, expect, test } from "bun:test"
import {
  adopt,
  assemble,
  findContradictions,
  MIN_SAMPLES,
  type InstructionModule,
} from "../src/instructions"
import { evaluateSurfaceChange, narrowSurface, type ToolDescriptor } from "../src/surface"
import { parseConstrained, promptSuspicion, repairStats } from "../src/structured"
import { planForWindow, selectRetrieval, stateTheGap, usable, type Piece } from "../src/local"

const mod = (id: string, over: Partial<InstructionModule> = {}): InstructionModule => ({
  id,
  scope: "system",
  version: 1,
  text: `rule ${id}`,
  rationale: `why ${id} exists`,
  expectedBehaviour: `the agent does ${id}`,
  measuredBy: ["edit_01_add_field"],
  ...over,
})

describe("S45 GATE — no instruction change is adopted on feel", () => {
  test("a change with no measurement is refused, however sensible it reads", () => {
    const verdict = adopt(mod("a"), { moduleId: "a", newText: "rule a, but clearer", why: "reads better" })
    expect(verdict.decision).toBe("needs_measurement")
    expect(verdict.why).toContain("nobody knows")
    expect(verdict.module).toBeUndefined()
  })

  test("one run either way measures the sampler, not the prompt", () => {
    const verdict = adopt(mod("a"), {
      moduleId: "a",
      newText: "rule a v2",
      why: "should help",
      measurement: { on: "code_edit", before: 0.8, after: 0.95, samples: 1 },
    })
    expect(verdict.decision).toBe("needs_measurement")
    expect(verdict.why).toContain(`${MIN_SAMPLES} minimum`)
  })

  test("a measured improvement is adopted and bumps the version", () => {
    const verdict = adopt(mod("a"), {
      moduleId: "a",
      newText: "rule a v2",
      why: "narrower wording",
      measurement: { on: "code_edit", before: 0.8, after: 0.9, samples: 20 },
    })
    expect(verdict.decision).toBe("adopted")
    expect(verdict.module!.version).toBe(2)
    expect(verdict.module!.text).toBe("rule a v2")
  })

  test("a change that measured WORSE is rejected — this is how a system decays one reasonable decision at a time", () => {
    const verdict = adopt(mod("a"), {
      moduleId: "a",
      newText: "rule a v2",
      why: "felt cleaner",
      measurement: { on: "code_edit", before: 0.9, after: 0.7, samples: 30 },
    })
    expect(verdict.decision).toBe("rejected")
    expect(verdict.why).toContain("measured WORSE")
  })

  test("a neutral change is adopted as a SIMPLIFICATION, and recorded as neutral", () => {
    const verdict = adopt(mod("a"), {
      moduleId: "a",
      newText: "rule a, shorter",
      why: "half the words",
      measurement: { on: "code_edit", before: 0.9, after: 0.9, samples: 30 },
    })
    expect(verdict.decision).toBe("adopted")
    // nobody may later cite this as evidence the wording mattered
    expect(verdict.why).toContain("not as evidence the wording mattered")
  })

  test("assembly is ordered by id, so adding a module cannot silently reorder the prompt", () => {
    const set = assemble("system", [mod("zeta"), mod("alpha"), mod("mid"), mod("other", { scope: "verifier" })])
    expect(set.modules.map((m) => m.id)).toEqual(["alpha", "mid", "zeta"])
    expect(set.text.split("\n\n")).toHaveLength(3)
  })

  test("a module no scenario exercises is reported — a prompt nobody measures is folklore", () => {
    const set = assemble("system", [mod("a"), mod("b", { measuredBy: [] })])
    expect(set.unmeasured).toEqual(["b"])
  })

  test("declared contradictions are found without asking a model to read English", () => {
    const set = assemble("system", [mod("always_ask"), mod("never_interrupt")])
    expect(findContradictions(set, [["always_ask", "never_interrupt"]])).toEqual([
      { a: "always_ask", b: "never_interrupt" },
    ])
  })
})

const tool = (name: string, over: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  name,
  schemaTokens: 100,
  classes: ["read"],
  tags: [name],
  ...over,
})

describe("S46 GATE — a narrowing that does not help is reverted", () => {
  test("tools this mode could never use are hidden, with the reason", () => {
    const surface = narrowSurface({
      mode: "planner",
      objective: "read the config loader and plan the change",
      tools: [
        tool("read", { tags: ["read", "config"], essential: true }),
        tool("deploy", { classes: ["production_write"], tags: ["deploy"] }),
      ],
      allowedClasses: ["read"],
    })
    expect(surface.exposed.map((t) => t.name)).toEqual(["read"])
    expect(surface.hidden[0]!.why).toContain("would be refused anyway")
    expect(surface.savedTokens).toBe(100)
  })

  test("essential tools are never hidden, whatever the objective says", () => {
    const surface = narrowSurface({
      mode: "builder",
      objective: "something entirely unrelated",
      tools: [tool("read", { essential: true }), tool("write", { essential: true }), tool("browser")],
      floor: 1,
    })
    expect(surface.exposed.map((t) => t.name)).toEqual(["read", "write"])
  })

  test("the floor protects an objective phrased in words no tag matches", () => {
    const surface = narrowSurface({
      mode: "builder",
      objective: "اكتب محمّل الإعدادات",
      tools: [tool("a"), tool("b"), tool("c"), tool("d"), tool("e")],
      floor: 3,
    })
    // nothing matched, and an agent holding no tools is not a narrower agent
    expect(surface.exposed).toHaveLength(3)
    expect(surface.hidden).toHaveLength(2)
  })

  test("a narrowing that raised accuracy but cost COMPLETION is reverted", () => {
    const verdict = evaluateSurfaceChange(
      { toolAccuracy: 0.8, completion: 0.9, samples: 30 },
      { toolAccuracy: 0.95, completion: 0.82, samples: 30 },
    )
    expect(verdict.keep).toBe(false)
    expect(verdict.why).toContain("a capability the agent no longer has")
    expect(verdict.why).toContain("does not buy this")
  })

  test("a narrowing that moved nothing is reverted — it bought tokens and risked capability", () => {
    const verdict = evaluateSurfaceChange(
      { toolAccuracy: 0.9, completion: 0.9, samples: 30 },
      { toolAccuracy: 0.9, completion: 0.9, samples: 30 },
    )
    expect(verdict.keep).toBe(false)
    expect(verdict.why).toContain("bought tokens and nothing else")
  })

  test("a real improvement is kept", () => {
    const verdict = evaluateSurfaceChange(
      { toolAccuracy: 0.78, completion: 0.9, samples: 40 },
      { toolAccuracy: 0.9, completion: 0.92, samples: 40 },
    )
    expect(verdict.keep).toBe(true)
  })

  test("too few samples reverts rather than keeps — the default is the state that was measured", () => {
    expect(
      evaluateSurfaceChange({ toolAccuracy: 0.5, completion: 0.5, samples: 2 }, { toolAccuracy: 1, completion: 1, samples: 2 })
        .keep,
    ).toBe(false)
  })
})

describe("S47 GATE — zero parse failures, and every repair counted", () => {
  const shapes = [
    ['{"a":1}', "clean"],
    ['```json\n{"a":1}\n```', "repaired"],
    ['Sure! Here is the result:\n{"a":1}', "repaired"],
    ['{"a":1,}', "repaired"],
    ['{a:1}', "repaired"],
    // JSON.parse already tolerates surrounding whitespace, so this arrives
    // CLEAN and the `trim` repair never fires. Worth keeping in the table:
    // a repair listed for a case that did not need one would have inflated
    // the repair statistics that Sprint 47 uses to accuse a prompt.
    ['  {"a":1}  ', "clean"],
    ["```\n{\"a\":1}\n```", "repaired"],
  ] as const

  test("every shape a model actually produces is parsed", () => {
    for (const [raw, expected] of shapes) {
      const outcome = parseConstrained<{ a: number }>(raw)
      expect(outcome.kind).toBe(expected)
      if (outcome.kind !== "failed") expect(outcome.value.a).toBe(1)
    }
  })

  test("a repaired result is MARKED — it must not look identical to a clean one", () => {
    const clean = parseConstrained('{"a":1}')
    const fixed = parseConstrained('```json\n{"a":1}\n```')
    expect(clean.kind).toBe("clean")
    expect(fixed.kind).toBe("repaired")
    if (fixed.kind === "repaired") expect(fixed.repairs).toContain("strip_code_fence")
  })

  test("output that cannot be repaired fails with what was attempted, not with a shrug", () => {
    const outcome = parseConstrained("I am not going to answer in JSON, sorry.")
    expect(outcome.kind).toBe("failed")
    if (outcome.kind === "failed") {
      expect(outcome.attempted.length).toBeGreaterThan(3)
      expect(outcome.why).toContain("did not produce valid output")
    }
  })

  test("a schema check rejects a parseable value of the wrong shape", () => {
    const outcome = parseConstrained('{"b":1}', {
      validate: (v) => (typeof (v as { a?: unknown }).a === "number" ? undefined : "missing numeric `a`"),
    })
    expect(outcome.kind).toBe("failed")
  })

  test("a repair firing constantly is a PROMPT problem, and is named as one", () => {
    const outcomes = Array.from({ length: 10 }, (_, i) =>
      parseConstrained(i < 6 ? '```json\n{"a":1}\n```' : '{"a":1}'),
    )
    const stats = repairStats(outcomes)
    expect(stats.failed).toBe(0)
    expect(stats.byRepair.strip_code_fence).toBe(6)
    const suspicion = promptSuspicion(stats)
    expect(suspicion.suspicious).toBe(true)
    expect(suspicion.why).toContain("prompt problem being absorbed")
  })
})

describe("S48 GATE — a prompt that did not fit is never silently truncated", () => {
  const budget = { contextTokens: 8000, reserveForOutput: 1500, reserveForTools: 500 }

  test("optional context is dropped by priority; required context never is", () => {
    const pieces: Piece[] = [
      { id: "system", tokens: 800, required: true },
      { id: "the_file", tokens: 3000, required: true },
      { id: "history", tokens: 4000, required: false, priority: 1 },
      { id: "examples", tokens: 1500, required: false, priority: 9 },
    ]
    const plan = planForWindow(pieces, budget)
    expect(plan.kind).toBe("fits")
    if (plan.kind === "fits") {
      expect(plan.included).toContain("the_file")
      // higher priority wins the remaining room
      expect(plan.included).toContain("examples")
      expect(plan.included).not.toContain("history")
      expect(plan.usedTokens).toBeLessThanOrEqual(usable(budget))
    }
  })

  test("required content that does not fit is SPLIT, not truncated", () => {
    const pieces: Piece[] = [
      { id: "system", tokens: 1000, required: true },
      { id: "file_a", tokens: 3000, required: true },
      { id: "file_b", tokens: 3000, required: true },
    ]
    const plan = planForWindow(pieces, budget)
    expect(plan.kind).toBe("split")
    if (plan.kind === "split") {
      expect(plan.steps.length).toBeGreaterThan(1)
      expect(plan.why).toContain("missing what the answer depended on")
      // every required piece appears exactly once across the steps
      const all = plan.steps.flatMap((s) => s.included)
      expect(all.sort()).toEqual(["file_a", "file_b", "system"])
    }
  })

  test("one required piece larger than the whole window is IMPOSSIBLE, not half-sent", () => {
    const plan = planForWindow([{ id: "huge_file", tokens: 50_000, required: true }], budget)
    expect(plan.kind).toBe("impossible")
    if (plan.kind === "impossible") {
      expect(plan.why).toContain("a request missing the thing it is about")
      expect(plan.shortfall).toBe(50_000 - usable(budget))
    }
  })

  test("retrieval uses a relevance FLOOR, not a fixed top-k", () => {
    const result = selectRetrieval(
      [
        { id: "good_1", tokens: 500, score: 0.9 },
        { id: "good_2", tokens: 500, score: 0.7 },
        { id: "noise_1", tokens: 500, score: 0.2 },
        { id: "noise_2", tokens: 500, score: 0.1 },
      ],
      4000,
    )
    // top-4 would have filled a small window with noise the model cannot discount
    expect(result.chosen).toEqual(["good_1", "good_2"])
    expect(result.droppedForScore).toBe(2)
  })

  test("the local/cloud gap is stated in both directions rather than scored", () => {
    const text = stateTheGap({
      task: "add the config loader",
      local: { passed: true, tokens: 42_000, ms: 240_000, steps: 31 },
      cloud: { passed: true, tokens: 18_000, ms: 60_000, steps: 8 },
    })
    expect(text).toContain("both completed it")
    expect(text).toContain("3.9x the steps")
    expect(text).toContain("depends on what the tokens cost you")
  })

  test("a local failure is stated plainly, not softened", () => {
    const text = stateTheGap({
      task: "refactor across four packages",
      local: { passed: false, tokens: 60_000, ms: 400_000, steps: 44 },
      cloud: { passed: true, tokens: 22_000, ms: 90_000, steps: 11 },
    })
    expect(text).toContain("did NOT complete this task")
  })
})
