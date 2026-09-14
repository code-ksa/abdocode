import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".rs",
  ".toml",
  ".ts",
  ".tsx",
  ".webmanifest",
  ".yaml",
  ".yml",
])

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  "__snapshots__",
  "dist",
  "fixtures",
  "node_modules",
  "target",
  "test",
  "tests",
])

/**
 * This is deliberately a quarantine manifest, not a compatibility allowlist.
 * A quarantined package is audited as inherited evidence but can never be a
 * release candidate. Removing it from this list must be a reviewed decision.
 */
export const QUARANTINE_MANIFEST = Object.freeze([])

export const SURFACE_RULES = Object.freeze([
  Object.freeze({
    id: "inherited-opencode-identity",
    description: "OpenCode product identity outside license and notice files",
    pattern: /["'`]OpenCode["'`]/i,
    ignoreLicenseFile: true,
  }),
  Object.freeze({
    id: "remote-config-discovery",
    description: "remote .well-known configuration discovery",
    pattern: /\.well-known\/(?:abdo|opencode)(?:[/?#"'`\s]|$)/i,
  }),
  Object.freeze({
    id: "automatic-update",
    description: "automatic update or download surface",
    pattern: /\bauto[-_ ]?update\b|\bautomatically\s+(?:downloads?|installs?|updates?)\b/i,
  }),
  Object.freeze({
    id: "remote-mcp",
    description: "remote MCP transport or OAuth surface",
    pattern: /\bremote\s+MCP\b|\btype\s*[:=]\s*["'`]remote["'`].{0,120}\bMCP\b/is,
  }),
  Object.freeze({
    id: "public-session-share",
    description: "public session sharing runtime",
    pattern: /\b(?:share[-_ ]?next|session[-_ ]?share|public[-_ ]?share|share[-_ ]?public)\b|\bpublicly\s+share\b/i,
  }),
  Object.freeze({
    id: "public-listen-default",
    description: "default public 0.0.0.0 listener",
    pattern: /\b(?:host(?:name)?|listen)\s*[:=]\s*["'`]0\.0\.0\.0["'`]|--(?:host|hostname)\s+0\.0\.0\.0/i,
  }),
  Object.freeze({
    id: "mdns-default",
    description: "default-enabled mDNS discovery",
    pattern: /\bmdns\b\s*[:=]\s*(?:true|["'`]enabled["'`])|--mdns(?:\s|$)/i,
  }),
  Object.freeze({
    id: "generated-js-ts-tools",
    description: "generated JavaScript or TypeScript tool execution",
    pattern: /\b(?:generated?|custom)\s+(?:JavaScript|TypeScript|JS|TS)\s+tools?\b|\btools?\s+(?:are\s+)?defined\s+as\s+(?:TypeScript|JavaScript)\b/i,
  }),
  Object.freeze({
    id: "clone-upstream",
    description: "cloning an upstream or dependency repository",
    pattern: /\bclone\s+(?:an?\s+)?(?:upstream|dependency)\s+(?:repository|repo)\b|\bgit\s+clone\s+https?:\/\//i,
  }),
])

const normalized = (value) => value.split(path.sep).join("/")
const isLicenseFile = (relativePath) => /(?:^|\/)(?:licen[cs]e|notice|copying)(?:[._-]|$)/i.test(normalized(relativePath))

export function classifySurface(source, relativePath = "surface.txt") {
  return SURFACE_RULES.filter((rule) => {
    if (rule.ignoreLicenseFile && isLicenseFile(relativePath)) return false
    rule.pattern.lastIndex = 0
    return rule.pattern.test(source)
  }).map((rule) => rule.id)
}

export function evaluateReleaseSelection(packageNames, quarantine = QUARANTINE_MANIFEST) {
  const quarantined = new Map(quarantine.map((entry) => [entry.packageName, entry]))
  return packageNames.flatMap((packageName) => {
    const entry = quarantined.get(packageName)
    return entry
      ? [{
          packageName,
          ruleId: "quarantined-package-release",
          detail: `${entry.packageName} is ${entry.status}: ${entry.reason}`,
        }]
      : []
  })
}

function packageDirectories(root) {
  const packagesRoot = path.join(root, "packages")
  if (!existsSync(packagesRoot)) return []
  return readdirSync(packagesRoot)
    .map((name) => path.join(packagesRoot, name))
    .filter((directory) => statSync(directory).isDirectory() && existsSync(path.join(directory, "package.json")))
}

function walkTextFiles(directory, files = []) {
  for (const name of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(name)) continue
    const full = path.join(directory, name)
    const entry = statSync(full)
    if (entry.isDirectory()) walkTextFiles(full, files)
    else if (TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())) files.push(full)
  }
  return files
}

function validateQuarantine(root, quarantine) {
  const failures = []
  if (quarantine.length !== 0) failures.push({ ruleId: "quarantine-scope", detail: "release must contain no quarantined package" })
  return failures
}

function dependencyGroups(manifest) {
  return [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies]
    .filter(Boolean)
}

export function runGate({ root = process.cwd(), releasePackages = [] } = {}) {
  const failures = validateQuarantine(root, QUARANTINE_MANIFEST)
  const quarantinedPaths = new Set(QUARANTINE_MANIFEST.map((entry) => normalized(entry.packagePath)))
  const quarantinedNames = new Set(QUARANTINE_MANIFEST.map((entry) => entry.packageName))
  const scannedFiles = []

  for (const directory of packageDirectories(root)) {
    const relativeDirectory = normalized(path.relative(root, directory))
    const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"))

    if (!quarantinedNames.has(manifest.name)) {
      for (const group of dependencyGroups(manifest)) {
        for (const dependency of Object.keys(group)) {
          if (quarantinedNames.has(dependency)) {
            failures.push({
              ruleId: "quarantine-dependency",
              file: normalized(path.relative(root, path.join(directory, "package.json"))),
              detail: `${manifest.name} depends on release-blocked ${dependency}`,
            })
          }
        }
      }
    }

    if (quarantinedPaths.has(relativeDirectory)) continue
    for (const file of walkTextFiles(directory)) {
      const relativeFile = normalized(path.relative(root, file))
      scannedFiles.push(relativeFile)
      const source = readFileSync(file, "utf8")
      for (const ruleId of classifySurface(source, relativeFile)) {
        failures.push({ ruleId, file: relativeFile, detail: "forbidden inherited surface in a shippable package" })
      }
    }
  }

  failures.push(...evaluateReleaseSelection(releasePackages))
  return { failures, scannedFiles, quarantine: QUARANTINE_MANIFEST }
}

function parseReleasePackages(argv) {
  const packages = []
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === "--release-package") {
      if (argv[index + 1]) packages.push(argv[++index])
    } else if (value.startsWith("--release-package=")) {
      packages.push(value.slice("--release-package=".length))
    }
  }
  return packages
}

function main() {
  const releasePackages = parseReleasePackages(process.argv.slice(2))
  const result = runGate({ releasePackages })

  for (const entry of result.quarantine) {
    console.log(`QUARANTINE ${entry.packageName} — ${entry.status}; ${entry.reason}`)
  }

  if (result.failures.length === 0) {
    console.log(`PASS provenance surface gate — ${result.scannedFiles.length} non-quarantined files scanned`)
    return
  }

  for (const failure of result.failures) {
    const location = failure.file ? ` (${failure.file})` : ""
    console.error(`FAIL ${failure.ruleId}${location} — ${failure.detail}`)
  }
  process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main()
