import { describe, expect, test } from "bun:test"
import { settingsPatchConfirmed } from "../../desktop/ui/native-shell.js"

/**
 * مقيسٌ 2026-09-13 على التطبيق المثبَّت عبر CDP: حفظُ اللغة أرسل رقعةً فيها `visionModel: ""`
 * (حقلٌ فارغ في النموذج)، والمحرّكُ حفظ وأعاد الصدى `settings{language:"ar"}` **بلا** `visionModel`
 * (`saveSettings` يحذف الفارغ). المطابقةُ الحرفيّة رفضت الصدى، فانتظرت القشرةُ ١٥ ثانية وأعلنت
 * «لم يؤكّد المحرّك» — واللغةُ لم تتغيّر، واللوحةُ بقيت مقفلةً (inert) طوال الانتظار.
 */
describe("settings patch confirmation — the engine's echo is the truth", () => {
  test("a cleared optional field that comes back absent still confirms the patch", () => {
    const patch = { model: "qwen-token-plan/qwen3.7-plus", chatModel: "qwen-token-plan/qwen3.7-plus", agentModel: "qwen-token-plan/qwen3.7-plus", visionModel: "", language: "ar", workMode: "basic" }
    const echo = { model: "qwen-token-plan/qwen3.7-plus", chatModel: "qwen-token-plan/qwen3.7-plus", agentModel: "qwen-token-plan/qwen3.7-plus", language: "ar", workMode: "basic", mode: "auto" }
    expect(settingsPatchConfirmed(echo, patch)).toBe(true)
  })

  test("the twin: a differing value is still not a confirmation — the fix is not 'accept anything'", () => {
    expect(settingsPatchConfirmed({ language: "en" }, { language: "ar" })).toBe(false)
    expect(settingsPatchConfirmed({}, { language: "ar" })).toBe(false)
    expect(settingsPatchConfirmed({ visionModel: "openai/gpt-4o" }, { visionModel: "" })).toBe(false)
    expect(settingsPatchConfirmed({ plugins: { memory: false } }, { plugins: { memory: true } })).toBe(false)
  })

  test("nested plugin patches and a set vision model match as before", () => {
    expect(settingsPatchConfirmed({ plugins: { memory: true, lessons: false }, visionModel: "qwen-token-plan/qwen3.8-max" }, { plugins: { memory: true }, visionModel: "qwen-token-plan/qwen3.8-max" })).toBe(true)
  })
})
