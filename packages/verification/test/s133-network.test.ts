import { describe, expect, test } from "bun:test"
import { fold, type CheckKind } from "../src/engine"
import { judgeEffects } from "../src/gates"
import {
  CRITICAL_QUORUM,
  QUORUM_KINDS,
  admit,
  criticalityOf,
  demand,
  review,
  type AttributedCheck,
  type PatchProfile,
} from "../src/network"

// ==========================================================================
// The rules, one at a time
// ==========================================================================

const AUTHOR = "agent-a"

const ordinary: PatchProfile = {
  id: "p1",
  author: AUTHOR,
  filesChanged: 2,
  classes: ["read", "local_write"],
  protectedAspects: [],
}

const critical: PatchProfile = {
  id: "p2",
  author: AUTHOR,
  filesChanged: 2,
  classes: ["read", "network_write"],
  protectedAspects: ["credential_broker"],
}

const check = (over: Partial<AttributedCheck> & Pick<AttributedCheck, "kind" | "status" | "witness">): AttributedCheck => ({
  id: over.id ?? `${over.kind}-check`,
  evidence: over.evidence ?? "evidence",
  tokens: 0,
  ...over,
})

const mech = (tool: string) => ({ sort: "mechanical", tool }) as const
const judged = (by: string, context: "clean" | "contaminated" = "clean") => ({ sort: "judged", by, context }) as const

const passing = (kind: CheckKind, witness: AttributedCheck["witness"], id = `${kind}-${witnessLabel(witness)}`) =>
  check({ id, kind, status: "passed", witness })

const witnessLabel = (witness: AttributedCheck["witness"]) => (witness.sort === "mechanical" ? witness.tool : witness.by)

describe("criticality is derived from surface, not from size or assertion", () => {
  test("local classes and nothing protected is ordinary", () => {
    expect(criticalityOf(ordinary)).toBe("ordinary")
  })

  test("a protected aspect makes a two-file change critical", () => {
    expect(criticalityOf(critical)).toBe("critical")
  })

  test("a large but local change stays ordinary — size is a different question", () => {
    expect(criticalityOf({ ...ordinary, filesChanged: 400 })).toBe("ordinary")
  })

  test("critical work demands what the change DID, not only what its diff said", () => {
    expect(demand(critical).required).toContain("side_effect")
    expect(demand(ordinary).required).not.toContain("side_effect")
  })
})

describe("a self-claim can condemn and cannot acquit", () => {
  test("the author's own passing judgement is not evidence, and the patch is unverified rather than passed", () => {
    const verdict = review(ordinary, [
      passing("build", mech("tsgo")),
      check({ kind: "test", status: "passed", witness: judged(AUTHOR) }),
    ])
    expect(verdict.verdict).toBe("unverified")
    expect(verdict.downgrades).toHaveLength(1)
    expect(verdict.downgrades[0]!.why).toContain("a claim is not a measurement")
  })

  test("the author's own FAILING judgement is final — an admission against interest costs something", () => {
    const verdict = review(ordinary, [
      passing("build", mech("tsgo")),
      passing("test", mech("bun-test")),
      check({ kind: "test", status: "failed", witness: judged(AUTHOR), detail: "I broke the retry path" }),
    ])
    expect(verdict.verdict).toBe("failed")
    expect(verdict.downgrades).toHaveLength(0)
  })

  test("a build the author ran IS evidence — the compiler has no stake in the patch", () => {
    const verdict = review(ordinary, [
      passing("build", mech("tsgo")),
      passing("test", mech("bun-test")),
      passing("security", mech("secret-scan")),
    ])
    expect(verdict.verdict).toBe("passed")
  })
})

describe("a contaminated second opinion is the first opinion again", () => {
  test("a reviewer who read the author's reasoning cannot supply the passing evidence", () => {
    const verdict = review(ordinary, [
      passing("build", mech("tsgo")),
      check({ kind: "test", status: "passed", witness: judged("agent-b", "contaminated") }),
    ])
    expect(verdict.verdict).toBe("unverified")
    expect(verdict.downgrades[0]!.why).toContain("inherited")
  })

  test("the same reviewer with clean context can", () => {
    const verdict = review(ordinary, [
      passing("build", mech("tsgo")),
      passing("test", judged("agent-b", "clean")),
      passing("security", mech("secret-scan")),
    ])
    expect(verdict.verdict).toBe("passed")
  })
})

