/**
 * عميلُ MCP — مقيسٌ على **خادمٍ حقيقيّ**، لا على مُحاكٍ.
 *
 * المستودعُ يشحن خادمَ MCP قياسيّاً (`src/google-search-mcp.ts`). فحصُ عميلٍ
 * بمُحاكٍ يكتبه كاتبُ العميل يثبت أنّ الكاتبَ متّسقٌ مع نفسه لا أنّ السلك
 * يعمل. هنا يُشغَّل الخادمُ عمليّةً حقيقيّة ويُقاس ما يخرج من الأنبوب.
 *
 * والأثقلُ في الملفّ سطرٌ واحد: أنّ الأداةَ تصل بصنف `command` **بينما الخادمُ
 * يُعلن عن نفسه `readOnlyHint: true`**. لو قرأنا تلميحَه لكان كلُّ خادمٍ يُعفي
 * نفسَه من بوّابة الموافقة بسطرٍ في ردّه. هذا الفحصُ هو ما يمنع ذلك الباب.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Mcp } from "../src/mind/mcp"

const REPO = resolve(import.meta.dir, "../../..")

describe("عميل MCP — التحويلات الخالصة", () => {
  test("الصيغةُ تُبنى من المخطّط: المطلوبُ أوّلاً وبقوسين، والاختياريُّ بمعقوفين", () => {
    const schema = { type: "object", properties: { query: { type: "string" }, count: { type: "number" }, site: { type: "string" } }, required: ["query"] }
    expect(Mcp.usageFromSchema("google_search", schema)).toBe("google_search <query> [count] [site]")
    // مخطّطٌ بلا خانات: الاسمُ وحده، لا `<معطيات>` مخترعة.
    expect(Mcp.usageFromSchema("ping", { type: "object" })).toBe("ping")
    // ‏`required` يذكر مفتاحاً غيرَ معلَنٍ في `properties` — يُتجاهل لا يُصدَّق.
    expect(Mcp.usageFromSchema("t", { properties: { a: {} }, required: ["ghost", "a"] })).toBe("t <a>")
  })

  test("المعطياتُ تُحوَّل حتميّاً — وما التبس يُرفض بمفاتيحه لا يُخمَّن", () => {
    const one = { properties: { query: { type: "string" } }, required: ["query"] }
    const two = { properties: { path: { type: "string" }, body: { type: "string" } }, required: ["path", "body"] }

    // كائنُ JSON يُقبل كما هو.
    expect(Mcp.argumentsFor('{"query":"riyadh","count":3}', one)).toEqual({ ok: true, value: { query: "riyadh", count: 3 } })
    // نصٌّ حرٌّ لخانةٍ نصّيّةٍ واحدةٍ لا لبسَ فيها.
    expect(Mcp.argumentsFor("riyadh weather", one)).toEqual({ ok: true, value: { query: "riyadh weather" } })
    // خانتان مطلوبتان: التخمينُ ممنوع، والرفضُ يسمّي المفاتيح.
    const refused = Mcp.argumentsFor("something", two)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.why).toContain("path")
    // فراغٌ مع مطلوب = رفضٌ مسمّى؛ وفراغٌ بلا مطلوب = كائنٌ فارغ.
    expect(Mcp.argumentsFor("", one).ok).toBe(false)
    expect(Mcp.argumentsFor("", { properties: {} })).toEqual({ ok: true, value: {} })
    // ‏JSON مكسورٌ يُرفض ولا يُعامَل نصّاً حرّاً — وإلّا مرّ `{"a":` خانةً نصّيّة.
    const broken = Mcp.argumentsFor('{"query":', one)
    expect(broken.ok).toBe(false)
    // وخانةٌ واحدةٌ غيرُ نصّيّة لا تبتلع نصّاً حرّاً.
    expect(Mcp.argumentsFor("12", { properties: { count: { type: "number" } }, required: ["count"] }).ok).toBe(false)
  })

  test("النتيجةُ تُقرأ نصّاً، وغيرُ النصّيّ يُسمّى بنوعه ولا يُبتلع", () => {
    expect(Mcp.textOfResult({ content: [{ type: "text", text: "أ" }, { type: "text", text: "ب" }] })).toBe("أ\nب")
    expect(Mcp.textOfResult({ content: [{ type: "image", data: "..." }] })).toBe("[image]")
    expect(Mcp.textOfResult({ content: [] })).toBe("")
  })
})

describe("عميل MCP — على خادم المستودع الحقيقيّ", () => {
  test("المصافحةُ تُعلن الأداةَ منسوبةً، وبصنف command رغم إعلان الخادم أنّه للقراءة", async () => {
    const session = new Mcp.McpSession({ id: "gsearch", command: [process.execPath, join(REPO, "packages/engine/src/google-search-mcp.ts")] })
    try {
      const tools = await session.handshake(20_000)
      expect(tools).toHaveLength(1)
      const tool = tools[0]!
      // الاسمُ منسوبٌ فلا يُظلَّل اسمٌ أصليّ.
      expect(tool.name).toBe("gsearch.google_search")
      // ⚠ السطرُ الحاكم: الخادمُ يعلن `annotations.readOnlyHint: true`، والصنفُ
      // يصل `command` — فيقف على بوّابة الموافقة. إقرارُ طرفٍ ثالثٍ عن نفسه
      // ليس دليلاً، وقراءتُه هنا بابٌ حول البوّابة.
      expect(tool.effect).toBe("command")
      const declared = await Bun.file(join(REPO, "packages/engine/src/google-search-mcp.ts")).text()
      expect(declared).toContain("readOnlyHint: true")
      // الصيغةُ تبدأ بالاسم الشرعيّ (شرطُ الهارنس) وتحمل الخانة المطلوبة.
      expect(tool.usage.startsWith("gsearch.google_search")).toBe(true)
      expect(tool.usage).toContain("<query>")
      expect(tool.summary.length).toBeGreaterThan(0)
    } finally {
      session.close()
    }
  }, 40_000)

  test("خطأُ البروتوكول من الخادم يصل بنصّه، ولا يُبتلع في نجاحٍ صامت", async () => {
    const session = new Mcp.McpSession({ id: "gsearch", command: [process.execPath, join(REPO, "packages/engine/src/google-search-mcp.ts")] })
    try {
      expect(await session.handshake(20_000)).toHaveLength(1)
      // كائنٌ صالحٌ محلّيّاً وناقصٌ عند الخادم: يعبر عميلَنا ويُرفض هناك.
      const answer = await session.call("gsearch.google_search", "{}", 15_000)
      expect(answer.ok).toBe(false)
      expect(answer.text).toContain("Invalid tool arguments")
      // وأداةٌ لا وجودَ لها تُرفض عندنا قبل أن تُزعج الخادم.
      const missing = await session.call("gsearch.nope", "{}", 5_000)
      expect(missing.ok).toBe(false)
      expect(missing.text).toContain("لا أداةَ باسم nope")
    } finally {
      session.close()
    }
  }, 40_000)
})

describe("عميل MCP — نداءٌ ناجح وفشلُ أداةٍ مُعلَن", () => {
  test("النداءُ يعبر ويعود بنصّه، و isError يصير حكماً لا نجاحاً", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-mcp-echo-"))
    const server = join(dir, "echo-mcp.mjs")
    // خادمٌ صغير يتكلّم MCP فعلاً — عمليّةٌ حقيقيّةٌ على أنبوبٍ حقيقيّ.
    writeFileSync(server, [
      'const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n")',
      'const TOOLS = [',
      '  { name: "echo", description: "يردّ ما أُعطي", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },',
      '  { name: "boom", description: "يفشل مُعلِناً", inputSchema: { type: "object", properties: {} } },',
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
      '    if (request.method === "initialize") { send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: {}, serverInfo: { name: "echo", version: "1" } } }); continue }',
      '    if (request.method === "tools/list") { send({ jsonrpc: "2.0", id: request.id, result: { tools: TOOLS } }); continue }',
      '    if (request.method === "tools/call") {',
      '      const name = request.params.name',
      '      if (name === "boom") { send({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: "سقطت الأداة" }] } }); continue }',
      '      send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "صدى: " + request.params.arguments.text }] } }); continue',
      '    }',
      '    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })',
      '  }',
      '})',
    ].join("\n"))

    const session = new Mcp.McpSession({ id: "echo", command: [process.execPath, server] })
    try {
      const tools = await session.handshake(15_000)
      expect(tools.map((t) => t.name)).toEqual(["echo.echo", "echo.boom"])
      // نصٌّ حرٌّ ← الخانةُ النصّيّةُ الواحدة، ثمّ عبورٌ حقيقيٌّ وعودة.
      expect(await session.call("echo.echo", "مرحباً", 10_000)).toEqual({ ok: true, text: "صدى: مرحباً" })
      // فشلُ الأداة يُعلَن داخل النتيجة في MCP — فيصير حكماً عندنا لا نجاحاً
      // نصُّه رسالةُ الخطأ. هذا هو الفرقُ بين «رُفضت» و«نجحت وقالت لا».
      expect(await session.call("echo.boom", "", 10_000)).toEqual({ ok: false, text: "سقطت الأداة" })
      // وأداةٌ بلا مطلوبٍ تُنادى بلا معطيات.
      expect(session.tools().find((t) => t.name === "echo.boom")!.usage).toBe("echo.boom")

      // موتُ الخادم يُفرغ أدواته: قائمةٌ لخادمٍ ميتٍ كذبةٌ صامتة.
      session.close()
      expect(session.tools()).toEqual([])
    } finally {
      session.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 40_000)
})

/**
 * البوّابة عبر المحرّك الحيّ — الاتجاهان.
 *
 * «المعطَّل يعني **غير محمَّل** لا مخفيّاً»: طلبُ التوصيل بـmcp والمفتاحُ مطفأ
 * يُرفض **قبل** `await import`، فلا وحدةَ تدخل الذاكرة. والفحصُ السلبيّ وحده
 * كان يمرّ لو أنّ التوصيل لا يعمل أصلاً — فمعه توأمُه: المفتاحُ مُشغَّلٌ
 * فتصل الأداةُ إلى الكتالوج بصنفها المشدَّد.
 */
