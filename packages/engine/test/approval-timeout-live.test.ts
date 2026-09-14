/**
 * مهلةُ الموافقة — «الصمتُ ليس إذناً» صارت آليّةً لا تعليقاً.
 *
 * القاعدةُ كانت مكتوبةً في تعليق البوّابة منذ البداية بلا ما ينفّذها: سؤالٌ لا
 * يجيبه أحدٌ يعلّق الدورَ إلى الأبد. وهذا الفحصُ يقيس الاتجاهين:
 *
 *   • صمتٌ  ⇒ إطارُ انتهاءٍ مسمّى، ورفضٌ، **وتمامُ الدور** — لا تعليق.
 *   • جوابٌ قبل المهلة ⇒ لا إطارَ انتهاءٍ أبداً، ولو انتظرنا بعده.
 *
 * والثاني شرطُ المعنى: بدونه كان «انتهت» يعني «المؤقّتُ يضرب دائماً» لا
 * «يضرب حين يجب».
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const REPO = resolve(import.meta.dir, "../../..")
const TIMEOUT_SECONDS = 10

interface Wire {
  readonly seen: Record<string, unknown>[]
  readonly send: (frame: Readonly<Record<string, unknown>>) => Promise<void>
  readonly until: (test: () => boolean, why: string, ms?: number) => Promise<void>
  readonly stop: () => Promise<void>
}

const openEngine = async (state: string): Promise<Wire> => {
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: REPO,
    env: {
      ...process.env,
      ABDO_SHELL_TOKEN: "expiry-token",
      ABDO_FRAMED_STDIO: "1",
      ABDO_CODE_STATE_DIR: state,
      ABDO_CODE_SETTINGS: join(state, "settings.json"),
      ABDO_VAULT_HOME: state,
      USERPROFILE: state,
      HOME: state,
    },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const decoder = new LocalJsonFrameDecoder()
  const reader = child.stdout.getReader()
  const seen: Record<string, unknown>[] = []
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  const until = async (test: () => boolean, why: string, ms = 40_000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!test()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${why}; frames=${JSON.stringify(seen).slice(0, 900)}`)
      pending ??= reader.read()
      const got = await Promise.race([pending, Bun.sleep(150).then(() => undefined)])
      if (got === undefined) continue
      pending = undefined
      if (got.done) return
      for (const frame of decoder.push(got.value)) seen.push(frame as Record<string, unknown>)
    }
  }
  const send = async (frame: Readonly<Record<string, unknown>>): Promise<void> => {
    child.stdin.write(encodeLocalJsonFrame(frame))
    await child.stdin.flush()
  }
  return { seen, send, until, stop: async () => { child.kill(); await child.exited } }
}

/** حالةٌ مهيّأةٌ بمهلةٍ قصيرةٍ وخادم MCP يُوصَل، فيقف نداؤه على البوّابة. */
const prepared = (): { state: string; server: string } => {
  const state = mkdtempSync(join(tmpdir(), "abdo-expiry-"))
  const server = join(state, "probe-mcp.mjs")
  writeFileSync(server, [
    'const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n")',
    'let buffer = ""',
    'process.stdin.on("data", (chunk) => {',
    '  buffer += chunk.toString()',
    '  let cut',
    '  while ((cut = buffer.indexOf("\\n")) >= 0) {',
    '    const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1)',
    '    if (!line.trim()) continue',
    '    let request; try { request = JSON.parse(line) } catch { continue }',
    '    if (request.id === undefined) continue',
    '    if (request.method === "initialize") { send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: {}, serverInfo: { name: "probe", version: "1" } } }); continue }',
    '    if (request.method === "tools/list") { send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] } }); continue }',
    '    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "pong" }] } })',
    '  }',
    '})',
  ].join("\n"))
  writeFileSync(join(state, "settings.json"), JSON.stringify({
    approvalTimeoutSeconds: TIMEOUT_SECONDS,
    plugins: { mcpClient: true },
  }), "utf-8")
  return { state, server }
}

const forward = (path: string): string => path.split("\\").join("/")

