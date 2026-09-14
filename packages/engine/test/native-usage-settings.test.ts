import { expect, test } from "bun:test"
import { exportableUsageSummary, normaliseMeterSummary, normaliseUsageSummary } from "../../desktop/ui/native-usage-settings.js"

const valid = {
  status: "available",
  source: "local-cloud-token-ledger",
  localModelsIncluded: false,
  capTokens: 1_000,
  remainingTokens: 750,
  calls: 2,
  inputTokens: 300,
  cachedInputTokens: 100,
  outputTokens: 50,
  rawTokens: 350,
  effectiveTokens: 250,
  cacheHitRate: 1 / 3,
  cacheDiscount: 0.25,
}

test("native usage accepts only internally consistent aggregate ledger totals", () => {
  expect(normaliseUsageSummary(valid)).toEqual(valid)
  expect(normaliseUsageSummary({ ...valid, rawTokens: 351 })).toMatchObject({ status: "unknown", rawTokens: null })
  expect(normaliseUsageSummary({ ...valid, remainingTokens: 751 })).toMatchObject({ status: "unknown", remainingTokens: null })
  expect(normaliseUsageSummary({ ...valid, cachedInputTokens: 301 })).toMatchObject({ status: "unknown", cachedInputTokens: null })
  expect(normaliseUsageSummary({ ...valid, source: "provider-invoice" })).toMatchObject({ status: "unknown" })
})

test("native usage renderer requests aggregates and makes provider billing limits explicit", async () => {
  const source = await Bun.file(new URL("../../desktop/ui/native-usage-settings.js", import.meta.url)).text()
  expect(source).toContain("Promise.resolve(api.bridge.send({kind:'usage-get',requestId})).catch(failed)")
  expect(source).toContain("does not receive provider plans, prices, balances, reset times or invoices")
  expect(source).toContain("no money estimate is inferred")
  expect(source).not.toContain("ABDO_TOKEN_LEDGER")
  expect(source).not.toMatch(/localStorage|sessionStorage/u)
  expect(source).toContain("abdocode:settings-rendered")
  expect(source).toContain("abdocode:settings-opened")
  const shell = await Bun.file(new URL("../../desktop/ui/native-shell.js", import.meta.url)).text()
  const usageMenu = shell.match(/function usageMenu\([^\n]+/u)?.[0]?.trim()
  expect(usageMenu).toBe("function usageMenu(_anchor){native.settings('nss-usage');}")
  expect(usageMenu).not.toContain("JSON.stringify")
  expect(usageMenu).not.toContain("runtime")
})

test("clipboard export is an aggregate allowlist and drops unexpected private fields", () => {
  const exported = exportableUsageSummary({
    ...valid,
    ledgerPath: "C:/private/ledger.json",
    entries: [{ provider: "private-provider", model: "private-model", prompt: "private prompt" }],
    apiKey: "must-not-leak",
  })
  expect(exported).toEqual({
    schema: "abdocode-cloud-usage-summary-v1",
    source: "local-cloud-token-ledger",
    scope: "recorded-cloud-model-calls-only",
    localModelsIncluded: false,
    providerAccountDataIncluded: false,
    totals: {
      calls: 2, inputTokens: 300, cachedInputTokens: 100, outputTokens: 50,
      rawTokens: 350, effectiveTokens: 250, cacheHitRate: 1 / 3,
    },
    localSafetyCap: { capTokens: 1_000, remainingTokens: 750 },
    cacheAccounting: { cachedInputFraction: 0.25 },
  })
  const wire = JSON.stringify(exported)
  for (const privateValue of ["C:/private/ledger.json", "private-provider", "private-model", "private prompt", "must-not-leak"]) {
    expect(wire).not.toContain(privateValue)
  }
  expect(exportableUsageSummary({ ...valid, rawTokens: 351 })).toBeNull()
})

test("the local meter summary is accepted only when its aggregates are consistent, and carries no provider or model names", () => {
  const ok = { status: "available", calls: 5, localCalls: 3, cloudCalls: 2, ms: 1234, reported: { calls: 4, inputTokens: 400, outputTokens: 50 }, charged: { inputTokens: 420, outputTokens: 50 }, malformed: 0 }
  expect(normaliseMeterSummary(ok)).toEqual(ok)
  expect(normaliseMeterSummary({ status: "absent" })).toEqual({ status: "absent" })
  expect(normaliseMeterSummary({ ...ok, localCalls: 4 })).toEqual({ status: "unknown" })
  expect(normaliseMeterSummary({ ...ok, reported: { ...ok.reported, calls: 6 } })).toEqual({ status: "unknown" })
  expect(normaliseMeterSummary({ ...ok, ms: -1 })).toEqual({ status: "unknown" })
  expect(normaliseMeterSummary(null)).toEqual({ status: "unknown" })
  // الأسماءُ لا مكانَ لها في الخلاصة: حقلٌ غريب لا يُنسخ.
  expect(JSON.stringify(normaliseMeterSummary({ ...ok, byModel: { "dashscope/qwen-max": 1 } }))).not.toContain("dashscope")
})
