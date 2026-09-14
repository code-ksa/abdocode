import { createHash, randomUUID } from "node:crypto"
import { createEnforcedToolRunner, policy, ToolRegistry } from "@abdo/tools"
import { AdapterEffectLedger, ModelProviderWorker, ToolAdmissionWorker, type GoogleSearchWorkerRequest, type ModelProviderWorkerRequest, type ModelProviderWorkerResponse } from "@abdo/tool-worker"

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]))
  }
  return value
}

const digestValue = (value: unknown): string => createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")

/**
 * The single product path for authenticated internet reach. The TypeScript
 * side carries only public request material; Rust owns endpoint identity,
 * credential materialisation and HTTPS. Policy and the Rust effect ledger close
 * before a successful result is returned.
 */
export class RustReachEffects {
  readonly #worker: ModelProviderWorker
  readonly #admission: ToolAdmissionWorker
  readonly #ledger: AdapterEffectLedger

  constructor(
    toolWorkerExecutable: string,
    kernelExecutable: string,
    journalPath: string,
    private readonly workspace: () => string,
  ) {
    this.#worker = new ModelProviderWorker(toolWorkerExecutable)
    this.#admission = new ToolAdmissionWorker(toolWorkerExecutable)
    this.#ledger = new AdapterEffectLedger(kernelExecutable, journalPath)
  }

  hasCredential(provider: string): Promise<boolean> {
    return this.#worker.hasCredential(provider)
  }

  model(request: ModelProviderWorkerRequest, signal?: AbortSignal): Promise<ModelProviderWorkerResponse> {
    return this.#execute(
      { kind: "model-provider", provider: request.provider, endpoint: request.url, payloadHash: digestValue(request.body), timeoutMs: request.timeoutMs },
      (effectSignal) => this.#worker.request(request, effectSignal),
      signal,
    )
  }

  googleSearch(request: GoogleSearchWorkerRequest, signal?: AbortSignal): Promise<ModelProviderWorkerResponse> {
    return this.#execute(
      { kind: "google-pse", provider: "google-pse", endpoint: "https://www.googleapis.com/customsearch/v1", payloadHash: digestValue(request), timeoutMs: request.timeoutMs },
      (effectSignal) => this.#worker.search(request, effectSignal),
      signal,
    )
  }

  async #execute(
    descriptor: Readonly<{ kind: string; provider: string; endpoint: string; payloadHash: string; timeoutMs: number }>,
    execute: (signal?: AbortSignal) => Promise<ModelProviderWorkerResponse>,
    signal?: AbortSignal,
  ): Promise<ModelProviderWorkerResponse> {
    const effectId = randomUUID().replaceAll("-", "")
    const executionId = `reach_${randomUUID()}`
    let operationDigest = ""
    let began = false
    try {
      const admission = await this.#admission.admit("network")
      const registry = new ToolRegistry().register({
        name: "network_fetch",
        description: "Private compiled HTTPS request through the Rust worker",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string" }, provider: { type: "string" }, endpoint: { type: "string" }, payloadHash: { type: "string" }, timeoutMs: { type: "integer" },
          },
          required: ["kind", "provider", "endpoint", "payloadHash", "timeoutMs"],
          additionalProperties: false,
        },
        policy: policy({ risk: "high", timeoutMs: descriptor.timeoutMs, secretsAccess: "none" }),
        async run(_raw, context) {
          try {
            const output = await execute(context.signal)
            return { ok: true as const, output, resultFingerprint: digestValue(output) }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { ok: false as const, error: message, resultFingerprint: digestValue(message) }
          }
        },
      })
      const runner = createEnforcedToolRunner(registry, {
        // Selecting a configured remote service is the owner's bounded approval.
        approver: { approve: async () => true },
        identity: { agent: "abdocode", provider: "rust-reach-worker", workspace: this.workspace() },
      })
      // لا mode هنا عمداً: بوابة الأنماط تحكم عملياتٍ يقترحها النموذج —
      // وبوابتها الحاكمة في dispatchTool. نداء النقل هذا يملكه المحرك
      // ليشغّل النموذج أصلاً؛ تمرير BUILD كان يصنّفه production_write
      // فيُرفض كل نموذج سحابي (قيس حياً 2026-09-01 — المسار كان ميتاً).
      // يبقى: الاعتماد في Rust، وموافقة المالك المحدودة، ودفتر الأثر.
      const outcome = await runner.run(
        { name: "network_fetch", input: descriptor },
        {
          executionId,
          signal,
          onBeforeEffect: async ({ request, control, execution }) => {
            operationDigest = digestValue({
              version: 1,
              adapter: admission.adapter,
              limitations: Array.from(admission.report.limitations_digest),
              descriptor,
              argsHash: request.argsHash,
              decisionId: control.decisionId,
              decisionHash: control.decisionHash,
              executionId: execution.executionId,
              workspace: digestValue(this.workspace()),
            })
            await this.#ledger.begin(effectId, operationDigest)
            began = true
          },
        },
      )
      if (began) {
        await this.#ledger.settle(effectId, operationDigest, digestValue({
          ok: outcome.ok,
          resultFingerprint: outcome.resultFingerprint ?? null,
          error: outcome.ok ? null : outcome.error,
        }))
      }
      if (!outcome.ok) throw new Error(outcome.error)
      const output = outcome.output as Partial<ModelProviderWorkerResponse>
      if (!Number.isInteger(output.status) || output.status! < 100 || output.status! > 599 || typeof output.body !== "string") {
        throw new Error("rust_reach_invalid_output")
      }
      return Object.freeze({ status: output.status!, body: output.body })
    } catch (error) {
      if (began && operationDigest) {
        try { await this.#ledger.unknown(effectId, operationDigest, digestValue(error instanceof Error ? error.message : String(error))) }
        catch { /* Rust recovery keeps an unresolved dispatch fail-closed. */ }
      }
      throw error
    }
  }
}
