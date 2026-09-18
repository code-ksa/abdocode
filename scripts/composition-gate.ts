import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"

export const REPO = resolve(import.meta.dir, "..")
export const MANIFEST_PATH = join(REPO, "architecture", "composition.manifest.json")

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"])
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "dist", "target", "test", "tests", "scripts", "script"])
const EXCLUDED_FILE = /(?:\.test\.|\.spec\.|\.stories\.)/
const PACKAGE_NAME = /^@abdo\/[a-z0-9-]+$/
const PACKAGE_PATH = /^packages\/[a-z0-9-]+$/
const SPRINT = /^R(?:[0-9]|[1-9][0-9]+)$/

const ROLES = new Set([
  "composition-root",
  "authority",
  "contract",
  "runtime",
  "adapter",
  "policy",
  "persistence",
  "ui",
  "quality",
  "migration",
  "devtool",
])
const OWNERS = new Set(["kernel", "engine", "model", "control", "tools", "security", "desktop", "ui", "quality", "migration", "platform"])
const STATUSES = new Set(["connected", "integration-only", "diagnostic-only", "standalone", "planned-orphan", "deprecated"])
const EFFECT_BOUNDARIES = new Set(["none", "proposal-only", "rust-kernel-host", "test-only", "legacy-direct-temporary"])
const JOURNAL_BOUNDARIES = new Set(["none", "rust-effect-journal", "session-event-store", "projection-only", "legacy-ledger-temporary"])
const NETWORK_BOUNDARIES = new Set(["none", "local-only", "owner-configured-egress", "test-only", "legacy-direct-temporary"])

const REQUIRED_PARALLEL_MARKERS = [
  { id: "session-ledger", path: "packages/engine/src/cli.ts", marker: "appendFileSync(PERSIST" },
  { id: "session-loop", path: "packages/engine/src/cli.ts", marker: "const serve = async" },
  { id: "tool-catalog", path: "packages/engine/src/mind/tools.ts", marker: "export const TOOLS" },
  { id: "direct-effects", path: "packages/engine/src/cli.ts", marker: "Bun.spawn(" },
  { id: "secret-resolution", path: "packages/engine/src/cli.ts", marker: "const readVaultKey" },
  { id: "browser-surface", path: "packages/engine/src/mind/browser.ts", marker: "export class CdpBrowser" },
] as const

export interface CompositionManifest {
  schemaVersion: number
  product: string
  roots: Record<string, any>
  sourcesOfTruth: Record<string, any>
  packages: Record<string, any>
  parallelImplementations: any[]
  guards: any[]
  [key: string]: unknown
}

export interface PackageNode {
  readonly name: string
  readonly directory: string
  readonly runtimeDependencies: ReadonlySet<string>
  readonly productionImports: ReadonlySet<string>
  readonly sourceFiles: readonly string[]
}

export interface GraphSnapshot {
  readonly packages: ReadonlyMap<string, PackageNode>
}

export interface CompositionReport {
  readonly packageCount: number
  readonly manifestDesktopClosure: readonly string[]
  readonly productionEngineClosure: readonly string[]
  readonly outsideDesktop: readonly string[]
  readonly productClosure: readonly string[]
  readonly outsideProduct: readonly string[]
  readonly registeredParallelImplementations: number
}

export class CompositionGateError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`composition gate failed (${problems.length}):\n- ${problems.join("\n- ")}`)
    this.name = "CompositionGateError"
    this.problems = problems
  }
}

export function loadManifest(path = MANIFEST_PATH): CompositionManifest {
  return JSON.parse(readFileSync(path, "utf8")) as CompositionManifest
}

function listSourceFiles(directory: string): string[] {
  const output: string[] = []
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) visit(join(current, entry.name))
        continue
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name)) || EXCLUDED_FILE.test(entry.name)) continue
      output.push(join(current, entry.name))
    }
  }
  visit(directory)
  return output.sort()
}

function importSpecifiers(source: string): string[] {
  const values: string[] = []
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*["']([^"']+)["']/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) values.push(match[1]!)
  }
  return [...new Set(values)]
}

