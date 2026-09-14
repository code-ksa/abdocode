import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const KERNEL = join(REPO, "packages", "kernel")
const problems = []

const requiredFiles = [
  "Cargo.toml",
  "schemas/kernel-boundary.json",
  "migrations/0001_initial.sql",
  "migrations/0002_effects.sql",
  "migrations/0003_leases_budgets.sql",
  "migrations/0004_compactions.sql",
  "tests/contract/suite.json",
  "tests/replay/suite.json",
  "tests/crash_injection/suite.json",
  "tests/hostile_inputs/suite.json",
  "tests/platform/suite.json",
  "fuzz/targets.json",
  "benches/targets.json",
  "bins/abdo-kernel/Cargo.toml",
  "bins/abdo-kernel/src/main.rs",
  "bins/abdo-tool-worker/Cargo.toml",
  "bins/abdo-tool-worker/src/main.rs",
  "bins/abdo-tool-worker/tests/worker_gate.rs",
]

const crateGraph = {
  "abdo-contracts": [],
  "abdo-kernel": ["abdo-contracts"],
  "abdo-journal": ["abdo-contracts"],
  "abdo-authority": ["abdo-contracts"],
  "abdo-policy": ["abdo-authority", "abdo-contracts"],
  "abdo-evidence": ["abdo-contracts"],
  "abdo-tools": ["abdo-authority", "abdo-contracts", "abdo-evidence", "abdo-policy"],
  "abdo-runtime": [
    "abdo-authority",
    "abdo-contracts",
    "abdo-evidence",
    "abdo-journal",
    "abdo-kernel",
    "abdo-policy",
    "abdo-tools",
  ],
}

for (const path of requiredFiles) {
  const absolute = join(KERNEL, path)
  if (!existsSync(absolute) || !statSync(absolute).isFile()) problems.push(`missing file: ${path}`)
}

const actualCrateDirs = readdirSync(join(KERNEL, "crates"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
const expectedCrateDirs = Object.keys(crateGraph).sort()
if (JSON.stringify(actualCrateDirs) !== JSON.stringify(expectedCrateDirs)) {
  problems.push(
    `Rust crate tree differs: expected ${expectedCrateDirs.join(", ")}; got ${actualCrateDirs.join(", ")}`,
  )
}

const metadataResult = spawnSync(
  "cargo",
  ["metadata", "--format-version", "1", "--no-deps"],
  { cwd: KERNEL, encoding: "utf8", shell: false },
)
if (metadataResult.status !== 0) {
  problems.push(`cargo metadata failed: ${metadataResult.stderr.trim()}`)
} else {
  const metadata = JSON.parse(metadataResult.stdout)
  const packages = new Map(metadata.packages.map((pkg) => [pkg.name, pkg]))
  const workspaceNames = new Set(metadata.packages.map((pkg) => pkg.name))

  for (const [name, expectedDependencies] of Object.entries(crateGraph)) {
    const pkg = packages.get(name)
    if (!pkg) {
      problems.push(`workspace package missing: ${name}`)
      continue
    }
    const actualDependencies = pkg.dependencies
      .map((dependency) => dependency.name)
      .filter((dependency) => workspaceNames.has(dependency))
      .sort()
    const expected = [...expectedDependencies].sort()
    if (JSON.stringify(actualDependencies) !== JSON.stringify(expected)) {
      problems.push(
        `${name} workspace dependencies differ: expected ${expected.join(", ") || "none"}; got ${actualDependencies.join(", ") || "none"}`,
      )
    }
  }

  const binaryGraph = {
    "abdo-kernel-bin": ["abdo-runtime"],
    "abdo-tool-worker": ["abdo-contracts", "abdo-runtime", "abdo-tools"],
  }
  for (const [name, expectedDependencies] of Object.entries(binaryGraph)) {
    const pkg = packages.get(name)
    if (!pkg) {
      problems.push(`binary package missing: ${name}`)
      continue
    }
    const actualDependencies = pkg.dependencies
      .map((dependency) => dependency.name)
      .filter((dependency) => workspaceNames.has(dependency))
      .sort()
    const expected = [...expectedDependencies].sort()
    if (JSON.stringify(actualDependencies) !== JSON.stringify(expected)) {
      problems.push(
        `${name} workspace dependencies differ: expected ${expected.join(", ")}; got ${actualDependencies.join(", ")}`,
      )
    }
  }

  for (const [packageName, targetName] of [
    ["abdo-kernel-bin", "abdo-kernel"],
    ["abdo-tool-worker", "abdo-tool-worker"],
  ]) {
    const pkg = packages.get(packageName)
    if (pkg && !pkg.targets.some((target) => target.name === targetName && target.kind.includes("bin"))) {
      problems.push(`binary target missing: ${targetName}`)
    }
  }
}

for (const manifestPath of [
  "schemas/kernel-boundary.json",
  "tests/contract/suite.json",
  "tests/replay/suite.json",
  "tests/crash_injection/suite.json",
  "tests/hostile_inputs/suite.json",
  "tests/platform/suite.json",
  "fuzz/targets.json",
  "benches/targets.json",
]) {
  if (!existsSync(join(KERNEL, manifestPath))) continue
  const manifest = JSON.parse(readFileSync(join(KERNEL, manifestPath), "utf8"))
  const targets = manifest.targets ?? [
    manifest.canonicalSource,
    manifest.wireImplementation,
    manifest.generatedTypeScript,
  ].filter(Boolean)
  if (!Array.isArray(targets) || targets.length === 0) {
    problems.push(`empty structural manifest: ${manifestPath}`)
    continue
  }
  for (const target of targets) {
    if (!existsSync(join(KERNEL, target))) {
      problems.push(`${manifestPath} points to missing target: ${target}`)
    }
  }
}

if (problems.length > 0) {
  console.error(`ORIGINAL_RUST_STRUCTURE_FAILED problems=${problems.length}`)
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}

console.log(
  `ORIGINAL_RUST_STRUCTURE_OK crates=${Object.keys(crateGraph).length}/8 bins=2/2 migrations=4/4 suites=5/5`,
)
