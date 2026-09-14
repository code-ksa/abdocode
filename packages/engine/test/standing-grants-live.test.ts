/**
 * المنحُ القائم عبر المحرّك الحيّ — الحلقةُ كاملةً على أنبوبٍ حقيقيّ.
 *
 * المُخفِّضُ النقيُّ مُقاسٌ وحده في `standing-grants.test.ts`. هنا السؤالُ الآخر،
 * وهو الذي لا يجيب عنه مُخفِّض: **هل تستشيره البوّابةُ فعلاً، وهل يُعلَن المرور،
 * وهل يعود السؤالُ بعد النقض؟** فالمسارُ الحقيقيّ: خادمُ MCP يُوصَل، وأداتُه
 * تُستدعى بلا نموذج (الكلمةُ الأولى أداةٌ فتُوزَّع رأساً)، والبوّابةُ تسأل لأنّ
 * صنفَها `command` في نمط «قراءة فقط».
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const REPO = resolve(import.meta.dir, "../../..")
const forward = (path: string): string => path.split("\\").join("/")

/** خادمُ MCP بأداتين — كي يُقاس أنّ نطاقَ المزوّد يغطّي الثانيةَ بلا سؤالٍ ثانٍ. */
const FIXTURE = [
  'const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n")',
  'const TOOLS = [',
  '  { name: "ping", description: "يردّ pong", inputSchema: { type: "object", properties: {} } },',
  '  { name: "pong", description: "يردّ ping", inputSchema: { type: "object", properties: {} } },',
  ']',
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
  '    if (request.method === "tools/list") { send({ jsonrpc: "2.0", id: request.id, result: { tools: TOOLS } }); continue }',
  '    if (request.method === "tools/call") { send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "ok:" + request.params.name }] } }); continue }',
  '    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })',
  '  }',
  '})',
].join("\n")

