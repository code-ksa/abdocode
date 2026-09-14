/**
 * م9ز — تثبيتُ الجلسة عند المزوّد: رأسُ `x-session-id` على كلّ سلكٍ سحابيّ؛ وحقولُ الجسد (`user` لـOpenAI-compatible،
 * `metadata.user_id` لـAnthropic) فقط حين يقول المنادي إنّ المزوّد يوثّقها (`sessionAffinityBody`) — احترازٌ من بوّاباتٍ لا توثّقه.
 * أولاما المحلّيّ لا يرى شيئاً؛ الغيابُ لا يضيف شيئاً؛ النصُّ الحرّ يُرفض قبل أن يغادر.
 */
import { describe, expect, test } from "bun:test"
import { encodeChatRequest } from "../src"

const messages = [{ role: "user" as const, content: "hello" }]
const token = "abdo-0123456789abcdef0123456789abcdef"

describe("session affinity", () => {
  test("openai-compatible with body opt-in: body.user and the header", () => {
    const encoded = encodeChatRequest({ wire: "openai-compatible", model: "m", stream: false, messages, sessionAffinity: token, sessionAffinityBody: true })
    expect(JSON.parse(encoded.body).user).toBe(token)
    expect(encoded.headers["x-session-id"]).toBe(token)
  })
  test("openai-compatible without body opt-in (unlisted gateways): header only, no user field — the negative twin", () => {
    const encoded = encodeChatRequest({ wire: "openai-compatible", model: "m", stream: false, messages, sessionAffinity: token })
    expect("user" in JSON.parse(encoded.body)).toBe(false)
    expect(encoded.headers["x-session-id"]).toBe(token)
  })
  test("anthropic: metadata.user_id only with the opt-in; header always", () => {
    const withBody = encodeChatRequest({ wire: "anthropic", model: "m", stream: false, messages, sessionAffinity: "abdo-affinity-1", sessionAffinityBody: true })
    expect(JSON.parse(withBody.body).metadata).toEqual({ user_id: "abdo-affinity-1" })
    expect(withBody.headers["x-session-id"]).toBe("abdo-affinity-1")
    expect(withBody.headers["anthropic-version"]).toBe("2023-06-01")
    const headerOnly = encodeChatRequest({ wire: "anthropic", model: "m", stream: false, messages, sessionAffinity: "abdo-affinity-1" })
    expect("metadata" in JSON.parse(headerOnly.body)).toBe(false)
    expect(headerOnly.headers["x-session-id"]).toBe("abdo-affinity-1")
  })
  test("native-ollama ignores it; absence adds nothing", () => {
    const ollama = encodeChatRequest({ wire: "native-ollama", model: "m", stream: false, messages, sessionAffinity: token, sessionAffinityBody: true })
    expect(JSON.parse(ollama.body).user).toBeUndefined()
    expect(ollama.headers["x-session-id"]).toBeUndefined()
    const bare = encodeChatRequest({ wire: "openai-compatible", model: "m", stream: false, messages })
    expect("user" in JSON.parse(bare.body)).toBe(false)
    expect("x-session-id" in bare.headers).toBe(false)
  })
  test("free text or a secret-shaped value is refused before it leaves", () => {
    for (const bad of ["short", "has space here", "sk-" + "x".repeat(70), "عربي-ليس-بصمة"]) {
      expect(() => encodeChatRequest({ wire: "openai-compatible", model: "m", stream: false, messages, sessionAffinity: bad })).toThrow("opaque")
    }
  })
})
