import type { CatalogHandle, Digest, ToolId } from "./generated/contracts"

/**
 * The engine side of catalog snapshots.
 *
 * The kernel decides what a step may see and hands back a snapshot identity;
 * this holds that identity for the length of a step and refuses to mix it with
 * anything else. It decides nothing about which tools exist.
 *
 * # Why a step holds an identity rather than a catalog
 *
 * The tools live on the Rust side, where a snapshot is a copy that nothing can
 * reach into. What crosses the boundary is a handle and a digest. A step that
 * carried its own copy of the catalog would be a second answer to "what tools
 * were available", and the first time the two disagreed the ledger would say an
 * effect ran against a catalog nobody can reconstruct.
 */

/** Which catalog a step was working against. */
export interface SnapshotIdentity {
  readonly handle: CatalogHandle
  /** What the snapshot contained. Two equal digests saw the same tools. */
  readonly digest: Digest
  readonly toolCount: number
}

/** What a search disclosed, as the engine receives it. */
export interface Disclosure {
  readonly snapshot: SnapshotIdentity
  readonly toolIds: readonly ToolId[]
  /** How many tools the query could have matched, before the budget. */
  readonly considered: number
}

export type StepRefusal =
  | "different-snapshot"
  | "step-already-closed"
  | "budget-exceeded"
  | "undisclosed-tool"

export class StepRefusalError extends Error {
  readonly reason: StepRefusal

  constructor(reason: StepRefusal, detail: string) {
    super(`${reason}: ${detail}`)
    this.name = "StepRefusalError"
    this.reason = reason
  }
}

/**
 * One step's view of the catalog.
 *
 * Closed explicitly rather than left to garbage collection, because "this step
 * is over" is a fact the next step needs and not one a collector can report.
 */
export class CatalogStep {
  readonly #snapshot: SnapshotIdentity
  readonly #budget: number
  readonly #disclosed = new Set<bigint>()
  #closed = false

  constructor(snapshot: SnapshotIdentity, budget: number) {
    if (!Number.isSafeInteger(budget) || budget < 1) {
      throw new StepRefusalError("budget-exceeded", "a step needs a real disclosure budget")
    }
    this.#snapshot = snapshot
    this.#budget = budget
  }

  get snapshot(): SnapshotIdentity {
    return this.#snapshot
  }

  get budget(): number {
    return this.#budget
  }

  get disclosedCount(): number {
    return this.#disclosed.size
  }

  get isClosed(): boolean {
    return this.#closed
  }

  /**
   * Take in what a search disclosed.
   *
   * A disclosure from another snapshot is refused rather than merged. The two
   * may name the same tool identifier and mean different tools, and a step that
   * accepted both would be reasoning about a catalog that never existed.
   */
  admit(disclosure: Disclosure): void {
    if (this.#closed) {
      throw new StepRefusalError("step-already-closed", "the step has already ended")
    }
    if (!sameSnapshot(disclosure.snapshot, this.#snapshot)) {
      throw new StepRefusalError(
        "different-snapshot",
        "a disclosure arrived from a snapshot this step is not working against",
      )
    }
    if (this.#disclosed.size + disclosure.toolIds.length > this.#budget) {
      // Refused rather than truncated. Silently dropping the tail would leave
      // the step believing it had seen a search it had only seen part of.
      throw new StepRefusalError(
        "budget-exceeded",
        `${this.#disclosed.size + disclosure.toolIds.length} schemas against a budget of ${this.#budget}`,
      )
    }
    for (const toolId of disclosure.toolIds) this.#disclosed.add(toolId)
  }

  /** Was this tool disclosed to this step? */
  mayCall(toolId: ToolId): boolean {
    return !this.#closed && this.#disclosed.has(toolId)
  }

  /**
   * Assert the right to call, or refuse.
   *
   * A tool the step never saw is refused here rather than at the boundary. The
   * kernel would refuse it too — this is not the security check — but a model
   * that invents a tool identifier should be told so while there is still a
   * step to tell.
   */
  requireDisclosed(toolId: ToolId): void {
    if (this.#closed) {
      throw new StepRefusalError("step-already-closed", "the step has already ended")
    }
    if (!this.#disclosed.has(toolId)) {
      throw new StepRefusalError("undisclosed-tool", "this step was never shown that tool")
    }
  }

  close(): void {
    this.#closed = true
  }
}

function sameSnapshot(left: SnapshotIdentity, right: SnapshotIdentity): boolean {
  return (
    left.toolCount === right.toolCount &&
    sameBytes(left.handle, right.handle) &&
    sameBytes(left.digest, right.digest)
  )
}

/** Compare without leaking where the first difference is. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}