describe("المنحُ القائم — عبر المحرّك الحيّ", () => {
  test("سؤالٌ مرّةً، ثمّ منحٌ بنطاقِ المزوّد يمرّ مُعلَناً، ثمّ نقضٌ يعيد السؤال", async () => {
    const state = mkdtempSync(join(tmpdir(), "abdo-grants-live-"))
    const server = join(state, "probe-mcp.mjs")
    writeFileSync(server, FIXTURE)

    const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
      cwd: REPO,
      env: {
        ...process.env,
        ABDO_SHELL_TOKEN: "grants-live-token",
        ABDO_FRAMED_STDIO: "1",
        ABDO_CODE_STATE_DIR: state,
        ABDO_CODE_SETTINGS: join(state, "settings.json"),
        ABDO_VAULT_HOME: state,
        ABDO_PLUGIN_MCP_CLIENT: "1",
        ABDO_PLUGIN_STANDING_GRANTS: "1",
        USERPROFILE: state,
        HOME: state,
      },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    })
    try {
      const decoder = new LocalJsonFrameDecoder()
      const reader = child.stdout.getReader()
      const seen: Record<string, unknown>[] = []
      let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
      const until = async (test: () => boolean, why: string): Promise<void> => {
        const deadline = Date.now() + 40_000
        while (!test()) {
          if (Date.now() >= deadline) throw new Error(`timed out waiting for ${why}; frames=${JSON.stringify(seen).slice(0, 1200)}`)
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
      const approvals = (): Record<string, unknown>[] => seen.filter((f) => f.kind === "approval")
      const unlocked = (): Record<string, unknown>[] => seen.filter((f) => f.kind === "event" && String(f.payload ?? "").includes("🔓"))

      await send({ kind: "hello", shell: "desktop", token: "grants-live-token" })
      await until(() => seen.some((f) => f.kind === "ready"), "ready")
      await send({ kind: "external-connect", id: "probe", protocol: "mcp", command: [process.execPath, forward(server)] })
      await until(() => seen.some((f) => f.kind === "external"), "the connected server")

      // (١) أوّلُ نداءٍ يُسأل — والسؤالُ يحمل الهدفَ والنطاقاتِ المتاحة.
      await send({ kind: "submit", turn: { id: "t1", body: "probe.ping {}" } })
      await until(() => approvals().length >= 1, "the first approval")
      const asked = approvals()[0]!
      expect(asked.target).toBe("probe.ping")
      expect(asked.class).toBe("command")
      expect(asked.scopes).toEqual(["tool", "namespace"])

      // (٢) موافقةٌ بنطاق المزوّد ⇒ منحٌ واحدٌ يُبثّ.
      await send({ kind: "approve", turnId: "t1", scope: "namespace" })
      // ويُنتظَر تمامُ الدور قبل الذي يليه: المحرّكُ يرفض دورين معاً («اقطعه
      // قبل بدء محادثةٍ جديدة»)، فإرسالٌ مبكّرٌ يُرفض — وهو سباقٌ في الفحص لا
      // عطلٌ في المنتَج: يجتاز منفرداً ويسقط تحت الحِمل.
      await until(() => seen.some((f) => f.kind === "done" && f.turnId === "t1"), "the first turn to finish")
      await until(() => seen.some((f) => f.kind === "grants"), "the grants broadcast")
      const granted = seen.filter((f) => f.kind === "grants").at(-1)!
      expect(granted.grants).toEqual([{ request: "command", target: "probe.*" }])

      // (٣) نداءٌ ثانٍ **لأداةٍ أخرى** من المزوّد نفسِه: يمرّ بلا سؤال، ويُعلَن.
      const before = approvals().length
      await send({ kind: "submit", turn: { id: "t2", body: "probe.pong {}" } })
      await until(() => seen.some((f) => f.kind === "done" && f.turnId === "t2"), "the second turn to finish")
      await until(() => unlocked().length >= 1, "the announced pass")
      expect(String(unlocked()[0]!.payload)).toContain("probe.pong")
      expect(String(unlocked()[0]!.payload)).toContain("probe.*")
      // ولم يُطرح سؤالٌ جديد: هذا هو الفرقُ الذي يُقاس.
      expect(approvals().length).toBe(before)

      // (٤) النقضُ يُفرغ القائمة، والسؤالُ يعود — فالمنحُ ليس بلا رجعة.
      await send({ kind: "grant-revoke", request: "command", target: "probe.*" })
      await until(() => (seen.filter((f) => f.kind === "grants").at(-1)!.grants as unknown[]).length === 0, "the empty grants")
      await send({ kind: "submit", turn: { id: "t3", body: "probe.ping {}" } })
      await until(() => approvals().length > before, "the approval that returned")
      expect(approvals().at(-1)!.target).toBe("probe.ping")
    } finally {
      child.kill()
      await child.exited
      rmSync(state, { recursive: true, force: true })
    }
  }, 120_000)

  test("المفتاحُ مطفأٌ افتراضاً: لا نطاقاتٍ تُعرض، والموافقةُ بنطاقٍ تُرفض بالاسم", async () => {
    const state = mkdtempSync(join(tmpdir(), "abdo-grants-off-"))
    const server = join(state, "probe-mcp.mjs")
    writeFileSync(server, FIXTURE)
    const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
      cwd: REPO,
      env: {
        ...process.env,
        ABDO_SHELL_TOKEN: "grants-off-token",
        ABDO_FRAMED_STDIO: "1",
        ABDO_CODE_STATE_DIR: state,
        ABDO_CODE_SETTINGS: join(state, "settings.json"),
        ABDO_VAULT_HOME: state,
        ABDO_PLUGIN_MCP_CLIENT: "1",
        USERPROFILE: state,
        HOME: state,
      },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    })
    try {
      const decoder = new LocalJsonFrameDecoder()
      const reader = child.stdout.getReader()
      const seen: Record<string, unknown>[] = []
      let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
      const until = async (test: () => boolean, why: string): Promise<void> => {
        const deadline = Date.now() + 40_000
        while (!test()) {
          if (Date.now() >= deadline) throw new Error(`timed out waiting for ${why}`)
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
      await send({ kind: "hello", shell: "desktop", token: "grants-off-token" })
      await until(() => seen.some((f) => f.kind === "ready"), "ready")
      // المفتاحُ مطفأٌ في السجلّ المُعلَن — لا ادّعاء.
      const ready = seen.find((f) => f.kind === "ready")!
      expect((ready.pluginRegistry as { effective: Record<string, boolean> }).effective.standingGrants).toBe(false)

      await send({ kind: "external-connect", id: "probe", protocol: "mcp", command: [process.execPath, forward(server)] })
      await until(() => seen.some((f) => f.kind === "external"), "the connected server")
      await send({ kind: "submit", turn: { id: "t1", body: "probe.ping {}" } })
      await until(() => seen.some((f) => f.kind === "approval"), "the approval")
      // لا نطاقاتٍ تُعرض والمفتاحُ مطفأ: القشرةُ لا تعرض زرّاً بلا مُنفِّذ.
      expect(seen.find((f) => f.kind === "approval")!.scopes).toEqual([])

      // وموافقةٌ بنطاقٍ رغم ذلك: تُنفَّذ الموافقةُ ويُرفض المنحُ **بالاسم**.
      await send({ kind: "approve", turnId: "t1", scope: "namespace" })
      await until(() => seen.some((f) => f.kind === "refused" && String(f.why).includes("standingGrants")), "the named refusal")
      expect(seen.some((f) => f.kind === "grants")).toBe(false)
    } finally {
      child.kill()
      await child.exited
      rmSync(state, { recursive: true, force: true })
    }
  }, 120_000)
})
