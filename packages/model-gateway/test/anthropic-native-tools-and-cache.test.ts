import { describe, expect, test } from "bun:test"
import { answerEveryCall, decodeChatResponse, encodeChatRequest } from "../src"

// 10-14 — مقابل Claude Code بالنموذج نفسِه (claude-sonnet-5-5) على المهمّة نفسِها: Claude Code أنهى m11 ‏16/16 في 215 ث بـ18 نداءً، 95٪ من
// إدخاله مقروءٌ من الخبيئة (≈ $0.57). وعبدو كود كان يرسل الشكلَ الأنثروبيّ بلا cache_control وبلا أدواتٍ أصليّة (رفضٌ صريح)، ويُسقط
// cache_read من العدّ. هذه الاختبارات تثبّت الشكلَ الذي يغلق الفرق.

const ephemeral = { type: "ephemeral" }
const tools = [
  { name: "read_file", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "run", description: "run a command", parameters: { type: "object", properties: { command: { type: "string" } } } },
]

describe("Anthropic: أدواتٌ أصليّة", () => {
  const body = JSON.parse(encodeChatRequest({
    wire: "anthropic", model: "claude-sonnet-5-5", stream: false, stop: ["</tool_result>"], tools,
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "اقرأ الملفّين" },
      { role: "assistant", content: "أقرأهما. ", toolCalls: [{ id: "t1", name: "read_file", input: { path: "a" } }, { id: "t2", name: "read_file", input: '{"path":"b"}' }] },
      { role: "tool", content: "A", name: "read_file", toolCallId: "t1" },
      { role: "tool", content: "B", name: "read_file", toolCallId: "t2" },
    ],
  }).body)

  test("الأدواتُ بـinput_schema، وآخرُها نقطةُ خبيئة", () => {
    expect(body.tools).toEqual([
      { name: "read_file", description: "read a file", input_schema: tools[0]!.parameters },
      { name: "run", description: "run a command", input_schema: tools[1]!.parameters, cache_control: ephemeral },
    ])
  })
  test("نداءاتُ المساعد tool_use بوسائطَ كائن (النصُّ JSON يُفكّ)، والنصُّ بلا مسافةٍ في آخره", () => {
    expect(body.messages[1]).toEqual({ role: "assistant", content: [
      { type: "text", text: "أقرأهما." },
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
      { type: "tool_use", id: "t2", name: "read_file", input: { path: "b" } },
    ] })
  })
  test("نتائجُ الأدوات المتتالية رسالةُ user واحدة — Anthropic يشترط التناوب", () => {
    expect(body.messages).toHaveLength(3)
    expect(body.messages[2].role).toBe("user")
    expect(body.messages[2].content.map((b: { tool_use_id: string }) => b.tool_use_id)).toEqual(["t1", "t2"])
  })
  test("وقفُ العُرف النصّيّ (‏</tool_result>) لا يُرسل مع الأدوات الأصليّة — كان سيقطع النداء", () => {
    expect(body.stop_sequences).toBeUndefined()
    const text = JSON.parse(encodeChatRequest({ wire: "anthropic", model: "m", stream: false, stop: ["</tool_result>"], messages: [{ role: "user", content: "hi" }] }).body)
    expect(text.stop_sequences).toEqual(["</tool_result>"])
  })
})

describe("Anthropic: نقاطُ الخبيئة", () => {
  const body = JSON.parse(encodeChatRequest({
    wire: "anthropic", model: "claude-sonnet-5-5", stream: false, tools,
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "run", input: { command: "ls" } }] },
      { role: "tool", content: "out1", toolCallId: "t1" },
      { role: "assistant", content: "", toolCalls: [{ id: "t2", name: "run", input: { command: "pwd" } }] },
      { role: "tool", content: "out2", toolCallId: "t2" },
    ],
  }).body)
  const marked = (JSON.stringify(body).match(/cache_control/gu) ?? []).length

  test("أربعُ نقاطٍ بالضبط (الحدُّ الأقصى): الأدوات، النظام، آخرُ رسالة، وآخرُ user قبلها", () => {
    expect(marked).toBe(4)
    expect(body.system).toEqual([{ type: "text", text: "sys", cache_control: ephemeral }])
    expect(body.messages.at(-1).content.at(-1)).toMatchObject({ type: "tool_result", tool_use_id: "t2", cache_control: ephemeral })
    expect(body.messages[2].content.at(-1)).toMatchObject({ type: "tool_result", tool_use_id: "t1", cache_control: ephemeral })
  })
  test("نداءٌ برسالةٍ واحدة بلا أدوات: نقطتان (النظام والرسالة) لا أكثر", () => {
    const one = JSON.parse(encodeChatRequest({ wire: "anthropic", model: "m", stream: false, messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] }).body)
    expect((JSON.stringify(one).match(/cache_control/gu) ?? []).length).toBe(2)
  })
})

