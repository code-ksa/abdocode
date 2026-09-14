import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const KERNEL = join(REPO, "packages", "kernel")
const manifestPath = join(REPO, "architecture", "original-rust-blueprint.json")
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))

if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.elements)) {
  console.error("ORIGINAL_BLUEPRINT_INVALID schema")
  process.exit(1)
}

const unique = new Set(manifest.elements.map((element) => element.path))
const directories = manifest.elements.filter((element) => element.kind === "directory")
const files = manifest.elements.filter((element) => element.kind === "file")
const missing = []
const wrongKind = []
const invalidFacades = []
const canonicalCoverage = new Map()
for (const element of manifest.elements) {
  const target = join(KERNEL, ...element.path.split("/"))
  if (!existsSync(target)) {
    missing.push(element)
    continue
  }
  const actual = statSync(target)
  if ((element.kind === "file" && !actual.isFile()) || (element.kind === "directory" && !actual.isDirectory())) {
    wrongKind.push(element)
    continue
  }
  if (element.kind === "file" && element.path.endsWith(".rs")) {
    const source = readFileSync(target, "utf8")
    if (source.startsWith("//! BLUEPRINT_FACADE_V1")) {
      const canonical = /^\/\/! BLUEPRINT_FACADE_V1 canonical=([^\r\n]+)$/m.exec(source)?.[1]
      const crate = element.path.split("/")[1]
      const registry = join(KERNEL, "crates", crate, "src", "blueprint_facades.rs")
      const library = join(KERNEL, "crates", crate, "src", "lib.rs")
      const facadeRelative = element.path.split("/src/")[1]
      const canonicalTarget = canonical ? join(KERNEL, ...canonical.split("/")) : ""
      const canonicalSource = canonicalTarget && existsSync(canonicalTarget) ? readFileSync(canonicalTarget, "utf8") : ""
      if (!canonical || !canonical.startsWith(`crates/${crate}/src/`) || !canonicalSource || canonicalSource.startsWith("//! BLUEPRINT_FACADE_V1") || !existsSync(registry) || !facadeRelative || !readFileSync(registry, "utf8").includes(facadeRelative) || !readFileSync(library, "utf8").includes("pub mod blueprint_facades;")) {
        invalidFacades.push(element)
      } else {
        const covered = canonicalCoverage.get(crate) ?? new Set()
        covered.add(canonical)
        canonicalCoverage.set(crate, covered)
      }
    }
  }
}

const headerValid =
  manifest.elementCount === 327 &&
  manifest.directoryCount === 122 &&
  manifest.fileCount === 205 &&
  unique.size === manifest.elements.length &&
  directories.length === manifest.directoryCount &&
  files.length === manifest.fileCount

// Minima follow the capability families that actually occur as facades in the
// owner tree (not every real source in a crate). Falling back to one source per
// crate therefore fails, while small crates are not punished for honest scope.
const coverageMinimum = { "abdo-contracts": 4, "abdo-kernel": 3, "abdo-journal": 2, "abdo-authority": 2, "abdo-policy": 1, "abdo-runtime": 7, "abdo-tools": 3, "abdo-evidence": 1 }
const weakCoverage = Object.entries(coverageMinimum).filter(([crate, minimum]) => (canonicalCoverage.get(crate)?.size ?? 0) < minimum)

if (!headerValid || missing.length > 0 || wrongKind.length > 0 || invalidFacades.length > 0 || weakCoverage.length > 0) {
  console.error(
    `ORIGINAL_BLUEPRINT_NOT_READY present=${manifest.elements.length - missing.length - wrongKind.length}/${manifest.elements.length} missing=${missing.length} wrongKind=${wrongKind.length} invalidFacades=${invalidFacades.length}`,
  )
  if (!headerValid) console.error("- manifest cardinality or uniqueness differs from the owner-supplied tree")
  for (const [crate, minimum] of weakCoverage) console.error(`- ${crate}: capability routing ${(canonicalCoverage.get(crate)?.size ?? 0)}/${minimum}`)
  for (const element of [...missing, ...wrongKind, ...invalidFacades].slice(0, 40)) {
    console.error(`- ${element.kind}: ${element.path}`)
  }
  if (missing.length + wrongKind.length > 40) {
    console.error(`- ... ${missing.length + wrongKind.length - 40} more; inspect architecture/original-rust-blueprint.json`)
  }
  process.exit(1)
}

console.log(`ORIGINAL_BLUEPRINT_READY elements=327/327 directories=122/122 files=205/205 facades=${manifest.elements.filter((element) => element.kind === "file" && element.path.endsWith(".rs") && readFileSync(join(KERNEL, ...element.path.split("/")), "utf8").startsWith("//! BLUEPRINT_FACADE_V1")).length} canonicalCapabilities=${[...canonicalCoverage.values()].reduce((sum, values) => sum + values.size, 0)}`)