describe("an uncorroborated judged failure is a question, not a verdict", () => {
  test("it does not condemn the patch", () => {
    const verdict = review(ordinary, [
      passing("build", mech("tsgo")),
      passing("test", mech("bun-test")),
      check({ kind: "security", status: "failed", witness: judged("agent-b"), detail: "this smells like a secret" }),
    ])
    expect(verdict.verdict).not.toBe("failed")
  })

  test("and it does not evaporate — the kind it was raised in becomes required", () => {
    const verdict = review(ordinary, [
      passing("build", mech("tsgo")),
      passing("test", mech("bun-test")),
      check({ kind: "security", status: "failed", witness: judged("agent-b"), detail: "this smells like a secret" }),
    ])
    expect(verdict.verdict).toBe("unverified")
    expect(verdict.required).toContain("security")
    expect(verdict.why).toContain("uncorroborated concern")
  })

  /**
   * The sweep wrote this pair. The first version of the rule let the scanner
   * that had ALREADY passed count as the answer, and a real defect caught by a
   * single reviewer walked out on the strength of evidence that predated the
   * concern. An answer has to be new, or it is not an answer.
   */
  test("evidence that predates the concern does not answer it", () => {
    const verdict = review(ordinary, [
      passing("build", mech("tsgo")),
      passing("test", mech("bun-test")),
      passing("security", mech("secret-scan")),
      check({ kind: "security", status: "failed", witness: judged("agent-b") }),
    ])
    expect(verdict.verdict).toBe("unverified")
    expect(verdict.shortfall.get("security")).toBe(1)
  })

  test("a witness commissioned to answer it does", () => {
    const verdict = review(ordinary, [
      passing("build", mech("tsgo")),
      passing("test", mech("bun-test")),
      passing("security", mech("secret-scan")),
      check({ kind: "security", status: "failed", witness: judged("agent-b") }),
      passing("security", judged("agent-c")),
    ])
    expect(verdict.verdict).toBe("passed")
  })

  test("corroborated by a second witness, it is final", () => {
    const verdict = review(ordinary, [
      passing("build", mech("tsgo")),
      check({ kind: "security", status: "failed", witness: judged("agent-b") }),
      check({ kind: "test", status: "failed", witness: mech("bun-test") }),
    ])
    expect(verdict.verdict).toBe("failed")
  })

  test("a mechanical failure never needs corroboration", () => {
    const verdict = review(ordinary, [check({ kind: "build", status: "failed", witness: mech("tsgo") })])
    expect(verdict.verdict).toBe("failed")
  })
})

describe("on critical work one witness is a sample", () => {
  const criticalPass = (witnesses: readonly AttributedCheck[]) =>
    review(critical, [passing("build", mech("tsgo")), passing("test", mech("bun-test")), ...witnesses])

  test("a single security witness does not establish the kind", () => {
    const verdict = criticalPass([
      passing("security", mech("secret-scan")),
      passing("side_effect", mech("sandbox")),
      passing("side_effect", judged("agent-b")),
      passing("test", judged("agent-d")),
    ])
    expect(verdict.verdict).toBe("unverified")
    expect(verdict.downgrades.some((d) => d.why!.includes("sample rather than a quorum"))).toBe(true)
  })

  test("two independent witnesses do", () => {
    const verdict = criticalPass([
      passing("security", mech("secret-scan")),
      passing("security", judged("agent-b")),
      passing("side_effect", mech("sandbox")),
      passing("side_effect", judged("agent-c")),
      passing("test", judged("agent-d")),
    ])
    expect(verdict.verdict).toBe("passed")
  })

  test("the same witness twice is one witness", () => {
    const verdict = criticalPass([
      passing("security", mech("secret-scan"), "scan-a"),
      passing("security", mech("secret-scan"), "scan-b"),
      passing("side_effect", mech("sandbox")),
      passing("side_effect", judged("agent-c")),
      passing("test", judged("agent-d")),
    ])
    expect(verdict.verdict).toBe("unverified")
  })

  test("quorum never touches a failure — one sandbox that saw it is enough", () => {
    const verdict = criticalPass([check({ kind: "side_effect", status: "failed", witness: mech("sandbox") })])
    expect(verdict.verdict).toBe("failed")
  })

  test("ordinary work is not held to quorum", () => {
    const verdict = review(ordinary, [passing("build", mech("tsgo")), passing("test", mech("bun-test")), passing("security", mech("secret-scan"))])
    expect(verdict.verdict).toBe("passed")
  })
})

