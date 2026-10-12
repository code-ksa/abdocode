import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { salvageTextToolCalls } from "../src/text-tool-calls"
import { nativeToolReply } from "../src/native-agent-tools"

// 10-10 (مقيس في مهمّة n8n على deepseek-v4-pro): الردُّ انتهى بـ<tool_calls><invoke name="list">… نصّاً فظهر خامّاً للمستخدم ولم يُنفَّذ.
const LEAK = `خلصت المطلوب.<tool_calls>
<invoke name="list">
<parameter name="path" string="true">.abdo/reference</parameter>
</invoke>
<invoke name="glob">
<parameter name="pattern" string="true">.abdo/reference/**/meta.json</parameter>
</invoke>
</tool_calls>`

test("DeepSeek text tool calls become structured calls; the prose stays", () => {
  const s = salvageTextToolCalls(LEAK)!
  expect(s.text).toBe("خلصت المطلوب.")
  expect(s.calls).toEqual([{ id: "text-call-1", name: "list", input: { path: ".abdo/reference" } }, { id: "text-call-2", name: "glob", input: { pattern: ".abdo/reference/**/meta.json" } }])
  // DSML-prefixed spelling and non-string parameters
  const d = salvageTextToolCalls('<｜DSML｜function_calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">a.ts</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>')!
  expect(d.calls[0]).toMatchObject({ name: "read", input: { path: "a.ts" } })
  expect(salvageTextToolCalls('<tool_calls><invoke name="x"><parameter name="n" string="false">3</parameter></invoke></tool_calls>')!.calls[0]!.input).toEqual({ n: 3 })
  // the twin: ordinary prose (and prose that merely mentions the word) is untouched
  expect(salvageTextToolCalls("نفّذ: list .abdo")).toBeUndefined()
  expect(salvageTextToolCalls("the <tool_calls> tag is how DeepSeek writes calls")).toBeUndefined()
})

test("the salvaged calls pass the same native checks: a two-read batch becomes the list command", () => {
  const s = salvageTextToolCalls(LEAK)!
  const names = new Map([["list", "list"], ["glob", "glob"], ["write", "write"]])
  const reply = nativeToolReply({ kind: "tools", text: s.text, calls: s.calls, finishReason: "tool_calls", truncated: false, usage: {} }, names)
  expect(typeof reply).toBe("object")
  expect((reply as { command: string }).command).toBe("list .abdo/reference")
  // an undeclared tool is still refused by name
  const bad = nativeToolReply({ kind: "tools", text: "", calls: salvageTextToolCalls('<tool_calls><invoke name="rm"><parameter name="path" string="true">/</parameter></invoke></tool_calls>')!.calls, finishReason: "tool_calls", truncated: false, usage: {} }, names)
  expect(bad).toContain("unknown_native_tool")
})

test("wired into both the full and the streamed reply, before the text answer is returned", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
  const helper = cli.indexOf("const salvageTextCall = async (text: string)")
  expect(helper).toBeGreaterThan(0)
  const full = cli.indexOf("await salvageTextCall(decoded.text)", helper)
  const streamed = cli.indexOf("await salvageTextCall(cleanAnswer)", helper)
  expect(full).toBeGreaterThan(helper); expect(streamed).toBeGreaterThan(full)
  expect(full).toBeLessThan(cli.indexOf("const answer = normalizeToolNames(decoded.text", helper))
  expect(streamed).toBeLessThan(cli.indexOf("return hooks.conversationMode==='chat' ? cleanAnswer :", streamed))
})

test("the bare form without the <tool_calls> wrapper (measured after 4.0.129) is salvaged too", () => {
  const leak = 'أقرأ الخطّة.<invoke name="read">\n<parameter name="file">ABDO-SPRINTS.md</parameter>\n<parameter name="from">1</parameter>\n<parameter name="to">460</parameter>\n</invoke>'
  const s = salvageTextToolCalls(leak)!
  expect(s.text).toBe("أقرأ الخطّة.")
  expect(s.calls).toEqual([{ id: "text-call-1", name: "read", input: { file: "ABDO-SPRINTS.md", from: "1", to: "460" } }])
  // the twin: prose that only names the tag is untouched
  expect(salvageTextToolCalls("use the <invoke> tag carefully")).toBeUndefined()
})
