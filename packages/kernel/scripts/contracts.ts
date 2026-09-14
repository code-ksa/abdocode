import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"

export const KERNEL_PACKAGE_DIR = join(import.meta.dir, "..")
export const KERNEL_CARGO_MANIFEST_PATH = join(KERNEL_PACKAGE_DIR, "Cargo.toml")
export const RUST_VERSION = "1.94.1"
export const RUST_HOST = trustedRustHost()
export const RUST_TOOLCHAIN = `${RUST_VERSION}-${RUST_HOST}`
export const RUSTC_VERSION_IDENTITY = "rustc 1.94.1 (e408947bf 2026-03-25)"
export const CARGO_VERSION_IDENTITY = "cargo 1.94.1 (29ea6fb6a 2026-03-24)"
const CARGO_ENVIRONMENT_ALLOWLIST = new Set([
  "COMSPEC",
  "HOME",
  "NUMBER_OF_PROCESSORS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
])
const PREPARED_CONTEXT_PREFIX = "abdo-cargo-"
const PREPARED_CONTEXT_MARKER = "prepared-context.json"
const PREPARED_CONTEXT_ROOT_ENV = "ABDO_PREPARED_CARGO_ROOT"
const PREPARED_CONTEXT_TOKEN_ENV = "ABDO_PREPARED_CARGO_TOKEN"
const preparedContextTokens = new WeakMap<PreparedCargoContext, string>()
let inheritedPreparedContext: PreparedCargoContext | undefined

export function cargoCommand(command: string, ...args: string[]) {
  const toolchain = trustedRustToolchainIdentity()
  return [toolchain.rustupExecutable, "run", RUST_TOOLCHAIN, "cargo", command, ...args]
}

export function cargoWorkspaceCommand(command: string, ...args: string[]) {
  return cargoCommand(command, "--manifest-path", KERNEL_CARGO_MANIFEST_PATH, ...args)
}

export function sanitizedCargoEnvironment(source: Readonly<Record<string, string | undefined>> = process.env) {
  const environment: Record<string, string> = { CARGO_NET_OFFLINE: "true" }
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && CARGO_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())) environment[name] = value
  }
  environment.RUSTUP_HOME = trustedRustToolchainIdentity().rustupHome
  return environment
}

export interface TrustedRustToolchainIdentity {
  readonly rustupExecutable: string
  readonly rustupHome: string
  readonly host: string
}

export function trustedRustToolchainIdentity(): TrustedRustToolchainIdentity {
  const requestedUserHome = resolve(userInfo().homedir)
  const canonicalUserHome = canonicalDirectory(requestedUserHome, "OS user home")
  const canonicalCargoBin = canonicalDirectory(join(canonicalUserHome, ".cargo", "bin"), "Rustup binary directory")
  const rustupName = process.platform === "win32" ? "rustup.exe" : "rustup"
  const requestedRustup = join(canonicalCargoBin, rustupName)
  const requestedIdentity = lstatSync(requestedRustup)
  if (!requestedIdentity.isFile() || requestedIdentity.isSymbolicLink()) {
    throw new Error("Rustup executable must be a regular non-symlink file")
  }
  const rustupExecutable = realpathSync(requestedRustup)
  const executableIdentity = lstatSync(rustupExecutable)
  if (
    !executableIdentity.isFile() ||
    executableIdentity.isSymbolicLink() ||
    basename(rustupExecutable).toLowerCase() !== rustupName ||
    !sameCanonicalPath(dirname(rustupExecutable), canonicalCargoBin)
  ) {
    throw new Error("canonical Rustup executable escaped the OS user's Cargo bin")
  }
  const rustupHome = canonicalDirectory(join(canonicalUserHome, ".rustup"), "Rustup home")
  return Object.freeze({ rustupExecutable, rustupHome, host: RUST_HOST })
}

function trustedRustHost() {
  const identity = `${process.platform}:${process.arch}`
  const hosts: Readonly<Record<string, string>> = {
    "darwin:arm64": "aarch64-apple-darwin",
    "darwin:x64": "x86_64-apple-darwin",
    "linux:arm64": "aarch64-unknown-linux-gnu",
    "linux:x64": "x86_64-unknown-linux-gnu",
    "win32:x64": "x86_64-pc-windows-msvc",
  }
  const host = hosts[identity]
  if (host === undefined) throw new Error(`unsupported pinned Rust host: ${identity}`)
  return host
}