describe("مهلةُ الموافقة عبر المحرّك الحيّ", () => {
  test("صمتٌ ⇒ انتهاءٌ مسمّى ورفضٌ وتمامُ الدور — لا تعليقَ إلى الأبد", async () => {
    const { state, server } = prepared()
    const wire = await openEngine(state)
    try {
      await wire.send({ kind: "hello", shell: "desktop", token: "expiry-token" })
      await wire.until(() => wire.seen.some((f) => f.kind === "ready"), "ready")
      // المهلةُ المقروءةُ من الإعدادات تصل القشرة كما كُتبت.
      const ready = wire.seen.find((f) => f.kind === "ready")!
      expect((ready.settings as { approvalTimeoutSeconds?: number }).approvalTimeoutSeconds).toBe(TIMEOUT_SECONDS)

      await wire.send({ kind: "external-connect", id: "probe", protocol: "mcp", command: [process.execPath, forward(server)] })
      await wire.until(() => wire.seen.some((f) => f.kind === "external"), "the connected server")

      await wire.send({ kind: "submit", turn: { id: "t1", body: "probe.ping {}" } })
      await wire.until(() => wire.seen.some((f) => f.kind === "approval"), "the approval")

      // ولا نجيب. المهلةُ عشرُ ثوانٍ، فننتظر خمس عشرة.
      await wire.until(() => wire.seen.some((f) => f.kind === "approval-expired"), "the expiry frame", 30_000)
      const expired = wire.seen.find((f) => f.kind === "approval-expired")!
      expect(expired.turnId).toBe("t1")
      expect(String(expired.request)).toContain("probe.ping")

      // والدورُ **يتمّ** — وهو الفرقُ كلُّه: قبل المهلة كان يقف بلا نهاية.
      await wire.until(() => wire.seen.some((f) => f.kind === "done" && f.turnId === "t1"), "the finished turn")
      const answer = wire.seen.filter((f) => f.kind === "event" && f.turnId === "t1")
        .map((f) => String(f.payload ?? "")).join(" ⏎ ")
      expect(answer).toContain("رُفض")
    } finally {
      await wire.stop()
      rmSync(state, { recursive: true, force: true })
    }
  }, 120_000)

  test("جوابٌ قبل المهلة ⇒ لا إطارَ انتهاءٍ أبداً، ولو انتظرنا بعدها", async () => {
    const { state, server } = prepared()
    const wire = await openEngine(state)
    try {
      await wire.send({ kind: "hello", shell: "desktop", token: "expiry-token" })
      await wire.until(() => wire.seen.some((f) => f.kind === "ready"), "ready")
      await wire.send({ kind: "external-connect", id: "probe", protocol: "mcp", command: [process.execPath, forward(server)] })
      await wire.until(() => wire.seen.some((f) => f.kind === "external"), "the connected server")
      await wire.send({ kind: "submit", turn: { id: "t1", body: "probe.ping {}" } })
      await wire.until(() => wire.seen.some((f) => f.kind === "approval"), "the approval")

      await wire.send({ kind: "approve", turnId: "t1" })
      await wire.until(() => wire.seen.some((f) => f.kind === "done" && f.turnId === "t1"), "the finished turn")
      // ثمّ ننتظر ما بعد المهلة: المؤقّتُ أُلغي، فلا إطارَ متأخّرٌ يصل.
      const settled = Date.now()
      await wire.until(() => Date.now() - settled > (TIMEOUT_SECONDS + 4) * 1_000, "the timeout window to pass", 60_000)
        .catch(() => { /* الانتظارُ نفسُه هو المقصود */ })
      expect(wire.seen.some((f) => f.kind === "approval-expired")).toBe(false)
      // والنداءُ نُفِّذ فعلاً — فالفحصُ ليس «لم يحدث شيء».
      const answer = wire.seen.filter((f) => f.kind === "event" && f.turnId === "t1")
        .map((f) => String(f.payload ?? "")).join(" ⏎ ")
      expect(answer).toContain("pong")
    } finally {
      await wire.stop()
      rmSync(state, { recursive: true, force: true })
    }
  }, 120_000)
})
