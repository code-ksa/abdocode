export * from "./provider"

export interface ToolWorkerRequest { readonly version: 1; readonly requestId: string; readonly tool: string; readonly argv: readonly string[]; readonly timeoutMs: number }
export interface ToolWorkerResult { readonly version: 1; readonly requestId: string; readonly status: "completed" | "refused" | "timed-out"; readonly output: string }

export function validateToolWorkerRequest(value: unknown): ToolWorkerRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("tool_worker_request_invalid")
  const item = value as Record<string, unknown>
  if (Object.keys(item).some((key) => !["version", "requestId", "tool", "argv", "timeoutMs"].includes(key))) throw new Error("tool_worker_unknown_field")
  if (item.version !== 1 || typeof item.requestId !== "string" || !item.requestId || typeof item.tool !== "string" || !item.tool) throw new Error("tool_worker_request_invalid")
  if (!Array.isArray(item.argv) || !item.argv.every((argument) => typeof argument === "string" && !argument.includes("\0"))) throw new Error("tool_worker_argv_invalid")
  if (!Number.isSafeInteger(item.timeoutMs) || (item.timeoutMs as number) < 1 || (item.timeoutMs as number) > 300_000) throw new Error("tool_worker_timeout_invalid")
  return Object.freeze({ version: 1, requestId: item.requestId, tool: item.tool, argv: Object.freeze([...item.argv]), timeoutMs: item.timeoutMs as number })
}

import {
  decodeEnforcementReport,
  encodeToolSpec,
  type Digest,
  type EffectClass,
  type EnforcementReport,
  type ToolId,
  type ToolSpec,
} from "@abdo/kernel"

export type AdapterTool = "write" | "git-read" | "git-change" | "package" | "network"

const ADAPTERS: Record<AdapterTool, { id: bigint; label: string; effect: "read" | "mutate" | "reach" }> = {
  write: { id: 1n, label: "abdo-write-adapter", effect: "mutate" },
  "git-read": { id: 2n, label: "abdo-git-read-adapter", effect: "read" },
  "git-change": { id: 3n, label: "abdo-git-change-adapter", effect: "mutate" },
  package: { id: 4n, label: "abdo-package-adapter", effect: "reach" },
  network: { id: 5n, label: "abdo-network-adapter", effect: "reach" },
}

export function labelDigest(label: string): Digest {
  const encoded = new TextEncoder().encode(label)
  const digest = new Uint8Array(32)
  digest.set(encoded.slice(0, 31))
  digest[31] = 1
  return digest as Digest
}

function recovery(label: string) {
  return {
    compensating_operation_digest: labelDigest(`${label}-compensate`),
    evidence_operation_digest: labelDigest(`${label}-evidence`),
    max_attempts: 2n,
  }
}

export function adapterToolSpec(adapter: AdapterTool): ToolSpec {
  const item = ADAPTERS[adapter]
  const effect: EffectClass = item.effect === "read"
    ? { tag: "Read", value: {} }
    : item.effect === "mutate"
      ? { tag: "Mutate", value: { recovery: recovery(item.label) } }
      : { tag: "Reach", value: { recovery: recovery(item.label), endpoint_class_digest: labelDigest(`${item.label}-endpoint`) } }
  return {
    tool_id: item.id as ToolId,
    name_digest: labelDigest(item.label),
    input_schema_digest: labelDigest(`${item.label}-input`),
    output_schema_digest: labelDigest(`${item.label}-output`),
    effect,
    resources: { wall_ms: 300_000n, memory_bytes: 256n * 1024n * 1024n, output_bytes: 512n * 1024n, open_handles: 64n },
    postcondition_digest: labelDigest(`${item.label}-postcondition`),
    handler_digest: labelDigest("abdo-bounded-tool"),
  }
}

export interface ToolAdmission {
  readonly adapter: AdapterTool
  readonly report: EnforcementReport
}

export class ToolAdmissionWorker {
  constructor(
    private readonly executable: string,
    private readonly timeoutMs = 5_000,
  ) {}

