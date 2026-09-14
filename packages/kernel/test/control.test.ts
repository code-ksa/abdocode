import { describe, expect, test } from "bun:test"
import {
  CHANNEL_ORDER,
  ControlClient,
  DEFAULT_CLIENT_CAPACITY,
  type InputEnvelope,
} from "../src/control"
import {
  CONTRACT_DESCRIPTOR,
  MESSAGE_TAGS,
  type Digest,
  type KernelSessionId,
} from "../src/generated/contracts"

/**
 * Build a branded fixed-width value.
 *
 * The brand exists so a raw byte array cannot be passed where the contract
 * wants a specific opaque type; a cast here is deliberate and local to fixture
 * construction.
 */
function opaque<T extends Uint8Array>(fill: number, length = 32): T {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return new Uint8Array(length).fill(fill) as T
}

/** Build a branded identifier. Same reasoning as `opaque`. */
function identity<T>(value: bigint): T {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return value as T
}

function envelope(seed: number, channel: (typeof CHANNEL_ORDER)[number]): InputEnvelope {
  return {
    session_id: identity<KernelSessionId>(BigInt(seed + 1)),
    channel,
    payload_digest: opaque<Digest>((seed % 254) + 1),
    at_ms: BigInt(seed + 1),
  }
}

describe("S110 engine-side control client", () => {
  test("the channels come from the contract, in tag order, and are not a second list", () => {
    const declared = CONTRACT_DESCRIPTOR.types.InputChannel
    expect(declared?.kind).toBe("enum")
    if (!declared || declared.kind !== "enum") throw new Error("InputChannel is not an enum")

    // The order the client reports must be the tag order the contract declares.
    // Writing the list out by hand here would be a second source of truth that
    // drifts the first time a channel is added to only one of them.
    const fromDescriptor = [...declared.variants]
      .sort((left, right) => left.tag - right.tag)
      .map((variant) => variant.name)
    expect([...CHANNEL_ORDER]).toEqual(fromDescriptor)
    expect(CHANNEL_ORDER).toHaveLength(6)
    expect(CHANNEL_ORDER[0]).toBe("UserFollowup")
    expect(MESSAGE_TAGS.InputEnvelope).toBe(4)
  })

  test("a full client refuses rather than grows, and says how full it is", () => {
    const client = new ControlClient(4)
    for (let index = 0; index < 4; index += 1) {
      expect(client.offer(envelope(index, "UserFollowup"))).toEqual({
        kind: "accepted",
        depth: index + 1,
      })
    }
    expect(client.offer(envelope(9, "UserFollowup"))).toEqual({
      kind: "backpressure",
      capacity: 4,
    })

    // Bounded memory is a claim about the worst moment, so the high-water mark
    // is what the gate reads, not the depth at the moment somebody looked.
    expect(client.depth).toBe(4)
    expect(client.highWater).toBe(4)
    expect(client.accepted).toBe(4)
    expect(client.refused).toBe(1)
    expect(client.highWater).toBeLessThanOrEqual(client.capacity)
  })

  test("the bound holds however far arrival outruns drain", () => {
    const client = new ControlClient(8)
    let offered = 0
    let accepted = 0
    let refused = 0
    for (let index = 0; index < 5_000; index += 1) {
      offered += 1
      const channel = CHANNEL_ORDER[index % CHANNEL_ORDER.length]!
      const delivery = client.offer(envelope(index, channel))
      if (delivery.kind === "accepted") accepted += 1
      else refused += 1
      // Drain far more slowly than arrival.
      if (index % 5 === 0) client.take()
    }
    expect(accepted + refused).toBe(offered)
    expect(refused).toBeGreaterThan(0)
    expect(client.highWater).toBeLessThanOrEqual(8)
    expect(client.depth).toBeLessThanOrEqual(8)
  })

  test("an envelope survives the wire unchanged", () => {
    for (const channel of CHANNEL_ORDER) {
      const original = envelope(7, channel)
      const decoded = ControlClient.decode(ControlClient.encode(original))
      expect(decoded).toEqual(original)
    }
  })

  test("a frame the contract rejects is not quietly accepted", () => {
    const bytes = ControlClient.encode(envelope(3, "PolicyInterrupt"))

    // Every byte of the frame header is load-bearing. Flipping one must be
    // refused by the generated decoder rather than parsed into something
    // plausible.
    for (const position of [0, 8, 20]) {
      const corrupted = new Uint8Array(bytes)
      corrupted[position] = (corrupted[position]! ^ 0xff) & 0xff
      expect(() => ControlClient.decode(corrupted)).toThrow()
    }

    const truncated = bytes.slice(0, bytes.length - 1)
    expect(() => ControlClient.decode(truncated)).toThrow()
  })

  test("a rule the contract states is enforced on the way out", () => {
    // A zero digest and a zero timestamp are both refused by the schema. The
    // client does not re-check them; it must not have to.
    const zeroDigest: InputEnvelope = {
      ...envelope(1, "SystemInject"),
      payload_digest: opaque<Digest>(0),
    }
    expect(() => ControlClient.encode(zeroDigest)).toThrow()

    const zeroTime: InputEnvelope = { ...envelope(1, "SystemInject"), at_ms: 0n }
    expect(() => ControlClient.encode(zeroTime)).toThrow()
  })

  test("a client needs a real capacity", () => {
    expect(() => new ControlClient(0)).toThrow(RangeError)
    expect(() => new ControlClient(-1)).toThrow(RangeError)
    expect(() => new ControlClient(1.5)).toThrow(RangeError)
    expect(new ControlClient().capacity).toBe(DEFAULT_CLIENT_CAPACITY)
  })
})
