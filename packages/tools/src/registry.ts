/** Tool registry — tools declare a policy up front; the runner enforces it. */
import type { ToolDomain } from "@abdo/contracts"
import type { ControlledExecutionGrant } from "./launcher"

export type ToolPolicy = ToolDomain.ToolPolicy

export interface ToolContext {
  /** When true the tool must not perform side effects (dry-run probe). */
  readonly dryRun: boolean
  /** Aborts when the run is cancelled or times out; honor it to stop child processes. */
  readonly signal?: AbortSignal
  /** The tool.started execution id, for logging/verification correlation. */
  readonly executionId?: string
  /**
   * Environment the ENFORCEMENT POINT requires for this execution (CL-11). It
   * OVERRIDES the tool's own and the user's environment — it exists precisely to
   * override what the command would otherwise inherit — and a tool that receives
   * it must apply it or not run at all. The PEP will not hand it to a tool that
   * has not declared `honorsEnvOverlay`, so silently ignoring it is not a state
   * this type can reach by accident.
   */
  readonly envOverlay?: Readonly<Record<string, string>>
  /**
   * بثُّ خرج العملية أثناء تنفيذها. غيابُه = السلوكُ القديم حرفياً: يُجمَّع
   * ويُعاد بعد الخروج. **ليس قناةً للنتيجة** — النتيجةُ تبقى في العائد،
   * وهذا إشعارُ تقدّمٍ يجعل الفرقَ بين بناءٍ بطيءٍ وأمرٍ معلّقٍ مرئيّاً.
   */
  readonly onOutput?: (chunk: { readonly stream: "stdout" | "stderr"; readonly text: string }) => void
  /**
   * CL-16A2-B. The isolation this execution runs under, issued by the
   * ENFORCEMENT POINT. A tool that starts a process passes it straight to
   * `launchControlledProcess`; it never invents one and it cannot read one out
   * of its own arguments, so the model has no way to select the profile it runs
   * under. Absent means the control plane imposed none, and the launch uses
   * `INHERIT_PROFILE` — the behaviour that already existed.
   */
  readonly execution?: ControlledExecutionGrant
}

/**
 * Compensation data OWNED BY ONE TOOL EXECUTION. A failed call that never began
 * mutating returns `mutationStarted: false` and the runner must not roll back —
 * `ok: false` alone NEVER means there is something to compensate. This replaces
 * the shared path-keyed backup map that let a failed no-op call restore a
 * PREVIOUS call's backup and silently destroy completed work (the 2026-07-23
 * multi-11 incident).
 */
export interface MutationReceipt {
  /** The tool.started execution id this receipt belongs to. */
  readonly executionId: string
  /** Workspace-relative path the call targeted (when applicable). */
  readonly path?: string
  /** SHA-256 of the content before the call; null when the target did not exist. */
  readonly beforeHash: string | null
  /** SHA-256 of the content after a committed mutation. */
  readonly afterHash?: string
  /** Backup file holding the exact prior bytes (outside the workspace). */
  readonly backupPath?: string
  /** Whether the target existed before the call (rollback of a create = delete). */
  readonly existedBefore?: boolean
  /** The call began changing state (backup taken / write begun). */
  readonly mutationStarted: boolean
  /** The change fully landed. started && !committed = partial failure. */
  readonly mutationCommitted: boolean
}

export type ToolResult =
  | { readonly ok: true; readonly output: unknown; readonly mutation?: MutationReceipt; readonly resultFingerprint?: string }
  | {
      readonly ok: false
      readonly error: string
      /** Structured failure detail (e.g. shell exitCode/stdout/stderr) — a failure must never be information-poor. */
      readonly output?: unknown
      readonly mutation?: MutationReceipt
      /** Stable hash of the RESULT (volatile fields like duration excluded), so an
       *  identical call producing the identical result is detectable as such. */
      readonly resultFingerprint?: string
    }

/** Minimal JSON-Schema (object) describing a tool's input, for function calling. */
export interface JsonSchema {
  readonly type: "object"
  readonly properties: Record<string, { type: string; description?: string }>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
}

export interface ToolDefinition {
  readonly name: string
  readonly policy: ToolPolicy
  /** Human/LLM-facing description — shown to the model for function calling. */
  readonly description?: string
  /** JSON Schema for the input — sent to the model so it can call the tool. */
  readonly inputSchema?: JsonSchema
  /**
   * The tool APPLIES `ctx.envOverlay` when present, above its own and the
   * inherited environment. Declaring this is a promise the enforcement point
   * holds it to: a tool without the flag is never given a constrained execution,
   * it is refused, because an allow whose constraint quietly evaporated is worse
   * than a denial — the record would claim a protection that never existed.
   */
  readonly honorsEnvOverlay?: boolean
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>
  /** Optional no-side-effect probe; used when the runner runs dry-run first. */
  dryRun?(input: unknown): Promise<unknown>
  /**
   * Optional compensation, driven ONLY by the failing execution's own receipt
   * (never shared state). Called by the runner when a call fails AFTER its
   * mutation started; also callable by a later verifier with a stored receipt.
   */
  rollback?(receipt: MutationReceipt): Promise<void>
}

/** Neutral tool schema handed to a model client (provider-agnostic). */
export interface ModelToolSchema {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
}

const EMPTY_SCHEMA: JsonSchema = { type: "object", properties: {}, additionalProperties: false }

/** Terse policy builder with safe defaults (unknown => treat as risky). */
export function policy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return {
    risk: "medium",
    idempotent: false,
    reversible: false,
    requiresApproval: false,
    supportsDryRun: false,
    timeoutMs: 30_000,
    secretsAccess: "none",
    ...overrides,
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition): this {
    this.tools.set(tool.name, tool)
    return this
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  /** Neutral schemas for the model client. `names` filters (capability selection). */
  toModelSchemas(names?: readonly string[]): ModelToolSchema[] {
    const chosen = names ? this.list().filter((t) => names.includes(t.name)) : this.list()
    return chosen.map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      inputSchema: t.inputSchema ?? EMPTY_SCHEMA,
    }))
  }
}

/** Minimal input validation (required keys + primitive types). Returns a coded error. */
export function validateInput(
  schema: JsonSchema | undefined,
  input: unknown,
): { ok: true } | { ok: false; code: "invalid_tool_arguments"; message: string } {
  if (!schema) return { ok: true }
  const obj = (input ?? {}) as Record<string, unknown>
  for (const key of schema.required ?? []) {
    if (obj[key] === undefined || obj[key] === null) {
      return { ok: false, code: "invalid_tool_arguments", message: `${key} is required` }
    }
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    const v = obj[key]
    if (v === undefined) continue
    const t = Array.isArray(v) ? "array" : typeof v
    if (spec.type === "integer" || spec.type === "number") {
      if (typeof v !== "number") return { ok: false, code: "invalid_tool_arguments", message: `${key} must be ${spec.type}` }
    } else if (t !== spec.type) {
      return { ok: false, code: "invalid_tool_arguments", message: `${key} must be ${spec.type}` }
    }
  }
  return { ok: true }
}