describe("Anthropic: عدُّ الإدخال يشمل الخبيئة", () => {
  test("الإدخالُ = input + cache_read + cache_creation، والمخبوءُ = cache_read", () => {
    const decoded = decodeChatResponse("anthropic", {
      content: [{ type: "tool_use", id: "t9", name: "run", input: { command: "ls" } }], stop_reason: "tool_use",
      usage: { input_tokens: 36, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 1_200, output_tokens: 90 },
    })
    expect(decoded.kind).toBe("tools")
    expect(decoded.finishReason).toBe("tool_calls")
    expect(decoded.usage).toEqual({ inputTokens: 31_236, outputTokens: 90, cachedInputTokens: 30_000 })
  })
  test("التوأم: ردٌّ بلا حقول الخبيئة لا يخترع مخبوءاً", () => {
    const decoded = decodeChatResponse("anthropic", { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } })
    expect(decoded.usage).toEqual({ inputTokens: 10, outputTokens: 2 })
    expect(decoded.finishReason).toBe("stop")
  })
  test("max_tokens يبقى باسمه فيُعرف المقطوع", () => {
    expect(decodeChatResponse("anthropic", { content: [{ type: "text", text: "x" }], stop_reason: "max_tokens", usage: {} })).toMatchObject({ finishReason: "max_tokens", truncated: true })
  })
})

describe("كلُّ معرّف نداءٍ يُجاب قبل الدور التالي", () => {
  test("نداءٌ بقي بلا ردّ (حلقةٌ توقّفت في منتصف الطابور) يُجاب «لم يُنفَّذ» في رسالة user نفسِها — لا 400", () => {
    const body = JSON.parse(encodeChatRequest({
      wire: "anthropic", model: "m", stream: false, tools,
      messages: [
        { role: "user", content: "u" },
        { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "run", input: {} }, { id: "w2", name: "run", input: {} }] },
        { role: "tool", content: "ok", toolCallId: "w1" },
        { role: "user", content: "تابع" },
      ],
    }).body)
    expect(body.messages).toHaveLength(3)
    expect(body.messages[2].content.map((b: { type: string; tool_use_id?: string }) => b.tool_use_id ?? b.type)).toEqual(["w1", "w2", "text"])
    expect(body.messages[2].content[1].content).toContain("لم يُنفَّذ")
  })
  test("ردُّ أداةٍ بلا نداءٍ قبله يصير نصّاً، والمحادثةُ السليمة لا تتغيّر", () => {
    expect(answerEveryCall([{ role: "user", content: "u" }, { role: "tool", content: "orphan", toolCallId: "x" }])).toEqual([{ role: "user", content: "u" }, { role: "user", content: "orphan" }])
    const sound = [{ role: "user" as const, content: "u" }, { role: "assistant" as const, content: "", toolCalls: [{ id: "a", name: "run", input: {} }] }, { role: "tool" as const, content: "r", toolCallId: "a" }]
    expect(answerEveryCall(sound)).toEqual(sound)
  })
  test("الشكلُ المتوافق مع OpenAI يُجاب أيضاً (يرفض 400 مثله)", () => {
    const body = JSON.parse(encodeChatRequest({ wire: "openai-compatible", model: "m", stream: false,
      messages: [{ role: "user", content: "u" }, { role: "assistant", content: "", toolCalls: [{ id: "a", name: "run", input: {} }] }, { role: "user", content: "تابع" }] }).body)
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "tool", "user"])
  })
})
