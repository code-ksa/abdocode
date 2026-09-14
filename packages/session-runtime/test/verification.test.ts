/**
 * Sprint 27 — the builder builds, the verifier judges, and neither does the
 * other's job.
 *
 * The rules under test are the two that make the split real: a criterion is met
 * by a CHECK and never by prose, and judgement may refuse but never bless. Both
 * exist because a confident account of finished work is the cheapest thing an
 * agent can produce.
 */
import { describe, expect, test } from "bun:test"
import {
  applyJudgement,
  currentVerdict,
  isSelfVerified,
  mechanicalVerdict,
  passIsEarned,
  type AcceptanceCriterion,
  type CheckOutcome,
  type EvidencePacket,
} from "@abdo/contracts/verification"
import { MemoryEventStore } from "@abdo/event-store"
import { MissionLedger } from "../src/missions"
import { buildEvidencePacket, narrativeLeak, runVerificationLoop, VerificationLedger } from "../src/verification"

const MID = "mis_v"
const CRITERIA: AcceptanceCriterion[] = [
  { id: "c1", text: "the loader reads a config file", checks: ["unit"] },
  { id: "c2", text: "an invalid file is refused", checks: ["invalid"] },
]

const check = (checkId: string, passed: boolean): CheckOutcome => ({
  checkId,
  command: `bun test ${checkId}`,
  exitCode: passed ? 0 : 1,
  passed,
})

const packetWith = (checks: CheckOutcome[], acceptance = CRITERIA): EvidencePacket =>
  buildEvidencePacket({
    packetId: "pkt_1",
    sprintId: "s27",
    builderRunId: "run_builder",
    acceptance,
    diff: { files: [{ path: "src/config.ts", added: 40, removed: 0, status: "added" }] },
    checks,
  })

describe("the mechanical floor", () => {
  test("every criterion demonstrated by a passing check is verified", () => {
    const v = mechanicalVerdict(packetWith([check("unit", true), check("invalid", true)]))
    expect(v.decision).toBe("verified")
    expect(v.unmet).toEqual([])
  })

  test("a failing check is a REJECTION — the work was measured and it did not hold", () => {
    const v = mechanicalVerdict(packetWith([check("unit", true), check("invalid", false)]))
    expect(v.decision).toBe("rejected")
    expect(v.unmet).toEqual(["c2"])
  })

  test("a criterion nothing checked is INCONCLUSIVE, not a pass", () => {
    const v = mechanicalVerdict(packetWith([check("unit", true)]))
    expect(v.decision).toBe("inconclusive")
    expect(v.unmet).toEqual(["c2"])
    expect(v.reasons.join(" ")).toContain("no check demonstrates this")
  })

  test("a criterion that declares no check at all can never be met", () => {
    const v = mechanicalVerdict(
      packetWith([check("unit", true)], [{ id: "c1", text: "it feels right", checks: [] }]),
    )
    expect(v.decision).toBe("inconclusive")
    expect(v.unmet).toEqual(["c1"])
  })

  test("no acceptance criteria is inconclusive — there was nothing to verify against", () => {
    const v = mechanicalVerdict(packetWith([check("unit", true)], []))
    expect(v.decision).toBe("inconclusive")
  })
})

describe("judgement refuses, never blesses", () => {
  test("the verifier cannot promote an inconclusive packet", () => {
    const floor = mechanicalVerdict(packetWith([check("unit", true)]))
    const final = applyJudgement(floor, { decision: "verified", reasons: ["looks complete to me"] })
    expect(final.decision).toBe("inconclusive")
    expect(final.unmet).toEqual(["c2"])
  })

  test("the verifier CAN reject work every check passed — green is not correct", () => {
    const floor = mechanicalVerdict(packetWith([check("unit", true), check("invalid", true)]))
    expect(floor.decision).toBe("verified")
    const final = applyJudgement(floor, {
      decision: "rejected",
      unmet: ["c2"],
      reasons: ["the test asserts the refusal message, not that the file was refused"],
    })
    expect(final.decision).toBe("rejected")
    expect(final.reasons.join(" ")).toContain("not that the file was refused")
  })
})

