/**
 * منحُ اعتمادٍ لخادم MCP — من الخزنة الحقيقيّة إلى بيئة الطفل، ولا مكانَ ثالثاً.
 *
 * هذا أوّلُ مسارٍ في المنتَج يُدخل قيمةَ سرٍّ إلى المحرّك: `vaultGet` كانت
 * مبنيّةً ومُختبَرةً و**بلا مُنادٍ في الإنتاج**، لأنّ عاملَ Rust يقرأ أسرارَه
 * بنفسه. فالفحصُ هنا يقيس ثلاثةَ أشياءَ معاً لا واحداً:
 *
 *   (أ) **يصل**: الطفلُ يرى القيمةَ في المتغيّر الممنوح — بلا هذا كان
 *       «لا يتسرّب» يمرّ لأنّ شيئاً لم يحدث أصلاً.
 *   (ب) **ولا يتسرّب**: لا في إطارٍ يصل القشرة، ولا في ملفّ الإعدادات.
 *   (ج) **ولا يُهرَّب المجرَّدُ عائداً**: الطفلُ لا يرى `ABDO_SHELL_TOKEN` ولا
 *       مقابضَ الخزنة، فالمنحُ ليس باباً حول التجريد.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { vaultSet } from "../src/vault"
import { Mcp } from "../src/mind/mcp"
import { grantableEnvName } from "@abdo/tools/env-strip"

const REPO = resolve(import.meta.dir, "../../..")
const SECRET = "granted-value-4f9a2b7c"
const HANDLE = "custom-mcp-probe"

const forward = (path: string): string => path.split("\\").join("/")

/** خادمُ MCP صغير يبلّغ بيئتَه ثمّ يتكلّم البروتوكول كما ينبغي. */
const fixture = (probe: string): string => [
  'import { writeFileSync } from "node:fs"',
  `writeFileSync(${JSON.stringify(forward(probe))}, JSON.stringify({`,
  '  granted: process.env.MY_TOKEN ?? "absent",',
  '  shellToken: process.env.ABDO_SHELL_TOKEN ?? "absent",',
  '  vaultHome: process.env.ABDO_VAULT_HOME ?? "absent",',
  '}))',
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
  '    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })',
  '  }',
  '})',
].join("\n")

describe("منحُ اعتمادٍ لخادم MCP", () => {
  test("الاعتمادُ يصل الطفلَ من الخزنة، ولا يظهر في إطارٍ ولا في ملفّ الإعدادات", async () => {
    const state = mkdtempSync(join(tmpdir(), "abdo-mcp-grant-"))
    const probe = join(state, "probe.json")
    const server = join(state, "probe-mcp.mjs")
    const settingsFile = join(state, "settings.json")
    writeFileSync(server, fixture(probe))

    // خزنةٌ حقيقيّة في بيتٍ مؤقّت — والقيمةُ تدخلها بالمسار المعتمد وحده.
    const stored = await vaultSet(HANDLE, SECRET, { ABDO_VAULT_HOME: state })
    if ("refusal" in stored) throw new Error(`تعذّر تهيئة الخزنة: ${stored.refusal}`)

    // المنحُ **مقبضٌ لا قيمة**: هذا ما يُكتب في الإعدادات.
    writeFileSync(settingsFile, JSON.stringify({
      mcpServers: [{
        id: "probe",
        command: [process.execPath, forward(server)],
        secrets: [{ env: "MY_TOKEN", handle: HANDLE }],
      }],
    }, null, 2), "utf-8")

    const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
      cwd: REPO,
      env: {
        ...process.env,
        ABDO_SHELL_TOKEN: "grant-test-shell-token",
        ABDO_FRAMED_STDIO: "1",
        ABDO_CODE_STATE_DIR: state,
        ABDO_CODE_SETTINGS: settingsFile,
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
      const pump = async (): Promise<void> => {
        pending ??= reader.read()
        const got = await Promise.race([pending, Bun.sleep(200).then(() => undefined)])
        if (got === undefined) return
        pending = undefined
        if (got.done) return
        for (const frame of decoder.push(got.value)) seen.push(frame as Record<string, unknown>)
      }
      const until = async (test: () => boolean, why: string): Promise<void> => {
        const deadline = Date.now() + 40_000
        while (!test()) {
          if (Date.now() >= deadline) throw new Error(`timed out waiting for ${why}; frames=${JSON.stringify(seen).slice(0, 900)}`)
          await pump()
        }
      }
      const send = async (frame: Readonly<Record<string, unknown>>): Promise<void> => {
        child.stdin.write(encodeLocalJsonFrame(frame))
        await child.stdin.flush()
      }

      await send({ kind: "hello", shell: "desktop", token: "grant-test-shell-token" })
      await until(() => seen.some((f) => f.kind === "ready"), "ready")
      await send({ kind: "external-connect", id: "probe", protocol: "mcp", command: [process.execPath, forward(server)] })
      await until(() => seen.some((f) => f.kind === "external" || f.kind === "refused"), "the connect verdict")

      const refusal = seen.find((f) => f.kind === "refused")
      expect(refusal === undefined ? "" : String(refusal.why)).toBe("")
      await until(() => existsSync(probe), "the child's own report")
      const child_saw = JSON.parse(readFileSync(probe, "utf-8")) as Record<string, string>

      // (أ) يصل — التوأمُ الإيجابيّ الذي يجعل (ب) و(ج) ذواتَ معنى.
      expect(child_saw.granted).toBe(SECRET)
      // (ج) ولا يُهرَّب المجرَّدُ عائداً مع المنح.
      expect(child_saw.shellToken).toBe("absent")
      expect(child_saw.vaultHome).toBe("absent")

      // (ب) ولا يتسرّب: لا إلى القشرة، ولا إلى القرص.
      expect(JSON.stringify(seen)).not.toContain(SECRET)
      expect(readFileSync(settingsFile, "utf-8")).not.toContain(SECRET)
      // والمقبضُ نفسُه يبقى في الإعدادات — فالفحصُ أعلاه ليس «الملفُّ فارغ».
      expect(readFileSync(settingsFile, "utf-8")).toContain(HANDLE)
    } finally {
      child.kill()
      await child.exited
      rmSync(state, { recursive: true, force: true })
    }
  }, 90_000)

  test("مقبضٌ غائبٌ يمنع التوصيل بالاسم — فشلٌ مغلقٌ لا خادمٌ ناقصُ اعتماد", async () => {
    const state = mkdtempSync(join(tmpdir(), "abdo-mcp-grant-missing-"))
    const server = join(state, "probe-mcp.mjs")
    const settingsFile = join(state, "settings.json")
    writeFileSync(server, fixture(join(state, "probe.json")))
    writeFileSync(settingsFile, JSON.stringify({
      mcpServers: [{
        id: "probe",
        command: [process.execPath, forward(server)],
        secrets: [{ env: "MY_TOKEN", handle: "custom-never-stored" }],
      }],
    }), "utf-8")

    const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
      cwd: REPO,
      env: {
        ...process.env,
        ABDO_SHELL_TOKEN: "grant-missing-token",
        ABDO_FRAMED_STDIO: "1",
        ABDO_CODE_STATE_DIR: state,
        ABDO_CODE_SETTINGS: settingsFile,
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
          const got = await Promise.race([pending, Bun.sleep(200).then(() => undefined)])
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
      await send({ kind: "hello", shell: "desktop", token: "grant-missing-token" })
      await until(() => seen.some((f) => f.kind === "ready"), "ready")
      await send({ kind: "external-connect", id: "probe", protocol: "mcp", command: [process.execPath, forward(server)] })
      await until(() => seen.some((f) => f.kind === "refused"), "the named refusal")

      const refusal = seen.find((f) => f.kind === "refused")!
      expect(String(refusal.why)).toContain("custom-never-stored")
      expect(String(refusal.why)).toContain("غيرُ موجودٍ في الخزنة")
      // ولم يُوصَل الخادمُ رغم أنّ أمرَه سليمٌ ويعمل: النقصُ يمنع لا يؤجَّل.
      expect(seen.some((f) => f.kind === "external")).toBe(false)
    } finally {
      child.kill()
      await child.exited
      rmSync(state, { recursive: true, force: true })
    }
  }, 90_000)
})