function canonicalDirectory(path: string, name: string) {
  const requestedIdentity = lstatSync(path)
  if (!requestedIdentity.isDirectory() || requestedIdentity.isSymbolicLink()) {
    throw new Error(`${name} must be a real non-symlink directory`)
  }
  const canonical = realpathSync(path)
  if (!sameCanonicalPath(path, canonical) || lstatSync(canonical).isSymbolicLink()) {
    throw new Error(`${name} must already be canonical`)
  }
  return canonical
}

function sameCanonicalPath(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

export function validateRustToolchainPreflight(rustcOutput: string, cargoOutput: string) {
  const rustcLines = rustcOutput.replaceAll("\r\n", "\n").trim().split("\n")
  const entries: Array<readonly [string, string]> = rustcLines.slice(1).map((line) => {
    const separator = line.indexOf(": ")
    if (separator === -1) return [line, ""] as const
    return [line.slice(0, separator), line.slice(separator + 2)] as const
  })
  const fields = new Map(entries)
  if (
    rustcLines[0] !== RUSTC_VERSION_IDENTITY ||
    JSON.stringify(entries.map(([name]) => name)) !==
      JSON.stringify(["binary", "commit-hash", "commit-date", "host", "release", "LLVM version"]) ||
    fields.get("binary") !== "rustc" ||
    !/^e408947bf[0-9a-f]{31}$/.test(fields.get("commit-hash") ?? "") ||
    fields.get("commit-date") !== "2026-03-25" ||
    fields.get("release") !== RUST_VERSION ||
    fields.get("host") !== RUST_HOST ||
    !/^\d+\.\d+\.\d+$/.test(fields.get("LLVM version") ?? "")
  ) {
    throw new Error("pinned rustc release or host identity drifted")
  }
  if (cargoOutput.trim() !== CARGO_VERSION_IDENTITY) {
    throw new Error("pinned Cargo identity drifted")
  }
  return { rustc: RUSTC_VERSION_IDENTITY, cargo: CARGO_VERSION_IDENTITY, host: RUST_HOST }
}

export function trustedBunExecutable() {
  const requestedPath = resolve(process.execPath)
  const requestedIdentity = lstatSync(requestedPath)
  if (!requestedIdentity.isFile() || requestedIdentity.isSymbolicLink()) {
    throw new Error("Bun executable must be a regular non-symlink file")
  }
  const executablePath = realpathSync(requestedPath)
  const executableIdentity = lstatSync(executablePath)
  if (!executableIdentity.isFile() || executableIdentity.isSymbolicLink()) {
    throw new Error("canonical Bun executable must be a regular non-symlink file")
  }
  if (!/^bun(?:\.exe)?$/i.test(basename(executablePath))) {
    throw new Error(`unexpected Bun executable basename: ${basename(executablePath)}`)
  }
  return executablePath
}

export interface PreparedCargoContext {
  readonly root: string
  readonly cwd: string
  readonly cargoHome: string
  readonly targetDirectory: string
  readonly markerPath: string
  readonly environment: Readonly<Record<string, string>>
}

export interface PreparedCargoLease {
  readonly context: PreparedCargoContext
  dispose(): void
}

interface PreparedCargoMarker {
  readonly version: 1
  readonly token: string
  readonly ownerPid: number
  readonly root: string
  readonly cwd: string
  readonly cargoHome: string
  readonly targetDirectory: string
  readonly markerPath: string
  readonly cargoLockSha256: string
  readonly fetchCount: 1
  readonly networkState: "offline"
}

export function prepareCargoContext(): PreparedCargoLease {
  const temporaryParent = realpathSync(tmpdir())
  const root = realpathSync(mkdtempSync(join(temporaryParent, PREPARED_CONTEXT_PREFIX)))
  try {
  const cwd = join(root, "work")
  const cargoHome = join(root, "cargo-home")
  const targetDirectory = join(root, "target")
  const markerPath = join(root, PREPARED_CONTEXT_MARKER)
  mkdirSync(cwd)
  mkdirSync(cargoHome)
  mkdirSync(targetDirectory)
  const canonicalContext = { root, cwd, cargoHome, targetDirectory, markerPath }
  assertCanonicalPreparedPaths(canonicalContext, false)
  if (readdirSync(cargoHome).length !== 0) throw new Error("fresh Cargo home was not empty before fetch")
  const toolchainEnvironment = sanitizedCargoEnvironment()
  toolchainEnvironment.CARGO_HOME = cargoHome
  toolchainEnvironment.CARGO_TARGET_DIR = targetDirectory
  assertTrustedRustToolchainPreflight(cwd, toolchainEnvironment)
  if (readdirSync(cargoHome).length !== 0) {
    throw new Error("pinned Rust toolchain preflight wrote to the fresh Cargo home")
  }
  const cargoLockBeforeFetch = cargoLockSha256()

  const fetchEnvironment = { ...toolchainEnvironment }
  delete fetchEnvironment.CARGO_NET_OFFLINE
  const cargoFetchResult = Bun.spawnSync(cargoWorkspaceCommand("fetch", "--locked"), {
    cwd,
    env: fetchEnvironment,
    stdout: "inherit",
    stderr: "inherit",
    timeout: 120_000,
  })
  if (cargoFetchResult.exitCode !== 0) {
    rmSync(root, { recursive: true, force: true })
    throw new Error(`fresh Cargo fetch failed (${cargoFetchResult.exitCode})`)
  }
  const cargoLockAfterFetch = cargoLockSha256()
  if (cargoLockAfterFetch !== cargoLockBeforeFetch) {
    rmSync(root, { recursive: true, force: true })
    throw new Error("Cargo.lock changed during the locked fetch")
  }
  assertFetchedCargoHome(cargoHome)

  const token = randomToken()
  const marker: PreparedCargoMarker = {
    version: 1,
    token,
    ownerPid: process.pid,
    ...canonicalContext,
    cargoLockSha256: cargoLockBeforeFetch,
    fetchCount: 1,
    networkState: "offline",
  }
  writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { encoding: "utf8", flag: "wx" })
  const environment = Object.freeze({
    ...sanitizedCargoEnvironment(),
    CARGO_HOME: cargoHome,
    CARGO_TARGET_DIR: targetDirectory,
  })
  const context = Object.freeze({ ...canonicalContext, environment })
  preparedContextTokens.set(context, token)
  assertPreparedCargoContext(context)
  let disposed = false
  return {
    context,
    dispose() {
      if (disposed) return
      disposed = true
      preparedContextTokens.delete(context)
      rmSync(root, { recursive: true, force: true })
    },
  }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

export function preparedCargoChildEnvironment(context: PreparedCargoContext) {
  assertPreparedCargoContext(context)
  return {
    ...context.environment,
    [PREPARED_CONTEXT_ROOT_ENV]: context.root,
    [PREPARED_CONTEXT_TOKEN_ENV]: preparedContextTokens.get(context)!,
  }
}

export function assertPreparedCargoContext(context: PreparedCargoContext) {
  const token = preparedContextTokens.get(context)
  if (token === undefined) throw new Error("Cargo context was not issued by the prepared-context factory")
  assertCanonicalPreparedPaths(context)
  const marker = parsePreparedMarker(context.markerPath)
  assertPreparedCargoMarker(context, marker, token, [process.pid, process.ppid])
  if (context.environment.CARGO_NET_OFFLINE !== "true") {
    throw new Error("prepared Cargo context must remain offline after fetch")
  }
  if (context.environment.RUSTUP_HOME !== trustedRustToolchainIdentity().rustupHome) {
    throw new Error("prepared Cargo context must use the canonical Rustup home")
  }
  if (
    context.environment.CARGO_HOME !== context.cargoHome ||
    context.environment.CARGO_TARGET_DIR !== context.targetDirectory
  ) {
    throw new Error("prepared Cargo environment escaped its canonical cache or target directory")
  }
}

export function validatePreparedCargoDescriptor(
  context: Omit<PreparedCargoContext, "environment">,
  markerValue: unknown,
  expectedToken: string,
  expectedCargoLockSha256: string,
  allowedOwnerPids: readonly number[],
) {
  const marker = requirePreparedMarker(markerValue)
  if (!validToken(expectedToken) || marker.token !== expectedToken) {
    throw new Error("prepared Cargo marker token mismatch")
  }
  if (!allowedOwnerPids.includes(marker.ownerPid)) throw new Error("prepared Cargo marker owner mismatch")
  const exactIdentity = {
    version: 1,
    token: expectedToken,
    ownerPid: marker.ownerPid,
    root: context.root,
    cwd: context.cwd,
    cargoHome: context.cargoHome,
    targetDirectory: context.targetDirectory,
    markerPath: context.markerPath,
    cargoLockSha256: expectedCargoLockSha256,
    fetchCount: 1,
    networkState: "offline",
  }
  if (JSON.stringify(marker) !== JSON.stringify(exactIdentity)) {
    throw new Error("prepared Cargo marker identity drifted")
  }
  assertDirectChildPath(context.root, context.cwd, "working directory")
  assertDirectChildPath(context.root, context.cargoHome, "Cargo home")
  assertDirectChildPath(context.root, context.targetDirectory, "target directory")
  assertDirectChildPath(context.root, context.markerPath, "marker")
  return marker
}

export type IsolatedCargoContext = PreparedCargoContext

export function withIsolatedCargo<T>(
  operation: (context: IsolatedCargoContext) => T,
  preparedContext?: PreparedCargoContext,
): T {
  const lease = acquireCargoContext(preparedContext)
  try {
    return operation(lease.context)
  } finally {
    lease.dispose()
  }
}

/**
 * Asynchronous sibling of `withIsolatedCargo`.
 *
 * The synchronous form disposes the lease as soon as `operation` returns, which
 * releases the prepared context while a pending promise still needs it. Any
 * caller that awaits a child process must use this form.
 */
export async function withIsolatedCargoAsync<T>(
  operation: (context: IsolatedCargoContext) => Promise<T>,
  preparedContext?: PreparedCargoContext,
): Promise<T> {
  const lease = acquireCargoContext(preparedContext)
  try {
    return await operation(lease.context)
  } finally {
    lease.dispose()
  }
}

function assertTrustedRustToolchainPreflight(cwd: string, environment: Readonly<Record<string, string>>) {
  const toolchain = trustedRustToolchainIdentity()
  if (environment.RUSTUP_HOME !== toolchain.rustupHome) {
    throw new Error("Rust toolchain preflight received a non-canonical RUSTUP_HOME")
  }
  const rustc = runRustToolchainIdentityCommand(
    [toolchain.rustupExecutable, "run", RUST_TOOLCHAIN, "rustc", "-Vv"],
    cwd,
    environment,
  )
  const cargo = runRustToolchainIdentityCommand(
    [toolchain.rustupExecutable, "run", RUST_TOOLCHAIN, "cargo", "-V"],
    cwd,
    environment,
  )
  validateRustToolchainPreflight(rustc, cargo)
}

function runRustToolchainIdentityCommand(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
) {
  const result = Bun.spawnSync([...command], {
    cwd,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  })
  const stderr = new TextDecoder("utf-8", { fatal: true }).decode(result.stderr).trim()
  if (result.exitCode !== 0 || stderr !== "") {
    throw new Error(`pinned Rust toolchain identity command failed (${result.exitCode})`)
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)
}

function acquireCargoContext(preparedContext?: PreparedCargoContext): PreparedCargoLease {
  if (preparedContext !== undefined) {
    assertPreparedCargoContext(preparedContext)
    return { context: preparedContext, dispose() {} }
  }
  const inherited = preparedCargoContextFromEnvironment()
  if (inherited !== undefined) return { context: inherited, dispose() {} }
  return prepareCargoContext()
}

function preparedCargoContextFromEnvironment() {
  if (inheritedPreparedContext !== undefined) {
    assertPreparedCargoContext(inheritedPreparedContext)
    return inheritedPreparedContext
  }
  const rootValue = process.env[PREPARED_CONTEXT_ROOT_ENV]
  const token = process.env[PREPARED_CONTEXT_TOKEN_ENV]
  if (rootValue === undefined && token === undefined) return undefined
  if (rootValue === undefined || token === undefined) throw new Error("partial prepared Cargo context environment")
  const root = realpathSync(rootValue)
  const context = Object.freeze({
    root,
    cwd: join(root, "work"),
    cargoHome: join(root, "cargo-home"),
    targetDirectory: join(root, "target"),
    markerPath: join(root, PREPARED_CONTEXT_MARKER),
    environment: Object.freeze({
      ...sanitizedCargoEnvironment(),
      CARGO_HOME: join(root, "cargo-home"),
      CARGO_TARGET_DIR: join(root, "target"),
    }),
  })
  assertCanonicalPreparedPaths(context)
  const marker = parsePreparedMarker(context.markerPath)
  assertPreparedCargoMarker(context, marker, token, [process.ppid])
  preparedContextTokens.set(context, token)
  inheritedPreparedContext = context
  return context
}

function assertPreparedCargoMarker(
  context: Omit<PreparedCargoContext, "environment">,
  marker: unknown,
  token: string,
  allowedOwnerPids: readonly number[],
) {
  validatePreparedCargoDescriptor(context, marker, token, cargoLockSha256(), allowedOwnerPids)
}

function assertCanonicalPreparedPaths(
  context: Omit<PreparedCargoContext, "environment">,
  markerMustExist = true,
) {
  const temporaryParent = realpathSync(tmpdir())
  if (dirname(context.root) !== temporaryParent || !basename(context.root).startsWith(PREPARED_CONTEXT_PREFIX)) {
    throw new Error("prepared Cargo root must be a direct OS-temporary child")
  }
  assertCargoConfigFreeAncestors(context.cwd)
  for (const [name, path] of [
    ["root", context.root],
    ["working directory", context.cwd],
    ["Cargo home", context.cargoHome],
    ["target directory", context.targetDirectory],
  ] as const) {
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) {
      throw new Error(`prepared Cargo ${name} is not a canonical real directory`)
    }
  }
  if (markerMustExist && lstatSync(context.markerPath).isSymbolicLink()) {
    throw new Error("prepared Cargo marker may not be a symlink")
  }
  assertDirectChildPath(context.root, context.cwd, "working directory")
  assertDirectChildPath(context.root, context.cargoHome, "Cargo home")
  assertDirectChildPath(context.root, context.targetDirectory, "target directory")
  assertDirectChildPath(context.root, context.markerPath, "marker")
}

function assertDirectChildPath(root: string, child: string, name: string) {
  if (dirname(resolve(child)) !== resolve(root) || relative(root, child).startsWith("..")) {
    throw new Error(`prepared Cargo ${name} escapes its root`)
  }
}

function parsePreparedMarker(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error("prepared Cargo marker is missing or invalid", { cause: error })
  }
}

