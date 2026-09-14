import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, relative, sep } from "node:path"
import {
  INHERIT_PROFILE,
  UNMEASURED_CAPABILITY,
  launchControlledProcess,
  policy,
  type ControlledExecutionGrant,
  type ToolContext,
  type ToolDefinition,
  type ToolRegistry,
  type ToolResult,
} from "@abdo/tools"
import { resolveInWorkspace } from "./workspace"
import { stripChildEnv } from "@abdo/tools/env-strip"

const OUTPUT_BYTES = 64 * 1024
const NETWORK_BYTES = 512 * 1024
const NETWORK_TEXT = 4_000
const NETWORK_TIMEOUT_MS = 15_000
const DNS_TIMEOUT_MS = 4_000
const MAX_REDIRECTS = 3
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex")

const object = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
const string = (input: unknown, key: string): string | undefined => {
  const value = object(input)[key]
  return typeof value === "string" ? value : undefined
}

function childEnvironment(ctx: ToolContext): Record<string, string> {
  // نزعُ الاعتمادات كما في `run_command`. هذا الموضعُ يخدم `git_read` و
  // `git_change` و`package_install` و`network_fetch` — وكلُّها تُطلق برامجَ
  // خارجيّة: `git` ينفّذ خطّافاتِ المستودع، و`npm` ينفّذ سكربتاتِ الحزم.
  // فبقاؤه ناسخاً للبيئة كاملةً كان يجعل بابَ التسريب مفتوحاً في أوسع
  // مواضعه بينما `run` وحده أُغلق (وجدته مراجعةٌ عدائيّة 2026-09-03).
  const { env } = stripChildEnv(process.env)
  Object.assign(env, ctx.envOverlay ?? {})
  return env
}

async function controlled(
  executable: string,
  argv: readonly string[],
  cwd: string,
  ctx: ToolContext,
  timeoutMs = 30_000,
): Promise<ToolResult> {
  const grant: ControlledExecutionGrant =
    ctx.execution ?? { profile: INHERIT_PROFILE, capability: UNMEASURED_CAPABILITY, approvalGranted: false }
  const result = await launchControlledProcess({
    executable,
    argv: [...argv],
    cwd,
    env: childEnvironment(ctx),
    isolationProfile: grant.profile,
    capability: grant.capability,
    cancellation: ctx.signal,
    timeoutMs,
    evidence: grant,
  })
  if (result.outcome !== "ran") {
    return { ok: false, error: `${result.reasonCode}: ${result.detail}`, resultFingerprint: sha256(`${result.outcome}:${result.detail}`) }
  }
  const stdout = result.stdout.slice(0, OUTPUT_BYTES)
  const stderr = result.stderr.slice(0, OUTPUT_BYTES)
  const output = {
    executable,
    argv,
    exitCode: result.exitCode,
    stdout,
    stderr,
    timedOut: result.timedOut,
    aborted: result.aborted,
    outputTruncated: result.stdout.length > stdout.length || result.stderr.length > stderr.length,
  }
  const fingerprint = sha256([executable, ...argv, String(result.exitCode), sha256(stdout), sha256(stderr)].join("\0"))
  return result.exitCode === 0 && !result.timedOut && !result.aborted
    ? { ok: true, output, resultFingerprint: fingerprint }
    : { ok: false, error: result.timedOut ? "timeout" : result.aborted ? "aborted" : `exit_${result.exitCode}`, output, resultFingerprint: fingerprint }
}

const GIT_READ_ACTIONS = {
  status: ["status", "--short", "--branch"],
  diff: ["diff", "--no-ext-diff", "--"],
  log: ["log", "--oneline", "--decorate", "-n", "30"],
  branch: ["branch", "--show-current"],
  show: ["show", "--stat", "--oneline", "--no-ext-diff", "HEAD"],
} as const

function confinedPath(workspace: string, raw: string): string {
  const absolute = resolveInWorkspace(workspace, raw)
  const rel = relative(workspace, absolute).split(sep).join("/")
  if (!rel || rel === ".") throw new Error("a concrete workspace-relative path is required")
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error("Git mutation requires one existing regular file")
  return `:(literal)${rel}`
}

export function gitReadTool(workspace: string): ToolDefinition {
  return {
    name: "git_read",
    policy: policy({ risk: "read", idempotent: true }),
    description: "Read Git state using a compiled allow-list. No arbitrary Git arguments or remote operations.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", description: "status, diff, log, branch, or show" } },
      required: ["action"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const action = string(input, "action") as keyof typeof GIT_READ_ACTIONS | undefined
      const argv = action === undefined ? undefined : GIT_READ_ACTIONS[action]
      if (argv === undefined) return { ok: false, error: "git_read action must be status, diff, log, branch, or show" }
      return controlled("git", argv, resolveInWorkspace(workspace, "."), ctx)
    },
  }
}

