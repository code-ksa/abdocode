import type { InstructionScope } from "./instructions"

/**
 * S125 — the harness profile, as validated data.
 *
 * A "harness" is everything about a request that is not the model and not the
 * conversation: what the assistant is told it is, what the tools are called,
 * what shape their schemas take, where the model is told to stop. Every agent
 * that supports more than one of these grows the same organ — a function with
 * a branch per style, then a branch per provider inside it, then a loop over
 * both — and after the third style nobody can say what any single harness
 * actually sends.
 *
 * So the harness is a **document**, and the two acceptance conditions are the
 * two ways that claim can be false:
 *
 * - **A new harness must be a new file, with no loop and no provider branch.**
 *   The applier below reads fields; it never asks which profile it is holding.
 *   `harness-profile.test.ts` reads this file's own source and fails if a
 *   profile id or a vendor name appears in it, with the id list derived from
 *   the registry rather than typed out — so hardcoding a special case reddens.
 * - **An invalid file is rejected before the network.** `parse` validates and
 *   returns a reason. Nothing here opens a socket, and nothing downstream can
 *   accept a profile that did not come through `parse`, because `Profile` is
 *   only constructible from it.
 *
 * The validator is written by hand rather than pulled from a schema library.
 * This package carries exactly one dependency on purpose, and "rejected before
 * the network" is a stronger claim when the thing doing the rejecting has no
 * transitive dependencies at all.
 */

const NAME_CASES = ["snake", "kebab", "camel", "as-written"] as const
export type NameCase = (typeof NAME_CASES)[number]

const TOOL_SHAPES = ["json-schema", "typescript", "xml"] as const
export type ToolShape = (typeof TOOL_SHAPES)[number]

const SCOPES = ["system", "builder", "verifier", "planner", "recovery"] as const

/**
 * Where a pack's text came from.
 *
 * S126 requires every harness pack to be written here rather than lifted from
 * a vendor's published prompt, and the only mechanically checkable part of that
 * is the declaration plus the absence of imported licence text. A machine
 * cannot verify authorship; what it can do is refuse to load a pack that will
 * not claim it, and refuse one that carries somebody else's copyright header.
 */
const ORIGINS = ["written-here"] as const
export type Origin = (typeof ORIGINS)[number]

export interface HarnessInstruction {
  readonly scope: InstructionScope
  readonly text: string
}

export interface HarnessProfileDocument {
  /** Stable id. Used for selection and logging — never branched on. */
  readonly id: string
  readonly version: number
  /** Why this harness exists. A profile nobody can justify gets deleted. */
  readonly rationale: string
  /** Provenance claim. See `Origin`. */
  readonly origin: Origin
  readonly naming: {
    /** What the assistant is called inside its own instructions. */
    readonly assistant: string
    /** Optional prefix every tool name carries. */
    readonly toolNamespace?: string
    readonly toolNameCase: NameCase
  }
  readonly instructions: readonly HarnessInstruction[]
  readonly tools: {
    readonly shape: ToolShape
    /** Whether the schema is declared closed to the provider. */
    readonly strict: boolean
    /** Hard cap on exposed tools, or absent for no cap. */
    readonly limit?: number
    /** Descriptions longer than this are a profile error, not a truncation. */
    readonly descriptionMaxChars: number
  }
  readonly stop: readonly string[]
}

/**
 * A profile that has been through the validator.
 *
 * The private symbol is the point: a function that accepts `Profile` cannot be
 * handed a plain object that skipped validation, so "rejected before the
 * network" is a property of the type rather than a discipline somebody has to
 * remember.
 */
declare const validated: unique symbol

export interface Profile {
  readonly document: HarnessProfileDocument
  readonly [validated]: true
}

