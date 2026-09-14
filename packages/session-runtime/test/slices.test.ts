/**
 * Sprint 18 GATE — a failing postcondition rolls back the LAST slice only.
 *
 * Compensation already existed, but only for a tool that FAILED while writing.
 * A tool that succeeded and produced the wrong state was never undone: it
 * reported ok, the run carried on, and the mistake surfaced much later with
 * nothing left to point at.
 *
 * The world here is a map of files. After a slice fails, the test asserts what
 * is in that map — not what the log says happened to it.
 */
import { describe, expect, test } from "bun:test"
import { foldSlices, stuckSlices } from "@abdo/contracts/slice"
import { MemoryEventStore } from "@abdo/event-store"
import { SliceExecutor, type Slice } from "../src/slices"

const SID = "ses_slice"
const RUN = "run_slice"

const executor = () => {
  const store = new MemoryEventStore()
  return { store, exec: new SliceExecutor({ store, sessionId: SID, runId: RUN }) }
}

/** A slice that writes `value` to `key` in `world`, and can put back what was there. */
function writeSlice(
  world: Map<string, string>,
  id: string,
  key: string,
  value: string,
  options: {
    precondition?: () => { ok: boolean; detail?: string }
    postconditionOk?: boolean
    rollback?: "works" | "fails" | "none"
  } = {},
): Slice {
  let previous: string | undefined
  const rollbackMode = options.rollback ?? "works"
  const slice: Slice = {
    id,
    description: `write ${key}`,
    mutate() {
      previous = world.get(key)
      world.set(key, value)
      return { ok: true, operationIds: [`tex_${id}`] }
    },
    postcondition() {
      return options.postconditionOk === false
        ? { ok: false, detail: `${key} is not what it should be` }
        : { ok: world.get(key) === value }
    },
  }
  if (options.precondition) (slice as { precondition?: unknown }).precondition = options.precondition
  if (rollbackMode !== "none") {
    ;(slice as { rollback?: unknown }).rollback = () => {
      if (rollbackMode === "fails") return { ok: false, detail: "the backup was gone" }
      if (previous === undefined) world.delete(key)
      else world.set(key, previous)
      return { ok: true }
    }
  }
  return slice
}

describe("one slice", () => {
  test("precondition, mutation, postcondition, all in order and all recorded", async () => {
    const world = new Map<string, string>()
    const { store, exec } = executor()
    const outcome = await exec.run(writeSlice(world, "s1", "a.ts", "v1", { precondition: () => ({ ok: true }) }))

    expect(outcome.state).toBe("committed")
    expect(world.get("a.ts")).toBe("v1")

    const types = (await store.readAll()).map((e) => e.type)
    expect(types).toEqual([
      "slice.started",
      "slice.precondition_checked",
      "slice.mutated",
      "slice.postcondition_checked",
      "slice.completed",
    ])
  })

  test("a refused precondition changes nothing, and needs no rollback", async () => {
    const world = new Map<string, string>()
    const { store, exec } = executor()
    const outcome = await exec.run(
      writeSlice(world, "s1", "a.ts", "v1", { precondition: () => ({ ok: false, detail: "file is locked" }) }),
    )

    expect(outcome.state).toBe("refused")
    expect(outcome.precondition?.detail).toBe("file is locked")
    expect(world.size).toBe(0)
    expect((await store.readAll()).some((e) => e.type === "slice.rolled_back")).toBe(false)
  })

  test("a failing postcondition puts the change back", async () => {
    const world = new Map<string, string>([["a.ts", "original"]])
    const { store, exec } = executor()
    const outcome = await exec.run(writeSlice(world, "s1", "a.ts", "broken", { postconditionOk: false }))

    expect(outcome.state).toBe("rolled_back")
    // the world, not the log
    expect(world.get("a.ts")).toBe("original")
    expect(foldSlices(await store.readAll(), RUN)[0]!.state).toBe("rolled_back")
  })

  test("a change that cannot be put back is STUCK, never reported as rolled back", async () => {
    const world = new Map<string, string>([["a.ts", "original"]])
    const { store, exec } = executor()
    const outcome = await exec.run(writeSlice(world, "s1", "a.ts", "broken", { postconditionOk: false, rollback: "none" }))

    expect(outcome.state).toBe("stuck")
    expect(world.get("a.ts")).toBe("broken") // honest: the change stands
    const record = foldSlices(await store.readAll(), RUN)[0]!
    expect(record.state).toBe("stuck")
    expect(stuckSlices(await store.readAll(), RUN)).toHaveLength(1)
  })

  test("a rollback that fails is stuck too — a failed undo is not an undo", async () => {
    const world = new Map<string, string>([["a.ts", "original"]])
    const { store, exec } = executor()
    const outcome = await exec.run(writeSlice(world, "s1", "a.ts", "broken", { postconditionOk: false, rollback: "fails" }))

    expect(outcome.state).toBe("stuck")
    expect(outcome.rollback).toEqual({ ok: false, detail: "the backup was gone" })
    expect(stuckSlices(await store.readAll(), RUN)).toHaveLength(1)
  })

  test("a rollback that throws is recorded as failed, not swallowed", async () => {
    const world = new Map<string, string>()
    const { store, exec } = executor()
    const slice: Slice = {
      id: "s1",
      mutate() {
        world.set("a.ts", "x")
        return { ok: true }
      },
      postcondition: () => ({ ok: false, detail: "no" }),
      rollback() {
        throw new Error("disk on fire")
      },
    }
    const outcome = await exec.run(slice)
    expect(outcome.state).toBe("stuck")
    expect(outcome.rollback?.detail).toContain("disk on fire")
    expect((await store.readAll()).some((e) => e.type === "slice.rolled_back")).toBe(true)
  })
})

