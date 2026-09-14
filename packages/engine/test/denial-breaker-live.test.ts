/**
 * قاطعُ الرفض عبر المحرّك الحيّ — والعرضُ يسبق القطع.
 *
 * العطلُ الذي يعالجه ليس ثغرةً في البوّابة بل في **صبر من يقف عليها**: نموذجٌ
 * يعيد ما رُفض فيُسأل المشغّلُ مراراً حتى يملّ فيوافق.
 *
 * والفحصُ يقيس الفصلَ الذي فرضه القانون:
 *   • **العرضُ بلا مفتاح** — `deniedBefore` يركب كلَّ سؤالٍ ولو كان القاطعُ مطفأً.
 *   • **والقطعُ خلف مفتاحه** — مطفأً يُسأل رابعاً، ومشغَّلاً يُقطع بلا سؤال.
 *   • **وللقطع مخرج** — المحوُ يعيد السؤال، فرفضٌ بلا رجعةٍ عطلٌ لا حماية.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const REPO = resolve(import.meta.dir, "../../..")
const forward = (path: string): string => path.split("\\").join("/")

const FIXTURE = [
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
].join("\n")

const drive = async (breakerOn: boolean): Promise<Record<string, unknown>[]> => {
  const state = mkdtempSync(join(tmpdir(), "abdo-breaker-"))
  const server = join(state, "probe-mcp.mjs")
  writeFileSync(server, FIXTURE)
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: REPO,
    env: {
      ...process.env,
      ABDO_SHELL_TOKEN: "breaker-token",
      ABDO_FRAMED_STDIO: "1",
      ABDO_CODE_STATE_DIR: state,
      ABDO_CODE_SETTINGS: join(state, "settings.json"),
      ABDO_VAULT_HOME: state,
      ABDO_PLUGIN_MCP_CLIENT: "1",
      ...(breakerOn ? { ABDO_PLUGIN_DENIAL_BREAKER: "1" } : {}),
      USERPROFILE: state,
      HOME: state,
    },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const decoder = new LocalJsonFrameDecoder()
  const reader = child.stdout.getReader()
  const seen: Record<string, unknown>[] = []
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  const until = async (test: () => boolean, why: string): Promise<void> => {
    const deadline = Date.now() + 40_000
    while (!test()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${why}; frames=${JSON.stringify(seen).slice(0, 900)}`)
      pending ??= reader.read()
      const got = await Promise.race([pending, Bun.sleep(120).then(() => undefined)])
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
  try {
    await send({ kind: "hello", shell: "desktop", token: "breaker-token" })
    await until(() => seen.some((f) => f.kind === "ready"), "ready")
    await send({ kind: "external-connect", id: "probe", protocol: "mcp", command: [process.execPath, forward(server)] })
    await until(() => seen.some((f) => f.kind === "external"), "the connected server")

    // ثلاثةُ أدوارٍ تُرفض واحداً واحداً.
    for (const turn of ["d1", "d2", "d3"]) {
      await send({ kind: "submit", turn: { id: turn, body: "probe.ping {}" } })
      await until(() => seen.some((f) => f.kind === "approval" && f.turnId === turn), `the approval for ${turn}`)
      await send({ kind: "deny", turnId: turn })
      await until(() => seen.some((f) => f.kind === "done" && f.turnId === turn), `${turn} to finish`)
    }
    // ورابعٌ: يُسأل أم يُقطع؟ هذا هو الفرق.
    await send({ kind: "submit", turn: { id: "d4", body: "probe.ping {}" } })
    await until(
      () => seen.some((f) => f.kind === "approval" && f.turnId === "d4") || seen.some((f) => f.kind === "done" && f.turnId === "d4"),
      "the fourth verdict",
    )
    // ومطفأً يُسأل الرابعُ فيجب أن يُجاب، وإلّا عُلِّق الدورُ فلا يبدأ الخامس:
    // المحرّكُ يرفض دورين معاً. (سباقٌ في الفحص لا عطلٌ في المنتَج.)
    if (seen.some((f) => f.kind === "approval" && f.turnId === "d4")) {
      await send({ kind: "deny", turnId: "d4" })
    }
    await until(() => seen.some((f) => f.kind === "done" && f.turnId === "d4"), "d4 to finish")

    // وبعده: محوُ العدّاد ثمّ سؤالٌ خامس.
    await send({ kind: "denial-reset", request: "command", target: "probe.ping" })
    await until(() => {
      const rows = seen.filter((f) => f.kind === "denials").at(-1)?.denials as unknown[] | undefined
      return rows !== undefined && rows.length === 0
    }, "the cleared counter")
    await send({ kind: "submit", turn: { id: "d5", body: "probe.ping {}" } })
    await until(() => seen.some((f) => f.kind === "approval" && f.turnId === "d5"), "the approval that returned")
    return seen
  } finally {
    child.kill()
    await child.exited
    rmSync(state, { recursive: true, force: true })
  }
}

describe("قاطعُ الرفض — عبر المحرّك الحيّ", () => {
  test("مطفأً: التاريخُ يُعرض في كلّ سؤال، والرابعُ يُسأل ولا يُقطع", async () => {
    const seen = await drive(false)
    const asks = seen.filter((f) => f.kind === "approval")
    // العرضُ بلا مفتاح: الأوّلُ صفرٌ، والرابعُ ثلاثة.
    expect(asks.map((f) => f.deniedBefore)).toEqual([0, 1, 2, 3, 0])
    expect(asks.map((f) => f.turnId)).toEqual(["d1", "d2", "d3", "d4", "d5"])
    // ولم يُقطع شيء: الرابعُ سُئل كإخوته.
    expect(seen.some((f) => f.kind === "refused" && String(f.why).includes("فقُطع"))).toBe(false)
    // والعدّادُ بُثّ للقشرة.
    const rows = seen.filter((f) => f.kind === "denials")
    expect(rows.length).toBeGreaterThan(0)
  }, 120_000)

  test("مشغَّلاً: الرابعُ يُقطع بلا سؤال، والمحوُ يعيد السؤال", async () => {
    const seen = await drive(true)
    const asks = seen.filter((f) => f.kind === "approval")
    // ثلاثةُ أسئلةٍ فقط ثمّ قطع — والخامسُ بعد المحو.
    expect(asks.map((f) => f.turnId)).toEqual(["d1", "d2", "d3", "d5"])
    const cut = seen.find((f) => f.kind === "refused" && String(f.why).includes("فقُطع"))
    expect(cut).toBeDefined()
    expect(String(cut!.why)).toContain("probe.ping")
    // ورفضٌ بلا مخرجٍ عطلٌ لا حماية: السطرُ يقول كيف يُمحى.
    expect(String(cut!.why)).toContain("الصلاحيات")
    // والخامسُ حمل تاريخاً صفراً بعد المحو.
    expect(asks.at(-1)!.deniedBefore).toBe(0)
  }, 120_000)
})