function workspacePackage(specifier: string): string | undefined {
  const match = /^(@abdo\/[a-z0-9-]+)(?:\/.*)?$/.exec(specifier)
  return match?.[1]
}

function forbiddenImport(specifier: string): boolean {
  return (
    specifier === "effect" ||
    specifier.startsWith("effect/") ||
    specifier === "opencode" ||
    specifier.startsWith("opencode/") ||
    specifier.startsWith("@opencode-ai/") ||
    specifier === "sst" ||
    specifier.startsWith("sst/") ||
    specifier.startsWith("@sst/")
  )
}

export function measureGraph(repo = REPO): GraphSnapshot {
  const packagesDirectory = join(repo, "packages")
  const packages = new Map<string, PackageNode>()
  for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = join(packagesDirectory, entry.name)
    const packagePath = join(directory, "package.json")
    if (!existsSync(packagePath)) continue
    const json = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string; dependencies?: Record<string, string> }
    if (typeof json.name !== "string") throw new Error(`${relative(repo, packagePath)} has no package name`)
    const sourceFiles = listSourceFiles(directory)
    const productionImports = new Set<string>()
    for (const file of sourceFiles) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        const workspace = workspacePackage(specifier)
        if (workspace !== undefined && workspace !== json.name) productionImports.add(workspace)
      }
    }
    packages.set(json.name, {
      name: json.name,
      directory,
      runtimeDependencies: new Set(Object.keys(json.dependencies ?? {}).filter((name) => PACKAGE_NAME.test(name))),
      productionImports,
      sourceFiles,
    })
  }
  return { packages }
}

function closure(graph: ReadonlyMap<string, ReadonlySet<string>>, root: string): string[] {
  const seen = new Set<string>()
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (seen.has(current)) continue
    seen.add(current)
    for (const dependency of graph.get(current) ?? []) queue.push(dependency)
  }
  return [...seen].sort()
}

function resolveLocalImport(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [base, ...[".ts", ".tsx", ".js", ".mjs", ".cjs"].map((suffix) => base + suffix)]
  for (const name of ["index.ts", "index.tsx", "index.js", "index.mjs"]) candidates.push(join(base, name))
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
}

/**
 * Start at the declared root entry. Relative imports stay file-exact; once a
 * workspace package is crossed, its production package graph is conservative.
 */
function entryPackageClosure(repo: string, snapshot: GraphSnapshot, entry: string, rootPackage: string): string[] {
  const seenFiles = new Set<string>()
  const packages = new Set<string>([rootPackage])
  const queue = [resolve(repo, entry)]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seenFiles.has(file) || !existsSync(file)) continue
    seenFiles.add(file)
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      const workspace = workspacePackage(specifier)
      if (workspace !== undefined) {
        packages.add(workspace)
        continue
      }
      const local = resolveLocalImport(file, specifier)
      if (local !== undefined) queue.push(local)
    }
  }
  const importGraph = new Map([...snapshot.packages].map(([name, node]) => [name, node.productionImports] as const))
  for (const name of [...packages]) for (const transitive of closure(importGraph, name)) packages.add(transitive)
  return [...packages].sort()
}

function nonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)
}

