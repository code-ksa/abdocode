import { describe, expect, test } from "bun:test"
import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_CHAT_MODEL,
  PROVIDERS,
  catalogDigest,
  classifyModelLane,
  decodeResponse,
  parseRef,
  prepareChatRequest,
  provider,
  selectModelLane,
} from "../src"

describe("owned provider catalogue", () => {
  test("is deterministic and local-first", () => {
    expect(PROVIDERS[0]?.id).toBe("anthropic")
    expect(PROVIDERS.some((entry) => entry.id === "ollama" && entry.local)).toBeTrue()
    expect(catalogDigest).toHaveLength(64)
    expect(PROVIDERS).toHaveLength(17)
    expect(PROVIDERS.filter((entry) => !entry.local).every((entry) => entry.vaultKey?.startsWith("abdocode-"))).toBeTrue()
  })

  test("includes the product-owned compatibility providers without discovery", () => {
    expect(["google", "xai", "mistral", "groq", "together"].every((id) => provider(id) !== undefined)).toBeTrue()
    expect(provider("google")?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai")
    expect(provider("groq")?.baseUrl).toBe("https://api.groq.com/openai/v1")
  })

  test("uses the owner-selected Qwen Token Plan fallback while keeping separate chat and agent lanes", () => {
    expect(DEFAULT_CHAT_MODEL).toBe("qwen-token-plan/qwen3.7-plus")
    expect(DEFAULT_AGENT_MODEL).toBe("qwen-token-plan/qwen3.7-plus")
    expect(provider("ollama")?.models).toContain("empero-qwen3.8-9b-gpu:latest")
    expect(classifyModelLane("ما عاصمة المغرب؟")).toBe("chat")
    expect(classifyModelLane("اشرح لي الفرق بين النموذجين")).toBe("chat")
    expect(classifyModelLane("اصلح ملف cli.ts واختبر الحزمة")).toBe("agent")
    expect(classifyModelLane("خطة تطوير المحرك")).toBe("agent")
    expect(classifyModelLane("أكمل من نقطة التوقف")).toBe("agent")
    // 2026-09-02: قائمة أفعال الاستئناف واحدة مع المحرّك — كلُّ استئنافٍ عارٍ (ولو مزيّناً) مسارُ وكيل.
    for (const body of ["كمّل", "كمل", "تابع", "carry on", "يا عبدو كمّل الآن", "Resume where you left off please", "من فضلك، اكمل", "تابع خطة الاسبرنتات"]) {
      expect(classifyModelLane(body)).toBe("agent")
    }
    // الزينة وحدها أو معرّفٌ بعد الفعل ليسا استئنافاً عارياً؛ مسار الدردشة ما لم تدلّ العبارة على عمل.
    expect(classifyModelLane("من فضلك")).toBe("chat")
    expect(classifyModelLane("الآن")).toBe("chat")
    expect(classifyModelLane("المتابعة")).toBe("chat")
    expect(classifyModelLane("اكمل S3")).toBe("agent")
    // IDEA 4 (routerGate): the front gate's eligibility precondition — trivia stays on the chat lane
    // (greetings, questions about the conversation, status). routing.ts itself is untouched.
    for (const body of ["مرحبا", "ماذا فعلت؟", "ما حالة المشروع؟"]) expect(classifyModelLane(body)).toBe("chat")
    expect(selectModelLane("chat", "اصلح المشروع")).toBe("chat")
    expect(selectModelLane("agent", "مرحبا")).toBe("agent")
  })

  test("does no discovery and prepares the selected local harness", () => {
    const ollama = provider("ollama")!
    const request = prepareChatRequest({
      provider: ollama,
      model: "qwen",
      system: "Use {{tool:status}}.\n{{tool-catalogue}}",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ legalName: "status", usage: "status", description: "kernel status", parameters: {} }],
      stream: false,
      contextTokens: 65_536,
      maxOutputTokens: 16_384,
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
      think: true,
    })
    expect(request.url).toBe("http://127.0.0.1:11434/api/chat")
    const body = JSON.parse(request.body)
    expect(body.think).toBeTrue()
    expect(body.options).toMatchObject({ num_ctx: 65_536, num_predict: 16_384, temperature: 0.6, top_p: 0.95, top_k: 20 })
    expect(body.messages.filter((message: { role: string }) => message.role === "system")).toHaveLength(1)
    expect(request.toolBindings[0]).toEqual(expect.objectContaining({ legalName: "status", exposedName: "abdo_status" }))
  })

  test("refuses ambiguous references and uncredentialed remote use", () => {
    expect(parseRef("unknown/model")).toBeUndefined()
    expect(provider("deepseek")?.models).toContain("deepseek-v4-flash")
    expect(() => prepareChatRequest({ provider: provider("openai")!, model: "gpt-4o", messages: [], stream: false })).toThrow("vault credential")
  })

  test("uses the owned Anthropic codec and credential header", () => {
    const request = prepareChatRequest({
      provider: provider("anthropic")!,
      model: "claude-sonnet-4-5",
      system: "owned system",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      credentialHandle: {
        applyToHeaders: (headers, kind) => Object.freeze({ ...headers, [kind === "bearer" ? "authorization" : "x-api-key"]: "test-only" }),
      },
    })
    expect(request.url).toBe("https://api.anthropic.com/v1/messages")
    expect(request.headers["x-api-key"]).toBe("test-only")
    expect(request.headers.authorization).toBeUndefined()
    expect(JSON.parse(request.body)).toMatchObject({ system: expect.stringContaining("owned system") })
    expect(decodeResponse(provider("anthropic")!, {
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 1 },
    })).toMatchObject({ kind: "final", text: "done", usage: { inputTokens: 2, outputTokens: 1 } })
  })

  test("prepares remote payloads for Rust-owned credential injection without a secret", () => {
    const request = prepareChatRequest({
      provider: provider("openai")!, model: "gpt-4o", messages: [{ role: "user", content: "hello" }],
      stream: false, credentialOwner: "rust-worker",
    })
    expect(request.credential).toBe("bearer")
    expect(request.headers.authorization).toBeUndefined()
    expect(JSON.stringify(request)).not.toContain("test-only")
  })
})
