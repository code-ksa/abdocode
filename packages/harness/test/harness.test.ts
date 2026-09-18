import { describe, expect, test } from "bun:test"
import { labelDigest } from "@abdo/kernel/contracts"
import { attest, buildChatRequest, classifyInput, HarnessRegistry } from "../src"

describe("owned harness adapter", () => {
  test("uses the generated Rust channel vocabulary without duplicating wake semantics", () => {
    expect(classifyInput("OperatorSteer", "stop after tests")).toEqual({ channel: "OperatorSteer", body: "stop after tests" })
    expect(classifyInput("SchedulerSignal", "tick")).toEqual({ channel: "SchedulerSignal", body: "tick" })
    expect("wakesAgent" in classifyInput("SystemInject", "policy")).toBeFalse()
  })

  test("validates the generated enforcement report instead of defining another", () => {
    const digest = labelDigest("test-enforcement")
    expect(attest({
      requested_digest: digest,
      granted_digest: digest,
      enforcement: "Unavailable",
      backend_digest: digest,
      limitations_digest: digest,
    }).enforcement).toBe("Unavailable")
  })

  test("loads the locally written DeepSeek-style profile without network discovery", () => {
    expect(HarnessRegistry.ids()).toContain("deepseek-style")
    const request = buildChatRequest({
      wire: "native-ollama",
      harness: "deepseek-style",
      model: "qwen",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    })
    const body = JSON.parse(request.body)
    expect(request.path).toBe("/api/chat")
    expect(body.think).toBeFalse()
    expect(body.messages[0].role).toBe("system")
  })

  test("applies the profile to real tools and keeps a reversible legal-name map", () => {
    const request = buildChatRequest({
      wire: "native-ollama",
      harness: "qwen-style",
      model: "qwen",
      system: "Run {{tool:status}} when asked.\n{{tool-catalogue}}",
      messages: [{ role: "user", content: "status?" }],
      tools: [{
        legalName: "status",
        usage: "status",
        description: "read the local kernel status",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
      stream: false,
    })
    const body = JSON.parse(request.body)
    expect(request.toolBindings).toEqual([expect.objectContaining({ legalName: "status", exposedName: "abdo_status", usage: "abdo_status" })])
    expect(body.messages.filter((message: { role: string }) => message.role === "system")).toHaveLength(1)
    expect(body.messages[0].content).toContain("Run abdo_status when asked.")
    expect(body.messages[0].content).toContain("- abdo_status — read the local kernel status")
  })

  test("rejects ambiguous mappings and a second system-message channel", () => {
    const duplicate = { legalName: "status", usage: "status", description: "status", parameters: {} }
    expect(() => buildChatRequest({
      wire: "native-ollama",
      harness: "abdo-native",
      model: "qwen",
      messages: [],
      tools: [duplicate, duplicate],
      stream: false,
    })).toThrow("duplicate legal tool name")
    expect(() => buildChatRequest({
      wire: "native-ollama",
      harness: "abdo-native",
      model: "qwen",
      messages: [{ role: "system", content: "second channel" }],
      stream: false,
    })).toThrow("singular system field")
  })
})

describe("الكتالوجُ في النظام: فهرسُ أسماءٍ لا نسخةٌ ثانية حين تكون الأدواتُ أصيلة (مقيس 2026-09-18: 17,860 ⇦ 1,342 بايتاً)", () => {
  const tools = Array.from({ length: 12 }, (_, i) => Object.freeze({
    legalName: `tool${i}`,
    usage: `tool${i} <وسيط>`,
    description: `وصفٌ طويلٌ للأداة ${i} يشرح شكلَها وحقولَها وأمثلتَها ويأكل بايتاتٍ كثيرةً في كلّ نداء`,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  })) as never[]
  const systemOf = (nativeTools: boolean): string => {
    const request = buildChatRequest({
      wire: "native-ollama", harness: "deepseek-style", model: "m", system: "رأسٌ\n{{tool-catalogue}}\nذيلٌ",
      messages: [{ role: "user", content: "س" }], tools, stream: false, nativeTools,
    } as never) as { body: unknown }
    const raw = typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body as Uint8Array)
    const parsed = JSON.parse(raw) as { messages?: { role: string; content: string }[]; system?: string }
    return parsed.messages?.find((m) => m.role === "system")?.content ?? parsed.system ?? ""
  }

  test("الأصيل: الأسماءُ وحدها والوصفُ في التعريفات؛ والنصّيّ: الوصفُ كاملاً لأنّه لا مصدرَ سواه", () => {
    const native = systemOf(true)
    const textual = systemOf(false)
    // الأسماءُ حاضرةٌ في الوضعين — لا قدرةَ تُخفى.
    for (const name of ["tool0", "tool11"]) { expect(native).toContain(name); expect(textual).toContain(name) }
    // الوصفُ الطويل مرّةً واحدة: غائبٌ عن النصّ في الأصيل، حاضرٌ في النصّيّ.
    expect(native).not.toContain("يأكل بايتاتٍ كثيرةً")
    expect(textual).toContain("يأكل بايتاتٍ كثيرةً")
    expect(native).toContain("تعريفات الأدوات المرفقة")
    // التوأمُ العدديّ: الوفرُ حقيقيٌّ لا تجميلٌ.
    expect(Buffer.byteLength(native, "utf8")).toBeLessThan(Buffer.byteLength(textual, "utf8") / 2)
    // الرأسُ والذيلُ يبقيان في مكانهما (العلامةُ تُستبدل لا تُلحق).
    expect(native.indexOf("رأسٌ")).toBeGreaterThanOrEqual(0)
    expect(native.indexOf("ذيلٌ")).toBeGreaterThan(native.indexOf("رأسٌ"))
  })
})
