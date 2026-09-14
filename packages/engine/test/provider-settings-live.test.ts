import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

test("native settings save local provider models and route a real framed turn to the selected loopback server", async () => {
  const state = mkdtempSync(join(tmpdir(), "abdo-provider-settings-"))
  const settingsFile = join(state, "settings.json")
  const requests: { model: string; authorization: string | null; path: string }[] = []
  let releaseRequest: (() => void) | undefined
  let requestStarted: (() => void) | undefined
  let holdRequest = false
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as { model: string; stream?: boolean }
      requests.push({ model: body.model, authorization: request.headers.get("authorization"), path: new URL(request.url).pathname })
      if (holdRequest) {
        await new Promise<void>((resolve) => { releaseRequest = resolve; requestStarted?.() })
      }
      const message = "Local provider round-trip verified."
      if (body.stream) return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: message }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } })
      return Response.json({ choices: [{ message: { role: "assistant", content: message }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
    },
  })
  const executable = process.env.ABDO_TEST_ENGINE
  const child = Bun.spawn(executable ? [executable, "serve"] : [process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...process.env, ABDO_CODE_SETTINGS: settingsFile, ABDO_CODE_STATE_DIR: state, ABDO_SHELL_TOKEN: "provider-settings-test", ABDO_FRAMED_STDIO: "1", ABDO_VAULT_HOME: state, USERPROFILE: state, HOME: state },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  const decoder = new LocalJsonFrameDecoder()
  const reader = child.stdout.getReader()
  const frames: Record<string, unknown>[] = []
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  const send = async (frame: Record<string, unknown>) => { child.stdin.write(encodeLocalJsonFrame(frame)); await child.stdin.flush() }
  const read = async (kind: string): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 25_000
    for (;;) {
      const index = frames.findIndex((frame) => frame.kind === kind)
      if (index >= 0) return frames.splice(index, 1)[0]!
      if (Date.now() > deadline) throw new Error(`No ${kind} frame: ${JSON.stringify(frames).slice(-1500)}`)
      pending ??= reader.read()
      const result = await Promise.race([pending, Bun.sleep(100).then(() => undefined)])
      if (result === undefined) continue
      pending = undefined
      if (result.done) throw new Error(`Engine exited: ${(await stderr).slice(0, 1500)}`)
      for (const frame of decoder.push(result.value)) frames.push(frame as Record<string, unknown>)
    }
  }
  try {
    await send({ kind: "hello", shell: "desktop", token: "provider-settings-test" })
    await read("ready")
    const local = { id: "local-proof", label: "Local proof", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["local-proof-model"] }
    await send({ kind: "settings-set", settings: { customProviders: [local], model: "local-proof/local-proof-model", modelRole: "chat", mode: "read-only", plugins: { settingsSeam: true } } })
    let acknowledged = await read("settings")
    expect(acknowledged.settings).toMatchObject({ customProviders: [local], model: "local-proof/local-proof-model" })
    // Exercise narrow settings actions after the routing checks, preserving the
    // initial legacy single-model configuration for those checks.
    const verifyNarrowSettingsActions = async () => {
    for (const [frame, event, expected] of [
      [{ kind: "mode-set", mode: "auto" }, "mode", { mode: "auto" }],
      [{ kind: "model-set", name: "local-proof/replacement-model" }, "model", { agentModel: "local-proof/replacement-model" }],
      [{ kind: "project-set", path: state }, "trust-request", { project: state }],
    ] as const) {
      const previousRevision = (acknowledged.pluginRegistry as { revision: number }).revision
      await send(frame)
      await read(event)
      acknowledged = await read("settings")
      expect(acknowledged.settings).toMatchObject(expected)
      if (frame.kind === 'model-set') {
        // A Code session writes its own model; it must not silently pin Chat.
        expect((acknowledged.settings as any).chatModel).toBeUndefined()
        expect((acknowledged.settings as any).modelRole).toBe('chat')
      }
      const revision = (acknowledged.pluginRegistry as { revision: number }).revision
      expect(revision).toBeGreaterThanOrEqual(previousRevision)
      expect(revision).toBe(JSON.parse(readFileSync(settingsFile, "utf8")).pluginsRevision ?? 0)
      await send({ kind: "settings-set", settings: { language: "en", plugins: { settingsSeam: true } }, expectedPluginsRevision: revision })
      acknowledged = await read("settings")
      expect(acknowledged.settings).toMatchObject({ language: "en", plugins: { settingsSeam: true } })
      expect((acknowledged.pluginRegistry as { revision: number }).revision).toBeGreaterThan(revision)
      expect(frames.some(frame => frame.kind === "refused")).toBe(false)
    }
    }
    // A legacy single-model setting remains authoritative after the default changes.
    await send({ kind: "submit", turn: { id: "provider-proof", body: "Hello" } })
    await read("done")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual({ model: "local-proof-model", authorization: null, path: "/v1/chat/completions" })
    expect(JSON.stringify(frames)).toContain("Local provider round-trip verified.")
    expect(frames.find(frame => frame.kind === 'model-route' && frame.turnId === 'provider-proof')).toMatchObject({lane:'agent',ref:'local-proof/local-proof-model'})
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toMatchObject({ model: "local-proof/local-proof-model", customProviders: [local] })
    await send({ kind: "settings-set", settings: { customProviders: [{ ...local, id: "bad-local", baseUrl: "http://external.invalid/v1" }] } })
    expect(String((await read("refused")).why)).toContain("loopback")
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).customProviders).toEqual([local])

    const reconfigured = { ...local, label: "Reconfigured", models: ["replacement-model"] }
    await send({ kind: "settings-set", settings: { customProviders: [reconfigured], model: "local-proof/replacement-model" } })
    expect((await read("settings")).settings).toMatchObject({ customProviders: [reconfigured] })
    holdRequest = true
    const started = new Promise<void>((resolve) => { requestStarted = resolve })
    await send({ kind: "submit", turn: { id: "provider-proof-two", body: "Hello again" } })
    await read("admission")
    await Promise.race([started, Bun.sleep(15_000).then(() => { throw new Error("Reconfigured local model was never called") })])
    await send({ kind: "settings-set", settings: { customProviders: [] } })
    expect(String((await read("refused")).why)).toContain("أثناء عمل دور")
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).customProviders).toEqual([reconfigured])
    releaseRequest?.()
    await read("done")
    expect(requests).toHaveLength(2)
    expect(requests[1]?.model).toBe("replacement-model")
    await send({ kind: "settings-get", requestId: "native-refresh-regression" })
    acknowledged = await read("settings")
    expect(acknowledged.requestId).toBe("native-refresh-regression")
    await verifyNarrowSettingsActions()
    await send({ kind: "settings-set", settings: { customProviders: [], model: "deepseek/deepseek-v4-flash" } })
    expect((await read("settings")).settings).toMatchObject({ customProviders: [], model: "deepseek/deepseek-v4-flash" })
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).customProviders).toEqual([])
  } finally {
    releaseRequest?.()
    child.kill()
    await child.exited
    server.stop(true)
    rmSync(state, { recursive: true, force: true })
  }
}, 60_000)