describe("عميل MCP — البوّابة عبر المحرّك الحيّ", () => {
  const drive = async (pluginOn: boolean): Promise<Record<string, unknown>[]> => {
    const state = mkdtempSync(join(tmpdir(), "abdo-mcp-serve-"))
    const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
      cwd: REPO,
      env: {
        ...process.env,
        ABDO_SHELL_TOKEN: "mcp-gate-token",
        ABDO_FRAMED_STDIO: "1",
        ABDO_CODE_STATE_DIR: state,
        ABDO_CODE_SETTINGS: join(state, "settings.json"),
        USERPROFILE: state,
        HOME: state,
        ...(pluginOn ? { ABDO_PLUGIN_MCP_CLIENT: "1" } : {}),
      },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    })
    const decoder = new LocalJsonFrameDecoder()
    const reader = child.stdout.getReader()
    const seen: Record<string, unknown>[] = []
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
    const pump = async (): Promise<void> => {
      pending ??= reader.read()
      const got = await Promise.race([pending, Bun.sleep(250).then(() => undefined)])
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
    try {
      await send({ kind: "hello", shell: "desktop", token: "mcp-gate-token" })
      await until(() => seen.some((f) => f.kind === "ready"), "ready")
      await send({
        kind: "external-connect",
        id: "gsearch",
        protocol: "mcp",
        command: [process.execPath, join(REPO, "packages/engine/src/google-search-mcp.ts")],
      })
      await until(() => seen.some((f) => f.kind === "external" || f.kind === "refused"), "the connect verdict")
      return seen
    } finally {
      child.kill()
      await child.exited
      rmSync(state, { recursive: true, force: true })
    }
  }

  test("المفتاحُ مطفأٌ افتراضاً فيُرفض التوصيل بالاسم — ولا وحدةَ تُحمَّل", async () => {
    const seen = await drive(false)
    const refusal = seen.find((f) => f.kind === "refused")
    expect(refusal).toBeDefined()
    expect(String(refusal!.why)).toContain("عميل MCP معطَّل")
    // ولم يصل إعلانُ أدوات: الرفضُ سبق التوصيل لا تبعه.
    expect(seen.some((f) => f.kind === "external")).toBe(false)
    // والمفتاحُ يظهر مطفأً في سجلّ الإضافات الذي أرسله المحرّك مع ready.
    const ready = seen.find((f) => f.kind === "ready")!
    const effective = (ready.pluginRegistry as { effective: Record<string, boolean> }).effective
    expect(effective.mcpClient).toBe(false)
  }, 90_000)

  test("والتوأمُ الإيجابيّ: مع تشغيل المفتاح تصل الأداةُ إلى الكتالوج بصنفها المشدَّد", async () => {
    const seen = await drive(true)
    const announced = seen.find((f) => f.kind === "external")
    expect(announced).toBeDefined()
    expect(announced!.id).toBe("gsearch")
    const tools = announced!.tools as { name: string; effect: string }[]
    expect(tools.map((t) => t.name)).toEqual(["gsearch.google_search"])
    // البوّابةُ تبقى على الطريق حتى بعد التشغيل: الصنفُ `command` لا `read`.
    expect(tools[0]!.effect).toBe("command")
    expect(seen.some((f) => f.kind === "refused")).toBe(false)
  }, 90_000)
})
