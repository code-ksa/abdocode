import { dirname, resolve } from "node:path"
import { createEngineHost, type ModelClient } from "@abdo/engine-host"
import { KernelHost, type FilesystemHandle } from "@abdo/kernel"
import { readBoundObjectTool } from "@abdo/kernel-tools"
import { reduceAgentRequest } from "@abdo/agent-server"
import { nextBrowserLane } from "@abdo/browser-router"
import { LocalAgentClient } from "@abdo/client-sdk"
import { admitComputerAction, bindTarget } from "@abdo/computer-router"
import { createEvidenceReceipt, verifyEvidenceChain } from "@abdo/evidence"
import { recordHttp } from "@abdo/http-recorder"
import { localPluginDigest, validateLocalPlugin } from "@abdo/plugin-runtime"
import { loadPublicProjectConfig } from "@abdo/public-config"
import { generateSkill } from "@abdo/skill-factory"
import { validateToolWorkerRequest } from "@abdo/tool-worker"
import { generateShellReference } from "@abdo/transport-codegen"
import { decodeTransportFrame } from "@abdo/transport-contracts"

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * Product-composition proof: the same owned EngineHost and kernel tool adapter
 * used by later serve convergence, with no local tool or ledger substitute.
 */
export async function runIntegrationProof(input: {
  readonly kernel: string
  readonly journal: string
  readonly events: string
  readonly target: string
}) {
  const sessionState = reduceAgentRequest(
    { sessionId: "integration", acceptedRequestIds: [], interrupted: false, afterSequence: 0 },
    { version: 1, kind: "events", requestId: "resume-1", sessionId: "integration", afterSequence: 0 },
  )
  const clientFrame = decodeTransportFrame(new LocalAgentClient("integration").submit("proof"))
  const surface = { generation: 1, targetIds: ["project"] } as const
  const targetRef = bindTarget(surface, "project", "accessibility")
  admitComputerAction(surface, targetRef)
  const evidence = createEvidenceReceipt({ action: "composition", result: "verified", verified: true })
  const plugin = validateLocalPlugin({ id: "local-proof", version: "1.0.0", entry: "dist/index.js", permissions: ["read-project"] })
  const publicConfig = loadPublicProjectConfig({ version: 1, projectDirectory: ".", network: "off" }, true, dirname(resolve(input.target)))
  const packageProofs = Object.freeze({
    agentServer: sessionState.acceptedRequestIds.length === 1,
    browserRouter: nextBrowserLane([]) === "api",
    clientSdk: clientFrame.kind === "submit",
    computerRouter: targetRef.generation === surface.generation,
    evidence: verifyEvidenceChain([evidence]),
    httpRecorder: recordHttp({ method: "GET", url: "https://example.invalid/proof" }).bodyBytes === 0,
    pluginRuntime: localPluginDigest(plugin).length === 64,
    publicConfig: publicConfig.network === "off",
    skillFactory: generateSkill("local-proof", [{ tool: "read", arguments: { path: "package.json" }, verified: true }]).steps.length === 1,
    toolWorker: validateToolWorkerRequest({ version: 1, requestId: "proof", tool: "read", argv: ["package.json"], timeoutMs: 1000 }).version === 1,
    transportCodegen: generateShellReference().includes('kind: "submit"'),
  })
  if (Object.values(packageProofs).some((value) => value !== true)) throw new Error("equivalent package composition failed")
  const object = new Uint8Array(32).fill(0xa3) as FilesystemHandle
  const target = resolve(input.target)
  const kernel = new KernelHost({
    executable: resolve(input.kernel),
    journal: resolve(input.journal),
    bindings: [`${hex(object)}=${target}`],
    sealingKey: hex(new Uint8Array(32).fill(0x3a)),
  })
  kernel.start()

  let turn = 0
  const model: ModelClient = {
    async call() {
      turn++
      if (turn === 1) return { kind: "tools" as const, calls: [{ name: "kernel_read", input: {} }] }
      return { kind: "final" as const, text: "rust-main integrated" }
    },
  }

  const host = createEngineHost({
    database: resolve(input.events),
    model,
    toolDefinitions: [readBoundObjectTool({ host: kernel, object })],
    runner: {
      identity: { agent: "abdocode", provider: "local-proof", workspace: dirname(target) },
    },
  })
  try {
    const sessionId = "integration-owned-composition"
    await host.admit(sessionId, "prove package-to-kernel composition")
    const result = await host.run(sessionId)
    const events = await host.replay(sessionId)
    const eventTypes = events.map((event) => event.type)
    const kernelVerified =
      kernel.accepted === 1 &&
      kernel.refused === 0 &&
      eventTypes.includes("tool.executed") &&
      eventTypes.includes("run.completed")
    if (result.state !== "completed" || !kernelVerified || !eventTypes.includes("control.decided")) {
      throw new Error(
        `integration proof failed: state=${result.state}, kernelAccepted=${kernel.accepted}, kernelRefused=${kernel.refused}`,
      )
    }
    return {
      state: result.state,
      text: result.text,
      eventTypes,
      kernelVerified,
      kernelAccepted: kernel.accepted,
      kernelRefused: kernel.refused,
      packageProofs,
    }
  } finally {
    host.close()
    await kernel.close()
  }
}