export function gitChangeTool(workspace: string): ToolDefinition {
  return {
    name: "git_change",
    policy: policy({ risk: "critical", requiresApproval: true }),
    description: "Stage, unstage, or commit local Git changes. Push, fetch, reset, checkout, remotes and arbitrary arguments are unavailable.",
    honorsEnvOverlay: true,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "stage, unstage, or commit" },
        path: { type: "string", description: "Exact workspace-relative path for stage/unstage" },
        message: { type: "string", description: "Commit message, 1-200 characters" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const action = string(input, "action")
      let argv: string[]
      try {
        if (action === "stage" || action === "unstage") {
          const path = string(input, "path")
          if (!path) return { ok: false, error: `git_change ${action} requires one exact path` }
          const rel = confinedPath(workspace, path)
          argv = action === "stage" ? ["add", "--", rel] : ["restore", "--staged", "--", rel]
        } else if (action === "commit") {
          const message = string(input, "message")?.trim()
          if (!message || message.length > 200 || /[\r\n\0]/.test(message)) {
            return { ok: false, error: "git_change commit requires a single-line message of 1-200 characters" }
          }
          const nullHooks = process.platform === "win32" ? "NUL" : "/dev/null"
          argv = ["-c", `core.hooksPath=${nullHooks}`, "-c", "commit.gpgsign=false", "commit", "-m", message]
        } else {
          return { ok: false, error: "git_change action must be stage, unstage, or commit" }
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (ctx.dryRun) return { ok: true, output: { executable: "git", argv, dryRun: true } }
      return controlled("git", argv, resolveInWorkspace(workspace, "."), ctx, 60_000)
    },
  }
}

export type PackageManager = "npm" | "pnpm" | "bun" | "cargo"

const PACKAGE_PLAN: Record<PackageManager, { lockfiles: readonly string[]; args: readonly string[]; offline: readonly string[] }> = {
  npm: { lockfiles: ["package-lock.json", "npm-shrinkwrap.json"], args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], offline: ["--offline"] },
  pnpm: { lockfiles: ["pnpm-lock.yaml"], args: ["install", "--frozen-lockfile", "--ignore-scripts"], offline: ["--offline"] },
  bun: { lockfiles: ["bun.lock", "bun.lockb"], args: ["install", "--frozen-lockfile", "--ignore-scripts"], offline: ["--offline"] },
  cargo: { lockfiles: ["Cargo.lock"], args: ["fetch", "--locked"], offline: ["--offline"] },
}

const DEFAULT_REGISTRIES: Record<PackageManager, readonly string[]> = {
  npm: ["registry.npmjs.org"],
  pnpm: ["registry.npmjs.org"],
  bun: ["registry.npmjs.org"],
  cargo: ["crates.io", "index.crates.io", "static.crates.io", "github.com"],
}

export interface AdapterOptions {
  readonly packageRegistryHosts?: readonly string[]
  readonly networkAllowedHosts?: readonly string[]
  readonly networkDeniedHosts?: readonly string[]
  readonly lookupHost?: typeof lookup
  readonly requestFetch?: typeof fetch
}

