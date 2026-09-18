/**
 * P5c2-FINAL-RC4 §4 — THE LIFECYCLE IS EVIDENCE, NOT A FORMAT.
 *
 * The concern this file answers, stated plainly: a recorder that appends
 * `started -> child_started -> child_exited -> result` because that is the
 * expected order proves nothing at all. It would produce a perfect, ordered,
 * complete sequence for a spawn that created no process and for a wait that
 * never observed an exit — and every downstream check would pass while measuring
 * the recorder's own vocabulary.
 *
 * So two things are pinned here:
 *
 *   POSITIVE  the events a REAL run produces are bound to that run's identity,
 *             and both transports produce equivalent evidence — not merely
 *             equivalent strings;
 *   NEGATIVE  every way the evidence can be wrong is REJECTED, and each is
 *             constructed explicitly rather than hoped for.
 *
 * The negative cases are synthetic on purpose. A fabricated `child_started` for
 * a process that never existed cannot be produced by asking the harness nicely;
 * the only honest way to prove the validator catches it is to hand it one.
 */
import { describe, expect, test } from "bun:test"
import { LIFECYCLE_ORDER, helperBuilt, lastBinding, lastEvents, runDirect, runDirectAsync, validateLifecycle, type LifecycleBinding } from "./harness"

const READY = process.platform === "win32" && helperBuilt()
const CMD = "C:\\Windows\\System32\\cmd.exe"
const T = 120_000

/** A well-formed sequence for one invocation, as the recorder would emit it. */
function goodEvents(b: LifecycleBinding, pid = 4242): string {
  return [
    `started seq=0 run=${b.runId} op=${b.operationId} t=1000`,
    `child_started seq=1 run=${b.runId} op=${b.operationId} pid=${pid} t=1001`,
    `child_exited seq=2 run=${b.runId} op=${b.operationId} pid=${pid} code=0 t=1002`,
    `result seq=3 run=${b.runId} op=${b.operationId} t=1003`,
  ].join("\n")
}

const BIND: LifecycleBinding = { runId: "r-1", operationId: "run", pid: 4242 }

describe("RC4 §4 — the lifecycle validator rejects every fabrication", () => {
  test("a well-formed, correctly bound sequence is ACCEPTED (non-vacuity)", () => {
    // Without this the whole file could pass with a validator that refuses
    // everything, which would be indistinguishable from one that works.
    expect(validateLifecycle(goodEvents(BIND), BIND)).toEqual([])
  })

  test("PROCESS CREATION FAILED: child_started must not exist", () => {
    // The spawn produced nothing, so there is no pid to name. A recorder that
    // wrote `child_started` anyway would be inventing the central fact.
    const events = [`started seq=0 run=r-1 op=run t=1000`, `result seq=1 run=r-1 op=run t=1003`].join("\n")
    const problems = validateLifecycle(events, BIND)
    expect(problems.join(" ")).toContain('missing lifecycle event "child_started"')
    expect(problems.join(" ")).toContain('missing lifecycle event "child_exited"')
  })

  test("WAIT FAILED OR TIMED OUT: child_exited must not be fabricated", () => {
    const events = [
      `started seq=0 run=r-1 op=run t=1000`,
      `child_started seq=1 run=r-1 op=run pid=4242 t=1001`,
      `result seq=2 run=r-1 op=run t=1002`,
    ].join("\n")
    expect(validateLifecycle(events, BIND).join(" ")).toContain('missing lifecycle event "child_exited"')
  })

  test("RESULT BEFORE THE OBSERVED EXIT is rejected", () => {
    // Sequence numbers alone do not catch this: they can be perfectly monotonic
    // while the outcome was recorded before the process ended.
    const events = [
      `started seq=0 run=r-1 op=run t=1000`,
      `child_started seq=1 run=r-1 op=run pid=4242 t=1001`,
      `result seq=2 run=r-1 op=run t=1002`,
      `child_exited seq=3 run=r-1 op=run pid=4242 code=0 t=1003`,
    ].join("\n")
    expect(validateLifecycle(events, BIND).join(" ")).toContain("was recorded before")
  })

  test("A DUPLICATE event is rejected", () => {
    const events = `${goodEvents(BIND)}\nresult seq=4 run=r-1 op=run t=1004`
    expect(validateLifecycle(events, BIND).join(" ")).toContain('duplicate lifecycle event "result"')
  })

  test("A NON-MONOTONIC sequence is rejected", () => {
    const events = [
      `started seq=0 run=r-1 op=run t=1000`,
      `child_started seq=5 run=r-1 op=run pid=4242 t=1001`,
      `child_exited seq=2 run=r-1 op=run pid=4242 code=0 t=1002`,
      `result seq=6 run=r-1 op=run t=1003`,
    ].join("\n")
    expect(validateLifecycle(events, BIND).join(" ")).toContain("non-monotonic seq")
  })

  test("TIME RUNNING BACKWARDS is rejected", () => {
    const events = [
      `started seq=0 run=r-1 op=run t=5000`,
      `child_started seq=1 run=r-1 op=run pid=4242 t=1001`,
      `child_exited seq=2 run=r-1 op=run pid=4242 code=0 t=1002`,
      `result seq=3 run=r-1 op=run t=1003`,
    ].join("\n")
    expect(validateLifecycle(events, BIND).join(" ")).toContain("time runs backwards")
  })

  test("AN EVENT FROM ANOTHER runId or operationId is rejected", () => {
    // The concurrency failure mode: two runs writing into one slot. Without the
    // binding these lines are indistinguishable from this run's own.
    const foreignRun = goodEvents({ runId: "r-999", operationId: "run", pid: 4242 })
    expect(validateLifecycle(foreignRun, BIND).join(" ")).toContain("carries run=r-999")

    const foreignOp = goodEvents({ runId: "r-1", operationId: "delete-profile", pid: 4242 })
    expect(validateLifecycle(foreignOp, BIND).join(" ")).toContain("carries op=delete-profile")
  })

  test("A CHILD EVENT NAMING THE WRONG PID is rejected", () => {
    expect(validateLifecycle(goodEvents(BIND, 9999), BIND).join(" ")).toContain("names pid 9999")
  })

  test("A REUSED PID — same number, different creation time — is rejected", () => {
    // The reason a pid is never an identity on its own.
    const bound: LifecycleBinding = { ...BIND, startTime: "133000000000000001" }
    const events = [
      `started seq=0 run=r-1 op=run t=1000`,
      `child_started seq=1 run=r-1 op=run pid=4242 start=133999999999999999 t=1001`,
      `child_exited seq=2 run=r-1 op=run pid=4242 code=0 t=1002`,
      `result seq=3 run=r-1 op=run t=1003`,
    ].join("\n")
    expect(validateLifecycle(events, bound).join(" ")).toContain("the pid was reused")
  })

  test("EMPTY evidence is rejected outright", () => {
    expect(validateLifecycle("", BIND)).toEqual(["no lifecycle events were recorded at all"])
  })

  test("ALL problems are reported, not just the first", () => {
    // A sequence that is both misbound and duplicated must say both, or fixing
    // one would only reveal the next on the following run.
    const events = `${goodEvents({ runId: "r-999", operationId: "run", pid: 4242 })}\nresult seq=9 run=r-999 op=run t=1009`
    const problems = validateLifecycle(events, BIND)
    expect(problems.length).toBeGreaterThan(1)
    expect(problems.join(" ")).toContain("carries run=r-999")
    expect(problems.join(" ")).toContain("duplicate")
  })
})