describe("the side effect gate", () => {
  test("an unobserved run is unavailable, not clean", () => {
    const verdict = judgeEffects({ sandbox: "sbx", declared: ["fs.write:build/"], observed: undefined })
    expect(verdict.status).toBe("unavailable")
    expect(verdict.detail).toContain("an unobserved run is not a clean run")
  })

  test("an effect it never declared is a failure, however innocent the diff", () => {
    const verdict = judgeEffects({ sandbox: "sbx", declared: ["fs.write:build/"], observed: ["fs.write:build/", "net.connect:example.test:443"] })
    expect(verdict.status).toBe("failed")
    expect(verdict.undeclared).toEqual(["net.connect:example.test:443"])
  })

  test("declared and never exercised is reported and does not fail", () => {
    const verdict = judgeEffects({ sandbox: "sbx", declared: ["fs.write:build/"], observed: [] })
    expect(verdict.status).toBe("passed")
    expect(verdict.unexercised).toEqual(["fs.write:build/"])
  })
})

describe("every downgrade carries its reason", () => {
  test("nothing is dropped silently", () => {
    const checks = [
      passing("build", mech("tsgo")),
      check({ kind: "test", status: "passed", witness: judged(AUTHOR) }),
      check({ kind: "security", status: "passed", witness: judged("agent-b", "contaminated") }),
    ]
    const admissions = admit(ordinary, checks)
    expect(admissions).toHaveLength(checks.length)
    for (const admission of admissions) {
      if (admission.admitted.status !== admission.check.status) expect(admission.why).toBeString()
    }
  })
})

// ==========================================================================
// The sweep
// ==========================================================================

/**
 * S133 — the four numbers, measured against two other arms.
 *
 * # Why there are three arms and not two
 *
 * The network does two separable things, and a two-arm comparison would let one
 * take credit for the other's work:
 *
 *   DEMAND    — it decides what evidence must exist BEFORE any evidence exists,
 *               so that not running a check stops being cheaper than passing it
 *   ADMISSION — it decides which claims are entitled to count as evidence
 *
 * So: arm A is what an agent does today (fold over whatever it happened to
 * collect, self-claims included); arm B has the full commissioned evidence and
 * NO admission rules, which isolates demand; arm C is `review`. Without arm B,
 * "the network works" could mean nothing more than "it ran more checks", which
 * is not a finding, it is a budget.
 *
 * # What "rejected" means
 *
 * `verdict !== "passed"`. `unverified` is a rejection for the purpose that
 * matters — the patch does not land — and the distinction between `failed` and
 * `unverified` is preserved everywhere else precisely because it tells the
 * author two different things to do.
 *
 * # The rates below
 *
 * Fixed before the first run and stated with their reasoning, because a dial
 * turned after seeing the result is not a measurement. Each is an honest guess
 * at a real quantity, and the sweep is a claim about the DESIGN under those
 * quantities, not a claim about the world.
 */

/** A compiler either compiles or it does not; the residue is a config nobody built. */
const MECHANICAL_DETECT: Readonly<Record<DefectKind, number>> = {
  build: 0.99,
  /**
   * The suite, GIVEN that it covers the changed lines. Split from coverage
   * below, and the product of the two is kept at the 0.78 that was fixed before
   * the first run — refining a parameter into its parts is allowed, moving the
   * aggregate after seeing a result is not.
   */
  test: 0.886,
  /** A scanner matches the shapes on its list; the residue is a shape that is not. */
  security: 0.93,
  /**
   * Given that the run went down the path, the effect HAPPENED and was
   * recorded. A watcher does not half-see a syscall.
   */
  side_effect: 0.995,
}

