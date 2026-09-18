import { describe, expect, test } from "bun:test"
import {
  ApprovalGate,
  IRREVERSIBLE_RISK,
  type ApprovalDecision,
  type ApprovalRefusal,
  type ApprovalRequest,
} from "../src/approval"
import type { Digest } from "../src/generated/contracts"

/** Build a branded fixed-width value. Same reasoning as the control tests. */
function opaque<T extends Uint8Array>(fill: number, length = 32): T {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return new Uint8Array(length).fill(fill) as T
}

function ask(fill = 0x11, risk = 2): ApprovalRequest {
  return {
    binding: opaque<Digest>(fill),
    risk,
    askedAtMs: 1_000n,
    expiresAtMs: 61_000n,
  }
}

function grant(request: ApprovalRequest): ApprovalDecision {
  return {
    binding: request.binding,
    granted: true,
    decidedAtMs: 1_100n,
    expiresAtMs: 61_000n,
  }
}

describe("S114 engine-side approval gate", () => {
  test("with nobody to ask, it refuses and still counts the question", () => {
    const gate = new ApprovalGate()
    expect(gate.hasHandler).toBe(false)

    // The gate is usable, not broken. It answers, and its answer is no.
    const outcome = gate.decide(ask())
    return outcome.then((result) => {
      expect(result).toEqual({ kind: "refused", reason: "no-handler" })
      // Asked-but-unanswered has to be visible, or a silent deny looks the same
      // as a request that was never made.
      expect(gate.asked).toBe(1)
      expect(gate.granted).toBe(0)
      expect(gate.refused).toBe(1)
    })
  })

  test("a handler that returns nothing has not said yes", async () => {
    const gate = new ApprovalGate(() => undefined)
    expect(await gate.decide(ask())).toEqual({ kind: "refused", reason: "no-handler" })
  })

  test("a handler that throws does not approve by accident", async () => {
    let calls = 0
    const gate = new ApprovalGate(() => {
      calls += 1
      throw new Error("the operator's terminal went away")
    })
    expect(await gate.decide(ask())).toEqual({ kind: "refused", reason: "handler-failed" })
    expect(calls).toBe(1)
    expect(gate.granted).toBe(0)
  })

  test("an answer to a different question does not admit this one", async () => {
    const request = ask(0x22)
    const gate = new ApprovalGate(() => ({
      // Approved, genuinely — but for some other binding.
      binding: opaque<Digest>(0x23),
      granted: true,
      decidedAtMs: 1_100n,
      expiresAtMs: 61_000n,
    }))
    expect(await gate.decide(request)).toEqual({
      kind: "refused",
      reason: "handler-answered-elsewhere",
    })
  })

  test("a binding that differs in one byte is a different binding", async () => {
    const request = ask(0x30)
    const nearly = new Uint8Array(request.binding)
    nearly[31] = (nearly[31]! ^ 0x01) as number
    // The two are the same length and differ at a single bit, which is the case
    // a length check or a first-byte comparison would wave through.
    expect(nearly).not.toEqual(new Uint8Array(request.binding))

    const gate = new ApprovalGate(() => ({
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      binding: nearly as Digest,
      granted: true,
      decidedAtMs: 1_100n,
      expiresAtMs: 61_000n,
    }))
    expect(await gate.decide(request)).toEqual({
      kind: "refused",
      reason: "handler-answered-elsewhere",
    })
  })

  test("no is carried as no, and separately from nobody answering", async () => {
    const request = ask(0x40)
    const gate = new ApprovalGate(() => ({ ...grant(request), granted: false }))
    // The distinction matters: a refusal is an answer and should not be retried
    // the way an unreachable operator might be.
    expect(await gate.decide(request)).toEqual({ kind: "refused", reason: "refused" })
  })

  test("a decision that expires when it is made admits nothing", async () => {
    const request = ask(0x50)
    const gate = new ApprovalGate(() => ({
      ...grant(request),
      decidedAtMs: 2_000n,
      expiresAtMs: 2_000n,
    }))
    expect(await gate.decide(request)).toEqual({ kind: "refused", reason: "expired" })
  })

  test("a real answer is carried through unchanged", async () => {
    const request = ask(0x60)
    const decision = grant(request)
    const gate = new ApprovalGate(async () => decision)
    const outcome = await gate.decide(request)
    expect(outcome.kind).toBe("granted")
    if (outcome.kind !== "granted") throw new Error("expected a grant")
    // The gate is a courier, not a second policy: what the person decided is
    // what arrives, byte for byte.
    expect(outcome.decision).toEqual(decision)
    expect(gate.granted).toBe(1)
    expect(gate.refused).toBe(0)
  })

  test("every refusal path is reachable and none of them grants", async () => {
    const request = ask(0x70)
    const handlers: readonly (readonly [
      ApprovalRefusal,
      ConstructorParameters<typeof ApprovalGate>[0],
    ])[] = [
        ["no-handler", undefined],
        [
          "handler-failed",
          () => {
            throw new Error("gone")
          },
        ],
        [
          "handler-answered-elsewhere",
          () => ({ ...grant(request), binding: opaque<Digest>(0x71) }),
        ],
        ["refused", () => ({ ...grant(request), granted: false })],
        ["expired", () => ({ ...grant(request), decidedAtMs: 5n, expiresAtMs: 5n })],
      ]

    // Naming each reason and requiring all of them keeps this from passing when
    // one check silently shadows another — whichever ran first would otherwise
    // satisfy a test that only asked for "some refusal".
    const seen: ApprovalRefusal[] = []
    for (const [reason, handler] of handlers) {
      const gate = new ApprovalGate(handler)
      const outcome = await gate.decide(request)
      expect(outcome).toEqual({ kind: "refused", reason })
      expect(gate.granted).toBe(0)
      seen.push(reason)
    }
    expect(seen).toEqual(handlers.map(([reason]) => reason))
  })

  test("the irreversible band matches the kernel's", () => {
    // Both sides count risk from zero and stop at four. A drift here would let
    // the engine treat an R4 as coverable by a standing answer.
    expect(IRREVERSIBLE_RISK).toBe(4)
  })
})