describe.skipIf(!READY)("RC4 §4 — real runs produce evidence that satisfies the validator", () => {
  test("a REAL synchronous run's events validate against its own binding", () => {
    const r = runDirect(["run", "--name", `abdo-winiso-lc-${process.pid}`, "--mode", "plain", "--timeout-ms", "20000", "--", CMD, "/c", "echo", "LC"])
    expect(String(r.stdout)).toContain("LC")
    const problems = validateLifecycle(lastEvents(), lastBinding())
    expect(problems).toEqual([])
    // And the binding really names the process that ran, not a placeholder.
    expect(lastBinding().pid).toBeGreaterThan(0)
    expect(lastBinding().operationId).toBe("run")
    console.log(`[gate] lifecycle sync: ${lastEvents().replace(/\n/g, " | ")}`)
  }, T)

  test("a REAL asynchronous run's events validate, and carry a kernel creation time", () => {
    // The async transport is the one used under concurrency, so its evidence
    // pins the pid with the creation time rather than the number alone.
    return runDirectAsync(["run", "--name", `abdo-winiso-lca-${process.pid}`, "--mode", "plain", "--timeout-ms", "20000", "--", CMD, "/c", "echo", "LCA"]).then((r) => {
      expect(String(r.stdout)).toContain("LCA")
      expect(validateLifecycle(r.events, r.binding)).toEqual([])
      expect(r.binding.startTime).toMatch(/^\d+$/)
      expect(Number(r.binding.startTime)).toBeGreaterThan(0)
      console.log(`[gate] lifecycle async: pid=${r.binding.pid} start=${r.binding.startTime}`)
    })
  }, T)

  test("BOTH transports produce the SAME evidence shape for the same command", () => {
    // "Equivalent evidence, not equivalent strings": the timestamps, pids and
    // run ids differ by construction, so what is compared is the STRUCTURE —
    // the same steps, in the same order, each carrying its binding.
    const argv = ["run", "--name", `abdo-winiso-lcb-${process.pid}`, "--mode", "plain", "--timeout-ms", "20000", "--", CMD, "/c", "echo", "SAME"]
    runDirect(argv)
    const syncSteps = lastEvents().split("\n").map((l) => l.split(/\s+/)[0])

    return runDirectAsync(argv).then((r) => {
      const asyncSteps = r.events.split("\n").map((l) => l.split(/\s+/)[0])
      expect(syncSteps).toEqual([...LIFECYCLE_ORDER])
      expect(asyncSteps).toEqual([...LIFECYCLE_ORDER])
      // Each carries a binding, and the two bindings are DIFFERENT invocations —
      // if they matched, one transport would be reporting the other's events.
      expect(r.binding.runId).not.toBe(lastBinding().runId)
    })
  }, T)

  test("a run whose helper is given a NONSENSE verb still records only what happened", () => {
    // The helper refuses and exits non-zero while printing good JSON, so the
    // lifecycle is complete and honest: a process really did start and exit.
    const r = runDirect(["no-such-verb-at-all"])
    expect(r.ok).not.toBe(true)
    expect(validateLifecycle(lastEvents(), lastBinding())).toEqual([])
    expect(lastBinding().operationId).toBe("no-such-verb-at-all")
  }, T)
})