export type ParseResult = { readonly ok: true; readonly profile: Profile } | { readonly ok: false; readonly why: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0

const positiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0

/**
 * Validate a harness document. Pure, synchronous, and the only way to obtain a
 * `Profile`. Returns the first thing wrong rather than a list, because a
 * profile is fixed one problem at a time and the first one is the one being
 * fixed.
 */
export const parse = (input: unknown): ParseResult => {
  const bad = (why: string): ParseResult => ({ ok: false, why })
  if (!isRecord(input)) return bad("a harness profile must be an object")
  if (!nonEmptyString(input.id)) return bad("id must be a non-empty string")
  if (!positiveInt(input.version)) return bad("version must be a positive integer")
  if (!nonEmptyString(input.rationale)) return bad("rationale must be a non-empty string")
  if (!ORIGINS.includes(input.origin as Origin)) return bad(`origin must be one of ${ORIGINS.join(", ")}`)

  const naming = input.naming
  if (!isRecord(naming)) return bad("naming must be an object")
  if (!nonEmptyString(naming.assistant)) return bad("naming.assistant must be a non-empty string")
  if (!NAME_CASES.includes(naming.toolNameCase as NameCase)) {
    return bad(`naming.toolNameCase must be one of ${NAME_CASES.join(", ")}`)
  }
  if (naming.toolNamespace !== undefined && !nonEmptyString(naming.toolNamespace)) {
    return bad("naming.toolNamespace, when present, must be a non-empty string")
  }

  if (!Array.isArray(input.instructions) || input.instructions.length === 0) {
    return bad("instructions must be a non-empty array")
  }
  const scopes = new Set<string>()
  for (const entry of input.instructions) {
    if (!isRecord(entry)) return bad("each instruction must be an object")
    if (!SCOPES.includes(entry.scope as InstructionScope)) {
      return bad(`instruction scope must be one of ${SCOPES.join(", ")}`)
    }
    if (!nonEmptyString(entry.text)) return bad(`instruction ${String(entry.scope)} has empty text`)
    if (scopes.has(entry.scope as string)) return bad(`scope ${String(entry.scope)} is declared twice`)
    scopes.add(entry.scope as string)
  }

  const tools = input.tools
  if (!isRecord(tools)) return bad("tools must be an object")
  if (!TOOL_SHAPES.includes(tools.shape as ToolShape)) {
    return bad(`tools.shape must be one of ${TOOL_SHAPES.join(", ")}`)
  }
  if (typeof tools.strict !== "boolean") return bad("tools.strict must be a boolean")
  if (!positiveInt(tools.descriptionMaxChars)) return bad("tools.descriptionMaxChars must be a positive integer")
  if (tools.limit !== undefined && !positiveInt(tools.limit)) {
    return bad("tools.limit, when present, must be a positive integer")
  }

  if (!Array.isArray(input.stop) || input.stop.some((entry) => !nonEmptyString(entry))) {
    return bad("stop must be an array of non-empty strings")
  }

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return { ok: true, profile: { document: input as unknown as HarnessProfileDocument } as Profile }
}

// --- applying a profile --------------------------------------------------------

const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase())

const upperFirst = (value: string) => `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`

const cased = (name: string, style: NameCase) => {
  if (style === "as-written") return name
  const parts = words(name)
  if (style === "snake") return parts.join("_")
  if (style === "kebab") return parts.join("-")
  return parts.map((part, index) => (index === 0 ? part : upperFirst(part))).join("")
}

const joined = (namespace: string, name: string, style: NameCase) => {
  if (style === "camel") return `${namespace}${upperFirst(name)}`
  if (style === "kebab") return `${namespace}-${name}`
  if (style === "snake") return `${namespace}_${name}`
  return `${namespace} ${name}`
}

export interface ToolInput {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

export interface ShapedTool {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  readonly strict: boolean
}

export interface Applied {
  readonly assistant: string
  readonly instructions: Readonly<Partial<Record<InstructionScope, string>>>
  readonly tools: readonly ShapedTool[]
  readonly dropped: readonly { readonly name: string; readonly why: string }[]
  readonly shape: ToolShape
  readonly stop: readonly string[]
}

/**
 * Render a request's harness-shaped parts from a validated profile.
 *
 * Reads fields. Does not ask which profile it is holding, and does not know any
 * vendor exists — the guard test enforces both by reading this source.
 */
export const apply = (profile: Profile, tools: readonly ToolInput[]): Applied => {
  const document = profile.document
  const instructions: Partial<Record<InstructionScope, string>> = {}
  for (const entry of document.instructions) {
    instructions[entry.scope] = entry.text.replaceAll("{assistant}", document.naming.assistant)
  }

  const shaped: ShapedTool[] = []
  const dropped: { readonly name: string; readonly why: string }[] = []
  for (const tool of tools) {
    if (document.tools.limit !== undefined && shaped.length >= document.tools.limit) {
      dropped.push({ name: tool.name, why: `over the profile limit of ${document.tools.limit}` })
      continue
    }
    if (tool.description.length > document.tools.descriptionMaxChars) {
      // Not truncated. A description the profile cannot carry is a mismatch
      // between the tool and the harness, and silently shortening it hides
      // which of the two is wrong.
      dropped.push({
        name: tool.name,
        why: `description ${tool.description.length} chars over the profile maximum of ${document.tools.descriptionMaxChars}`,
      })
      continue
    }
    const style = document.naming.toolNameCase
    const base = cased(tool.name, style)
    shaped.push({
      name:
        document.naming.toolNamespace === undefined
          ? base
          : joined(cased(document.naming.toolNamespace, style), base, style),
      description: tool.description,
      parameters: tool.parameters,
      strict: document.tools.strict,
    })
  }

  return {
    assistant: document.naming.assistant,
    instructions,
    tools: shaped,
    dropped,
    shape: document.tools.shape,
    stop: document.stop,
  }
}

/** Roughly what a harness costs before a single message is added. */
export const overheadChars = (applied: Applied): number =>
  Object.values(applied.instructions).reduce((total, text) => total + (text?.length ?? 0), 0) +
  applied.tools.reduce(
    (total, entry) => total + entry.name.length + entry.description.length + JSON.stringify(entry.parameters).length,
    0,
  )
