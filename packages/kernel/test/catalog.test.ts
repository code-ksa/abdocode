import { describe, expect, test } from "bun:test"
import { CatalogStep, StepRefusalError, type Disclosure, type SnapshotIdentity } from "../src/catalog"
import type { CatalogHandle, Digest, ToolId } from "../src/generated/contracts"

function opaque<T extends Uint8Array>(fill: number, length = 32): T {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return new Uint8Array(length).fill(fill) as T
}

function identity<T>(value: bigint): T {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return value as T
}

function snapshot(fill: number, toolCount = 3): SnapshotIdentity {
  return {
    handle: opaque<CatalogHandle>(fill),
    digest: opaque<Digest>(fill + 1),
    toolCount,
  }
}

function disclosure(from: SnapshotIdentity, ids: readonly bigint[], considered = 100): Disclosure {
  return {
    snapshot: from,
    toolIds: ids.map((value) => identity<ToolId>(value)),
    considered,
  }
}

describe("S116 engine-side catalog step", () => {
  test("a step only calls what it was shown", () => {
    const view = snapshot(0x10)
    const step = new CatalogStep(view, 4)
    step.admit(disclosure(view, [1n, 2n]))

    expect(step.mayCall(identity<ToolId>(1n))).toBe(true)
    expect(step.mayCall(identity<ToolId>(9n))).toBe(false)
    // Refused where there is still a step to refuse it in. The kernel would
    // refuse it too; this is the earlier and more useful of the two.
    expect(() => step.requireDisclosed(identity<ToolId>(9n))).toThrow(StepRefusalError)
    expect(step.disclosedCount).toBe(2)
  })

  test("a disclosure from another snapshot is refused rather than merged", () => {
    const view = snapshot(0x20)
    const other = snapshot(0x30)
    const step = new CatalogStep(view, 8)
    step.admit(disclosure(view, [1n]))

    // The two snapshots may name the same identifier and mean different tools.
    let refusal: unknown
    try {
      step.admit(disclosure(other, [2n]))
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(StepRefusalError)
    expect((refusal as StepRefusalError).reason).toBe("different-snapshot")
    expect(step.disclosedCount).toBe(1)
  })

  test("a snapshot differing in one byte is a different snapshot", () => {
    const view = snapshot(0x40)
    const nearly: SnapshotIdentity = {
      handle: view.handle,
      digest: (() => {
        const bytes = new Uint8Array(view.digest)
        bytes[31] = (bytes[31]! ^ 0x01) as number
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        return bytes as Digest
      })(),
      toolCount: view.toolCount,
    }
    expect(nearly.digest).not.toEqual(view.digest)

    const step = new CatalogStep(view, 4)
    expect(() => step.admit(disclosure(nearly, [1n]))).toThrow("different-snapshot")
  })

  test("a full step refuses rather than truncates", () => {
    const view = snapshot(0x50)
    const step = new CatalogStep(view, 3)
    step.admit(disclosure(view, [1n, 2n]))

    // Dropping the tail would leave the step believing it had seen a whole
    // search when it had seen part of one.
    expect(() => step.admit(disclosure(view, [3n, 4n]))).toThrow("budget-exceeded")
    expect(step.disclosedCount).toBe(2)
    expect(step.mayCall(identity<ToolId>(3n))).toBe(false)

    // And the remaining room is still usable.
    step.admit(disclosure(view, [3n]))
    expect(step.disclosedCount).toBe(3)
  })

  test("a closed step calls nothing, including what it was shown", () => {
    const view = snapshot(0x60)
    const step = new CatalogStep(view, 4)
    step.admit(disclosure(view, [1n]))
    expect(step.mayCall(identity<ToolId>(1n))).toBe(true)

    step.close()
    expect(step.isClosed).toBe(true)
    // "This step is over" is a fact the next step needs, so it is stated rather
    // than left to a collector to notice.
    expect(step.mayCall(identity<ToolId>(1n))).toBe(false)
    expect(() => step.requireDisclosed(identity<ToolId>(1n))).toThrow("step-already-closed")
    expect(() => step.admit(disclosure(view, [2n]))).toThrow("step-already-closed")
  })

  test("a step needs a real budget", () => {
    const view = snapshot(0x70)
    for (const budget of [0, -1, 1.5, Number.NaN]) {
      expect(() => new CatalogStep(view, budget)).toThrow(StepRefusalError)
    }
    expect(new CatalogStep(view, 1).budget).toBe(1)
  })

  test("every refusal is reachable and none of them admits", () => {
    const view = snapshot(0x80)
    const other = snapshot(0x90)
    const seen: string[] = []

    const budgetless = () => new CatalogStep(view, 0)
    const wrongSnapshot = () => new CatalogStep(view, 4).admit(disclosure(other, [1n]))
    const overBudget = () => new CatalogStep(view, 1).admit(disclosure(view, [1n, 2n]))
    const closed = () => {
      const step = new CatalogStep(view, 4)
      step.close()
      step.admit(disclosure(view, [1n]))
    }
    const unseen = () => new CatalogStep(view, 4).requireDisclosed(identity<ToolId>(1n))

    // Named one by one, so a check that shadowed another would show up as a
    // missing name rather than as a suite that still passed.
    for (const [expected, act] of [
      ["budget-exceeded", budgetless],
      ["different-snapshot", wrongSnapshot],
      ["budget-exceeded", overBudget],
      ["step-already-closed", closed],
      ["undisclosed-tool", unseen],
    ] as const) {
      try {
        act()
        throw new Error(`${expected} was not refused`)
      } catch (error) {
        expect(error).toBeInstanceOf(StepRefusalError)
        expect((error as StepRefusalError).reason).toBe(expected)
        seen.push(expected)
      }
    }
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(4)
  })
})