export function validateComposition(
  manifest: CompositionManifest,
  snapshot = measureGraph(),
  repo = REPO,
): CompositionReport {
  const problems: string[] = []
  const actualNames = [...snapshot.packages.keys()].sort()
  const manifestNames = Object.keys(manifest.packages ?? {}).sort()
  const missing = actualNames.filter((name) => !manifestNames.includes(name))
  const unknown = manifestNames.filter((name) => !actualNames.includes(name))
  if (missing.length > 0 || unknown.length > 0) {
    problems.push(`package manifest coverage mismatch; missing=[${missing.join(", ")}], unknown=[${unknown.join(", ")}]`)
  }

  if (manifest.schemaVersion !== 1) problems.push("schemaVersion must be 1")
  if (manifest.product !== "abdocode") problems.push("product must be abdocode")
  if (manifest.roots === null || typeof manifest.roots !== "object") problems.push("roots must be an object")
  if (manifest.sourcesOfTruth === null || typeof manifest.sourcesOfTruth !== "object") problems.push("sourcesOfTruth must be an object")
  if (!Array.isArray(manifest.parallelImplementations)) problems.push("parallelImplementations must be an array")
  if (!Array.isArray(manifest.guards) || manifest.guards.length === 0) problems.push("guards must be a non-empty array")

  const manifestGraph = new Map([...snapshot.packages].map(([name, node]) => [name, node.runtimeDependencies] as const))
  const importGraph = new Map([...snapshot.packages].map(([name, node]) => [name, node.productionImports] as const))
  const rootClosures = new Map<string, string[]>()

  for (const [rootId, root] of Object.entries(manifest.roots ?? {})) {
    if (root === null || typeof root !== "object") {
      problems.push(`root ${rootId} must be an object`)
      continue
    }
    if (!snapshot.packages.has(root.package)) problems.push(`root ${rootId} names unknown package ${String(root.package)}`)
    const entry = typeof root.entry === "string" ? resolve(repo, root.entry) : ""
    if (!entry || !existsSync(entry)) problems.push(`root ${rootId} entry does not exist: ${String(root.entry)}`)
    if (root.reachability === "manifest") rootClosures.set(rootId, closure(manifestGraph, root.package))
    else if (root.reachability === "production-imports") rootClosures.set(rootId, entryPackageClosure(repo, snapshot, root.entry, root.package))
    else problems.push(`root ${rootId} has invalid reachability ${String(root.reachability)}`)
    for (const launched of root.launches ?? []) if (!(launched in manifest.roots)) problems.push(`root ${rootId} launches unknown root ${launched}`)
  }

  for (const [name, node] of snapshot.packages) {
    for (const imported of node.productionImports) {
      if (!snapshot.packages.has(imported)) problems.push(`${name} imports unknown workspace package ${imported}`)
      else if (!node.runtimeDependencies.has(imported)) problems.push(`${name} imports ${imported} in production without declaring it in dependencies`)
    }
    for (const file of node.sourceFiles) {
      const source = readFileSync(file, "utf8")
      for (const specifier of importSpecifiers(source)) {
        if (forbiddenImport(specifier)) problems.push(`${relative(repo, file)} imports forbidden lineage/runtime package ${specifier}`)
      }
      if (/https?:\/\/(?:[^/]+\.)?(?:opencode\.ai|opncd\.ai|anoma\.ly|sst\.dev)(?:[/:]|$)/i.test(source)) {
        // Egress owns the forbidden host vocabulary and its tests may quote it.
        if (!file.includes(`${join("packages", "egress")}${process.platform === "win32" ? "\\" : "/"}`)) {
          problems.push(`${relative(repo, file)} contains a fixed reference-service endpoint`)
        }
      }
    }
  }

  for (const [name, entry] of Object.entries(manifest.packages ?? {})) {
    if (!PACKAGE_NAME.test(name)) problems.push(`invalid package key ${name}`)
    if (entry === null || typeof entry !== "object") {
      problems.push(`package ${name} entry must be an object`)
      continue
    }
    if (!PACKAGE_PATH.test(entry.path ?? "")) problems.push(`${name} has invalid path ${String(entry.path)}`)
    const node = snapshot.packages.get(name)
    if (node !== undefined) {
      const expectedPath = relative(repo, node.directory).replaceAll("\\", "/")
      if (entry.path !== expectedPath) problems.push(`${name} path ${entry.path} does not match ${expectedPath}`)
    }
    if (!ROLES.has(entry.role)) problems.push(`${name} has invalid role ${String(entry.role)}`)
    if (!OWNERS.has(entry.owner)) problems.push(`${name} has invalid owner ${String(entry.owner)}`)
    if (!STATUSES.has(entry.status)) problems.push(`${name} has invalid status ${String(entry.status)}`)
    if (!nonEmptyStrings(entry.capabilities)) problems.push(`${name} capabilities must be non-empty strings`)
    if (!Array.isArray(entry.runtimeRoots)) problems.push(`${name} runtimeRoots must be an array`)
    for (const root of entry.runtimeRoots ?? []) {
      if (!(root in manifest.roots)) problems.push(`${name} references unknown runtime root ${root}`)
      else if (!(rootClosures.get(root) ?? []).includes(name)) problems.push(`${name} claims runtime root ${root} but is not reachable from it`)
    }
    if (entry.status === "planned-orphan") {
      if ((entry.runtimeRoots ?? []).length !== 0) problems.push(`planned orphan ${name} must not claim a runtime root`)
      if (entry.plan === undefined) problems.push(`planned orphan ${name} needs plan.sprint, reason, targetConsumer and completionCondition`)
    } else if (["connected", "integration-only", "diagnostic-only", "standalone"].includes(entry.status) && (entry.runtimeRoots ?? []).length === 0) {
      problems.push(`${entry.status} package ${name} needs at least one runtime root`)
    }
    if (entry.plan !== undefined) {
      if (!SPRINT.test(entry.plan.sprint ?? "")) problems.push(`${name} has invalid plan sprint ${String(entry.plan.sprint)}`)
      if (!snapshot.packages.has(entry.plan.targetConsumer)) problems.push(`${name} plan targets unknown consumer ${String(entry.plan.targetConsumer)}`)
      for (const field of ["reason", "completionCondition"] as const) {
        if (typeof entry.plan[field] !== "string" || entry.plan[field].length === 0) problems.push(`${name} plan.${field} must be non-empty`)
      }
    }
    if (!Array.isArray(entry.proofs) || entry.proofs.length === 0) problems.push(`${name} needs at least one proof`)
    for (const proof of entry.proofs ?? []) {
      if (typeof proof.id !== "string" || !/^[a-z0-9-]+$/.test(proof.id)) problems.push(`${name} has invalid proof id`)
      if (typeof proof.command !== "string" || proof.command.length === 0) problems.push(`${name} proof ${String(proof.id)} needs a command`)
      if (!nonEmptyStrings(proof.asserts)) problems.push(`${name} proof ${String(proof.id)} needs assertions`)
      const packageScript = /^bun --cwd (packages\/[a-z0-9-]+) ([a-z0-9:-]+)$/.exec(proof.command ?? "")
      if (packageScript !== null) {
        const packageJsonPath = resolve(repo, packageScript[1]!, "package.json")
        const packageJson = existsSync(packageJsonPath)
          ? (JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> })
          : undefined
        if (packageJson?.scripts?.[packageScript[2]!] === undefined) {
          problems.push(`${name} proof ${String(proof.id)} names missing package script ${packageScript[2]}`)
        }
      }
    }
    if (entry.truth === null || typeof entry.truth !== "object" || !Array.isArray(entry.truth.owns) || !Array.isArray(entry.truth.consumes)) {
      problems.push(`${name} truth must contain owns and consumes arrays`)
    }
    if (entry.boundaries === null || typeof entry.boundaries !== "object") problems.push(`${name} needs boundaries`)
    else {
      if (!EFFECT_BOUNDARIES.has(entry.boundaries.effects)) problems.push(`${name} has invalid effect boundary`)
      if (!JOURNAL_BOUNDARIES.has(entry.boundaries.journal)) problems.push(`${name} has invalid journal boundary`)
      if (!NETWORK_BOUNDARIES.has(entry.boundaries.network)) problems.push(`${name} has invalid network boundary`)
    }
  }

  const truthOwners = new Map<string, string[]>()
  for (const [name, entry] of Object.entries(manifest.packages ?? {})) {
    for (const truth of entry?.truth?.owns ?? []) {
      const owners = truthOwners.get(truth) ?? []
      owners.push(name)
      truthOwners.set(truth, owners)
    }
    for (const consumed of entry?.truth?.consumes ?? []) {
      if (!(consumed in (manifest.sourcesOfTruth ?? {}))) problems.push(`${name} consumes unknown source of truth ${consumed}`)
    }
  }
  for (const [truth, source] of Object.entries(manifest.sourcesOfTruth ?? {})) {
    if (!snapshot.packages.has(source.package)) problems.push(`source of truth ${truth} names unknown package ${String(source.package)}`)
    const owners = truthOwners.get(truth) ?? []
    if (owners.length !== 1) problems.push(`source of truth ${truth} must have exactly one package owner; owners=[${owners.join(", ")}]`)
    else if (owners[0] !== source.package) problems.push(`source of truth ${truth} declares ${source.package} but is owned by ${owners[0]}`)
  }
  for (const truth of truthOwners.keys()) if (!(truth in (manifest.sourcesOfTruth ?? {}))) problems.push(`package claims undeclared source of truth ${truth}`)

  const parallelIds = new Set<string>()
  for (const item of manifest.parallelImplementations ?? []) {
    if (parallelIds.has(item.id)) problems.push(`duplicate parallel implementation id ${String(item.id)}`)
    parallelIds.add(item.id)
    if (!snapshot.packages.has(item.canonicalPackage)) problems.push(`parallel implementation ${String(item.id)} has unknown canonical package`)
    if (!SPRINT.test(item.sprint ?? "")) problems.push(`parallel implementation ${String(item.id)} has invalid sprint`)
    const file = resolve(repo, item.parallelPath ?? "")
    if (!existsSync(file)) problems.push(`parallel implementation ${String(item.id)} path does not exist`)
    else {
      const source = readFileSync(file, "utf8")
      if (!nonEmptyStrings(item.markers)) problems.push(`parallel implementation ${String(item.id)} needs markers`)
      for (const marker of item.markers ?? []) if (!source.includes(marker)) problems.push(`parallel implementation ${String(item.id)} marker is absent: ${marker}`)
    }
  }
  for (const required of REQUIRED_PARALLEL_MARKERS) {
    const path = resolve(repo, required.path)
    if (!existsSync(path) || !readFileSync(path, "utf8").includes(required.marker)) continue
    const registered = (manifest.parallelImplementations ?? []).some(
      (item) => item.id === required.id && item.parallelPath === required.path && item.markers?.includes(required.marker),
    )
    if (!registered) problems.push(`unregistered parallel implementation ${required.id} at ${required.path}`)
  }

  const productClosure = [...new Set([...rootClosures.values()].flat())].sort()
  const outsideProduct = actualNames.filter((name) => !productClosure.includes(name))
  if (outsideProduct.length > 0) {
    problems.push(`packages outside every product root: ${outsideProduct.join(", ")}`)
  }
  const plannedOrphans = Object.entries(manifest.packages ?? {})
    .filter(([, entry]) => entry?.status === "planned-orphan")
    .map(([name]) => name)
  if (plannedOrphans.length > 0) {
    problems.push(`planned orphan packages are no longer allowed: ${plannedOrphans.join(", ")}`)
  }
  if ((manifest.parallelImplementations ?? []).length > 0) {
    problems.push("parallel implementations are no longer allowed; move ownership to the canonical package")
  }

  if (problems.length > 0) throw new CompositionGateError(problems)

  const desktopClosure = closure(manifestGraph, "@abdo/desktop")
  const engineClosure = entryPackageClosure(repo, snapshot, "packages/engine/src/cli.ts", "@abdo/engine")
  return {
    packageCount: actualNames.length,
    manifestDesktopClosure: desktopClosure,
    productionEngineClosure: engineClosure,
    outsideDesktop: actualNames.filter((name) => !desktopClosure.includes(name)),
    productClosure,
    outsideProduct,
    registeredParallelImplementations: manifest.parallelImplementations.length,
  }
}

export function runCompositionGate(): CompositionReport {
  return validateComposition(loadManifest(), measureGraph(), REPO)
}

if (import.meta.main) {
  try {
    const report = runCompositionGate()
    console.log(`COMPOSITION_OK packages=${report.packageCount}/${report.packageCount} product_closure=${report.productClosure.length} outside_product=${report.outsideProduct.length} desktop_closure=${report.manifestDesktopClosure.length} engine_import_closure=${report.productionEngineClosure.length} parallels=${report.registeredParallelImplementations}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
