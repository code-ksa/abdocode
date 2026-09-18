import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

test("usage-get returns the aggregate local cloud ledger without entry details", async () => {
  const root = resolve(import.meta.dir, "../../..")
  const sandbox = mkdtempSync(resolve(tmpdir(), "abdo-usage-summary-"))
  const state = resolve(sandbox, "state")
  const ledger = resolve(sandbox, "private-ledger.json")
  const token = "usage-summary-test-token"
  writeFileSync(ledger, JSON.stringify({
    capTokens: 999_999,
    entries: [{
      at: "2026-09-05T00:00:00.000Z",
      provider: "provider-must-not-cross-boundary",
      model: "model-must-not-cross-boundary",
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      note: "private-note-must-not-cross-boundary",
    }],
  }), "utf8")
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: root,
    env: {
      ...process.env,
      ABDO_SHELL_TOKEN: token,
      ABDO_FRAMED_STDIO: "1",
      ABDO_CODE_STATE_DIR: state,
      ABDO_CODE_SETTINGS: resolve(sandbox, "settings.json"),
      ABDO_TOKEN_LEDGER: ledger,
      ABDO_CLOUD_TOKEN_CAP: "1000",
      ABDO_CLOUD_CACHE_DISCOUNT: "0.5",
      USERPROFILE: sandbox,
      HOME: sandbox,
    },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const decoder = new LocalJsonFrameDecoder()
  const reader = child.stdout.getReader()
  const buffered: Record<string, unknown>[] = []
  const stderrText = new Response(child.stderr).text()
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  const send = async (frame: Record<string, unknown>) => {
    child.stdin.write(encodeLocalJsonFrame(frame))
    await child.stdin.flush()
  }
  const readKind = async (kind: string) => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const found = buffered.findIndex(frame => frame.kind === kind)
      if (found >= 0) return buffered.splice(found, 1)[0]!
      if (Date.now() >= deadline) throw new Error(`timeout waiting for ${kind}`)
      pending ??= reader.read()
      const next = await Promise.race([pending, Bun.sleep(100).then(() => undefined)])
      if (next === undefined) continue
      pending = undefined
      if (next.done) throw new Error(`engine ended before ${kind}`)
      for (const frame of decoder.push(next.value)) buffered.push(frame as Record<string, unknown>)
    }
  }

  try {
    await send({ kind: "hello", shell: "desktop", token })
    await readKind("ready")
    await send({ kind: "usage-get", requestId: "usage-live-1" })
    const frame = await readKind("usage-summary")
    expect(frame).toEqual({
      kind: "usage-summary",
      requestId: "usage-live-1",
      summary: {
        status: "available",
        source: "local-cloud-token-ledger",
        localModelsIncluded: false,
        capTokens: 1000,
        remainingTokens: 900,
        calls: 1,
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 20,
        rawTokens: 120,
        effectiveTokens: 100,
        cacheHitRate: 0.4,
        cacheDiscount: 0.5,
      },
    })
    const wire = JSON.stringify(frame)
    for (const secret of [ledger, "provider-must-not-cross-boundary", "model-must-not-cross-boundary", "private-note-must-not-cross-boundary"]) {
      expect(wire).not.toContain(secret)
    }
  } finally {
    child.kill()
    await child.exited
    // Drain stderr after exit so a failed startup remains diagnosable without
    // ever including ledger contents in the assertion output.
    await stderrText
    rmSync(sandbox, { recursive: true, force: true })
  }
}, 40_000)