describe("الحارسُ الثاني — الإعداداتُ تُحرَّر باليد على القرص", () => {
  test("اسمُ متغيّرٍ مجرَّدٍ لا يُمنَح، وحارسُ الجلسة يمنعه ولو تجاوز حارسَ الإعدادات", async () => {
    // القاعدةُ نفسُها خالصةً أوّلاً.
    expect(grantableEnvName("MY_TOKEN")).toBe(true)
    expect(grantableEnvName("ABDO_SHELL_TOKEN")).toBe(false)
    expect(grantableEnvName("ABDO_VAULT_HOME")).toBe(false)
    expect(grantableEnvName("ABDO_VAULT_ANYTHING")).toBe(false)
    // وأسماءٌ غريبةُ الشكل لا تُحقن.
    expect(grantableEnvName("lower")).toBe(false)
    expect(grantableEnvName("HAS SPACE")).toBe(false)
    expect(grantableEnvName("")).toBe(false)

    // ثمّ حيّاً: طبقةٌ خبيثةٌ تُمرَّر إلى الجلسة رأساً — كأنّ ملفّ الإعدادات
    // حُرّر باليد فتجاوز المُتحقِّق. الحارسُ الثاني عند الولادة يمنعها.
    const state = mkdtempSync(join(tmpdir(), "abdo-mcp-smuggle-"))
    const probe = join(state, "probe.json")
    const server = join(state, "probe-mcp.mjs")
    writeFileSync(server, fixture(probe))
    const session = new Mcp.McpSession({
      id: "smuggle",
      command: [process.execPath, forward(server)],
      envOverlay: { MY_TOKEN: "granted-value-4f9a2b7c", ABDO_SHELL_TOKEN: "smuggled", ABDO_VAULT_HOME: "smuggled" },
    })
    try {
      const deadline = Date.now() + 20_000
      while (!existsSync(probe) && Date.now() < deadline) await Bun.sleep(100)
      expect(existsSync(probe)).toBe(true)
      const saw = JSON.parse(readFileSync(probe, "utf-8")) as Record<string, string>
      // المسموحُ يمرّ — وإلّا كان «غائب» يعني «لا طبقةَ أصلاً».
      expect(saw.granted).toBe("granted-value-4f9a2b7c")
      // والمهرَّبُ يسقط، ولو كُتب في الطلب صراحةً.
      expect(saw.shellToken).toBe("absent")
      expect(saw.vaultHome).toBe("absent")
    } finally {
      session.close()
      rmSync(state, { recursive: true, force: true })
    }
  }, 40_000)
})
