import { describe, expect, test } from "bun:test"
import { chatEndpointFor, customProviderEnvValue, parseRef, provider, Providers, registerCustomProvider } from "../src"

describe("custom providers — owner-config registration (settings tab, 2026-08-31)", () => {
  test("a valid https provider registers and its refs parse", () => {
    expect(registerCustomProvider({ id: "mycloud", label: "سحابتي", baseUrl: "https://api.mycloud.example/v1", vaultKey: "custom-mycloud-api-key" })).toBeUndefined()
    const p = provider("mycloud")
    expect(p?.source).toBe("owner-config")
    expect(p?.local).toBe(false)
    expect(p?.wire).toBe("openai-compatible")
    expect(parseRef("mycloud/some-model")?.provider).toBe("mycloud")
  })

  test("re-saving the same definition is idempotent; a different one is refused by name", () => {
    expect(registerCustomProvider({ id: "mycloud", label: "سحابتي", baseUrl: "https://api.mycloud.example/v1", vaultKey: "custom-mycloud-api-key" })).toBeUndefined()
    const refusal = registerCustomProvider({ id: "mycloud", label: "سحابتي", baseUrl: "https://other.example/v1", vaultKey: "custom-mycloud-api-key" })
    expect(refusal).toContain("مختلف")
  })

  test("http is refused — cloud credentials never ride plaintext", () => {
    expect(registerCustomProvider({ id: "insecure", label: "x", baseUrl: "http://api.example/v1", vaultKey: "custom-insecure-api-key" })).toContain("https")
    expect(provider("insecure")).toBeUndefined()
  })

  test("garbage URLs and builtin-id collisions are refused by name", () => {
    expect(registerCustomProvider({ id: "bad", label: "x", baseUrl: "ليس رابطاً", vaultKey: "custom-bad-api-key" })).toContain("URL")
    const clash = registerCustomProvider({ id: "dashscope", label: "انتحال", baseUrl: "https://evil.example/v1", vaultKey: "custom-dash-api-key" })
    expect(clash).toContain("مختلف")
    expect(provider("dashscope")?.baseUrl).toContain("dashscope-intl.aliyuncs.com")
  })

  test("the builtin snapshot and digest are not polluted by runtime registration", () => {
    expect(Providers.PROVIDERS.some((p) => p.id === "mycloud")).toBe(false)
  })

  test("...and the LIVE list does show it — otherwise a registered provider is invisible forever", () => {
    // العطلُ المقيس (2026-09-03): اللقطةُ المُجمَّدة صحيحةٌ ومقصودة، لكنّ
    // القرّاء الذين يريدون الحيّ كانوا يقرأونها — فمزوّدٌ يُسجَّل بنجاحٍ لا
    // يظهر في منتقي النماذج ولا في حالة الخزنة ولا في بذرة الكتالوج. هذا
    // الفحصُ هو الفرقُ بين «مسجَّلة» و«مرئيّة»، وبلا توأمِه أعلاه يمرّ أحدُهما
    // وحده ويبدو النظامُ سليماً في الاتجاهين معاً.
    expect(Providers.listProviders().some((p) => p.id === "mycloud")).toBe(true)
    // وهي حقّاً لقطةٌ عند النداء: المُجمَّعون كلُّهم فيها أيضاً.
    expect(Providers.listProviders().length).toBe(Providers.PROVIDERS.length + 1)
    expect(Providers.listProviders().some((p) => p.id === "anthropic")).toBe(true)
  })
})

describe("custom provider → Rust worker pass-through (ABDO_CUSTOM_PROVIDERS)", () => {
  test("chatEndpointFor composes exactly what prepareChatRequest will call", () => {
    expect(chatEndpointFor("https://api.example.com/v1")).toBe("https://api.example.com/v1/chat/completions")
    expect(chatEndpointFor("https://api.example.com/v1/")).toBe("https://api.example.com/v1/chat/completions")
    expect(chatEndpointFor("http://api.example.com/v1")).toBeUndefined()
    expect(chatEndpointFor("ليس رابطاً")).toBeUndefined()
  })

  test("env value carries id|endpoint|vaultKey per entry; unset when nothing is declarable", () => {
    const value = customProviderEnvValue([
      { id: "mycloud", baseUrl: "https://api.mycloud.example/v1", vaultKey: "custom-mycloud-api-key" },
      { id: "second", baseUrl: "https://api.second.example/v2/", vaultKey: "custom-second-api-key" },
    ])
    expect(value).toBe(
      "mycloud|https://api.mycloud.example/v1/chat/completions|custom-mycloud-api-key;" +
        "second|https://api.second.example/v2/chat/completions|custom-second-api-key",
    )
    expect(customProviderEnvValue([])).toBeUndefined()
    expect(customProviderEnvValue([{ id: "bad", baseUrl: "http://plain.example/v1", vaultKey: "k-bad-key" }])).toBeUndefined()
  })

  test("an id or key carrying the separator bytes is dropped, not smuggled", () => {
    expect(customProviderEnvValue([{ id: "a|b", baseUrl: "https://x.example/v1", vaultKey: "custom-ab-api-key" }])).toBeUndefined()
    expect(customProviderEnvValue([{ id: "ok", baseUrl: "https://x.example/v1", vaultKey: "k;rm" }])).toBeUndefined()
  })
})
