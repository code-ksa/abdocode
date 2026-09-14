import { describe, expect, test } from "bun:test"
import { decodeChatResponse } from "@abdo/model-gateway"
import { nativeToolReply, nativeToolDefinition, nativeAgentSystem, dropOldestExchange } from "../src/native-agent-tools"
import { TOOLS } from "@abdo/tools"

const names = new Map([['abdo_write', 'write'], ['abdo_edit', 'edit'], ['abdo_run', 'run']])
const response = (name: string, input: unknown, finish = "stop") => decodeChatResponse("native-ollama", {
  message: { content: "سأصلح الملف", tool_calls: [{ function: { name, arguments: input } }] }, done_reason: finish,
})
describe("native tool surface", () => {
  test("keeps file bytes separate from explanation and preserves delimiters and whitespace", () => {
    const content = '\n```ts\nconst fn = () => `نفّذ: غير قابل للتنفيذ`;\n```\n'
    const reply = nativeToolReply(response("abdo_write", { path: "README.md", content }), names)
    expect(typeof reply).toBe("object")
    if (typeof reply === "string") throw new Error(reply)
    expect(reply.call.input).toEqual({ path: "README.md", content })
    expect(reply.command).toBe(`write README.md <<<\n${content}`)
    expect(reply.command).not.toContain("سأصلح الملف")
  })
  test("rejects truncation, unknown tools, extra fields, multiline shell, invalid objects and batches", () => {
    for (const turn of [
      response("abdo_write", { path: "a", content: "partial" }, "length"),
      response("delete", { path: "a" }), response("abdo_write", { path: "a", content: "x", execute: true }),
      response("abdo_run", { command: "npm test\nشرح" }), response("abdo_run", ["npm test"]),
      response("abdo_edit", { path: "a", old_text: "", new_text: "x" }),
      { ...response("abdo_run", { command: "npm test" }), calls: [] },
      { ...response("abdo_run", { command: "npm test" }), calls: [response("abdo_run", {}).calls[0]!, response("abdo_run", {}).calls[0]!] },
    ]) expect(nativeToolReply(turn, names)).toMatch(/^رُفض إخراج النموذج:/u)
  })
  test("typed edit has no delimiter ambiguity", () => {
    const args = { path: "a.ts", old_text: "() => 1", new_text: "() => 2\n" }
    expect(nativeToolReply(response("abdo_edit", args), names)).toMatchObject({ call: { input: args } })
  })
  test("schemas come from the registry, and a tool outside it still gets an honest shape", () => {
    const tool = { legalName: "write", usage: "write path", description: "write", parameters: {} }
    expect(nativeToolDefinition(tool)?.parameters).toMatchObject({ required: ["path", "content"], additionalProperties: false })
    // أداةُ مزوّدٍ خارجيّ ليست في السجلّ. كان هذا يعيد `undefined` فتسقط
    // صامتةً على المسار الأصيل بينما يعدّها المُوزِّع قابلةً للنداء — العطلُ
    // نفسُه الذي أسقط المتصفّحَ والبحث، طبقةً أعلى. شكلُها من صيغتها:
    const external = { legalName: "mcp.search", usage: "mcp.search <q>", description: "x", parameters: {} }
    expect(nativeToolDefinition(external)?.parameters).toMatchObject({ required: ["input"] })
    // وبلا وسائط: صيغتُها اسمُها.
    const bare = { legalName: "mcp.ping", usage: "mcp.ping", description: "x", parameters: {} }
    expect(nativeToolDefinition(bare)?.parameters).toMatchObject({ required: [] })
    // 2026-09-13: «page [styles]» و«shot [full]» — الحقلُ معلَنٌ وغيرُ إلزاميّ: النداءُ العاري يمرّ، والوسيطُ يُمرَّر حين يُعطى.
    for (const name of ["page", "shot"]) {
      const tool = TOOLS.find((t) => t.name === name)!
      const shape = nativeToolDefinition({ ...tool, legalName: tool.name } as never)!.parameters as { required: string[]; properties: Record<string, unknown> }
      expect(shape.required).toEqual([])
      expect(Object.keys(shape.properties)).toEqual(["input"])
      const names = new Map([[`abdo_${name}`, name]])
      const bareCall = nativeToolReply({ truncated: false, finishReason: "stop", text: "", calls: [{ name: `abdo_${name}`, input: {} }] } as never, names)
      expect(typeof bareCall === "string" ? bareCall : bareCall.command).toBe(name)
      const withArg = nativeToolReply({ truncated: false, finishReason: "stop", text: "", calls: [{ name: `abdo_${name}`, input: { input: name === "page" ? "styles" : "full" } }] } as never, names)
      expect(typeof withArg === "string" ? withArg : withArg.command).toBe(name === "page" ? "page styles" : "shot full")
    }
    // والاحتواءُ لم يُفتح: الردُّ يرفض اسماً **لم يُعلَن** في خريطة الدور.
    expect(nativeToolReply(response("never_advertised", { input: "x" }), names)).toMatch(/unknown_native_tool/u)
  })
  // IDEA 2 — plugins.intentField: مطفأً مخطّطٌ ومدقّقٌ وموجِّهٌ مطابقةٌ بايتاً؛
  // مشغّلاً الحقل إلزاميّ بنيوياً ولا يدخل الأمر المُركَّب أبداً.
  test("intentField makes intent required in every schema, and OFF leaves the schemas byte-identical", () => {
    const legal = ["read", "list", "glob", "grep", "write", "edit", "run"]
    for (const legalName of legal) {
      const tool = { legalName, usage: legalName, description: legalName, parameters: {} }
      const off = nativeToolDefinition(tool)!.parameters as { required: string[]; properties: Record<string, unknown> }
      const on = nativeToolDefinition(tool, true)!.parameters as { required: string[]; properties: Record<string, unknown> }
      expect(off.required).not.toContain("intent")
      expect(Object.keys(off.properties)).not.toContain("intent")
      expect(on.required).toEqual([...off.required, "intent"])
      expect(on.properties.intent).toMatchObject({ type: "string" })
      // كل ما عدا الحقل الجديد هو عين المخطّط القديم.
      expect(nativeToolDefinition(tool, false)).toEqual(nativeToolDefinition(tool))
    }
    expect(nativeAgentSystem(false, false, true)).toContain("حقل intent")
    expect(nativeAgentSystem(false, false, false)).toBe(nativeAgentSystem(false, false))
    expect(nativeAgentSystem(false, false)).not.toContain("intent")
  })
  test("the validator enforces the intent structurally when on, and rejects it as an extra key when off", () => {
    const withIntent = { command: "npm test", intent: "أشغّل الاختبارات" }
    const reply = nativeToolReply(response("abdo_run", withIntent), names, true)
    if (typeof reply === "string") throw new Error(reply)
    // الأمر المُركَّب مطابقٌ لأمر الوضع القديم بالوسائط نفسها — النيّة لا تدخله.
    expect(reply.command).toBe("run npm test")
    expect(reply.command).not.toContain("أشغّل")
    expect(nativeToolReply(response("abdo_run", { command: "npm test" }), names, true))
      .toBe("رُفض إخراج النموذج: intent_required")
    expect(nativeToolReply(response("abdo_run", { command: "npm test", intent: "  " }), names, true))
      .toBe("رُفض إخراج النموذج: intent_required")
    expect(nativeToolReply(response("abdo_run", { command: "npm test", intent: "سطر\nثانٍ" }), names, true))
      .toBe("رُفض إخراج النموذج: single_line_intent_required")
    expect(nativeToolReply(response("abdo_run", { command: "npm test", intent: "ن".repeat(201) }), names, true))
      .toBe("رُفض إخراج النموذج: single_line_intent_required")
    // مفتاحٌ زائد لا يزال مرفوضاً في الوضعين — الإرث مثبَّت.
    expect(nativeToolReply(response("abdo_run", withIntent), names))
      .toBe("رُفض إخراج النموذج: exact_string_arguments_required")
    expect(nativeToolReply(response("abdo_run", { ...withIntent, extra: "x" }), names, true))
      .toBe("رُفض إخراج النموذج: exact_string_arguments_required")
    // وحمولة write تبقى بايتاً كما هي مع الحقل الإلزاميّ.
    const written = nativeToolReply(response("abdo_write", { path: "a.md", content: "# x\n", intent: "أكتب الملف" }), names, true)
    expect(written).toMatchObject({ command: "write a.md <<<\n# x\n" })
  })
  test("pruning never leaves an orphaned observation", () => {
    const messages = [{ role: "user" }, { role: "assistant" }, { role: "tool" }, { role: "user" }, { role: "assistant" }, { role: "tool" }]
    expect(dropOldestExchange(messages)).toEqual(messages.slice(3))
    expect(dropOldestExchange(messages.slice(3))).toEqual([])
  })
})