/**
 * Whether a sandbox run reaches the change at all.
 *
 * Split out from detection deliberately, and it is the sharpest lever in this
 * file. "The watcher missed it" and "the run never went there" have the same
 * output — an empty list of effects — and only the second is knowable BY THE
 * WATCHER. Once it is reported, it stops being a silent miss and becomes an
 * `unavailable`, which the demand can answer with a targeted run.
 */
const SIDE_EFFECT_COVERAGE = 0.85

/**
 * Whether the suite executes the lines that changed.
 *
 * The same split as above, and the reason it is a weaker lever: an executed
 * line with no assertion about it catches nothing, so coverage here does not
 * imply detection the way a recorded syscall does. It buys only the refusal to
 * read an uncovered green suite as a passing one.
 */
const TEST_COVERAGE = 0.88

/** A competent reviewer, reading the change cold. */
const JUDGED_CLEAN_DETECT = 0.62
/** The same reviewer, having read the author's explanation first. It inherits the blind spot. */
const JUDGED_CONTAMINATED_DETECT = 0.17
/**
 * The author, before submitting.
 *
 * This is NOT a false-positive rate for the author, and the first sweep got
 * that wrong at a cost of 3.68 points of false rejection: it let authors submit
 * patches while reporting their own work broken. Nobody does that — they fix it
 * first. So the population here is SUBMITTED patches, and an author who noticed
 * the defect removed it instead of appearing in the numbers.
 */
const AUTHOR_DETECT = 0.05
/** A reviewer looking at a change finds defects outside their focus at a fraction of the rate. */
const OFF_FOCUS = 0.25

/** Flake. */
const MECHANICAL_FALSE_POSITIVE = 0.004
/** Reviewers raise concerns that turn out to be nothing. This is the false-rejection engine. */
const JUDGED_FALSE_POSITIVE = 0.035

/** A commissioned check usually arrives. Sandboxes and runners are occasionally down. */
const ARRIVES_WHEN_DEMANDED = 0.98
/** A volunteered one arrives when somebody felt like running it. */
const ARRIVES_WHEN_VOLUNTEERED = 0.72
/** The diff scanner is free, so it runs whether or not anyone demanded it. */
const FREE_SCANNER_ARRIVES = 0.9

/** Nobody asked for clean context, so most volunteered reviewers had the author's reasoning. */
const VOLUNTEERED_CONTAMINATION = 0.55
/** Context leaks even when it was demanded clean. */
const DEMANDED_CONTAMINATION = 0.05

const RUNS = 40_000
const SEED = 0x5133

/**
 * The seeds the bounds are checked against.
 *
 * Not decoration. At a critical quorum of three the false-rejection rate on
 * THIS seed was 2.93% and looked like it fit inside the 3% line; on three of
 * the five below it was 3.15–3.17% and did not. One seed had been the lucky
 * one, and a configuration chosen on it would have shipped as a measured pass.
 * A bound that holds on a single seed is a bound that holds on a single seed.
 */
const SEEDS = [0x5133, 0x7f31, 0x2718, 0xabc9, 0x1a2b]

type DefectKind = "build" | "test" | "security" | "side_effect"

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

interface Patch {
  readonly profile: PatchProfile
  /** Ground truth. `undefined` is a good patch. */
  readonly defect: DefectKind | undefined
}

/**
 * Patches, half of them wrong.
 *
 * Criticality is a property of the SURFACE and is drawn independently of
 * whether the patch is good — a change to the credential broker is critical
 * whether or not it is correct, which is the whole reason the demand is
 * computed before any evidence exists.
 *
 * An ordinary patch can still carry a security defect: an API key committed in
 * an otherwise local edit is a real and common shape, and it is deliberately in
 * the population because the network does NOT demand security evidence for
 * ordinary work. If that hole is expensive, the sweep is where it shows.
 */
