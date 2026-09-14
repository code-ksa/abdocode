import { describe, expect, test } from "bun:test"
import {
  CompositionGateError,
  loadManifest,
  measureGraph,
  REPO,
  validateComposition,
  type CompositionManifest,
} from "./composition-gate"

const snapshot = measureGraph(REPO)

function manifest(): CompositionManifest {
  return structuredClone(loadManifest())
}

function expectGateFailure(input: CompositionManifest, message: string): void {
  try {
    validateComposition(input, snapshot, REPO)
    throw new Error("the synthetic composition break unexpectedly passed")
  } catch (error) {
    expect(error).toBeInstanceOf(CompositionGateError)
    expect((error as Error).message).toContain(message)
  }
}

describe("AK-R2 composition gate", () => {
  test("the real tree classifies all 52 packages", () => {
    const report = validateComposition(manifest(), snapshot, REPO)
    expect(report.packageCount).toBe(52)
    expect(report.manifestDesktopClosure.length).toBe(47)
    expect(report.productionEngineClosure.length).toBe(46)
    expect(report.outsideDesktop.length).toBe(5)
    expect(report.productClosure.length).toBe(52)
    expect(report.outsideProduct).toEqual([])
    expect(report.registeredParallelImplementations).toBe(0)
  })

  test("a missing package classification is rejected", () => {
    const input = manifest()
    delete input.packages["@abdo/browser"]
    expectGateFailure(input, "package manifest coverage mismatch")
  })

  test("an invented package classification is rejected", () => {
    const input = manifest()
    input.packages["@abdo/invented"] = structuredClone(input.packages["@abdo/browser"])
    input.packages["@abdo/invented"].path = "packages/invented"
    expectGateFailure(input, "package manifest coverage mismatch")
  })

  test("an orphan without a scheduled owner and completion condition is rejected", () => {
    const input = manifest()
    input.packages["@abdo/browser"].status = "planned-orphan"
    input.packages["@abdo/browser"].runtimeRoots = []
    delete input.packages["@abdo/browser"].plan
    expectGateFailure(input, "planned orphan @abdo/browser needs plan")
  })

  test("two owners cannot claim one source of truth", () => {
    const input = manifest()
    input.packages["@abdo/engine"].truth.owns.push("effect-authority")
    expectGateFailure(input, "source of truth effect-authority must have exactly one package owner")
  })

  test("a parallel runtime cannot be reintroduced", () => {
    const input = manifest()
    input.parallelImplementations.push({
      id: "session-loop",
      canonicalPackage: "@abdo/engine-host",
      parallelPath: "packages/engine/src/cli.ts",
      markers: ["runServeShell"],
      sprint: "S200",
    })
    expectGateFailure(input, "parallel implementations are no longer allowed")
  })

  test("a connected package cannot claim no runtime root", () => {
    const input = manifest()
    input.packages["@abdo/providers"].runtimeRoots = []
    expectGateFailure(input, "connected package @abdo/providers needs at least one runtime root")
  })
})