describe("the packet carries evidence and no argument", () => {
  test("it is assembled field by field, so an extra property cannot ride along", () => {
    const packet = buildEvidencePacket({
      packetId: "pkt_x",
      sprintId: "s27",
      builderRunId: "run_b",
      acceptance: CRITERIA,
      diff: { files: [] },
      checks: [],
      // a caller attaching a note the type does not declare
      ...({ builderNotes: "I checked this by hand and it is definitely correct" } as object),
    })
    expect(JSON.stringify(packet)).not.toContain("definitely correct")
    expect("builderNotes" in packet).toBe(false)
  })

  test("check output is tail-truncated by the builder of the packet, not the model", () => {
    const packet = buildEvidencePacket({
      packetId: "pkt_y",
      sprintId: "s27",
      builderRunId: "run_b",
      acceptance: CRITERIA,
      diff: { files: [] },
      checks: [{ checkId: "unit", command: "bun test", exitCode: 0, passed: true, output: "x".repeat(9000) }],
    })
    expect(packet.checks[0]!.output!.length).toBe(4000)
  })

  test("narrativeLeak reports what it found rather than silently scrubbing it", () => {
    const packet = buildEvidencePacket({
      packetId: "pkt_z",
      sprintId: "s27",
      builderRunId: "run_b",
      acceptance: CRITERIA,
      diff: { files: [], patch: "+// trust me, this path is unreachable\n" },
      checks: [],
    })
    // the diff is what the builder ACTUALLY did; censoring it would be worse
    expect(narrativeLeak(packet, ["trust me"])).toEqual(["trust me"])
    // and it still earns nothing: no check, so nothing is demonstrated
    expect(mechanicalVerdict(packet).decision).toBe("inconclusive")
  })
})

describe("the loop", () => {
  const ledgerFor = () => {
    const store = new MemoryEventStore()
    return { store, ledger: new VerificationLedger({ store, missionId: MID }) }
  }

  test("a rejection sends back criteria and reasons — and nothing about the verifier", async () => {
    const { ledger } = ledgerFor()
    const seen: unknown[] = []
    let round = 0
    const result = await runVerificationLoop({
      ledger,
      sprintId: "s27",
      acceptance: CRITERIA,
      build: async (feedback) => {
        seen.push(feedback)
        round++
        return {
          runId: `run_b${round}`,
          diff: { files: [{ path: "a.ts", added: 1, removed: 0, status: "modified" }] },
          checks: round === 1 ? [check("unit", true), check("invalid", false)] : [check("unit", true), check("invalid", true)],
        }
      },
      judge: async () => ({ runId: "run_v", decision: "verified" }),
    })

    expect(result.outcome).toBe("verified")
    expect(seen[0]).toBeUndefined()
    expect(seen[1]).toEqual({
      round: 2,
      unmet: [{ id: "c2", text: "an invalid file is refused" }],
      reasons: ["c2: bun test invalid exited 1"],
    })
  })

  test("the same failure twice stops the loop instead of spending the budget on it", async () => {
    const { ledger } = ledgerFor()
    let builds = 0
    const result = await runVerificationLoop({
      ledger,
      sprintId: "s27",
      acceptance: CRITERIA,
      maxRounds: 5,
      build: async () => {
        builds++
        return {
          runId: `run_b${builds}`,
          diff: { files: [] },
          checks: [check("unit", true), check("invalid", false)],
        }
      },
      judge: async () => ({ runId: "run_v", decision: "verified" }),
    })

    expect(result.outcome).toBe("escalated")
    expect(builds).toBe(2)
    expect(result.reason).toContain("identical failure")
  })

  test("rounds exhausted escalates and never quietly passes", async () => {
    const { ledger } = ledgerFor()
    let n = 0
    const result = await runVerificationLoop({
      ledger,
      sprintId: "s27",
      acceptance: CRITERIA,
      maxRounds: 3,
      build: async () => {
        n++
        // a DIFFERENT failure each round, so the loop detector does not fire
        return {
          runId: `run_b${n}`,
          diff: { files: [] },
          checks: [check("unit", n % 2 === 0), check("invalid", false)],
        }
      },
      judge: async () => ({ runId: "run_v", decision: "verified" }),
    })
    expect(result.outcome).toBe("escalated")
    expect(result.rounds).toBe(3)
    expect(result.reason).toContain("3 rounds")
  })

  test("a verifier that is the builder is refused, and the refusal is written down", async () => {
    const { store, ledger } = ledgerFor()
    const result = await runVerificationLoop({
      ledger,
      sprintId: "s27",
      acceptance: CRITERIA,
      build: async () => ({
        runId: "run_same",
        diff: { files: [] },
        checks: [check("unit", true), check("invalid", true)],
      }),
      judge: async () => ({ runId: "run_same", decision: "verified" }),
    })

    expect(result.outcome).toBe("escalated")
    const types = (await store.readAll()).map((e) => e.type)
    expect(types).toContain("verification.refused")
    // and no verdict was recorded at all — a self-verdict that counted a little
    // would be worse than one that counted fully
    expect(types).not.toContain("verification.verdict")
  })
})