function requirePreparedMarker(value: unknown): PreparedCargoMarker {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("prepared Cargo marker must be an object")
  }
  return value as PreparedCargoMarker
}

function cargoLockSha256() {
  return new Bun.CryptoHasher("sha256").update(readFileSync(join(KERNEL_PACKAGE_DIR, "Cargo.lock"))).digest("hex")
}

function assertFetchedCargoHome(cargoHome: string) {
  const entries = readdirSync(cargoHome)
  if (entries.length === 0) throw new Error("fresh Cargo fetch produced an empty Cargo home")
  for (const forbidden of ["config", "config.toml", "credentials", "credentials.toml"]) {
    if (entries.some((entry) => entry.toLowerCase() === forbidden)) {
      throw new Error(`fresh Cargo home contains forbidden ${forbidden}`)
    }
  }
}

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function validToken(token: string) {
  return token.length === 64 && /^[0-9a-f]+$/.test(token)
}

function assertCargoConfigFreeAncestors(path: string) {
  let current = resolve(path)
  for (;;) {
    for (const name of ["config", "config.toml"]) {
      if (existsSync(join(current, ".cargo", name))) {
        throw new Error(`isolated Cargo working directory inherits ${join(current, ".cargo", name)}`)
      }
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

export const GENERATED_CONTRACTS_PATH = join(KERNEL_PACKAGE_DIR, "src", "generated", "contracts.ts")
export const CONTRACT_FIXTURE_DIR = join(KERNEL_PACKAGE_DIR, "crates", "abdo-contracts", "test", "fixtures")
export const CANCEL_COMMAND_FIXTURE_PATH = join(CONTRACT_FIXTURE_DIR, "cancel-command-v1.bin")
export const CANCEL_COMMAND_MANIFEST_PATH = join(CONTRACT_FIXTURE_DIR, "cancel-command-v1.json")

export interface GeneratedContractBundle {
  readonly contracts: Uint8Array
  readonly cancelCommandFixture: Uint8Array
  readonly cancelCommandManifest: Uint8Array
}

export async function generateContractBundle(
  preparedContext?: PreparedCargoContext,
): Promise<GeneratedContractBundle> {
  const cargoLease = acquireCargoContext(preparedContext)
  let temporaryDirectory: string | undefined
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "abdo-contracts-"))
    const temporaryContracts = join(temporaryDirectory, "contracts.ts")
    const temporaryFixtures = join(temporaryDirectory, "fixtures")
    runCodegen(["--out", temporaryContracts, temporaryFixtures], cargoLease.context)
    const bundle = {
      contracts: new Uint8Array(await readFile(temporaryContracts)),
      cancelCommandFixture: new Uint8Array(await readFile(join(temporaryFixtures, "cancel-command-v1.bin"))),
      cancelCommandManifest: new Uint8Array(await readFile(join(temporaryFixtures, "cancel-command-v1.json"))),
    }
    if (Object.values(bundle).some((bytes) => bytes.byteLength === 0)) {
      throw new Error("contract codegen emitted an empty bundle member")
    }
    return bundle
  } finally {
    if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true })
    cargoLease.dispose()
  }
}

