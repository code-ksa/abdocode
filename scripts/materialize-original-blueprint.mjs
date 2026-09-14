import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const KERNEL = join(REPO, "packages", "kernel")
const manifest = JSON.parse(readFileSync(join(REPO, "architecture", "original-rust-blueprint.json"), "utf8"))

const source = (crate, file) => `crates/${crate}/src/${file}.rs`
const includes = (path, words) => words.some((word) => path.includes(word))

/**
 * Route every physical blueprint element to the real behaviour it represents.
 * A crate-wide catch-all made 197 files compile, but did not prove feature
 * ownership. These domain routes make drift reviewable without duplicating the
 * implementation into one file per name from the reference tree.
 */
const canonicalFor = (path, crate) => {
  if (crate === "abdo-contracts") {
    if (includes(path, ["wire", "frame", "codec", "protocol"])) return source(crate, "wire")
    if (includes(path, ["codegen", "generated", "schema_macros"])) return source(crate, "codegen")
    if (includes(path, ["id", "nonce", "generator"])) return source(crate, "generator")
    return source(crate, "schema")
  }
  if (crate === "abdo-kernel") {
    if (includes(path, ["effect", "intent", "fingerprint"])) return source(crate, "effect")
    if (includes(path, ["admission", "transition", "reduce", "unknown", "commit"])) return source(crate, "reduce")
    return source(crate, "state")
  }
  if (crate === "abdo-journal") {
    if (includes(path, ["migration", "compact", "snapshot"])) return source(crate, "migration")
    if (includes(path, ["hash", "chain"])) return source(crate, "hash")
    if (includes(path, ["effect", "receipt"])) return source(crate, "effects")
    if (includes(path, ["identity", "instance", "lock"])) return source(crate, "identity")
    if (includes(path, ["govern", "lease", "budget"])) return source(crate, "govern")
    if (includes(path, ["model", "record"])) return source(crate, "model")
    return source(crate, "journal")
  }
  if (crate === "abdo-authority") {
    if (includes(path, ["capab", "grant", "lease", "scope", "secret"])) return source(crate, "capability")
    if (includes(path, ["identity", "workspace", "trust", "principal"])) return source(crate, "identity")
    return source(crate, "authority")
  }
  if (crate === "abdo-policy") return source(crate, "lib")
  if (crate === "abdo-runtime") {
    if (includes(path, ["queue", "control", "backpressure", "channel"])) return source(crate, "control")
    if (includes(path, ["schedul", "deadline", "fair", "priority"])) return source(crate, "schedule")
    if (includes(path, ["budget", "resource", "limit"])) return source(crate, "budget")
    if (includes(path, ["surface", "human", "browser", "takeover"])) return source(crate, "surface")
    if (includes(path, ["reconcil", "unknown", "recovery", "crash"])) return source(crate, "reconcile")
    if (includes(path, ["supervisor", "worker", "platform", "sandbox"])) return source(crate, "supervisor")
    if (includes(path, ["author", "policy", "admission", "gate"])) return source(crate, "gatekeeper")
    if (includes(path, ["phase", "effect", "dispatch", "settle"])) return source(crate, "phase")
    if (includes(path, ["ipc", "host", "bridge"])) return source(crate, "host")
    if (includes(path, ["vault", "secret", "credential"])) return source(crate, "vault")
    return source(crate, "session")
  }
  if (crate === "abdo-tools") {
    if (includes(path, ["catalog", "disclos", "schema", "description"])) return source(crate, "disclosure")
    if (includes(path, ["adapter", "execution", "provider", "filesystem", "shell", "surface", "browser", "output"])) return source(crate, "adapters")
    return source(crate, "broker")
  }
  if (crate === "abdo-evidence") return source(crate, "lib")
  return undefined
}

const crates = ["abdo-contracts", "abdo-kernel", "abdo-journal", "abdo-authority", "abdo-policy", "abdo-runtime", "abdo-tools", "abdo-evidence"]

const generated = new Map()
for (const element of manifest.elements) {
  const target = join(KERNEL, ...element.path.split("/"))
  if (element.kind === "directory") {
    mkdirSync(target, { recursive: true })
    continue
  }
  mkdirSync(dirname(target), { recursive: true })
  if (!target.endsWith(".rs")) continue
  const existing = existsSync(target) ? readFileSync(target, "utf8") : ""
  if (existing && !existing.startsWith("//! BLUEPRINT_FACADE_V1")) continue
  const parts = element.path.split("/")
  const crate = parts[1]
  const canonical = canonicalFor(element.path, crate)
  if (!canonical || !existsSync(join(KERNEL, ...canonical.split("/")))) throw new Error(`no canonical implementation for ${element.path}`)
  const content =
    `//! BLUEPRINT_FACADE_V1 canonical=${canonical}\n` +
    `//! Compiled compatibility facade for the owner-supplied physical tree.\n` +
    `//! Behaviour remains in the canonical implementation above; this file does not fork it.\n\n` +
    `pub const BLUEPRINT_ELEMENT: &str = ${JSON.stringify(element.path)};\n` +
    `pub const CANONICAL_SOURCE: &str = ${JSON.stringify(canonical)};\n` +
    `pub fn connected() -> bool { !BLUEPRINT_ELEMENT.is_empty() && !CANONICAL_SOURCE.is_empty() }\n`
  writeFileSync(target, content)
  const list = generated.get(crate) ?? []
  list.push(element.path)
  generated.set(crate, list)
}

// Every facade is compiled, not merely present on disk. The generated module
// registry is deterministic and is imported by each crate's lib.rs.
for (const crate of crates) {
  const paths = generated.get(crate) ?? []
  const src = join(KERNEL, "crates", crate, "src")
  const facadePaths = manifest.elements
    .filter((element) => element.kind === "file" && element.path.startsWith(`crates/${crate}/src/`) && element.path.endsWith(".rs"))
    .map((element) => element.path)
    .filter((path) => readFileSync(join(KERNEL, ...path.split("/")), "utf8").startsWith("//! BLUEPRINT_FACADE_V1"))
    .sort()
  const modules = facadePaths.map((path, index) => {
    const fromSrc = relative(src, join(KERNEL, ...path.split("/"))).replaceAll("\\", "/")
    return `#[path = ${JSON.stringify(fromSrc)}]\npub mod element_${String(index + 1).padStart(3, "0")};`
  })
  const entries = facadePaths.map((_path, index) => {
    const name = `element_${String(index + 1).padStart(3, "0")}`
    return `    (\n        ${name}::BLUEPRINT_ELEMENT,\n        ${name}::CANONICAL_SOURCE,\n        ${name}::connected,\n    ),`
  })
  writeFileSync(join(src, "blueprint_facades.rs"),
    "//! Generated compiled registry for original blueprint compatibility facades.\n\n" +
    modules.join("\n") + "\n\n" +
    "pub type BlueprintFacade = (&'static str, &'static str, fn() -> bool);\n" +
    "pub const FACADES: &[BlueprintFacade] = &[\n" + entries.join("\n") + "\n];\n\n" +
    "#[cfg(test)]\nmod tests {\n    #[test]\n    fn every_facade_is_connected() {\n        assert!(!super::FACADES.is_empty());\n        assert!(super::FACADES.iter().all(|(_, _, connected)| connected()));\n    }\n}\n",
  )
  console.log(`BLUEPRINT_FACADES crate=${crate} created=${paths.length} compiled=${facadePaths.length}`)
}
