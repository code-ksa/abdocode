/**
 * 10-11 — the turn meter charges cached input at the provider's real price ratio. Measured on the CRM run: 95% of DeepSeek input was
 * cached, and the flat 0.25 discount made 40 minutes look like 2.8M «effective» tokens (real cost ≈ $0.12), cutting the work into legs.
 */
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cacheDiscountFor } from "../src/token-budget"
import { TurnSpendMeter } from "../src/turn-budget"

afterEach(() => { delete process.env.ABDO_CLOUD_CACHE_DISCOUNT })

// one leg of the CRM run, from the account counters: 8.13M input, 7.75M of it cached, 168k output
const LEG = { inputTokens: 8_130_000, cachedInputTokens: 7_750_000, outputTokens: 168_000 }

test("DeepSeek's cached input is charged at its real ratio (~0.03), not the flat 0.25 — same leg, about a third of the meter", () => {
  const deepseek = new TurnSpendMeter(10_000_000)
  deepseek.charge(LEG, cacheDiscountFor("deepseek"))
  const flat = new TurnSpendMeter(10_000_000)
  flat.charge(LEG, cacheDiscountFor("some-other-cloud"))
  expect(cacheDiscountFor("deepseek")).toBeLessThan(0.05)
  expect(flat.snapshot().spent).toBe(Math.ceil(168_000 + 380_000 + 7_750_000 * 0.25)) // 2,485,500 — the old meter
  expect(deepseek.snapshot().spent).toBeLessThan(900_000)
})

test("the twins: an unknown provider keeps 0.25, and ABDO_CLOUD_CACHE_DISCOUNT still overrides every provider", () => {
  expect(cacheDiscountFor("nvidia3")).toBe(0.25)
  expect(cacheDiscountFor(undefined)).toBe(0.25)
  process.env.ABDO_CLOUD_CACHE_DISCOUNT = "1"
  expect(cacheDiscountFor("deepseek")).toBe(1)
})

test("every turn-meter charge in cli passes the answering provider's discount", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
  expect(cli.split("hooks.turnMeter?.charge(charged, cacheDiscountFor(prov.id))").length - 1).toBe(6)
  expect(cli).not.toContain("hooks.turnMeter?.charge(charged)")
})
