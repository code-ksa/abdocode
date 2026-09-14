import type { EnforcementReport, InputChannel } from "@abdo/kernel/contracts"
import { encodeEnforcementReport } from "@abdo/kernel/contracts"
import { encodeChatRequest, type ModelMessage, type ProviderWire } from "@abdo/model-gateway"
import { apply, HarnessRegistry, type Profile, type ShapedTool } from "@abdo/prompting"

export type { Enforcement, EnforcementReport, InputChannel } from "@abdo/kernel/contracts"
export type { ModelMessage, ModelRole, ProviderWire } from "@abdo/model-gateway"
export { HarnessRegistry, apply, parse, type HarnessProfileDocument, type Profile } from "@abdo/prompting"

export interface ClassifiedInput {
  readonly channel: InputChannel
  readonly body: string
}

export type HarnessWire = ProviderWire

export interface ChatRequest {
  readonly path: string
  readonly body: string
  readonly headers: Readonly<Record<string, string>>
  readonly credential: "none" | "bearer" | "x-api-key"
  readonly toolBindings: readonly HarnessToolBinding[]
  readonly droppedTools: readonly DroppedHarnessTool[]
}

/** A runtime-owned tool before a model profile changes its public spelling. */
export interface HarnessToolDefinition {
  readonly legalName: string
  readonly usage: string
  readonly description: string
  readonly parameters: unknown
}

/** The reversible edge between a model-facing name and the runtime's legal name. */
export interface HarnessToolBinding {
  readonly legalName: string
  readonly exposedName: string
  readonly usage: string
  readonly description: string
  readonly parameters: unknown
  readonly strict: boolean
}

export interface DroppedHarnessTool {
  readonly legalName: string
  readonly why: string
}

/** Adapter only: the legal channel vocabulary comes from generated Rust contracts. */
export function classifyInput(channel: InputChannel, body: string): ClassifiedInput {
  if (body.trim().length === 0) throw new Error("classified input cannot be empty")
  // Wake timing belongs to the Rust control queue. This adapter only validates
  // the generated channel vocabulary and carries the classified body onward.
  return Object.freeze({ channel, body })
}

/** Validate through the generated codec instead of inventing a second report. */
export function attest(report: EnforcementReport): EnforcementReport {
  encodeEnforcementReport(report)
  return Object.freeze({ ...report })
}

const exposedUsage = (definition: HarnessToolDefinition, exposedName: string): string => {
  const usage = definition.usage.trim()
  if (usage === definition.legalName) return exposedName
  if (usage.startsWith(`${definition.legalName} `)) return `${exposedName}${usage.slice(definition.legalName.length)}`
  throw new Error(`tool ${definition.legalName} usage must start with its legal name`)
}

const bindTools = (
  profile: Profile,
  definitions: readonly HarnessToolDefinition[],
): { readonly bindings: readonly HarnessToolBinding[]; readonly dropped: readonly DroppedHarnessTool[]; readonly system?: string; readonly stop: readonly string[] } => {
  const legalNames = new Set<string>()
  for (const definition of definitions) {
    if (definition.legalName.trim().length === 0) throw new Error("tool legal name is required")
    if (legalNames.has(definition.legalName)) throw new Error(`duplicate legal tool name: ${definition.legalName}`)
    legalNames.add(definition.legalName)
  }

  const applied = apply(profile, definitions.map((definition) => ({
    name: definition.legalName,
    description: definition.description,
    parameters: definition.parameters,
  })))
  const droppedByName = new Map(applied.dropped.map((entry) => [entry.name, entry.why]))
  const exposedNames = new Set<string>()
  const bindings: HarnessToolBinding[] = []
  let shapedIndex = 0
  for (const definition of definitions) {
    if (droppedByName.has(definition.legalName)) continue
    const shaped: ShapedTool | undefined = applied.tools[shapedIndex++]
    if (shaped === undefined) throw new Error(`profile omitted mapping for tool ${definition.legalName}`)
    if (exposedNames.has(shaped.name)) throw new Error(`profile maps two tools to exposed name: ${shaped.name}`)
    exposedNames.add(shaped.name)
    bindings.push(Object.freeze({
      legalName: definition.legalName,
      exposedName: shaped.name,
      usage: exposedUsage(definition, shaped.name),
      description: shaped.description,
      parameters: shaped.parameters,
      strict: shaped.strict,
    }))
  }
  if (shapedIndex !== applied.tools.length) throw new Error("profile produced an unmapped tool")
  return Object.freeze({
    bindings: Object.freeze(bindings),
    dropped: Object.freeze(applied.dropped.map((entry) => Object.freeze({ legalName: entry.name, why: entry.why }))),
    system: applied.instructions.system,
    stop: applied.stop,
  })
}

