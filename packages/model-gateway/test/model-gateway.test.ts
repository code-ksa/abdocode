import { describe, expect, test } from "bun:test"
import { BoundedWireDecoder, classifyModelFailure, decodeChatResponse, encodeChatRequest } from "../src"

describe("owned model gateway codecs", () => {
  test("encodes native schemas and action-observation history using Ollama fields", () => {
    const body = JSON.parse(encodeChatRequest({ wire: "native-ollama", model: "qwen", stream: false,
      tools: [{ name: "read", description: "read", parameters: { type: "object" } }],
      messages: [{ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", input: { path: "a" } }] },
        { role: "tool", content: "source", name: "read", toolCallId: "c1" }],
    }).body)
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "read" } })
    expect(body.messages[0].tool_calls[0].function.arguments).toEqual({ path: "a" })
    expect(body.messages[1]).toEqual({ role: "tool", content: "source", tool_name: "read" })
    expect(() => encodeChatRequest({ wire: "anthropic", model: "x", stream: false, messages: [],
      tools: [{ name: "read", description: "read", parameters: {} }],
    })).toThrow("not qualified")
  })
  test("encodes each provider family without discovery", () => {
    const messages = [{ role: "system" as const, content: "owned" }, { role: "user" as const, content: "hello" }]
    const ollama = encodeChatRequest({
      wire: "native-ollama", model: "qwen", messages, stream: false,
      contextTokens: 65_536, maxOutputTokens: 16_384, temperature: 0.6, topP: 0.95, topK: 20, think: true,
    })
    expect(ollama.path).toBe("/api/chat")
    expect(ollama.credential).toBe("none")
    expect(JSON.parse(ollama.body)).toMatchObject({
      think: true,
      options: { num_ctx: 65_536, num_predict: 16_384, temperature: 0.6, top_p: 0.95, top_k: 20 },
    })

    const openai = encodeChatRequest({ wire: "openai-compatible", model: "gpt", messages, stream: false })
    expect(openai.path).toBe("/chat/completions")
    expect(openai.credential).toBe("bearer")

    const anthropic = encodeChatRequest({ wire: "anthropic", model: "claude", messages, stream: false })
    const body = JSON.parse(anthropic.body)
    expect(anthropic.path).toBe("/messages")
    expect(anthropic.credential).toBe("x-api-key")
    expect(body.system).toBe("owned")
    expect(body.messages).toEqual([{ role: "user", content: "hello" }])
  })

  test("normalizes final, tool and truncated responses", () => {
    expect(decodeChatResponse("openai-compatible", {
      choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"path":"a"}' } }] } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    })).toMatchObject({ kind: "tools", calls: [{ id: "c1", name: "read", input: { path: "a" } }], usage: { inputTokens: 2, outputTokens: 3 } })
    expect(decodeChatResponse("anthropic", {
      content: [{ type: "text", text: "partial" }], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 4 },
    })).toMatchObject({ kind: "final", text: "partial", truncated: true })
  })

  test("exposes cached-prefix and reasoning token details when the provider reports them (token-plan probe 2026-09-02)", () => {
    const measured = decodeChatResponse("openai-compatible", {
      choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      usage: {
        prompt_tokens: 4558, completion_tokens: 43,
        prompt_tokens_details: { cached_tokens: 4224, text_tokens: 4558 },
        completion_tokens_details: { reasoning_tokens: 38, text_tokens: 43 },
      },
    })
    expect(measured.usage).toEqual({ inputTokens: 4558, outputTokens: 43, cachedInputTokens: 4224, reasoningTokens: 38 })
    expect(Object.isFrozen(measured.usage)).toBe(true)
  })

  test("never invents cache or reasoning counts — absent details stay absent", () => {
    const plain = decodeChatResponse("openai-compatible", {
      choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      usage: { prompt_tokens: 4558, completion_tokens: 43 },
    })
    expect(plain.usage).toEqual({ inputTokens: 4558, outputTokens: 43 })
    expect("cachedInputTokens" in plain.usage).toBe(false)
    expect("reasoningTokens" in plain.usage).toBe(false)
    const malformed = decodeChatResponse("openai-compatible", {
      choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: "4224" }, completion_tokens_details: null },
    })
    expect(malformed.usage).toEqual({ inputTokens: 10, outputTokens: 1 })
    const noUsage = decodeChatResponse("openai-compatible", { choices: [{ finish_reason: "stop", message: { content: "ok" } }] })
    expect(noUsage.usage).toEqual({})
  })

  test("frames SSE and NDJSON with a hard byte ceiling", () => {
    const decoder = new BoundedWireDecoder(80)
    expect(decoder.push('data: {"x":1}\n{"y":2}\ndata: [DONE]\n')).toEqual([
      { done: false, payload: { x: 1 } },
      { done: false, payload: { y: 2 } },
      { done: true },
    ])
    decoder.finish()
    const utf8 = new TextEncoder().encode('{"text":"ع"}\n')
    const arabicStart = utf8.indexOf(0xd8)
    const split = new BoundedWireDecoder()
    expect(split.push(utf8.slice(0, arabicStart + 1))).toEqual([])
    expect(split.push(utf8.slice(arabicStart + 1))).toEqual([{ done: false, payload: { text: "ع" } }])
    split.finish()
    expect(() => new BoundedWireDecoder(3).push("four")).toThrow("exceeded")
    expect(() => {
      const incomplete = new BoundedWireDecoder()
      incomplete.push('{"x":1}')
      incomplete.finish()
    }).toThrow("incomplete")
  })

  test("classifies retries once and never replays a started response", () => {
    expect(classifyModelFailure({ status: 429, retryAfter: "2" })).toEqual({
      kind: "rate-limited",
      retry: "bounded-backoff",
      status: 429,
      retryAfterMs: 2_000,
      reason: "provider rate limited the request",
    })
    expect(classifyModelFailure({ status: 503, responseStarted: true })).toMatchObject({
      kind: "protocol",
      retry: "never",
    })
    expect(classifyModelFailure({ status: 401 })).toMatchObject({ kind: "credential", retry: "operator-action" })
    expect(classifyModelFailure({ error: new TypeError("offline") })).toMatchObject({
      kind: "transport",
      retry: "bounded-backoff",
    })
  })
})
