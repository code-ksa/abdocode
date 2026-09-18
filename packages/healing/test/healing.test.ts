/**
 * Batch 10 GATES — S93 a fingerprint that survives a machine change, S94 no
 * stupid loop, S95 reboot and watchdog, S96 rollback and no silence.
 */
import { describe, expect, test } from "bun:test"
import {
  afterReboot,
  checkNoSilence,
  fingerprint,
  nextStrategy,
  normaliseFailure,
  planRollback,
  watchdog,
  worldHash,
  type Attempt,
  type FaultRecord,
  type RunHeartbeat,
} from "../src/index"

describe("S93 GATE — the same failure gives the same fingerprint across machines and sessions", () => {
  test("paths, pids, ports, timestamps, uuids and hashes do not change it", () => {
    const onWindows = fingerprint({
      failureClass: "TRANSPORT",
      site: "shell",
      message: `connect ECONNREFUSED 127.0.0.1:5432 at C:\\workspaces\\sample\\src\\db.ts (pid 41233) 2026-08-19T20:11:04.221Z req=8f3ac1d2-1f4e-4a11-9c33-77b8de10aa21`,
    })
    const onLinuxNextMonth = fingerprint({
      failureClass: "TRANSPORT",
      site: "shell",
      message: `connect ECONNREFUSED 127.0.0.1:5433 at /srv/abdo/src/db.ts (pid 902) 2026-09-30T04:00:00.000Z req=00000000-1111-2222-3333-444444444444`,
    })
    expect(onLinuxNextMonth.id).toBe(onWindows.id)
  })

  test("a genuinely different failure gets a different fingerprint", () => {
    const a = fingerprint({ failureClass: "TRANSPORT", site: "shell", message: "connect ECONNREFUSED" })
    const b = fingerprint({ failureClass: "TRANSPORT", site: "shell", message: "certificate has expired" })
    const c = fingerprint({ failureClass: "AUTH", site: "shell", message: "connect ECONNREFUSED" })
    expect(a.id).not.toBe(b.id)
    // the same message from a different class is a different fact
    expect(a.id).not.toBe(c.id)
  })

  test("the stack is excluded — a fingerprint that moves when an import is added has told you nothing", () => {
    const withStack = fingerprint({ failureClass: "DATA", site: "tool", message: "bad row", stack: "at line 41" })
    const laterEdit = fingerprint({ failureClass: "DATA", site: "tool", message: "bad row", stack: "at line 88" })
    expect(withStack.id).toBe(laterEdit.id)
  })

  test("normalisation is visible, so a mismatch can be explained rather than guessed at", () => {
    const normalised = normaliseFailure("failed on port 5432 at 0xdeadbeef")
    expect(normalised).toContain("port=<n>")
    expect(normalised).toContain("<addr>")
    expect(normaliseFailure("failed on port 5432")).not.toContain("5432")
  })
})

describe("S94 GATE — a failed strategy is not repeated while the world is unchanged", () => {
  const ladder = ["restart_service", "clear_cache", "reinstall"]
  const world = { facts: { serviceUp: "false", diskFreeGb: "40" } }
  const fp = "fp1"

  test("the first attempt just runs", () => {
    const decision = nextStrategy(ladder, [], { fingerprintId: fp, world })
    expect(decision.kind).toBe("try")
    if (decision.kind === "try") expect(decision.strategy).toBe("restart_service")
  })

  test("after all three fail with nothing changed, the answer is WAIT and it says what must move", () => {
    const attempts: Attempt[] = ladder.map((strategy, i) => ({
      fingerprintId: fp,
      strategy,
      worldHash: worldHash(world),
      at: i,
    }))
    const decision = nextStrategy(ladder, attempts, { fingerprintId: fp, world })
    expect(decision.kind).toBe("wait")
    if (decision.kind === "wait") expect(decision.why).toContain("not until something moves")
  })

  test("when the world DOES change, a previously failed strategy is a genuine retry", () => {
    const attempts: Attempt[] = ladder.map((strategy, i) => ({
      fingerprintId: fp,
      strategy,
      worldHash: worldHash(world),
      at: i,
    }))
    const changed = { facts: { serviceUp: "true", diskFreeGb: "40" } }
    const decision = nextStrategy(ladder, attempts, { fingerprintId: fp, world: changed })
    expect(decision.kind).toBe("try")
    if (decision.kind === "try") expect(decision.why).toContain("the world has changed since")
  })

  test("once every strategy has failed under a SECOND world, it escalates", () => {
    const first = worldHash(world)
    const second = worldHash({ facts: { serviceUp: "true", diskFreeGb: "40" } })
    const attempts: Attempt[] = ladder.flatMap((strategy, i) => [
      { fingerprintId: fp, strategy, worldHash: first, at: i },
      { fingerprintId: fp, strategy, worldHash: second, at: i + 10 },
    ])
    const decision = nextStrategy(ladder, attempts, { fingerprintId: fp, world })
    expect(decision.kind).toBe("escalate")
    if (decision.kind === "escalate") expect(decision.why).toContain("changing the world has already been tried")
  })

  test("a different failure is not blocked by this one's history", () => {
    const attempts: Attempt[] = [{ fingerprintId: fp, strategy: "restart_service", worldHash: worldHash(world), at: 1 }]
    expect(nextStrategy(ladder, attempts, { fingerprintId: "other", world }).kind).toBe("try")
  })

  test("a world hash does not depend on key order", () => {
    expect(worldHash({ facts: { a: "1", b: "2" } })).toBe(worldHash({ facts: { b: "2", a: "1" } }))
  })
})