export async function generateContractsBytes(preparedContext?: PreparedCargoContext) {
  return (await generateContractBundle(preparedContext)).contracts
}

export async function synchronizeGeneratedContracts(
  mode: "check" | "write",
  preparedContext?: PreparedCargoContext,
) {
  const cargoLease = acquireCargoContext(preparedContext)
  try {
    const generated = await generateContractBundle(cargoLease.context)
    const files = [
      { path: GENERATED_CONTRACTS_PATH, bytes: generated.contracts },
      { path: CANCEL_COMMAND_FIXTURE_PATH, bytes: generated.cancelCommandFixture },
      { path: CANCEL_COMMAND_MANIFEST_PATH, bytes: generated.cancelCommandManifest },
    ] as const

    if (mode === "write") {
      for (const file of files) {
        await mkdir(dirname(file.path), { recursive: true })
        await Bun.write(file.path, file.bytes)
      }
    } else {
      for (const file of files) {
        const current = await readCanonicalFile(file.path)
        if (!bytesEqual(current, file.bytes)) {
          throw new Error(`generated contract bundle member is stale: ${file.path}`)
        }
      }
    }

    runCodegen(["--check", GENERATED_CONTRACTS_PATH, CONTRACT_FIXTURE_DIR], cargoLease.context)
    return {
      mode,
      byteLength: generated.contracts.byteLength,
      fixtureByteLength: generated.cancelCommandFixture.byteLength,
      manifestByteLength: generated.cancelCommandManifest.byteLength,
    }
  } finally {
    cargoLease.dispose()
  }
}