const makePatch = (r: () => number, index: number): Patch => {
  const isCritical = r() < 0.35
  const profile: PatchProfile = isCritical
    ? { id: `p${index}`, author: AUTHOR, filesChanged: 1 + Math.floor(r() * 8), classes: ["read", "network_write"], protectedAspects: ["credential_broker"] }
    : { id: `p${index}`, author: AUTHOR, filesChanged: 1 + Math.floor(r() * 8), classes: ["read", "local_write"], protectedAspects: [] }

  if (r() < 0.5) return { profile, defect: undefined }

  // The author noticed it and fixed it before submitting. A defect caught here
  // never reaches the network, and never appears in any of its numbers.
  if (r() < AUTHOR_DETECT) return { profile, defect: undefined }

  const draw = r()
  const defect: DefectKind = isCritical
    ? draw < 0.45
      ? "security"
      : draw < 0.8
        ? "side_effect"
        : draw < 0.92
          ? "test"
          : "build"
    : draw < 0.1
      ? "security"
      : draw < 0.55
        ? "test"
        : "build"

  return { profile, defect }
}

type Witness = AttributedCheck["witness"]

const detects = (witness: Witness, focus: CheckKind, defect: DefectKind | undefined, r: () => number): boolean => {
  if (defect === undefined) return false
  if (witness.sort === "mechanical") return focus === defect && r() < MECHANICAL_DETECT[defect]
  const base = witness.by === AUTHOR ? AUTHOR_DETECT : witness.context === "clean" ? JUDGED_CLEAN_DETECT : JUDGED_CONTAMINATED_DETECT
  return r() < (focus === defect ? base : base * OFF_FOCUS)
}

const observe = (witness: Witness, focus: CheckKind, patch: Patch, r: () => number): AttributedCheck => {
  const base = {
    id: `${focus}:${witnessLabel(witness)}`,
    kind: focus,
    evidence: `${witnessLabel(witness)} on ${patch.profile.id}`,
    tokens: witness.sort === "mechanical" ? 0 : 1,
    witness,
  } as const

  // A mechanical witness that can tell whether it looked at the change says so.
  if (witness.sort === "mechanical" && focus === "side_effect" && r() >= SIDE_EFFECT_COVERAGE)
    return { ...base, status: "unavailable", detail: "the run never reached the change" }
  if (witness.sort === "mechanical" && focus === "test" && r() >= TEST_COVERAGE)
    return { ...base, status: "unavailable", detail: "no test executed the lines that changed" }

  const found = detects(witness, focus, patch.defect, r)
  const spurious =
    !found &&
    !(witness.sort === "judged" && witness.by === AUTHOR) &&
    r() < (witness.sort === "mechanical" ? MECHANICAL_FALSE_POSITIVE : JUDGED_FALSE_POSITIVE)
  return { ...base, status: found || spurious ? "failed" : "passed" }
}

/**
 * What gets collected without anybody asking.
 *
 * The author always says the patch is fine, unless they noticed the defect —
 * which is the honest model of a patch with a defect in it, and is why the
 * self-claim is the piece of evidence that is always present and always the
 * least informative.
 */
const volunteered = (patch: Patch, r: () => number): AttributedCheck[] => {
  const checks: AttributedCheck[] = [observe(judged(AUTHOR), "test", patch, r)]
  if (r() < ARRIVES_WHEN_VOLUNTEERED) checks.push(observe(mech("tsgo"), "build", patch, r))
  if (r() < ARRIVES_WHEN_VOLUNTEERED) checks.push(observe(mech("bun-test"), "test", patch, r))
  if (r() < FREE_SCANNER_ARRIVES) checks.push(observe(mech("secret-scan"), "security", patch, r))
  if (r() < 0.4)
    checks.push(observe(judged("agent-b", r() < VOLUNTEERED_CONTAMINATION ? "contaminated" : "clean"), "test", patch, r))
  return checks
}

/** Witnesses a demand would accept as establishing a kind. */
const admissibleWitnesses = (checks: readonly AttributedCheck[], kind: CheckKind): Set<string> => {
  const ids = new Set<string>()
  for (const c of checks) {
    if (c.kind !== kind || c.status !== "passed") continue
    if (c.witness.sort === "mechanical") ids.add(`tool:${c.witness.tool}`)
    else if (c.witness.by !== AUTHOR && c.witness.context === "clean") ids.add(`actor:${c.witness.by}`)
  }
  return ids
}

const MECHANICAL_FOR: Readonly<Record<string, string>> = {
  build: "tsgo",
  test: "bun-test",
  security: "secret-scan",
  side_effect: "sandbox",
}

/**
 * Fill a shortfall.
 *
 * The mechanical witness first, because it is cheaper and has no stake, then
 * clean reviewers. A commissioned check can still fail to arrive, and when it
 * does the kind stays short — the demand does not manufacture evidence, it
 * makes the absence of evidence visible.
 */
