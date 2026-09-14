import { describe, expect, test } from "bun:test"
import { DEFAULT_MODEL, PROVIDER_TEMPLATES } from "../src/catalog"
import { hasDeclaredImageInput, parseRef, prepareChatRequest, provider, registerCustomProvider, seedCatalog } from "../src"

describe("Qwen subscription providers", () => {
  const plans = [
    { id: "qwen-token-plan", base: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", key: "abdocode-qwen-token-plan" },
    { id: "qwen-coding-plan", base: "https://coding-intl.dashscope.aliyuncs.com/v1", key: "abdocode-qwen-coding-plan" },
  ] as const

  test("selecting a subscription reaches its own compiled URL without materializing a credential in JS", () => {
    for (const plan of plans) {
      const selected = parseRef(`${plan.id}/qwen3.7-plus`)
      expect(selected).toBeDefined()
      const entry = provider(plan.id)!
      expect(entry.vaultKey).toBe(plan.key)
      const request = prepareChatRequest({ provider: entry, model: "qwen3.7-plus", messages: [{ role: "user", content: "Explain this function" }], stream: false, credentialOwner: "rust-worker" })
      expect(request.url).toBe(`${plan.base}/chat/completions`)
      expect(request.headers.authorization).toBeUndefined()
      expect(JSON.parse(request.body).model).toBe("qwen3.7-plus")
      expect(seedCatalog().some(item => item.ref === `${plan.id}/qwen3.7-plus` && item.needsKey)).toBe(true)
      expect(PROVIDER_TEMPLATES.find(item => item.id === plan.id)).toMatchObject({ support: "builtin", baseUrl: plan.base, vaultKey: plan.key })
    }
    expect(new Set([...plans.map(plan => plan.key), provider("dashscope")!.vaultKey]).size).toBe(3)
    expect(DEFAULT_MODEL).toBe("qwen-token-plan/qwen3.7-plus")
  })

  test("the Token Plan declares exactly the models that answered a live image probe — and the one that refused stays text-only", () => {
    // مقيسٌ حيّاً 2026-09-13 (`work/qwen-vision-probe.ts`): الثلاثةُ وصفت مربّعاً أحمر بخطٍّ قطريّ (HTTP 200)،
    // و`qwen3.7-max` ردّ 400 «Unexpected item type in content». التوأمان معاً: الرؤيةُ تُعلَن حيث ثبتت، وتُحجب حيث رُفضت.
    const plan = provider("qwen-token-plan")!
    for (const model of ["qwen3.7-plus", "qwen3.8-max-preview", "qwen3.8-max"]) expect(hasDeclaredImageInput(plan, model)).toBe(true)
    expect(hasDeclaredImageInput(plan, "qwen3.7-max")).toBe(false)
    // الافتراضيُّ الطازج يرى — فاختيارُ الصور (ر2) لا يحتاج مزوّداً ثانياً
    const [defaultProvider, defaultModel] = DEFAULT_MODEL.split("/") as [string, string]
    expect(hasDeclaredImageInput(provider(defaultProvider)!, defaultModel)).toBe(true)
  })

  test("a custom config cannot replace a plan binding or redirect it to standard billing", () => {
    for (const plan of plans) {
      expect(registerCustomProvider({ id: plan.id, label: "redirect", baseUrl: provider("dashscope")!.baseUrl, vaultKey: "abdocode-dashscope" })).toBeDefined()
      expect(provider(plan.id)!.baseUrl).toBe(plan.base)
      expect(provider(plan.id)!.vaultKey).toBe(plan.key)
    }
  })

  test("installed small model names are seeded as local choices without credentials", () => {
    for (const model of ["qwen2b-gpu:latest", "qwen9b-gpu-32k:latest", "empero-qwen3.8-9b-gpu:latest"]) {
      expect(seedCatalog().find(item => item.ref === `ollama/${model}`)).toMatchObject({ needsKey: false })
    }
  })
})