const modelSystem = (
  profileSystem: string | undefined,
  applicationSystem: string | undefined,
  bindings: readonly HarnessToolBinding[],
): string | undefined => {
  const byLegalName = new Map(bindings.map((binding) => [binding.legalName, binding.exposedName]))
  const catalogue = bindings.map((binding) => `- ${binding.usage} — ${binding.description}`).join("\n")
  let application = applicationSystem
  if (application !== undefined) {
    application = application.replace(/\{\{tool:([^}]+)\}\}/g, (_marker, legalName: string) => {
      const exposedName = byLegalName.get(legalName)
      if (exposedName === undefined) throw new Error(`system prompt references unavailable legal tool: ${legalName}`)
      return exposedName
    })
    application = application.includes("{{tool-catalogue}}")
      ? application.replaceAll("{{tool-catalogue}}", catalogue)
      : `${application}\n\n${catalogue}`
  }
  const sections = [profileSystem, application].filter((section): section is string => section !== undefined && section.trim().length > 0)
  return sections.length === 0 ? undefined : sections.join("\n\n")
}

export function buildChatRequest(input: {
  readonly wire: HarnessWire
  readonly harness: string
  readonly model: string
  readonly system?: string
  readonly messages: readonly ModelMessage[]
  readonly tools?: readonly HarnessToolDefinition[]
  readonly stream: boolean
  readonly contextTokens?: number
  readonly maxOutputTokens?: number
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly think?: boolean
  readonly nativeTools?: boolean
  /** Pure conversation omits agent instructions, tool bindings and stop markers. */
  readonly conversationOnly?: boolean
  /** م9ز — يمرّ إلى المرمِّز كما هو؛ التحقّقُ هناك. */
  readonly sessionAffinity?: string
  readonly sessionAffinityBody?: boolean
}): ChatRequest {
  if (input.model.trim().length === 0) throw new Error("model is required")
  if (input.messages.some((message) => message.role === "system")) {
    throw new Error("system messages must be supplied through the singular system field")
  }
  const profile = HarnessRegistry.get(input.harness)
  if (profile === undefined) throw new Error(`unknown harness profile: ${input.harness}`)
  if (input.conversationOnly && (input.nativeTools || input.tools?.length)) throw new Error('conversation-only requests cannot advertise tools')
  const prepared = input.conversationOnly
    ? { bindings: [], dropped: [], system: undefined, stop: [] }
    : bindTools(profile, input.tools ?? [])
  const system = modelSystem(prepared.system, input.system, prepared.bindings)
  const messages = system === undefined ? input.messages : [{ role: "system" as const, content: system }, ...input.messages]
  const encoded = encodeChatRequest({
    wire: input.wire,
    model: input.model,
    messages,
    stream: input.stream,
    stop: prepared.stop,
    contextTokens: input.contextTokens,
    maxOutputTokens: input.maxOutputTokens,
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    think: input.think,
    sessionAffinity: input.sessionAffinity,
    sessionAffinityBody: input.sessionAffinityBody,
    tools: input.nativeTools ? prepared.bindings.map((tool) => ({ name: tool.exposedName, description: tool.description, parameters: tool.parameters })) : undefined,
  })
  return Object.freeze({
    path: encoded.path,
    body: encoded.body,
    headers: encoded.headers,
    credential: encoded.credential,
    toolBindings: prepared.bindings,
    droppedTools: prepared.dropped,
  })
}