  async admit(adapter: AdapterTool): Promise<ToolAdmission> {
    const spec = adapterToolSpec(adapter)
    const frame = encodeToolSpec(spec)
    let child: Bun.Subprocess<Uint8Array, "pipe", "pipe">
    try {
      child = Bun.spawn([this.executable], { stdin: frame, stdout: "pipe", stderr: "pipe" })
    } catch (error) {
      throw new Error(`tool_worker_unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    const timeout = setTimeout(() => child.kill(), this.timeoutMs)
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timeout))
    const bytes = new Uint8Array(stdout)
    if (exitCode !== 0) throw new Error(`tool_worker_refused: ${stderr.trim().slice(0, 512) || `exit ${exitCode}`}`)
    if (bytes.byteLength === 0 || bytes.byteLength > 65_536) throw new Error("tool_worker_invalid_output")
    let report: EnforcementReport
    try { report = decodeEnforcementReport(bytes) } catch (error) {
      throw new Error(`tool_worker_invalid_report: ${error instanceof Error ? error.message : String(error)}`)
    }
    const same = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((value, index) => value === right[index])
    if (!same(report.requested_digest, spec.handler_digest) || !same(report.granted_digest, spec.handler_digest)) {
      throw new Error("tool_worker_report_mismatch")
    }
    return Object.freeze({ adapter, report })
  }
}

export interface AdapterLedgerRecovery {
  readonly scanned: number
  readonly unresolved: number
  readonly markedUnknown: number
  readonly resumableWithoutDispatch: number
}

type LedgerRun = (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>

const defaultLedgerRun: LedgerRun = async (argv) => {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => child.kill(), 5_000)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timeout))
  return { exitCode, stdout: stdout.slice(0, 2_048), stderr: stderr.slice(0, 2_048) }
}

/**
 * The only product bridge into Rust's durable effect lifecycle. It transports
 * bounded ids/digests; adapter arguments and output never cross this channel.
 */
export class AdapterEffectLedger {
  constructor(
    private readonly kernelExecutable: string,
    private readonly journalPath: string,
    private readonly runCommand: LedgerRun = defaultLedgerRun,
  ) {}

  async begin(effectId: string, operationDigest: string, atMs = Date.now()): Promise<void> {
    await this.command(["begin", this.journalPath, effectId, operationDigest, String(atMs)], "ADAPTER_LEDGER_BEGIN")
  }

  async settle(effectId: string, operationDigest: string, outcomeDigest: string, atMs = Date.now()): Promise<void> {
    await this.command(["settle", this.journalPath, effectId, operationDigest, outcomeDigest, String(atMs)], "ADAPTER_LEDGER_SETTLE")
  }

  async unknown(effectId: string, operationDigest: string, reasonDigest: string, atMs = Date.now()): Promise<void> {
    await this.command(["unknown", this.journalPath, effectId, operationDigest, reasonDigest, String(atMs)], "ADAPTER_LEDGER_UNKNOWN")
  }

  async recover(atMs = Date.now()): Promise<AdapterLedgerRecovery> {
    const line = await this.command(["recover", this.journalPath, String(atMs)], "ADAPTER_LEDGER_RECOVER")
    const match = /scanned=(\d+) unresolved=(\d+) marked_unknown=(\d+) resumable_without_dispatch=(\d+)/.exec(line)
    if (!match) throw new Error("adapter_ledger_invalid_recovery_report")
    return {
      scanned: Number(match[1]),
      unresolved: Number(match[2]),
      markedUnknown: Number(match[3]),
      resumableWithoutDispatch: Number(match[4]),
    }
  }

  private async command(args: readonly string[], expected: string): Promise<string> {
    for (const value of args.slice(2, -1)) {
      if (!/^[0-9a-f]{32}$|^[0-9a-f]{64}$/.test(value)) throw new Error("adapter_ledger_invalid_binding")
    }
    const result = await this.runCommand([this.kernelExecutable, "adapter-ledger", ...args])
    const line = result.stdout.trim()
    if (result.exitCode !== 0 || !line.startsWith(expected)) {
      throw new Error(`adapter_ledger_refused: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
    }
    return line
  }
}