const commission = (
  patch: Patch,
  shortfall: ReadonlyMap<CheckKind, number>,
  used: Map<CheckKind, number>,
  r: () => number,
): AttributedCheck[] => {
  const extra: AttributedCheck[] = []
  for (const [kind, missing] of shortfall) {
    for (let i = 0; i < missing; i++) {
      const n = used.get(kind) ?? 0
      used.set(kind, n + 1)
      const witness: Witness =
        n === 0 ? mech(MECHANICAL_FOR[kind] ?? kind) : judged(`reviewer-${kind}-${n}`, r() < DEMANDED_CONTAMINATION ? "contaminated" : "clean")
      if (r() < ARRIVES_WHEN_DEMANDED) extra.push(observe(witness, kind, patch, r))
    }
  }
  return extra
}

/** The opening shortfall: the demand, minus whatever was volunteered. */
const openingShortfall = (patch: Patch, have: readonly AttributedCheck[]): Map<CheckKind, number> => {
  const plan = demand(patch.profile)
  const shortfall = new Map<CheckKind, number>()
  for (const kind of plan.required) {
    const need = plan.quorumKinds.includes(kind) ? plan.quorum : 1
    const missing = need - admissibleWitnesses(have, kind).size
    if (missing > 0) shortfall.set(kind, missing)
  }
  return shortfall
}

/**
 * How many times a harness will go back and fill what the verdict said was
 * missing.
 *
 * Not a dial — a mechanism. Without it a sandbox that was down, a witness that
 * reported no coverage, and a reviewer's spurious concern all end the same way:
 * the patch is refused for want of evidence that nobody went and got. That is
 * where the first sweep spent 6.4 of its 11.4 points of false rejection.
 */
const ANSWERING_ROUNDS = 4

/**
 * The network arm, with the harness that fulfils its demands.
 *
 * Each round asks `review` what is short and goes to get exactly that. Only a
 * shortfall that survives every round is a rejection.
 */
const networkArm = (patch: Patch, collected: readonly AttributedCheck[], r: () => number) => {
  const used = new Map<CheckKind, number>()
  let checks = [...collected, ...commission(patch, openingShortfall(patch, collected), used, r)]
  let verdict = review(patch.profile, checks)

  for (let round = 0; round < ANSWERING_ROUNDS; round++) {
    if (verdict.verdict !== "unverified" || verdict.shortfall.size === 0) break
    const answers = commission(patch, verdict.shortfall, used, r)
    if (answers.length === 0) break
    checks = [...checks, ...answers]
    verdict = review(patch.profile, checks)
  }

  return { verdict, checks }
}

interface ArmTally {
  readonly name: string
  goodRejected: number
  goodTotal: number
  badRejected: number
  badTotal: number
  criticalBadRejected: number
  criticalBadTotal: number
  judgedRuns: number
  escaped: Record<string, number>
  byKind: Record<string, number>
}

const tally = (name: string): ArmTally => ({
  name,
  goodRejected: 0,
  goodTotal: 0,
  badRejected: 0,
  badTotal: 0,
  criticalBadRejected: 0,
  criticalBadTotal: 0,
  judgedRuns: 0,
  escaped: {},
  byKind: {},
})

const record = (arm: ArmTally, patch: Patch, rejected: boolean, checks: readonly AttributedCheck[]) => {
  arm.judgedRuns += checks.filter((c) => c.witness.sort === "judged" && c.witness.by !== AUTHOR).length
  if (patch.defect === undefined) {
    arm.goodTotal += 1
    if (rejected) arm.goodRejected += 1
    return
  }
  arm.badTotal += 1
  arm.byKind[patch.defect] = (arm.byKind[patch.defect] ?? 0) + 1
  if (rejected) arm.badRejected += 1
  else arm.escaped[patch.defect] = (arm.escaped[patch.defect] ?? 0) + 1
  if (criticalityOf(patch.profile) === "critical") {
    arm.criticalBadTotal += 1
    if (rejected) arm.criticalBadRejected += 1
  }
}