function runCodegen(arguments_: readonly string[], preparedContext?: PreparedCargoContext) {
  const result = withIsolatedCargo(
    ({ cwd, environment }) =>
      Bun.spawnSync(
        cargoWorkspaceCommand(
          "run",
          "--locked",
          "--offline",
          "--quiet",
          "--package",
          "abdo-contracts",
          "--bin",
          "abdo-contracts-codegen",
          "--",
          ...arguments_,
        ),
        { cwd, env: environment, stdout: "pipe", stderr: "pipe" },
      ),
    preparedContext,
  )
  if (result.exitCode !== 0) {
    throw new Error(
      `contract codegen failed (${result.exitCode})\n${result.stderr.toString()}${result.stdout.toString()}`,
    )
  }
  if (result.stderr.byteLength !== 0 || result.stdout.byteLength !== 0) {
    throw new Error(
      `contract codegen bundle command wrote unexpected output\n${result.stderr.toString()}${result.stdout.toString()}`,
    )
  }
}

async function readCanonicalFile(path: string) {
  try {
    return new Uint8Array(await readFile(path))
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error("generated contract bundle is missing; run `bun run contracts:write` explicitly", {
        cause: error,
      })
    }
    throw error
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function requestedMode(arguments_: readonly string[]): "check" | "write" {
  if (arguments_.length === 1 && arguments_[0] === "--check") return "check"
  if (arguments_.length === 1 && arguments_[0] === "--write") return "write"
  throw new Error("usage: bun scripts/contracts.ts --check|--write")
}

if (import.meta.main) {
  const result = await synchronizeGeneratedContracts(requestedMode(process.argv.slice(2)))
  console.log(
    `contract codegen ${result.mode} passed: ${result.byteLength} TS bytes; ${result.fixtureByteLength} fixture bytes; ${result.manifestByteLength} manifest bytes`,
  )
}
