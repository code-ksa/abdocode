import { describe, expect, test } from "bun:test"
import { decodeChatResponse } from "@abdo/model-gateway"
import { nativeToolReply, nativeToolDefinition, nativeAgentSystem, dropOldestExchange } from "../src/native-agent-tools"
import { TOOLS } from "@abdo/tools"

const names = new Map([['abdo_write', 'write'], ['abdo_edit', 'edit'], ['abdo_run', 'run']])
const response = (name: string, input: unknown, finish = "stop") => decodeChatResponse("native-ollama", {
  message: { content: "سأصلح الملف", tool_calls: [{ function: { name, arguments: input } }] }, done_reason: finish,
})
// 10-09 (measured on nemotron-ultra with native tools): every multi-line argument outside write/edit was refused with the bare code
// single_line_argument_required — block tools whose usage IS <<< could not be called, and the model repeated the call 18 times.
describe("native block tools and refusals that say what to fix", () => {
  const blockNames = new Map([["abdo_plan", "plan"], ["abdo_medit", "medit"], ["abdo_patch", "patch"], ["abdo_run", "run"], ["abdo_read", "read"]])
  const command = (name: string, input: unknown): string => {
    const reply = nativeToolReply(response(name, input), blockNames)
    if (typeof reply === "string") throw new Error(reply)
    return reply.command
  }
  test("a multi-line input to a block tool becomes the same text command the dispatcher already guards", () => {
    expect(command("abdo_plan", { input: "set\na: read README\nb: write tests [after: a]" })).toBe("plan set <<<\na: read README\nb: write tests [after: a]")
    expect(command("abdo_plan", { input: "a: read README\nb: write tests [after: a]" })).toBe("plan set <<<\na: read README\nb: write tests [after: a]")
    expect(command("abdo_medit", { input: "src/a.ts\nold\n=>\nnew" })).toBe("medit src/a.ts <<<\nold\n=>\nnew")
    expect(command("abdo_patch", { input: "*** Begin Patch\n*** End Patch" })).toBe("patch <<<\n*** Begin Patch\n*** End Patch")
    expect(command("abdo_plan", { input: "set <<<\na: x" })).toBe("plan set <<<\na: x")
    expect(command("abdo_plan", { input: "show" })).toBe("plan show")
  })
  test("the twins: a multi-line shell command or path is still refused, and the refusal names the tool and the fix", () => {
    const run = nativeToolReply(response("abdo_run", { command: "node -e \"a\nb\"" }), blockNames)
    expect(run).toBe("رُفض إخراج النموذج: single_line_argument_required — run: أمرُ run سطرٌ واحد: للبرنامج متعدّد الأسطر اكتب ملفاً بـwrite ثمّ شغّله باستدعاء run مستقلّ")
    expect(nativeToolReply(response("abdo_read", { path: "a\nb" }), blockNames)).toMatch(/^رُفض إخراج النموذج: single_path_required/u)
  })
})

// 10-09 — up to four native read calls in one reply; writes and runs stay one call per reply.
describe("native read batch", () => {
  const readNames = new Map([["abdo_read", "read"], ["abdo_grep", "grep"], ["abdo_write", "write"], ["abdo_run", "run"]])
  const multi = (...calls: { name: string; input: unknown }[]) => decodeChatResponse("native-ollama", {
    message: { content: "", tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.input } })) }, done_reason: "stop",
  })
  test("two reads become one reply carrying a batch, each member checked as if alone", () => {
    const reply = nativeToolReply(multi({ name: "abdo_read", input: { path: "a.ts" } }, { name: "abdo_grep", input: { input: "TODO" } }), readNames)
    if (typeof reply === "string") throw new Error(reply)
    expect(reply.batch!.map((m) => m.command)).toEqual(["read a.ts", "grep TODO"])
    expect(reply.command).toBe("read a.ts")
  })
  test("the twins: a write in the batch, five reads, or one bad member refuse the whole reply by name", () => {
    expect(nativeToolReply(multi({ name: "abdo_read", input: { path: "a.ts" } }, { name: "abdo_write", input: { path: "b.ts", content: "x" } }), readNames)).toContain("الحزمةُ للقراءة وحدها")
    const five = multi(...["a", "b", "c", "d", "e"].map((x) => ({ name: "abdo_read", input: { path: `${x}.ts` } })))
    expect(nativeToolReply(five, readNames)).toContain("حتى 4 نداءات قراءة")
    expect(nativeToolReply(multi({ name: "abdo_read", input: { path: "a.ts" } }, { name: "abdo_read", input: { path: "a\nb" } }), readNames)).toMatch(/single_path_required/u)
    expect(nativeToolReply(multi(), readNames)).toMatch(/one_native_tool_call_required/u)
  })
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