describe("S95 GATE — a reboot resumes, and a dead run does not hold a claim for ever", () => {
  const beats: RunHeartbeat[] = [
    { runId: "r1", agentId: "a1", lastBeatAt: 10_000, intervalMs: 1000, holdsClaim: "t1" },
    { runId: "r2", agentId: "a2", lastBeatAt: 1000, intervalMs: 1000, holdsClaim: "t2" },
  ]

  test("three missed beats is dead; one is a slow disk", () => {
    const atTwoMissed = watchdog(beats, 12_500)
    expect(atTwoMissed.dead.map((d) => d.runId)).toEqual(["r2"])
    // killing a healthy run for one missed beat is worse than waiting
    expect(atTwoMissed.alive.map((a) => a.runId)).toContain("r1")
  })

  test("the claims a dead run held are named for release", () => {
    expect([...watchdog(beats, 100_000).claimsToRelease].sort()).toEqual(["t1", "t2"])
    expect(watchdog(beats, 100_000).why).toContain("must not hold a claim for ever")
  })

  test("a reboot with a matching tree resumes the sprint that was in flight", () => {
    const decision = afterReboot({
      inFlight: [{ sprintId: "s93", state: "RUNNING" }],
      treeMatchesLedger: true,
      treeReadable: true,
    })
    expect(decision.kind).toBe("resume")
    if (decision.kind === "resume") expect(decision.sprintId).toBe("s93")
  })

  test("a tree that moved while the machine was down blocks the resume", () => {
    const decision = afterReboot({
      inFlight: [{ sprintId: "s93", state: "RUNNING" }],
      treeMatchesLedger: false,
      treeReadable: true,
    })
    expect(decision.kind).toBe("reconcile_first")
    if (decision.kind === "reconcile_first") expect(decision.why).toContain("destroys a manual fix")
  })

  test("an unreadable tree is not a clean one", () => {
    expect(
      afterReboot({ inFlight: [{ sprintId: "s93", state: "RUNNING" }], treeMatchesLedger: true, treeReadable: false }).kind,
    ).toBe("reconcile_first")
  })

  test("nothing in flight means nothing to do", () => {
    expect(afterReboot({ inFlight: [{ sprintId: "s1", state: "COMMITTED" }], treeMatchesLedger: true, treeReadable: true }).kind).toBe(
      "nothing_to_do",
    )
  })
})

describe("S96 GATE — a rollback never touches a committed sprint, and nothing is silent", () => {
  const committed = [{ sprintId: "s90", state: "COMMITTED", commit: "abc", filesChanged: ["src/shared.ts"] }]

  test("rolling back a committed sprint is refused, and the reason is not about permissions", () => {
    const decision = planRollback({ sprintId: "s90", state: "COMMITTED", filesChanged: ["src/shared.ts"] }, committed)
    expect(decision.kind).toBe("refuse")
    if (decision.kind === "refuse") expect(decision.why).toContain("a state that never existed")
  })

  test("a file also touched by a committed sprint is refused, with the overlap named", () => {
    const decision = planRollback({ sprintId: "s94", state: "FAILED", filesChanged: ["src/a.ts", "src/shared.ts"] }, committed)
    expect(decision.kind).toBe("refuse")
    if (decision.kind === "refuse") {
      expect(decision.wouldTouch).toEqual(["src/shared.ts"])
      expect(decision.why).toContain("silently undo part of it")
    }
  })

  test("a clean rollback proceeds", () => {
    const decision = planRollback({ sprintId: "s94", state: "FAILED", filesChanged: ["src/a.ts"] }, committed)
    expect(decision.kind).toBe("rollback")
    if (decision.kind === "rollback") expect(decision.files).toEqual(["src/a.ts"])
  })

  test("every injected fault is classified and disposed of — a silent one fails the gate", () => {
    const clean: FaultRecord[] = [
      { fingerprintId: "f1", classified: true, disposition: "recovered" },
      { fingerprintId: "f2", classified: true, disposition: "escalated" },
    ]
    expect(checkNoSilence(clean).ok).toBe(true)

    const silent: FaultRecord[] = [...clean, { fingerprintId: "f3", classified: true }]
    const report = checkNoSilence(silent)
    expect(report.ok).toBe(false)
    expect(report.silent).toEqual(["f3"])
    expect(report.why).toContain("carried on as though it had not happened")
  })

  test("an unclassified fault is silent even if something was done about it", () => {
    expect(checkNoSilence([{ fingerprintId: "f1", classified: false, disposition: "recovered" }]).ok).toBe(false)
  })
})
