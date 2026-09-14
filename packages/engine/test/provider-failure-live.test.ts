import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { modelRequestFailure } from "../src/model-request-failure"
import { openServeJournal } from "@abdo/engine-host"

const ROOT = resolve(import.meta.dir, "../../..")

async function fixture(mode: "transport" | "credential" | "http" | "protocol" | "stream" | "success", selectedLocalModel?: string) {
  const state = mkdtempSync(join(tmpdir(), "abdo-provider-failure-"))
  const settings = join(state, "settings.json")
  const preload = join(state, "model.ts")
  const calls = join(state, "calls.txt")
  const payloads = join(state, "requests.jsonl")
  writeFileSync(settings, JSON.stringify({
    language: "en", modelRole: "agent", agentModel: selectedLocalModel ? `ollama/${selectedLocalModel}` : mode === "stream" ? "ollama/fixture-stream:latest" : "ollama/qwen9b-gpu-32k:latest", mode: "read-only",
    plugins: { routerGate: false, inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, generalAwareness: false, sessionAwareness: false },
    superAbdo: { enabled: false },
  }))
  writeFileSync(preload, [
    'import { appendFileSync } from "node:fs";',
    'globalThis.fetch = async (input, init) => {',
    `appendFileSync(${JSON.stringify(calls)}, "call\\n");`,
    `appendFileSync(${JSON.stringify(payloads)}, String(init?.body) + "\\n");`,
    mode === "transport" ? 'throw new TypeError("Unable to connect. Is the computer able to access the url?");' :
    mode === "credential" ? 'throw new Error("provider_worker_refused: abdo-tool-worker: provider credential unavailable");' :
    mode === "http" ? 'return new Response("DO-NOT-DISPLAY-PRIVATE-REQUEST-DATA", {status:401});' :
    mode === "protocol" ? 'return new Response("{malformed");' :
    mode === "stream" ? 'let count=0; return new Response(new ReadableStream({pull(controller){if(count++===0)controller.enqueue(new TextEncoder().encode(JSON.stringify({message:{content:"Partial answer."}})+"\\n"));else controller.error(new Error("private-stream-canary"));}}));' :
    'return Response.json({model:"fixture",message:{role:"assistant",content:"Ready. This is an explanatory answer."},done:true,done_reason:"stop",prompt_eval_count:12,eval_count:9});',
    '};',
  ].join("\n"))
  const child = Bun.spawn([process.execPath, "--preload", preload, "packages/engine/src/cli.ts", "serve"], {
    cwd: ROOT,
    env: { ...process.env, ABDO_SHELL_TOKEN: "provider-failure-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_STATE_DIR: state, ABDO_CODE_SETTINGS: settings, ABDO_VAULT_HOME: state, ABDO_PROJECT: state, USERPROFILE: state, HOME: state, ABDO_MAX_AGENT_EPOCHS: "1", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "", ABDO_TURN_TOKEN_CAP: "", ABDO_CLOUD_DAILY_TOKENS: "0" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  const decoder = new LocalJsonFrameDecoder()
  const reader = child.stdout.getReader()
  const seen: Record<string, any>[] = []
  let pending: ReturnType<typeof reader.read> | undefined
  const send = async (frame: Record<string, unknown>) => { child.stdin.write(encodeLocalJsonFrame(frame)); await child.stdin.flush() }
  const until = async (predicate: (frame: Record<string, any>) => boolean) => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const match = seen.find(predicate)
      if (match) return match
      pending ??= reader.read()
      const next = await Promise.race([pending, Bun.sleep(50).then(() => undefined)])
      if (!next) continue
      pending = undefined
      if (next.done) throw Error(`Fixture engine exited: ${(await stderr).slice(0, 700)}`)
      seen.push(...decoder.push(next.value) as Record<string, any>[])
    }
    throw Error(`Fixture timed out: ${JSON.stringify(seen).slice(-1000)}`)
  }
  try {
    await send({ kind: "hello", shell: "desktop", token: "provider-failure-test" })
    await until(f => f.kind === "ready")
    await send({ kind: "submit", turn: { id: "model-probe", body: "Answer briefly. Do not change files." } })
    const terminal = await until(f => f.turnId === "model-probe" && ["refused", "done", "unresolved"].includes(f.kind))
    // Reoffering the same ID replays its settled failure without another request.
    await send({ kind: "history" })
    await until(f => f.kind === "history")
    const seenBeforeReplay = [...seen]
    await send({ kind: "submit", turn: { id: "model-probe", body: "Answer briefly. Do not change files." } })
    const replay = await until(f => f !== terminal && f.turnId === "model-probe" && ["refused", "done", "unresolved"].includes(f.kind))
    return { terminal, replay, seen: seenBeforeReplay, requests: readFileSync(calls, "utf8").trim().split("\n").length, payloads: readFileSync(payloads, "utf8").trim().split("\n").map(line => JSON.parse(line)) }
  } finally {
    child.kill(); await child.exited
    if (!resolve(state).startsWith(resolve(tmpdir()) + sep) || !state.includes("abdo-provider-failure-")) throw Error("unsafe fixture cleanup")
    rmSync(state, { recursive: true, force: true })
  }
}

describe("provider failures through the real framed engine", () => {
  for (const [mode, kind, action] of [
    ["transport", "transport", "local-runtime"],
    ["credential", "credential", "provider-settings"],
    ["http", "credential", "provider-settings"],
    ["protocol", "protocol", "retry"],
    ["stream", "protocol", "retry"],
  ] as const) {
    test(`${mode} settles as failure once, without fabricated completion or repeated diagnostics`, async () => {
      const result = await fixture(mode)
      expect(result.terminal.kind).toBe("refused")
      expect(result.terminal.failure).toMatchObject({ kind, action })
      expect(result.replay).toMatchObject({ kind: "refused", why: result.terminal.why })
      expect(result.seen.some(f => f.kind === "done")).toBe(false)
      expect(result.seen.some(f => f.kind === "tool" || f.kind === "tool-result")).toBe(false)
      expect(result.requests).toBe(1)
      expect(result.seen.filter(f => f.kind === "event" && f.payload === result.terminal.why)).toHaveLength(1)
      const transcript = JSON.stringify(result.seen)
      expect(transcript).not.toContain("DO-NOT-DISPLAY")
      expect(transcript).not.toContain("provider_worker_refused")
      expect(transcript).not.toContain("bounded-backoff")
      expect(transcript).not.toContain("private-stream-canary")
      if (mode === "stream") expect(result.seen.some(f => f.kind === "delta" && JSON.stringify(f).includes("Partial answer."))).toBe(true)
    }, 40_000)
  }

  test("a real successful response still completes", async () => {
    const result = await fixture("success")
    expect(result.requests).toBe(1)
    expect(result.terminal).toMatchObject({ kind: "done", outcome: "completed", rerun: false })
    expect(result.seen.some(f => f.kind === "refused")).toBe(false)
  }, 40_000)

  test("selecting the verified small local aliases reaches native tool schemas in the actual request", async () => {
    for (const model of ["qwen2b-gpu:latest", "empero-qwen3.8-9b-gpu:latest"]) {
      const result = await fixture("success", model)
      expect(result.terminal.kind).toBe("done")
      expect(result.payloads[0]).toMatchObject({ model, stream: false })
      expect(result.payloads[0].tools.length).toBeGreaterThan(0)
      expect(result.payloads[0].tools.some((tool: any) => tool.function.parameters.properties.path)).toBe(true)
    }
  }, 40_000)

  test("credential classification is actionable without exposing source errors", () => {
    const failure = modelRequestFailure("DeepSeek", false, { error: new Error("provider credential unavailable secret-canary") })
    expect(failure.failure.kind).toBe("credential")
    expect(failure.action).toBe("provider-settings")
    expect(failure.publicMessage("en")).toContain("Settings → Providers")
    expect(failure.publicMessage("ar")).toContain("الخزنة")
    expect(failure.publicMessage("en")).not.toContain("secret-canary")
  })

  test("failure survives closing and reopening the real journal without becoming completed", async () => {
    const state = mkdtempSync(join(tmpdir(), "abdo-provider-failure-"))
    const file = join(state, "events.sqlite")
    let journal = await openServeJournal({ database: file })
    try {
      await expect(journal.fail("unknown", "Unavailable")).rejects.toThrow("without_admission")
      await journal.admit({ turnId: "failed-probe", body: "Open the project", sessionId: "failure-session" })
      await journal.emitOutput("failed-probe", "Provider unavailable. Open provider settings.")
      await journal.fail("failed-probe", "Provider unavailable. Open provider settings.")
      journal.close()
      journal = await openServeJournal({ database: file })
      expect(journal.snapshot().failed.get("failed-probe")).toBe("Provider unavailable. Open provider settings.")
      expect(journal.snapshot().completed.has("failed-probe")).toBe(false)
      expect(journal.snapshot().outputs).toHaveLength(1)
      await expect(journal.complete("failed-probe")).rejects.toThrow("after_failure")
      await journal.admit({ turnId: "completed-probe", body: "Explain", sessionId: "failure-session" })
      await journal.complete("completed-probe")
      await expect(journal.fail("completed-probe", "Late failure")).rejects.toThrow("after_completion")
    } finally {
      journal.close()
      if (!resolve(state).startsWith(resolve(tmpdir()) + sep) || !state.includes("abdo-provider-failure-")) throw Error("unsafe fixture cleanup")
      rmSync(state, { recursive: true, force: true })
    }
  })
})
