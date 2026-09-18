import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { KERNEL_PACKAGE_DIR } from "./contracts"

const REPOSITORY_DIR = resolve(KERNEL_PACKAGE_DIR, "..", "..")
const EFFECT_CLASSES = new Set(["Read", "Mutate", "Reach", "Spend", "Irreversible"])
const BUILTIN_FACTORIES = new Map([
  ["readFileTool", "read_file"],
  ["listDirTool", "list_dir"],
  ["writeFileTool", "write_file"],
  ["editFileTool", "edit_file"],
  ["runCommandTool", "run_command"],
  ["shellTool", "shell"],
])

export const INVENTORY_PATH = "inventory/tool-surface.json"

export interface InventoryImplementation {
  readonly surface: string
  readonly id: string
  readonly file: string
}

export interface InventoryCapability {
  readonly capability: string
  readonly effectClass: string
  readonly canonical: string
  readonly implementations: readonly InventoryImplementation[]
}

export interface ToolInventory {
  readonly version: number
  readonly boundToSchemaFingerprint: string
  readonly surfaces: Readonly<Record<string, { readonly root: string; readonly assembledBy: string }>>
  readonly capabilities: readonly InventoryCapability[]
  readonly dynamic: readonly { readonly kind: string; readonly file: string }[]
  readonly brokers: {
    readonly present: readonly { readonly name: string; readonly root: string }[]
    readonly absent: readonly string[]
  }
}

export interface InventoryReport {
  readonly capabilities: number
  readonly implementations: number
  readonly surfaces: number
  readonly duplicated: number
  readonly shippedIds: number
}

export async function readInventory(): Promise<ToolInventory> {
  const text = await readFile(join(KERNEL_PACKAGE_DIR, INVENTORY_PATH), "utf8")
  return JSON.parse(text) as ToolInventory
}

async function repositoryFile(relative: string): Promise<string | undefined> {
  try {
    return await readFile(join(REPOSITORY_DIR, relative), "utf8")
  } catch {
    return undefined
  }
}

function declaredIds(source: string): Set<string> {
  return new Set([...source.matchAll(/\bname:\s*\x22([a-z_][a-z0-9_]*)\x22/g)].map((match) => match[1]!))
}

async function assembledIds(): Promise<Set<string>> {
  const registry = await repositoryFile("packages/builtin-tools/src/index.ts")
  if (registry === undefined) throw new Error("S117 inventory cannot find the owned built-in registry")
  const factories = new Set([...registry.matchAll(/\.register\((\w+)\(/g)].map((match) => match[1]!))
  const ids = new Set<string>()
  for (const factory of factories) {
    const id = BUILTIN_FACTORIES.get(factory)
    if (id === undefined) throw new Error(`S117 registry assembles unknown factory ${factory}`)
    ids.add(id)
  }
  if (factories.size !== BUILTIN_FACTORIES.size) {
    throw new Error(`S117 registry assembles ${factories.size} built-ins; ${BUILTIN_FACTORIES.size} are required`)
  }
  return ids
}

async function currentSchemaFingerprint(): Promise<string> {
  const generated = await readFile(join(KERNEL_PACKAGE_DIR, "src/generated/contracts.ts"), "utf8")
  const declared = /const CODEC_SCHEMA_FINGERPRINT = INTRINSIC_OBJECT_FREEZE\(\[([^\]]*)\]/.exec(generated)?.[1]
  if (declared === undefined) throw new Error("S117 cannot read the schema fingerprint")
  const bytes = declared.split(",").map((part) => part.trim()).filter(Boolean).map(Number)
  if (bytes.length !== 16 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error("S117 schema fingerprint is not sixteen bytes")
  }
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function verifyInventory(): Promise<InventoryReport> {
  const inventory = await readInventory()
  if (inventory.version !== 2) throw new Error("S117 owned inventory version drifted")
  if (inventory.boundToSchemaFingerprint !== await currentSchemaFingerprint()) throw new Error("S117 inventory is not bound to the generated contract")

  const surfaces = new Set(Object.keys(inventory.surfaces))
  if (surfaces.size !== 1 || !surfaces.has("owned-registry")) throw new Error("S117 inventory must describe exactly the one owned tool surface")

  let implementations = 0
  let duplicated = 0
  const listedIds = new Set<string>()
  const capabilities = new Set<string>()
  for (const capability of inventory.capabilities) {
    if (!EFFECT_CLASSES.has(capability.effectClass)) throw new Error(`S117 invalid effect class for ${capability.capability}`)
    if (capabilities.has(capability.capability)) throw new Error(`S117 duplicate capability ${capability.capability}`)
    capabilities.add(capability.capability)
    if (capability.canonical !== "owned-registry" || capability.implementations.length !== 1) {
      throw new Error(`S117 ${capability.capability} must have exactly one owned implementation`)
    }
    if (capability.implementations.length > 1) duplicated += 1
    const entry = capability.implementations[0]!
    if (entry.surface !== capability.canonical) throw new Error(`S117 wrong surface for ${capability.capability}`)
    const declaring = await repositoryFile(entry.file)
    if (declaring === undefined) throw new Error(`S117 inventory names a missing file: ${entry.file}`)
    if (!declaredIds(declaring).has(entry.id)) throw new Error(`S117 ${entry.file} does not declare ${entry.id}`)
    if (listedIds.has(entry.id)) throw new Error(`S117 duplicate owned tool id ${entry.id}`)
    listedIds.add(entry.id)
    implementations += 1
  }

  const shippedIds = await assembledIds()
  if (listedIds.size !== shippedIds.size || [...shippedIds].some((id) => !listedIds.has(id))) {
    throw new Error(`S117 inventory lists ${listedIds.size} tools but the registry ships ${shippedIds.size}`)
  }
  for (const channel of inventory.dynamic) {
    if (await repositoryFile(channel.file) === undefined) throw new Error(`S117 dynamic channel is missing: ${channel.file}`)
  }
  for (const broker of inventory.brokers.present) {
    if (await repositoryFile(`${broker.root}/package.json`) === undefined && await repositoryFile(`${broker.root}/Cargo.toml`) === undefined) {
      throw new Error(`S117 broker root is missing: ${broker.root}`)
    }
  }
  if (inventory.brokers.absent.length !== 0) throw new Error("S117 inventory still records an absent broker")
  return { capabilities: capabilities.size, implementations, surfaces: surfaces.size, duplicated, shippedIds: shippedIds.size }
}