describe("GATE — a sequence undoes the failing slice and nothing before it", () => {
  test("three slices, the third fails: the first two stand", async () => {
    const world = new Map<string, string>()
    const { store, exec } = executor()

    const outcomes = await exec.runSequence([
      writeSlice(world, "s1", "one.ts", "1"),
      writeSlice(world, "s2", "two.ts", "2"),
      writeSlice(world, "s3", "three.ts", "3", { postconditionOk: false }),
    ])

    expect(outcomes.map((o) => o.state)).toEqual(["committed", "committed", "rolled_back"])
    // committed work stays committed — no cascade
    expect(world.get("one.ts")).toBe("1")
    expect(world.get("two.ts")).toBe("2")
    // only the failing slice was undone
    expect(world.has("three.ts")).toBe(false)

    const records = foldSlices(await store.readAll(), RUN)
    expect(records.map((r) => r.state)).toEqual(["committed", "committed", "rolled_back"])
    // exactly ONE rollback happened in the whole sequence
    expect((await store.readAll()).filter((e) => e.type === "slice.rolled_back")).toHaveLength(1)
  })

  test("the sequence stops at the failure instead of ploughing on", async () => {
    const world = new Map<string, string>()
    const { exec } = executor()
    let fourthRan = false

    const outcomes = await exec.runSequence([
      writeSlice(world, "s1", "one.ts", "1"),
      writeSlice(world, "s2", "two.ts", "2", { postconditionOk: false }),
      {
        id: "s3",
        mutate() {
          fourthRan = true
          return { ok: true }
        },
      },
    ])

    expect(outcomes).toHaveLength(2)
    expect(fourthRan).toBe(false)
    expect(world.get("one.ts")).toBe("1")
  })

  test("a refusal mid-sequence leaves earlier work alone as well", async () => {
    const world = new Map<string, string>()
    const { exec } = executor()

    const outcomes = await exec.runSequence([
      writeSlice(world, "s1", "one.ts", "1"),
      writeSlice(world, "s2", "two.ts", "2", { precondition: () => ({ ok: false, detail: "not yet" }) }),
    ])

    expect(outcomes.map((o) => o.state)).toEqual(["committed", "refused"])
    expect(world.get("one.ts")).toBe("1")
    expect(world.has("two.ts")).toBe(false)
  })

  test("a stuck slice mid-sequence stops everything and is visible as stuck", async () => {
    const world = new Map<string, string>()
    const { store, exec } = executor()

    const outcomes = await exec.runSequence([
      writeSlice(world, "s1", "one.ts", "1"),
      writeSlice(world, "s2", "two.ts", "2", { postconditionOk: false, rollback: "none" }),
      writeSlice(world, "s3", "three.ts", "3"),
    ])

    expect(outcomes.map((o) => o.state)).toEqual(["committed", "stuck"])
    expect(world.get("one.ts")).toBe("1")
    expect(world.get("two.ts")).toBe("2") // the un-undone change, stated plainly
    expect(world.has("three.ts")).toBe(false)
    const stuck = stuckSlices(await store.readAll(), RUN)
    expect(stuck.map((s) => s.sliceId)).toEqual(["s2"])
  })

  test("a mutation that throws is a failed slice, and the rest is not attempted", async () => {
    const world = new Map<string, string>()
    const { exec } = executor()
    const outcomes = await exec.runSequence([
      writeSlice(world, "s1", "one.ts", "1"),
      {
        id: "s2",
        mutate() {
          throw new Error("tool exploded")
        },
      },
      writeSlice(world, "s3", "three.ts", "3"),
    ])

    expect(outcomes.map((o) => o.state)).toEqual(["committed", "failed"])
    expect(outcomes[1]!.error).toContain("tool exploded")
    expect(world.has("three.ts")).toBe(false)
  })
})

describe("the log answers what each slice did", () => {
  test("operations are cited so a slice's receipts can be found", async () => {
    const world = new Map<string, string>()
    const { store, exec } = executor()
    await exec.run(writeSlice(world, "s1", "a.ts", "v1"))
    const record = foldSlices(await store.readAll(), RUN)[0]!
    expect(record.operationIds).toEqual(["tex_s1"])
    expect(record.description).toBe("write a.ts")
    expect(record.sequences.length).toBeGreaterThan(2)
  })

  test("a slice that started and never finished reads as in flight", async () => {
    const store = new MemoryEventStore()
    await store.append({
      aggregateKind: "session",
      aggregateId: SID,
      type: "slice.started",
      data: { runId: RUN, sliceId: "s_ghost", description: "half a change" },
    })
    expect(foldSlices(await store.readAll(), RUN)[0]!.state).toBe("in_flight")
  })
})
