import { describe, expect, test } from "bun:test"
import {
  type Digest,
  type EffectOutcome,
  type EffectRequest,
  type FilesystemHandle,
  type HostReply,
} from "@abdo/kernel"
import { ToolRegistry } from "@abdo/tools"
import {
  READ_BOUND_OBJECT_TOOL_NAME,
  readBoundObjectTool,
  registerKernelTools,
  type KernelEffectHost,
} from "../src"

const object = bytes(0xa3) as FilesystemHandle
const outcomeDigest = bytes(0xd4) as Digest
const postconditionDigest = bytes(0xd4) as Digest

class FakeHost implements KernelEffectHost {
  readonly requests: EffectRequest[] = []

  constructor(private readonly answer: (request: EffectRequest) => HostReply | Promise<HostReply>) {}

  async send(request: EffectRequest): Promise<HostReply> {
    this.requests.push(request)
    return this.answer(request)
  }
}

const context = (executionId = "execution-17") => ({ dryRun: false, executionId })

describe("read-bound-object kernel tool", () => {
  test("registers a ToolDefinition and exposes only a verified digest", async () => {
    const host = verifiedHost()
    const registry = registerKernelTools(new ToolRegistry(), { host, object, nowMs: () => 1_000n })
    const tool = registry.get(READ_BOUND_OBJECT_TOOL_NAME)

    expect(tool).toBeDefined()
    const result = await tool!.run({}, context())

    expect(result).toEqual({ ok: true, output: { digest: "d4".repeat(32) } })
    expect(Object.keys((result as { output: object }).output)).toEqual(["digest"])
    expect(host.requests).toHaveLength(1)
    expect(host.requests[0]!.requested_at_ms).toBe(1_000n)
    expect(host.requests[0]!.expires_at_ms).toBe(61_000n)
  })

  test("fails closed on a Declined outcome", async () => {
    const host = new FakeHost((request) => ({
      kind: "outcome",
      outcome: {
        tag: "Declined",
        value: { intent_id: request.intent_id, reason_digest: bytes(0xe1) as Digest, at_ms: 2_000n },
      },
    }))

    const result = await readBoundObjectTool({ host, object, nowMs: () => 1_000n }).run({}, context())

    expect(result.ok).toBe(false)
    expect(result).toEqual({ ok: false, error: `kernel_declined:${"e1".repeat(32)}` })
  })

  test("fails closed on an Unresolved outcome", async () => {
    const host = new FakeHost((request) => ({
      kind: "outcome",
      outcome: {
        tag: "Unresolved",
        value: { intent_id: request.intent_id, reason_digest: bytes(0xe2) as Digest, at_ms: 2_000n },
      },
    }))

    const result = await readBoundObjectTool({ host, object, nowMs: () => 1_000n }).run({}, context())

    expect(result).toEqual({ ok: false, error: `kernel_unresolved:${"e2".repeat(32)}` })
  })

  test("fails closed when the kernel host is unreachable", async () => {
    const host = new FakeHost(() => ({ kind: "unreachable", reason: "host exited" }))

    const result = await readBoundObjectTool({ host, object }).run({}, context())

    expect(result).toEqual({ ok: false, error: "kernel_unreachable:host exited" })
  })

  test("fails closed under backpressure", async () => {
    const host = new FakeHost(() => ({ kind: "backpressure", capacity: 4 }))

    const result = await readBoundObjectTool({ host, object }).run({}, context())

    expect(result).toEqual({ ok: false, error: "kernel_backpressure:capacity=4" })
  })

  test("derives stable request identifiers from executionId, never request time", async () => {
    const first = verifiedHost()
    const second = verifiedHost()
    const third = verifiedHost()
    await readBoundObjectTool({ host: first, object, nowMs: () => 100n }).run({}, context("same-execution"))
    await readBoundObjectTool({ host: second, object, nowMs: () => 900_000n }).run({}, context("same-execution"))
    await readBoundObjectTool({ host: third, object, nowMs: () => 100n }).run({}, context("other-execution"))

    const firstIds = requestIds(first.requests[0]!)
    expect(requestIds(second.requests[0]!)).toEqual(firstIds)
    expect(requestIds(third.requests[0]!)).not.toEqual(firstIds)
    expect(new Set(firstIds).size).toBe(3)
  })

  test("rejects missing execution identity before contacting the host", async () => {
    const host = verifiedHost()

    const result = await readBoundObjectTool({ host, object }).run({}, { dryRun: false })

    expect(result).toEqual({ ok: false, error: "kernel_execution_id_required" })
    expect(host.requests).toHaveLength(0)
  })

  test("does not trust a Verified outcome for a different intent", async () => {
    const host = new FakeHost((request) => ({
      kind: "outcome",
      outcome: verifiedOutcome({ ...request, intent_id: request.intent_id + 1n as typeof request.intent_id }),
    }))

    const result = await readBoundObjectTool({ host, object }).run({}, context())

    expect(result).toEqual({ ok: false, error: "kernel_verified_wrong_intent" })
  })
})

function verifiedHost(): FakeHost {
  return new FakeHost((request) => ({ kind: "outcome", outcome: verifiedOutcome(request) }))
}

function verifiedOutcome(request: EffectRequest): EffectOutcome {
  return {
    tag: "Verified",
    value: {
      intent_id: request.intent_id,
      outcome_digest: outcomeDigest,
      postcondition_digest: postconditionDigest,
      settled_at_ms: 2_000n,
      verified_at_ms: 2_001n,
    },
  }
}

function requestIds(request: EffectRequest): readonly bigint[] {
  return [request.intent_id, request.proposal_id, request.cause_event_id]
}

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill)
}
