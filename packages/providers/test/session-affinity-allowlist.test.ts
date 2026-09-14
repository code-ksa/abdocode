/**
 * م9ز — حقلُ تثبيت الجلسة في الجسد يُرسَل فقط لمن يوثّقه (OpenRouter/OpenAI/Anthropic)؛ إنفيديا NIM وغيرُها يأخذون الرأسَ وحده.
 * الفحصُ يقرأ الجسدَ المبنيّ فعلاً. (09-14: تعليقُ NIM المتقطّع ~40٪ قيس بلا علاقةٍ بالحقل — القائمةُ احترازٌ لا علاج.)
 */
import { describe, expect, test } from "bun:test"
import { AFFINITY_BODY_PROVIDERS, prepareChatRequest, provider } from "../src"

const token = "abdo-0123456789abcdef0123456789abcdef"
const messages = [{ role: "user" as const, content: "hello" }]

describe("session affinity allowlist", () => {
  test("nvidia (NIM): header only — no user field in the body", () => {
    const nvidia = provider("nvidia")!
    const request = prepareChatRequest({ provider: nvidia, model: nvidia.models[0]!, messages, stream: false, credentialOwner: "rust-worker", sessionAffinity: token })
    expect("user" in JSON.parse(request.body)).toBe(false)
    expect(request.headers["x-session-id"]).toBe(token)
  })
  test("openrouter: user in the body (documented cache routing) and the header", () => {
    const openrouter = provider("openrouter")!
    const request = prepareChatRequest({ provider: openrouter, model: openrouter.models[0]!, messages, stream: false, credentialOwner: "rust-worker", sessionAffinity: token })
    expect(JSON.parse(request.body).user).toBe(token)
    expect(request.headers["x-session-id"]).toBe(token)
  })
  test("the allowlist is explicit and small", () => {
    expect([...AFFINITY_BODY_PROVIDERS].sort()).toEqual(["anthropic", "openai", "openrouter"])
    expect(AFFINITY_BODY_PROVIDERS.has("nvidia")).toBe(false)
  })
  test("nvidia's default models are live ones (the EOL llama-3.3-70b was measured 410 on 2026-09-14)", () => {
    expect(provider("nvidia")!.models).toContain("nvidia/nemotron-3.5-lightning-30b-a3b")
    expect(provider("nvidia")!.models).not.toContain("meta/llama-3.3-70b-instruct")
  })
  test("nvidia declares the vision models that were measured reading a test image (omni 30B in 5s, llama-3.2-11b in 1s)", () => {
    const nvidia = provider("nvidia")!
    expect(nvidia.imageModels).toEqual(["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "meta/llama-3.2-11b-vision-instruct"])
    for (const model of nvidia.imageModels ?? []) expect(nvidia.models).toContain(model)
    // التوأمُ السلبيّ: نموذجٌ نصّيّ لا يُدّعى له بصر
    expect(nvidia.imageModels).not.toContain("nvidia/nemotron-3.5-lightning-30b-a3b")
  })
})