function lockfileEvidence(workspace: string, plan: (typeof PACKAGE_PLAN)[PackageManager], allowedHosts: readonly string[]) {
  const lockfile = plan.lockfiles.find((name) => existsSync(resolveInWorkspace(workspace, name)))
  if (lockfile === undefined) throw new Error(`locked install refused: requires one of ${plan.lockfiles.join(", ")}`)
  const path = resolveInWorkspace(workspace, lockfile)
  const bytes = readFileSync(path)
  const text = bytes.toString("utf8")
  const hosts = [...text.matchAll(/(?:https?|git\+https):\/\/([^\s/'"#]+)/gi)].map((match) => match[1]!.toLowerCase())
  const allow = new Set(allowedHosts.map((host) => host.toLowerCase()))
  const blocked = [...new Set(hosts.filter((host) => !allow.has(host)))]
  if (blocked.length > 0) throw new Error(`lockfile source refused: ${blocked.join(", ")}`)
  if (/\b(?:git\+(?:ssh|https?)|git@|file:|link:|workspace:..\/)/i.test(text)) throw new Error("lockfile contains a non-registry or escaping source")
  return { lockfile, lockfileHash: sha256(bytes), hosts: [...new Set(hosts)] }
}

export function packageInstallTool(workspace: string, options: AdapterOptions = {}): ToolDefinition {
  return {
    name: "package_install",
    policy: policy({ risk: "critical", requiresApproval: true, supportsDryRun: true, timeoutMs: 300_000 }),
    description: "Restore dependencies from an existing lockfile with lifecycle scripts disabled and registry sources allow-listed.",
    honorsEnvOverlay: true,
    inputSchema: {
      type: "object",
      properties: {
        manager: { type: "string", description: "npm, pnpm, bun, or cargo" },
        network: { type: "string", description: "offline or registry" },
      },
      required: ["manager", "network"],
      additionalProperties: false,
    },
    async dryRun(input) {
      const manager = string(input, "manager") as PackageManager | undefined
      const network = string(input, "network")
      const plan = manager === undefined ? undefined : PACKAGE_PLAN[manager]
      if (plan === undefined || (network !== "offline" && network !== "registry")) throw new Error("package_install requires a supported manager and network=offline|registry")
      const evidence = lockfileEvidence(workspace, plan, options.packageRegistryHosts ?? DEFAULT_REGISTRIES[manager as PackageManager])
      return { executable: manager, argv: [...plan.args, ...(network === "offline" ? plan.offline : [])], network, ...evidence }
    },
    async run(input, ctx) {
      try {
        const preview = await this.dryRun!(input) as { executable: string; argv: string[]; network: string; lockfile: string; lockfileHash: string; hosts: string[] }
        if (ctx.dryRun) return { ok: true, output: { ...preview, dryRun: true } }
        const result = await controlled(preview.executable, preview.argv, resolveInWorkspace(workspace, "."), ctx, 300_000)
        return result.ok ? { ...result, output: { ...(result.output as object), supplyChain: preview } } : result
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

const BLOCKED_NAMES = /^(localhost|.+\.localhost|.+\.local|.+\.internal|.+\.home\.arpa)$/i
// Product-severance deny set. Digests keep the executable free of inherited
// endpoint and repository names while still making every match deterministic.
const BUILTIN_DENIED_HOST_DIGESTS = new Set([
  "15f3d522b114416a3a7cacfa7426bb80a64c3dcd6bb6ed5cf490037bb78d28c9",
  "b67044bc69dbd4186682926e6b0947e0d2a233823bf5c72b8ddec9d932d52118",
])
const SEVERED_ORG_DIGESTS = new Set([
  "129f74d16ae6028ecdc414744846865657b808969f0b8b8528c6aca43b6cb3b0",
  "7b8932a7d01817e6e54e4d39151138caaaf577726f29b8a627bfc55da0de2588",
])
const SEVERED_REPOSITORY_DIGEST = "62f8e1ec095e1857446d403d1431007de8813aea9553a56ccd4552a131b1f297"
const SEVERED_ALL_REPOSITORIES_ORG_DIGEST = "37da8069862f0bd7afeb7e71b28409f26609b8ee4f983ff859e63018d9aedb6c"

function privateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number)
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)) || a >= 224
}

function privateV6(ip: string): boolean {
  const low = ip.toLowerCase()
  if (low === "::" || low === "::1") return true
  if (low.startsWith("::ffff:") || low.startsWith("64:ff9b:") || low.startsWith("2002:")) {
    const dotted = low.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1]
    if (dotted) return privateV4(dotted)
    const parts = low.split(":").filter(Boolean)
    const high = Number.parseInt(parts.at(-2) ?? "", 16)
    const lowPart = Number.parseInt(parts.at(-1) ?? "", 16)
    return !Number.isFinite(high) || !Number.isFinite(lowPart) || privateV4(`${high >> 8}.${high & 255}.${lowPart >> 8}.${lowPart & 255}`)
  }
  return /^(?:fc|fd|fe[89ab]|fe[cdef]|ff)/.test(low)
}

const privateIp = (ip: string): boolean => ip.includes(":") ? privateV6(ip) : privateV4(ip)
const hostMatches = (host: string, rule: string): boolean => host === rule || host.endsWith(`.${rule}`)

export interface UrlVerdict { readonly ok: boolean; readonly reason?: string; readonly url?: URL; readonly addresses?: readonly string[] }

export async function guardNetworkUrl(raw: string, options: AdapterOptions = {}): Promise<UrlVerdict> {
  let url: URL
  try { url = new URL(raw) } catch { return { ok: false, reason: "invalid URL" } }
  if (url.protocol !== "https:") return { ok: false, reason: "only HTTPS GET is allowed" }
  if (url.username || url.password) return { ok: false, reason: "credentials in URLs are refused" }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (BLOCKED_NAMES.test(host)) return { ok: false, reason: `local host refused: ${host}` }
  const suffixes = host.split(".").map((_, index, parts) => parts.slice(index).join("."))
  if (suffixes.some((suffix) => BUILTIN_DENIED_HOST_DIGESTS.has(sha256(suffix)))) return { ok: false, reason: `severed host: ${host}` }
  const denied = options.networkDeniedHosts ?? []
  if (denied.some((rule) => hostMatches(host, rule.toLowerCase()))) return { ok: false, reason: `denied host: ${host}` }
  if (host === "github.com") {
    const [org = "", repository = ""] = url.pathname.toLowerCase().split("/").filter(Boolean)
    const orgDigest = sha256(org)
    if ((SEVERED_ORG_DIGESTS.has(orgDigest) && sha256(repository) === SEVERED_REPOSITORY_DIGEST) || orgDigest === SEVERED_ALL_REPOSITORIES_ORG_DIGEST) {
      return { ok: false, reason: "severed repository access is refused" }
    }
  }
  const allowed = options.networkAllowedHosts
  if (allowed !== undefined && !allowed.some((rule) => hostMatches(host, rule.toLowerCase()))) return { ok: false, reason: `host is not allow-listed: ${host}` }
  if (/^[\d.]+$/.test(host) || host.includes(":")) return privateIp(host) ? { ok: false, reason: `private address refused: ${host}` } : { ok: true, url, addresses: [host] }
  try {
    const resolver = options.lookupHost ?? lookup
    const records = await Promise.race([
      resolver(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("DNS timeout")), DNS_TIMEOUT_MS)),
    ])
    if (records.length === 0) return { ok: false, reason: "DNS returned no addresses" }
    const addresses = records.map((record) => record.address)
    const blocked = addresses.find(privateIp)
    return blocked ? { ok: false, reason: `private DNS answer refused: ${blocked}` } : { ok: true, url, addresses }
  } catch (error) {
    return { ok: false, reason: `DNS resolution failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function readBounded(response: Response): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader()
  if (!reader) return { bytes: new Uint8Array(), truncated: false }
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const item = await reader.read()
    if (item.done) break
    if (total + item.value.byteLength > NETWORK_BYTES) {
      const remaining = NETWORK_BYTES - total
      if (remaining > 0) chunks.push(item.value.slice(0, remaining))
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(item.value)
    total += item.value.byteLength
  }
  return { bytes: Buffer.concat(chunks), truncated }
}

export function networkFetchTool(options: AdapterOptions = {}): ToolDefinition {
  return {
    name: "network_fetch",
    policy: policy({ risk: "high", requiresApproval: true, timeoutMs: NETWORK_TIMEOUT_MS }),
    description: "Fetch one HTTPS text resource through DNS/SSRF checks, manual redirect validation and strict size limits.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "HTTPS URL; GET only" } },
      required: ["url"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      let target = string(input, "url")?.trim()
      if (!target) return { ok: false, error: "network_fetch requires { url }" }
      const deadline = AbortSignal.timeout(NETWORK_TIMEOUT_MS)
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline
      const request = options.requestFetch ?? fetch
      const redirects: string[] = []
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const verdict = await guardNetworkUrl(target, options)
        if (!verdict.ok) return { ok: false, error: verdict.reason ?? "network guard refused the URL" }
        let response: Response
        try {
          response = await request(target, { method: "GET", redirect: "manual", signal, headers: { accept: "text/plain, text/html, application/json", "user-agent": "AbdoCode/4.0" } })
        } catch (error) {
          return { ok: false, error: `network request failed: ${error instanceof Error ? error.message : String(error)}` }
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location")
          if (!location) return { ok: false, error: `redirect ${response.status} has no location` }
          redirects.push(target)
          target = new URL(location, target).toString()
          continue
        }
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, output: { url: target, status: response.status, redirects } }
        const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
        if (!/^(?:text\/|application\/(?:json|[^;]+\+json))/.test(contentType)) {
          void response.body?.cancel()
          return { ok: false, error: `content type refused: ${contentType || "missing"}` }
        }
        const body = await readBounded(response)
        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(body.bytes)
        const text = decoded.slice(0, NETWORK_TEXT)
        const truncated = body.truncated || decoded.length > text.length
        const output = { url: target, status: response.status, contentType, text, bytes: body.bytes.byteLength, sha256: sha256(body.bytes), redirects, truncated }
        return { ok: true, output, resultFingerprint: sha256(JSON.stringify(output)) }
      }
      return { ok: false, error: `more than ${MAX_REDIRECTS} redirects` }
    },
  }
}

export function registerAdapterTools(registry: ToolRegistry, workspace: string, options: AdapterOptions = {}): ToolRegistry {
  return registry
    .register(gitReadTool(workspace))
    .register(gitChangeTool(workspace))
    .register(packageInstallTool(workspace, options))
    .register(networkFetchTool(options))
}