const sweep = (seed: number) => {
  const r = rng(seed)
  const A = tally("A — collected evidence, no demand, no admission")
  const B = tally("B — full evidence, no admission")
  const C = tally("C — the network")

  for (let i = 0; i < RUNS; i++) {
    const patch = makePatch(r, i)
    const collected = volunteered(patch, r)
    const { verdict, checks } = networkArm(patch, collected, r)

    record(A, patch, fold(collected).verdict !== "passed", collected)
    record(B, patch, fold(checks).verdict !== "passed", checks)
    record(C, patch, verdict.verdict !== "passed", checks)
  }

  return { A, B, C }
}

const rates = (arm: ArmTally) => ({
  badRejected: arm.badRejected / arm.badTotal,
  criticalBadRejected: arm.criticalBadRejected / arm.criticalBadTotal,
  falseRejection: arm.goodRejected / arm.goodTotal,
  judgedPerPatch: arm.judgedRuns / (arm.goodTotal + arm.badTotal),
})

const { A, B, C } = sweep(SEED)
const a = rates(A)
const b = rates(B)
const c = rates(C)

const pct = (x: number) => `${(x * 100).toFixed(2)}%`

describe(`the sweep — ${RUNS.toLocaleString("en")} patches, seed 0x${SEED.toString(16)}`, () => {
  /**
   * The control.
   *
   * S131 taught this the expensive way: a simulation that does not reproduce
   * the phenomenon measures nothing, and every arm passing is what that looks
   * like from the inside. If arm A already rejects bad patches, then there is
   * no problem here and the rest of the numbers are decoration.
   */
  test("control: the naive arm really does let bad patches through", () => {
    console.log(`  A ${A.name}`)
    console.log(`    bad rejected ${pct(a.badRejected)} | critical bad ${pct(a.criticalBadRejected)} | false rejection ${pct(a.falseRejection)}`)
    console.log(`  B ${B.name}`)
    console.log(`    bad rejected ${pct(b.badRejected)} | critical bad ${pct(b.criticalBadRejected)} | false rejection ${pct(b.falseRejection)}`)
    console.log(`  C ${C.name}`)
    console.log(`    bad rejected ${pct(c.badRejected)} | critical bad ${pct(c.criticalBadRejected)} | false rejection ${pct(c.falseRejection)}`)
    console.log(`  reviewer runs per patch: A ${a.judgedPerPatch.toFixed(2)}  B ${b.judgedPerPatch.toFixed(2)}  C ${c.judgedPerPatch.toFixed(2)}`)
    console.log(`  where the network's escapes are:`)
    for (const kind of Object.keys(C.byKind).sort())
      console.log(
        `    ${kind.padEnd(12)} escape ${pct((C.escaped[kind] ?? 0) / C.byKind[kind]!).padStart(7)}` +
          `  (${(((C.escaped[kind] ?? 0) / (C.badTotal - C.badRejected)) * 100).toFixed(0)}% of all escapes)`,
      )

    expect(a.badRejected).toBeLessThan(0.9)
  })

  test("false rejection stays at or under 3%", () => {
    expect(c.falseRejection).toBeLessThanOrEqual(0.03)
  })

  /**
   * The independent check, and the reason the false-rejection bound is not
   * enough on its own: the cheapest route to rejecting every bad patch is to
   * reject every patch. A good patch that carries its evidence has to land.
   */
  test("good patches still land — the guarantee is not bought by refusing everything", () => {
    expect(1 - c.falseRejection).toBeGreaterThan(0.95)
  })

  /**
   * Which mechanism did which job.
   *
   * Arm B has EXACTLY the evidence arm C has and none of the admission rules,
   * so the two gaps are clean: A to B is the demand, B to C is admission. And
   * the answer is not the one the design expected — the demand does nearly all
   * of the detection work, and admission does nearly all of the
   * false-rejection work. B finds 0.2 points more bad patches than C and pays
   * 5.4 points of false rejection for them, which is not a trade anybody would
   * take on purpose.
   *
   * Said plainly: making the evidence exist is what catches bad patches, and
   * refusing to count unearned evidence is what keeps good ones alive.
   */
  test("the demand does the detection, and admission pays for it in false rejections", () => {
    expect(b.badRejected - a.badRejected).toBeGreaterThan(0.25)
    expect(c.falseRejection).toBeLessThan(b.falseRejection / 2)
    expect(Math.abs(c.badRejected - b.badRejected)).toBeLessThan(0.01)
  })

  // ------------------------------------------------------------------------
  // The two acceptance lines this sprint does NOT meet
  // ------------------------------------------------------------------------

  /**
   * ≥98% of bad patches rejected. MEASURED: 94.83%, and 94.83–95.01% across
   * five seeds.
   *
   * Written as a failing test rather than softened, because a bar quietly
   * rewritten to the number that was achieved is not a bar.
   *
   * The residue has one name. The network converts "the witness did not look"
   * into a rejection — that is what the sandbox's coverage flag and the suite's
   * coverage flag do, and between them they took side-effect escapes to 1.1%
   * and cut test escapes by a third. Nothing here converts "the witness looked
   * and did not recognise", and a logic defect on a line the suite executes and
   * asserts nothing useful about is precisely that. It escapes at 11% and is
   * roughly four fifths of every escape the network makes.
   *
   * Whether this line is met is therefore a claim about the POPULATION, not
   * about the design, and the break-even is computable: with every other escape
   * rate as measured, ≥98% holds while subtle logic defects are at most about
   * 5% of bad patches. They are a third of them here. Moving that mix after
   * seeing the result would have produced a green test and no knowledge.
   */
  test.failing("bad patches are rejected at least 98% of the time", () => {
    expect(c.badRejected).toBeGreaterThanOrEqual(0.98)
  })

  /**
   * ≥99.9% of critical bad patches rejected. MEASURED: 98.51%.
   *
   * This one is reachable and is not taken, which is a different kind of miss
   * and worth being exact about. Raising the critical quorum walks toward it:
   *
   *     quorum   critical   false rejection   reviewer runs/patch
   *        2      98.51%         2.48%               1.40
   *        3      99.46%         2.93%               2.47
   *        4      99.91%         3.76%               3.54
   *        5      99.95%         5.01%               4.60
   *
   * Only quorum 4 clears 99.9%, and it clears it by breaking the ≤3% false
   * rejection line this same sprint sets. The two criteria are mutually
   * exclusive under these rates.
   *
   * Quorum 3 looked like the exception — 2.93% is inside 3% — and it is not:
   * on three of the five seeds it costs 3.15–3.17%. The row is a coin flip
   * against the ceiling and this seed won it. Two is the largest quorum that
   * holds the bound on every seed, so two is what this is.
   */
  test.failing("critical bad patches are rejected at least 99.9% of the time", () => {
    expect(c.criticalBadRejected).toBeGreaterThanOrEqual(0.999)
  })

  /**
   * The floors under the two bars above.
   *
   * Without these, `test.failing` is a place for numbers to rot quietly: a
   * change that took bad rejection from 95% to 60% would leave this file green
   * and say nothing. These are the measured values, and they are here to break
   * loudly if the design regresses.
   */
  test("the measured floors hold", () => {
    expect(c.badRejected).toBeGreaterThanOrEqual(0.94)
    expect(c.criticalBadRejected).toBeGreaterThanOrEqual(0.98)
    expect(c.judgedPerPatch).toBeLessThan(1.6)
  })

  /**
   * The bound that decided the configuration, checked where it was nearly lost.
   *
   * A quorum was chosen on one seed, fitted inside 3% by 0.07 points, and did
   * not survive contact with four more. So the false-rejection bound is
   * asserted on every seed, and the critical floor with it — a configuration
   * that holds only on the seed it was tuned on is a tuned configuration.
   */
  test("the bounds hold on every seed, not only the one they were measured on", () => {
    for (const seed of SEEDS) {
      const arm = rates(sweep(seed).C)
      expect(arm.falseRejection).toBeLessThanOrEqual(0.03)
      expect(arm.criticalBadRejected).toBeGreaterThanOrEqual(0.98)
      expect(arm.badRejected).toBeGreaterThanOrEqual(0.94)
    }
  })

  test("the quorum constants are the ones the network actually applied", () => {
    expect(CRITICAL_QUORUM).toBe(2)
    expect(QUORUM_KINDS).toContain("side_effect")
    expect(QUORUM_KINDS).toContain("test")
  })
})
