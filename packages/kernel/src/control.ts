import {
  CONTRACT_DESCRIPTOR,
  decodeInputEnvelope,
  encodeInputEnvelope,
  type InputChannel,
  type InputEnvelope,
} from "./generated/contracts"

/**
 * The engine side of the control plane.
 *
 * This is the second process the S110 acceptance talks about. The kernel bounds
 * its own mailboxes; if the client queued without a bound, the memory guarantee
 * would hold on one side of the boundary and quietly fail on the other, which
 * is the same as not holding at all.
 *
 * Nothing here decides policy. The channels, their tags and every field rule
 * come from the generated contract; what a channel is entitled to do is the
 * kernel's business. This side carries envelopes, refuses when full, and says
 * so.
 */

/** How many envelopes this client holds before refusing. */
export const DEFAULT_CLIENT_CAPACITY = 64

/**
 * The channels, in tag order, read from the generated descriptor.
 *
 * Not written out by hand. A second list here would drift from the contract the
 * first time somebody added a channel and edited only one of them, and the
 * whole point of generating the descriptor is that there is one list.
 */
export const CHANNEL_ORDER: readonly InputChannel[] = Object.freeze(
  (() => {
    const declared = CONTRACT_DESCRIPTOR.types.InputChannel
    if (declared.kind !== "enum") throw new TypeError("InputChannel is not an enum in the contract")
    return [...declared.variants]
      .sort((left, right) => left.tag - right.tag)
      .map((variant) => variant.name as InputChannel)
  })(),
)

export type ClientDelivery =
  | { readonly kind: "accepted"; readonly depth: number }
  /** Refused because the queue is full. Visible, counted, never silent. */
  | { readonly kind: "backpressure"; readonly capacity: number }

/**
 * A bounded queue of envelopes waiting to cross the boundary.
 *
 * Refusing is the feature. An unbounded queue does not remove the limit, it
 * moves the failure from a visible rejection to an invisible one.
 */
export class ControlClient {
  readonly #capacity: number
  readonly #queue: InputEnvelope[] = []
  #accepted = 0
  #refused = 0
  #highWater = 0

  constructor(capacity: number = DEFAULT_CLIENT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("a control client needs a positive integer capacity")
    }
    this.#capacity = capacity
  }

  get capacity(): number {
    return this.#capacity
  }

  get depth(): number {
    return this.#queue.length
  }

  /**
   * The deepest this queue has ever been.
   *
   * Reported because bounded memory is a claim about the worst moment, not
   * about the moment somebody happened to look.
   */
  get highWater(): number {
    return this.#highWater
  }

  get accepted(): number {
    return this.#accepted
  }

  get refused(): number {
    return this.#refused
  }

  /** Offer an envelope. Never grows past capacity. */
  offer(envelope: InputEnvelope): ClientDelivery {
    if (this.#queue.length >= this.#capacity) {
      this.#refused += 1
      return { kind: "backpressure", capacity: this.#capacity }
    }
    this.#queue.push(envelope)
    this.#accepted += 1
    if (this.#queue.length > this.#highWater) this.#highWater = this.#queue.length
    return { kind: "accepted", depth: this.#queue.length }
  }

  /** Take the oldest envelope, if any. */
  take(): InputEnvelope | undefined {
    return this.#queue.shift()
  }

  /** Encode an envelope for the wire, using the generated codec only. */
  static encode(envelope: InputEnvelope): Uint8Array {
    return encodeInputEnvelope(envelope)
  }

  /**
   * Decode an envelope the kernel sent.
   *
   * Framing, the schema fingerprint and every field rule are checked by the
   * generated decoder. A hand-rolled parser here would be a second opinion
   * about the protocol, and two opinions is how a boundary stops being one.
   */
  static decode(bytes: Uint8Array): InputEnvelope {
    return decodeInputEnvelope(bytes)
  }
}

export type { InputChannel, InputEnvelope }