describe("GATE — no sprint reaches PASSED on the builder's own word", () => {
  const setup = async () => {
    const store = new MemoryEventStore()
    const missions = new MissionLedger({ store, missionId: MID })
    const verification = new VerificationLedger({ store, missionId: MID })
    await missions.createMission("abdo 2.1")
    await missions.planSprint({ sprintId: "s27", number: 27, title: "personas", acceptance: ["c1", "c2"] })
    await missions.transition("s27", "READY")
    await missions.transition("s27", "RUNNING")
    await missions.transition("s27", "VERIFYING")
    return { store, missions, verification }
  }

  test("with no verdict at all, PASSED is refused", async () => {
    const { store, missions } = await setup()
    const moved = await missions.transition("s27", "PASSED", { reason: "everything works, I checked" })
    expect(moved.ok).toBe(false)
    expect(moved.reason).toContain("no verification verdict")
    const refusals = (await store.readAll()).filter((e) => e.type === "sprint.transition_refused")
    expect(refusals.length).toBe(1)
    expect((await missions.mission())!.sprints[0]!.state).toBe("VERIFYING")
  })

  test("with the builder's own verdict, PASSED is refused and says why", async () => {
    const { missions, verification } = await setup()
    await verification.recordVerdict({
      sprintId: "s27",
      packetId: "pkt_1",
      builderRunId: "run_b",
      verifierRunId: "run_b",
      decision: "verified",
      unmet: [],
      reasons: [],
    })
    const moved = await missions.transition("s27", "PASSED")
    expect(moved.ok).toBe(false)
    expect(moved.reason).toContain("verified its own work")
    expect(isSelfVerified((await verification.verdicts("s27"))!)).toBe(true)
  })

  test("with an inconclusive verdict, PASSED is refused — unknown is not yes", async () => {
    const { missions, verification } = await setup()
    await verification.recordVerdict({
      sprintId: "s27",
      packetId: "pkt_1",
      builderRunId: "run_b",
      verifierRunId: "run_v",
      decision: "inconclusive",
      unmet: ["c2"],
      reasons: ["c2: no check demonstrates this"],
    })
    const moved = await missions.transition("s27", "PASSED")
    expect(moved.ok).toBe(false)
    expect(moved.reason).toContain("inconclusive")
  })

  test("with an independent verified verdict, PASSED is allowed", async () => {
    const { store, missions, verification } = await setup()
    await verification.recordVerdict({
      sprintId: "s27",
      packetId: "pkt_1",
      builderRunId: "run_b",
      verifierRunId: "run_v",
      decision: "verified",
      unmet: [],
      reasons: [],
    })
    const moved = await missions.transition("s27", "PASSED")
    expect(moved.ok).toBe(true)
    expect(passIsEarned(currentVerdict(await store.readAll(), "s27")).ok).toBe(true)
    // and COMMITTED remains reachable only from here, as S23 established
    expect((await missions.transition("s27", "COMMITTED", { commit: "abc123" })).ok).toBe(true)
  })

  test("a later rejection is what stands — the newest verdict in LOG order wins", async () => {
    const { missions, verification } = await setup()
    for (const [verifier, decision] of [
      ["run_v1", "verified"],
      ["run_v2", "rejected"],
    ] as const) {
      await verification.recordVerdict({
        sprintId: "s27",
        packetId: "pkt_1",
        builderRunId: "run_b",
        verifierRunId: verifier,
        decision,
        unmet: decision === "rejected" ? ["c1"] : [],
        reasons: decision === "rejected" ? ["the loader ignores the path argument"] : [],
      })
    }
    const moved = await missions.transition("s27", "PASSED")
    expect(moved.ok).toBe(false)
    expect(moved.reason).toContain("ignores the path argument")
  })
})
