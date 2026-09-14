import {
  labelDigest,
  type Digest,
  type EffectOutcome,
  type EffectRequest,
  type EventId,
  type FilesystemHandle,
  type HostReply,
  type IntentId,
  type ProposalId,
} from "@abdo/kernel"
import { policy, type ToolContext, type ToolDefinition, type ToolRegistry, type ToolResult } from "@abdo/tools"

/** The only operation this adapter is allowed to ask the kernel to perform. */
export const READ_BOUND_OBJECT_OPERATION = "read-bound-object" as const
export const READ_BOUND_OBJECT_TOOL_NAME = "kernel_read" as const

const IDENTIFIER_DOMAIN = "abdo/kernel-tools/read-bound-object/identifier/v1"
const REQUEST_LIFETIME_MS = 60_000n
const MAX_U64 = (1n << 64n) - 1n

/** Narrow host port: tests and callers do not need permission to start a process. */
export interface KernelEffectHost {
  send(request: EffectRequest): Promise<HostReply>
}

export interface ReadBoundObjectToolOptions {
  /** A host which already owns the binding from this opaque handle to an object. */
  readonly host: KernelEffectHost
  readonly object: FilesystemHandle
  readonly name?: string
  /** Request time only. It never contributes to an identifier. */
  readonly nowMs?: () => bigint
}

/**
 * Define a read-only tool whose bytes can only come from the Rust kernel.
 *
 * There is deliberately no path argument and no filesystem fallback. The
 * engine supplies an opaque handle that the host was configured to bind, and
 * callers receive only the digest the kernel settled and verified.
 */
export function readBoundObjectTool(options: ReadBoundObjectToolOptions): ToolDefinition {
  const object = copyHandle(options.object)
  const nowMs = options.nowMs ?? systemTimeMs

  return {
    name: options.name ?? READ_BOUND_OBJECT_TOOL_NAME,
    description: "Read one pre-bound object through the Rust kernel and return only its verified digest",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    policy: policy({
      risk: "low",
      idempotent: true,
      reversible: true,
      timeoutMs: 10_000,
    }),
    async run(input: unknown, context: ToolContext): Promise<ToolResult> {
      if (!isEmptyObject(input)) return failure("invalid_tool_arguments")
      if (context.signal?.aborted === true) return failure("kernel_cancelled")
      if (context.executionId === undefined || context.executionId.length === 0) {
        return failure("kernel_execution_id_required")
      }

      let request: EffectRequest
      try {
        request = await buildRequest(context.executionId, object, nowMs())
      } catch (error) {
        return failure(`kernel_request_invalid:${describe(error)}`)
      }

      let reply: HostReply
      try {
        reply = await options.host.send(request)
      } catch (error) {
        return failure(`kernel_unreachable:${describe(error)}`)
      }

      if (reply.kind === "unreachable") return failure(`kernel_unreachable:${reply.reason}`)
      if (reply.kind === "backpressure") return failure(`kernel_backpressure:capacity=${reply.capacity}`)
      if (reply.outcome.tag !== "Verified") return failure(describeRefusal(reply.outcome))

      const verified = reply.outcome.value
      if (verified.intent_id !== request.intent_id) return failure("kernel_verified_wrong_intent")
      if (!isDigest(verified.outcome_digest) || !isDigest(verified.postcondition_digest)) {
        return failure("kernel_verified_invalid_digest")
      }
      if (!sameBytes(verified.outcome_digest, verified.postcondition_digest)) {
        return failure("kernel_verified_postcondition_mismatch")
      }

      return { ok: true, output: { digest: hex(verified.outcome_digest) } }
    },
  }
}

/** Register the owned kernel adapter without giving the caller a second copy. */
export function registerKernelTools(
  registry: ToolRegistry,
  options: ReadBoundObjectToolOptions,
): ToolRegistry {
  return registry.register(readBoundObjectTool(options))
}

async function buildRequest(
  executionId: string,
  object: FilesystemHandle,
  requestedAtMs: bigint,
): Promise<EffectRequest> {
  if (requestedAtMs < 0n || requestedAtMs > MAX_U64 - REQUEST_LIFETIME_MS) {
    throw new RangeError("request time is outside the kernel u64 window")
  }
  const expiresAtMs = requestedAtMs + REQUEST_LIFETIME_MS
  const [intentId, proposalId, eventId] = await Promise.all([
    derivedIdentifier<IntentId>(executionId, "intent"),
    derivedIdentifier<ProposalId>(executionId, "proposal"),
    derivedIdentifier<EventId>(executionId, "cause-event"),
  ])
  return {
    intent_id: intentId,
    proposal_id: proposalId,
    cause_event_id: eventId,
    scope: { tag: "Workspace", value: {} },
    target: { tag: "Filesystem", value: { object } },
    operation_digest: labelDigest(READ_BOUND_OBJECT_OPERATION),
    args_digest: labelDigest("no-arguments"),
    requested_at_ms: requestedAtMs,
    expires_at_ms: expiresAtMs,
  }
}

async function derivedIdentifier<T extends bigint>(executionId: string, role: string): Promise<T> {
  const material = new TextEncoder().encode(JSON.stringify([IDENTIFIER_DOMAIN, role, executionId]))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material))
  let value = 0n
  // Kernel identifiers are u128. Domain-separated SHA-256 supplies the bytes;
  // taking the first 128 bits preserves the wire width without clock state.
  for (let index = 0; index < 16; index += 1) value = (value << 8n) | BigInt(digest[index]!)
  return (value === 0n ? 1n : value) as T
}

function copyHandle(value: FilesystemHandle): FilesystemHandle {
  if (!(value instanceof Uint8Array) || value.length !== 32 || value.every((byte) => byte === 0)) {
    throw new TypeError("a bound object handle must be 32 bytes and cannot be all zeroes")
  }
  return Uint8Array.from(value) as FilesystemHandle
}

function isEmptyObject(value: unknown): value is Readonly<Record<string, never>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Reflect.ownKeys(value).length === 0
}

function describeRefusal(outcome: Exclude<EffectOutcome, { readonly tag: "Verified" }>): string {
  const tag = outcome.tag === "Declined" ? "declined" : "unresolved"
  const reason = isDigest(outcome.value.reason_digest) ? hex(outcome.value.reason_digest) : "invalid-reason-digest"
  return `kernel_${tag}:${reason}`
}

function isDigest(value: unknown): value is Digest {
  return value instanceof Uint8Array && value.length === 32 && value.some((byte) => byte !== 0)
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function failure(error: string): ToolResult {
  return { ok: false, error }
}

function systemTimeMs(): bigint {
  return BigInt(Date.now())
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
