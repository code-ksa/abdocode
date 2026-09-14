import { describe, expect, test } from "bun:test"
import { MAX_TEXT_AGENT_ROUNDS } from "@abdo/engine-host"
import { railProfile, tierForModel } from "../src/rail-policy"

describe("rail policy — strictness by model tier (owner decision 2026-08-31)", () => {
  // قيمةٌ تعبر حدود الحزم تُربط بمُتحقِّقها: الحلقة رفضت maxRounds=32 حياً
  // (2026-09-02) لأن حدّها كان 16 حرفياً غير مُصدَّر ولا مربوطاً بهذا الاختبار.
  test("every profile's round budget is accepted by the text agent loop", () => {
    for (const tier of ["strict", "medium", "thin"] as const) {
      const p = railProfile(tier, "")
      expect(p.maxRounds).toBeGreaterThanOrEqual(1)
      expect(p.maxRounds).toBeLessThanOrEqual(MAX_TEXT_AGENT_ROUNDS)
    }
  })

  test("auto derives strict for small local models and the unknown", () => {
    expect(tierForModel("ollama/qwen9b-gpu-64k:latest")).toBe("strict")
    expect(tierForModel("ollama/qwen3.5:9b")).toBe("strict")
    expect(tierForModel("some/unknown-model")).toBe("strict") // الغياب تشدّد لا ترخّص
  })

  test("auto derives medium for mid-size models", () => {
    expect(tierForModel("ollama/deepseek-r1-distill-32b")).toBe("medium")
    expect(tierForModel("ollama/qwen-14b")).toBe("medium")
  })

  test("auto derives thin for frontier families and huge sizes", () => {
    expect(tierForModel("anthropic/claude-sonnet")).toBe("thin")
    expect(tierForModel("openai/gpt-5")).toBe("thin")
    expect(tierForModel("ollama/qwen-72b")).toBe("thin")
    expect(tierForModel("google/gemini-pro")).toBe("thin")
  })

  test("strict injects everything with a short leash", () => {
    const p = railProfile("strict", "x")
    expect(p.coldMap && p.awarenessBrief && p.factRecall && p.errorPlaybooks && p.sprintPlanRequired && p.qualityGuards).toBe(true)
    expect(p.maxRounds).toBe(4)
  })

  test("thin unleashes: no injections, long rounds — but stays honest about what it keeps", () => {
    const p = railProfile("thin", "anthropic/claude-sonnet")
    // S13 (2026-09-02): الرفيع يُسقط القضبان لا الوعي — الاسترجاع والدفتر يبقيان.
    expect(p.awarenessBrief && p.factRecall).toBe(true)
    expect(p.errorPlaybooks || p.sprintPlanRequired || p.qualityGuards).toBe(false)
    expect(p.coldMap).toBe(true) // رخيصة ومفيدة للجميع
    expect(p.maxRounds).toBe(32)
  })

  test("manual setting overrides auto, and garbage falls back to auto", () => {
    expect(railProfile("thin", "ollama/qwen9b").tier).toBe("thin")
    expect(railProfile("strict", "anthropic/claude-sonnet").tier).toBe("strict")
    expect(railProfile(undefined, "ollama/qwen9b").tier).toBe("strict")
    expect(railProfile("nonsense" as never, "anthropic/claude-sonnet").tier).toBe("thin")
  })

  test("the reason names the derivation for the receipt", () => {
    expect(railProfile("auto", "ollama/qwen9b").reason).toContain("تلقائي")
    expect(railProfile("medium", "x").reason).toContain("يدوياً")
  })
})

describe("rail policy — a cloud provider is a strong model (owner directive 2026-09-06)", () => {
  test("auto: the owner's cloud models are thin whatever their ref text says", () => {
    for (const ref of ["qwen-token-plan/qwen3.5-plus", "qwen-coding-plan/qwen3-coder-plus", "dashscope/qwen-plus", "deepseek/deepseek-chat", "moonshot/kimi-k2", "minimax/MiniMax-M2.5", "xai/grok-4", "openrouter/z-ai/glm-4.6"]) expect(tierForModel(ref, false)).toBe("thin")
  })
  test("auto: a cloud model that announces itself small is medium — never strict", () => {
    for (const ref of ["openai/gpt-5-mini", "openai/gpt-4.1-nano", "google/gemini-2.5-flash-lite", "together/llama-3.1-8b-instruct", "cloud/deepseek-r1-distill-32b"]) expect(tierForModel(ref, false)).toBe("medium")
    expect(tierForModel("minimax/MiniMax-M2.5", false)).toBe("thin") // «mini» داخل كلمةٍ ليس إعلاناً بالصغر
  })
  test("auto: a local provider is still graded by size", () => {
    expect(tierForModel("ollama/qwen3.5:9b", true)).toBe("strict")
    expect(tierForModel("ollama/qwen-14b", true)).toBe("medium")
    expect(tierForModel("ollama/qwen-72b", true)).toBe("thin")
  })
  test("thin is thin: no coaching, no orientation prose, no summaries, no semantic/general briefs — strict and medium keep them all", () => {
    const thin = railProfile("thin", "x")
    expect(thin.coaching || thin.orientationProse || thin.sessionSummary || thin.semanticBrief || thin.generalAwareness).toBe(false)
    for (const tier of ["strict", "medium"] as const) {
      const p = railProfile(tier, "x")
      expect(p.coaching && p.orientationProse && p.sessionSummary && p.semanticBrief && p.generalAwareness).toBe(true)
    }
  })
  test("the reason names the origin, and a manual setting still wins", () => {
    expect(railProfile("auto", "deepseek/deepseek-chat", false).reason).toContain("سحابيّ")
    expect(railProfile("auto", "ollama/qwen3.5:9b", true).reason).toContain("محلّيّ")
    expect(railProfile("strict", "deepseek/deepseek-chat", false).tier).toBe("strict")
    expect(railProfile("thin", "ollama/qwen3.5:9b", true).tier).toBe("thin")
  })
})
