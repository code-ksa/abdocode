import type { Digest } from "./generated/contracts"

/**
 * The engine side of approval.
 *
 * The kernel decides that a person must answer; this asks them and carries the
 * answer back. It decides nothing itself.
 *
 * # A missing handler denies
 *
 * The default is refusal, and that is the whole design. An approval gate whose
 * handler is absent, or crashed, or timed out, and which then let the work
 * through, would be a gate that opens hardest when the operator is least
 * present. Silence is not consent, and here it is not even neutral.
 */

/** What the person is being shown, as digests rather than prose. */
export interface ApprovalRequest {
  /** The binding the kernel computed. The answer is only good for this. */
  readonly binding: Digest
  /** 0 to 4. Assigned by policy; nothing here can lower it. */
  readonly risk: number
  readonly askedAtMs: bigint
  readonly expiresAtMs: bigint
}

export interface ApprovalDecision {
  readonly binding: Digest
  readonly granted: boolean
  readonly decidedAtMs: bigint
  readonly expiresAtMs: bigint
}

/** Why the gate refused, when it did. */
export type ApprovalRefusal =
  | "no-handler"
  | "handler-failed"
  | "handler-answered-elsewhere"
  | "expired"
  | "refused"

export type ApprovalOutcome =
  | { readonly kind: "granted"; readonly decision: ApprovalDecision }
  | { readonly kind: "refused"; readonly reason: ApprovalRefusal }

export type ApprovalHandler = (
  request: ApprovalRequest,
) => ApprovalDecision | undefined | Promise<ApprovalDecision | undefined>

/** The highest risk band. Never covered by a standing answer. */
export const IRREVERSIBLE_RISK = 4

/**
 * Asks a person, and refuses when there is nobody to ask.
 */
export class ApprovalGate {
  readonly #handler: ApprovalHandler | undefined
  #asked = 0
  #granted = 0
  #refused = 0

  /**
   * A gate with no handler is a working gate that always refuses, not a broken
   * one. Construction does not throw, because a kernel that failed to start
   * because nobody was watching would be a kernel that has to be started with
   * somebody watching.
   */
  constructor(handler?: ApprovalHandler) {
    this.#handler = handler
  }

  get hasHandler(): boolean {
    return this.#handler !== undefined
  }

  get asked(): number {
    return this.#asked
  }

  get granted(): number {
    return this.#granted
  }

  get refused(): number {
    return this.#refused
  }

  async decide(request: ApprovalRequest): Promise<ApprovalOutcome> {
    this.#asked += 1
    if (this.#handler === undefined) return this.#refuse("no-handler")

    let answer: ApprovalDecision | undefined
    try {
      answer = await this.#handler(request)
    } catch {
      // A handler that threw did not answer. Treating a thrown error as
      // approval is how a crash becomes a permission.
      return this.#refuse("handler-failed")
    }
    if (answer === undefined) return this.#refuse("no-handler")

    // The answer must be to the question that was asked. A handler that returns
    // a decision for a different binding has approved something else, whether
    // by mistake or otherwise.
    if (!sameDigest(answer.binding, request.binding)) {
      return this.#refuse("handler-answered-elsewhere")
    }
    if (!answer.granted) return this.#refuse("refused")
    if (answer.expiresAtMs <= answer.decidedAtMs) return this.#refuse("expired")

    this.#granted += 1
    return { kind: "granted", decision: answer }
  }

  #refuse(reason: ApprovalRefusal): ApprovalOutcome {
    this.#refused += 1
    return { kind: "refused", reason }
  }
}

/** Compare without leaking where the first difference is. */
function sameDigest(left: Digest, right: Digest): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}
