/**
 * The concurrency dial — GATE: one agent does the work of four.
 *
 * The owner's requirement is precise and worth restating, because it is the
 * thing most tools get wrong: the number of agents changes how long the work
 * takes, and nothing else. Not which checks run, not how many verifications
 * happen, not what ends up in the tree.
 *
 * So the gate runs the SAME work list at 1, 2 and 4 lanes and demands the
 * outcomes be identical. If some future change ever makes the parallel path do
 * more (or the sequential path do less), this fails.
 */
import { describe, expect, test } from "bun:test"
import { laneUtilisation, runWorkQueue, workSignature, type WorkItem } from "../src/scheduler"

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Twelve pieces of work that each do something observable. */
function work(log: string[]): WorkItem<string>[] {
  return Array.from({ length: 12 }, (_, i) => ({
    id: `task_${String(i + 1).padStart(2, "0")}`,
    run: async () => {
      await sleep(5)
      log.push(`task_${i + 1}`)
      return `built task_${i + 1}`
    },
  }))
}

describe("GATE — the dial changes the clock and nothing else", () => {
  test("1, 2 and 4 lanes produce identical outcomes", async () => {
    const signatures: string[] = []
    for (const concurrency of [1, 2, 4]) {
      const log: string[] = []
      const report = await runWorkQueue(work(log), { concurrency })
      expect(report.completed).toBe(12)
      expect(report.failed).toBe(0)
      // every task ran exactly once, whatever the lane count
      expect(log.length).toBe(12)
      expect(new Set(log).size).toBe(12)
      signatures.push(workSignature(report))
    }
    expect(signatures[1]).toBe(signatures[0]!)
    expect(signatures[2]).toBe(signatures[0]!)
  })

  test("results are in DECLARATION order even when lanes finish out of order", async () => {
    const items: WorkItem<number>[] = [
      { id: "slow", run: async () => (await sleep(40), 1) },
      { id: "fast", run: async () => (await sleep(1), 2) },
      { id: "middle", run: async () => (await sleep(20), 3) },
    ]
    const report = await runWorkQueue(items, { concurrency: 3 })
    expect(report.outcomes.map((o) => o.id)).toEqual(["slow", "fast", "middle"])
  })

  test("one lane really is sequential — nothing overlaps", async () => {
    let inFlight = 0
    let peak = 0
    const items: WorkItem<void>[] = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      run: async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await sleep(3)
        inFlight--
      },
    }))
    await runWorkQueue(items, { concurrency: 1 })
    expect(peak).toBe(1)
  })

  test("four lanes really do overlap", async () => {
    let inFlight = 0
    let peak = 0
    const items: WorkItem<void>[] = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      run: async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await sleep(15)
        inFlight--
      },
    }))
    await runWorkQueue(items, { concurrency: 4 })
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(4)
  })
})

describe("failure does not spread", () => {
  test("one item throwing leaves the others' outcomes intact", async () => {
    const items: WorkItem<string>[] = [
      { id: "a", run: async () => "a" },
      {
        id: "b",
        run: async () => {
          throw new Error("the model produced unparseable output")
        },
      },
      { id: "c", run: async () => "c" },
    ]
    const report = await runWorkQueue(items, { concurrency: 3 })
    expect(report.completed).toBe(2)
    expect(report.failed).toBe(1)
    expect(report.outcomes.find((o) => o.id === "b")!.error).toContain("unparseable")
    // and the scheduler itself did not reject, which would have thrown away
    // the two successes along with the failure
    expect(report.outcomes.map((o) => o.ok)).toEqual([true, false, true])
  })

  test("the same failure happens identically at one lane and at four", async () => {
    const build = (): WorkItem<string>[] => [
      { id: "a", run: async () => "a" },
      {
        id: "b",
        run: async () => {
          throw new Error("boom")
        },
      },
      { id: "c", run: async () => "c" },
    ]
    const one = await runWorkQueue(build(), { concurrency: 1 })
    const four = await runWorkQueue(build(), { concurrency: 4 })
    expect(workSignature(four)).toBe(workSignature(one))
  })

  test("stopOnFailure is opt-in, and names what it skipped", async () => {
    const ran: string[] = []
    const items: WorkItem<void>[] = Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`,
      run: async () => {
        if (i === 1) throw new Error("stop here")
        ran.push(`t${i}`)
      },
    }))
    const report = await runWorkQueue(items, { concurrency: 1, stopOnFailure: true })
    expect(report.skipped.length).toBeGreaterThan(0)
    expect(ran).toEqual(["t0"])
  })
})

describe("what the dial actually bought", () => {
  test("speedup is measured, not assumed", async () => {
    const items: WorkItem<void>[] = Array.from({ length: 4 }, (_, i) => ({
      id: `t${i}`,
      run: async () => {
        await sleep(25)
      },
    }))
    const parallel = laneUtilisation(await runWorkQueue(items, { concurrency: 4 }))
    expect(parallel.workMs).toBeGreaterThan(parallel.wallClockMs)
    expect(parallel.speedup).toBeGreaterThan(1)
  })

  test("one long task and three short ones gets almost nothing from four lanes", async () => {
    const items: WorkItem<void>[] = [
      { id: "long", run: async () => sleep(60) },
      { id: "s1", run: async () => sleep(2) },
      { id: "s2", run: async () => sleep(2) },
      { id: "s3", run: async () => sleep(2) },
    ]
    const { speedup } = laneUtilisation(await runWorkQueue(items, { concurrency: 4 }))
    // bounded by the slowest single item — reporting the honest number is the
    // point, since the dial reads like a multiplier and is not one
    expect(speedup).toBeLessThan(2)
  })

  test("an empty queue is not an error", async () => {
    const report = await runWorkQueue([], { concurrency: 4 })
    expect(report.outcomes).toEqual([])
    expect(laneUtilisation(report).speedup).toBe(1)
  })
})
