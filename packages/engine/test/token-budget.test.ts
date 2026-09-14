import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decodeChatResponse } from "@abdo/model-gateway"
import {
  DEFAULT_CLOUD_CACHE_DISCOUNT, cacheDiscount, cachedTokensOf, chargeableUsage, cloudBudgetVerdict, cloudUsageSnapshot, conservativeTokens, effectiveTokens,
  ledgerSummary, rawSpentTokens, readLedgerSummary, recordCloudUsage, renderLedgerLine, spentTokens,
} from "../src/token-budget"

const dirs: string[] = []
const freshDir = () => { const d = mkdtempSync(join(tmpdir(), "abdo-ledger-")); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe("cloud token budget — hard 10M cap, fail-closed (owner decision 2026-08-30)", () => {
  test("a missing ledger is a legitimate zero, not a refusal", () => {
    const path = join(freshDir(), "ledger.json")
    expect(spentTokens(path)).toBe(0)
    expect(cloudBudgetVerdict(40_000, path).allowed).toBe(true)
  })

  test("a corrupt ledger is UNKNOWN — the call is refused, zero is not assumed", () => {
    const path = join(freshDir(), "ledger.json")
    writeFileSync(path, "{ broken", "utf8")
    expect(spentTokens(path)).toBe("unknown")
    const verdict = cloudBudgetVerdict(1, path)
    expect(verdict.allowed).toBe(false)
    expect(verdict.message).toContain("مجهول")
  })

  test("recording accumulates and the cap blocks before the wire", () => {
    const path = join(freshDir(), "ledger.json")
    process.env.ABDO_CLOUD_TOKEN_CAP = "100000"
    try {
      recordCloudUsage({ provider: "dashscope", model: "qwen-max", inputTokens: 60_000, outputTokens: 30_000 }, path)
      expect(spentTokens(path)).toBe(90_000)
      expect(cloudBudgetVerdict(5_000, path).allowed).toBe(true)
      const blocked = cloudBudgetVerdict(15_000, path)
      expect(blocked.allowed).toBe(false)
      expect(blocked.message).toContain("استُنفدت")
    } finally { delete process.env.ABDO_CLOUD_TOKEN_CAP }
  })

  test("recording over a corrupt ledger throws — no charge lands on an unknown book", () => {
    const path = join(freshDir(), "ledger.json")
    writeFileSync(path, "not json", "utf8")
    expect(() => recordCloudUsage({ provider: "dashscope", model: "qwen-max", inputTokens: 1, outputTokens: 1 }, path)).toThrow()
  })

  test("conservative accounting: missing or negative reports fall back to the estimate", () => {
    expect(conservativeTokens(undefined, 32_000)).toBe(32_000)
    expect(conservativeTokens(Number.NaN, 32_000)).toBe(32_000)
    expect(conservativeTokens(-5, 32_000)).toBe(32_000)
    expect(conservativeTokens(41_200, 32_000)).toBe(41_200)
  })

  test("the ledger on disk is readable JSON with per-call entries", () => {
    const path = join(freshDir(), "ledger.json")
    recordCloudUsage({ provider: "dashscope", model: "qwen-max", inputTokens: 10, outputTokens: 20 }, path)
    recordCloudUsage({ provider: "dashscope", model: "qwen-max", inputTokens: 5, outputTokens: 5 }, path)
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    expect(parsed.entries.length).toBe(2)
    expect(spentTokens(path)).toBe(40)
  })
})

/** token-plan probe 2026-09-02: prompt_tokens=4558, cached_tokens=4224, completion_tokens=43. */
const PROBE = { provider: "token-plan", model: "qwen-max", inputTokens: 4558, outputTokens: 43, cachedInputTokens: 4224 }

describe("cache-aware accounting — raw tokens are not cost (owner directive 2026-09-02)", () => {
  afterEach(() => { delete process.env.ABDO_CLOUD_CACHE_DISCOUNT; delete process.env.ABDO_CLOUD_TOKEN_CAP })

  test("discount defaults to 0.25 and only a number in [0, 1] overrides it", () => {
    expect(DEFAULT_CLOUD_CACHE_DISCOUNT).toBe(0.25)
    expect(cacheDiscount()).toBe(0.25)
    for (const [raw, expected] of [["0.1", 0.1], ["0", 0], ["1", 1], ["  0.5 ", 0.5]] as const) {
      process.env.ABDO_CLOUD_CACHE_DISCOUNT = raw
      expect(cacheDiscount()).toBe(expected)
    }
    for (const raw of ["1.5", "-0.1", "abc", "", "   ", "NaN", "Infinity"]) {
      process.env.ABDO_CLOUD_CACHE_DISCOUNT = raw
      expect(cacheDiscount()).toBe(0.25)
    }
  })

  test("effective tokens on the measured probe: 43 + 334 + 1056 = 1433", () => {
    expect(effectiveTokens(PROBE)).toBe(1433)
    expect(effectiveTokens(PROBE, 0.25)).toBe(1433)
    process.env.ABDO_CLOUD_CACHE_DISCOUNT = "0.1"
    expect(effectiveTokens(PROBE)).toBe(43 + 334 + Math.ceil(422.4))
  })

  test("cached is clamped to [0, inputTokens] and never invented", () => {
    expect(cachedTokensOf({ inputTokens: 100, cachedInputTokens: 250 })).toBe(100)
    expect(cachedTokensOf({ inputTokens: 100, cachedInputTokens: -7 })).toBe(0)
    expect(cachedTokensOf({ inputTokens: 100, cachedInputTokens: Number.NaN })).toBe(0)
    expect(cachedTokensOf({ inputTokens: 100 })).toBe(0)
    // over-reported cache cannot push the charge below output + input * discount
    expect(effectiveTokens({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 250 })).toBe(10 + 25)
    // missing cache = full price, exactly the legacy figure
    expect(effectiveTokens({ inputTokens: 100, outputTokens: 10 })).toBe(110)
  })

  test("legacy entries without the field load and charge exactly as before", () => {
    const path = join(freshDir(), "ledger.json")
    writeFileSync(path, JSON.stringify({ capTokens: 10_000_000, entries: [
      { at: "2026-08-30T00:00:00.000Z", provider: "dashscope", model: "qwen-max", inputTokens: 60_000, outputTokens: 30_000 },
      { at: "2026-08-30T00:01:00.000Z", provider: "dashscope", model: "qwen-max", inputTokens: 5, outputTokens: 5 },
    ] }), "utf8")
    expect(spentTokens(path)).toBe(90_010)
    expect(rawSpentTokens(path)).toBe(90_010)
    const summary = readLedgerSummary(path)
    expect(summary).toEqual({ calls: 2, inputTokens: 60_005, cachedInputTokens: 0, outputTokens: 30_005, effectiveTokens: 90_010, cacheHitRate: 0 })
  })

  test("discount 1 is the OFF switch: effective equals raw even with cached entries", () => {
    process.env.ABDO_CLOUD_CACHE_DISCOUNT = "1"
    const path = join(freshDir(), "ledger.json")
    recordCloudUsage(PROBE, path)
    expect(spentTokens(path)).toBe(4558 + 43)
    expect(rawSpentTokens(path)).toBe(4558 + 43)
  })

  test("the cap compares effective spend, not raw", () => {
    const path = join(freshDir(), "ledger.json")
    process.env.ABDO_CLOUD_TOKEN_CAP = "2000"
    recordCloudUsage(PROBE, path)               // raw 4601 > cap 2000, effective 1433 < cap
    expect(rawSpentTokens(path)).toBe(4601)
    expect(spentTokens(path)).toBe(1433)
    const allowed = cloudBudgetVerdict(500, path)
    expect(allowed.allowed).toBe(true)
    expect(allowed.spent).toBe(1433)
    const blocked = cloudBudgetVerdict(600, path) // 1433 + 600 > 2000
    expect(blocked.allowed).toBe(false)
    expect(blocked.message).toContain("منفَق 1433")
    process.env.ABDO_CLOUD_CACHE_DISCOUNT = "1"   // OFF ⇦ raw 4601 already over the cap
    expect(cloudBudgetVerdict(1, path).allowed).toBe(false)
  })

  test("the entry on disk carries cachedInputTokens verbatim", () => {
    const path = join(freshDir(), "ledger.json")
    recordCloudUsage(PROBE, path)
    recordCloudUsage({ provider: "token-plan", model: "qwen-max", inputTokens: 7, outputTokens: 3 }, path)
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    expect(parsed.entries[0].cachedInputTokens).toBe(4224)
    expect("cachedInputTokens" in parsed.entries[1]).toBe(false)
  })

  test("summary numbers on the measured probe and the Arabic event line", () => {
    const summary = ledgerSummary([{ at: "2026-09-02T00:00:00.000Z", ...PROBE }])
    expect(summary).toEqual({ calls: 1, inputTokens: 4558, cachedInputTokens: 4224, outputTokens: 43, effectiveTokens: 1433, cacheHitRate: 4224 / 4558 })
    expect(Math.round(summary.cacheHitRate * 100)).toBe(93)
    expect(renderLedgerLine(summary, 10_000_000)).toBe("💳 السحابة: نداءات=1 · إدخال=4558 (مخبوء=4224، 93%) · إخراج=43 · فعّال=1433/10000000")
    expect(ledgerSummary([])).toEqual({ calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, effectiveTokens: 0, cacheHitRate: 0 })
    expect(renderLedgerLine(ledgerSummary([]))).toContain("فعّال=0/10000000")
  })

  test("a corrupt ledger stays unknown for the summary too", () => {
    const path = join(freshDir(), "ledger.json")
    writeFileSync(path, "{ broken", "utf8")
    expect(readLedgerSummary(path)).toBe("unknown")
    expect(rawSpentTokens(path)).toBe("unknown")
    expect(readLedgerSummary(join(freshDir(), "absent.json"))).toEqual(ledgerSummary([]))
  })

  test("native usage is aggregate-only and distinguishes the local cap from provider quota", () => {
    const path = join(freshDir(), "ledger.json")
    process.env.ABDO_CLOUD_TOKEN_CAP = "2000"
    process.env.ABDO_CLOUD_CACHE_DISCOUNT = "0.25"
    recordCloudUsage(PROBE, path)
    expect(cloudUsageSnapshot(path)).toEqual({
      status: "available",
      source: "local-cloud-token-ledger",
      localModelsIncluded: false,
      capTokens: 2000,
      remainingTokens: 567,
      calls: 1,
      inputTokens: 4558,
      cachedInputTokens: 4224,
      outputTokens: 43,
      rawTokens: 4601,
      effectiveTokens: 1433,
      cacheHitRate: 4224 / 4558,
      cacheDiscount: 0.25,
    })
    const exposed = JSON.stringify(cloudUsageSnapshot(path))
    expect(exposed).not.toContain(path)
    expect(exposed).not.toContain("token-plan")
    expect(exposed).not.toContain("qwen-max")
  })

  test("native usage keeps unreadable or impossible ledgers visibly unknown", () => {
    const dir = freshDir()
    const corrupt = join(dir, "corrupt.json")
    const impossible = join(dir, "impossible.json")
    writeFileSync(corrupt, "{ broken", "utf8")
    writeFileSync(impossible, JSON.stringify({ capTokens: 10_000_000, entries: [
      { at: "t", provider: "p", model: "m", inputTokens: 10, outputTokens: -20 },
    ] }), "utf8")
    for (const path of [corrupt, impossible]) {
      expect(cloudUsageSnapshot(path)).toMatchObject({
        status: "unknown", source: "local-cloud-token-ledger", localModelsIncluded: false,
        calls: null, rawTokens: null, effectiveTokens: null, remainingTokens: null,
      })
    }
  })

  test("cacheHitRate never exceeds 1 even when a negative-input entry shrinks the raw denominator", () => {
    const summary = ledgerSummary([
      { at: "t", provider: "p", model: "m", inputTokens: 100, outputTokens: 0, cachedInputTokens: 100 },
      { at: "t", provider: "p", model: "m", inputTokens: -50, outputTokens: 0 },
    ])
    expect(summary.inputTokens).toBe(50)          // raw stays raw for reporting
    expect(summary.cachedInputTokens).toBe(100)
    expect(summary.cacheHitRate).toBe(1)
    expect(renderLedgerLine(summary, 1_000)).toContain("(مخبوء=100، 100%)")
    expect(ledgerSummary([{ at: "t", provider: "p", model: "m", inputTokens: -50, outputTokens: 0 }]).cacheHitRate).toBe(0)
  })

  test("an explicit discount outside [0, 1] can neither inflate nor negate the charge", () => {
    const entry = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 100 }
    const byDefault = effectiveTokens(entry)
    expect(byDefault).toBe(10 + 100 * DEFAULT_CLOUD_CACHE_DISCOUNT)
    for (const bad of [5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const charged = effectiveTokens(entry, bad)
      expect(charged).toBe(byDefault)
      expect(charged).toBeGreaterThanOrEqual(entry.outputTokens + entry.inputTokens * DEFAULT_CLOUD_CACHE_DISCOUNT)
      expect(charged).toBeLessThanOrEqual(entry.outputTokens + entry.inputTokens)
      expect(ledgerSummary([{ at: "t", provider: "p", model: "m", ...entry }], bad).effectiveTokens).toBe(byDefault)
    }
    expect(effectiveTokens(entry, 1)).toBe(110)
    expect(effectiveTokens(entry, 0)).toBe(10)
  })
})

/** The wire payload measured on token-plan 2026-09-02 (OpenAI-compatible detail blocks). */
const PROBE_PAYLOAD = {
  choices: [{ finish_reason: "stop", message: { content: "ok" } }],
  usage: {
    prompt_tokens: 4558, completion_tokens: 43,
    prompt_tokens_details: { cached_tokens: 4224, text_tokens: 4558 },
    completion_tokens_details: { reasoning_tokens: 38, text_tokens: 43 },
  },
}

describe("decoded usage → ledger entry (the live cli.ts path, end to end)", () => {
  afterEach(() => { delete process.env.ABDO_CLOUD_CACHE_DISCOUNT })

  test("the probe response lands on disk with cachedInputTokens and is charged 1433, not 4601", () => {
    const path = join(freshDir(), "ledger.json")
    const decoded = decodeChatResponse("openai-compatible", PROBE_PAYLOAD)
    recordCloudUsage({ provider: "token-plan", model: "qwen-max", ...chargeableUsage(decoded.usage, 3_000, 8_000) }, path)
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    expect(parsed.entries[0]).toMatchObject({ inputTokens: 4558, outputTokens: 43, cachedInputTokens: 4224 })
    expect(spentTokens(path)).toBe(1433)
    expect(rawSpentTokens(path)).toBe(4601)
    expect(readLedgerSummary(path)).toMatchObject({ calls: 1, cachedInputTokens: 4224 })
  })

  test("plugins.cacheAccounting=false is provably legacy: no field written, full price charged", () => {
    const path = join(freshDir(), "ledger.json")
    const decoded = decodeChatResponse("openai-compatible", PROBE_PAYLOAD)
    recordCloudUsage({ provider: "token-plan", model: "qwen-max", ...chargeableUsage(decoded.usage, 3_000, 8_000, false) }, path)
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    expect("cachedInputTokens" in parsed.entries[0]).toBe(false)
    expect(parsed.entries[0]).toMatchObject({ inputTokens: 4558, outputTokens: 43 })
    expect(spentTokens(path)).toBe(4601)
  })

  test("absent or malformed cache counts are never written — absence stays absence", () => {
    const noDetails = decodeChatResponse("openai-compatible", { choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } })
    expect(chargeableUsage(noDetails.usage, 4, 8)).toEqual({ inputTokens: 10, outputTokens: 1 })
    expect(chargeableUsage({ inputTokens: 10, outputTokens: 1, cachedInputTokens: Number.NaN }, 4, 8)).toEqual({ inputTokens: 10, outputTokens: 1 })
    expect(chargeableUsage({ inputTokens: 10, outputTokens: 1, cachedInputTokens: -3 }, 4, 8)).toEqual({ inputTokens: 10, outputTokens: 1 })
    // no usage at all → the conservative estimates, no cache field
    expect(chargeableUsage({}, 4, 8)).toEqual({ inputTokens: 4, outputTokens: 8 })
  })

  test("cached is clamped to the charged input; a reported input count wins and the estimate fills only absence (HEAD semantics)", () => {
    expect(chargeableUsage({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 250 }, 10, 8)).toEqual({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 100 })
    // a finite reported input is charged as reported, even below the estimate; the cache count survives within it
    expect(chargeableUsage({ inputTokens: 50, outputTokens: 5, cachedInputTokens: 40 }, 3_000, 8)).toEqual({ inputTokens: 50, outputTokens: 5, cachedInputTokens: 40 })
    expect(chargeableUsage({ inputTokens: 50, outputTokens: 5, cachedInputTokens: 0 }, 10, 8)).toEqual({ inputTokens: 50, outputTokens: 5, cachedInputTokens: 0 })
    // absent input → the estimate is charged and the cache count is clamped to it
    expect(chargeableUsage({ outputTokens: 5, cachedInputTokens: 40 }, 30, 8)).toEqual({ inputTokens: 30, outputTokens: 5, cachedInputTokens: 30 })
  })
})
