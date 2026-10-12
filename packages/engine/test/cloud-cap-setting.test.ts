/**
 * 10-09 (measured on installed 4.0.111): the shared ledger reached 294M against a 100M cap, and the only way to raise it was a hidden
 * environment variable the app inherits only after Explorer restarts. The cap is now a visible setting (`cloudTokenCap`): the setting
 * first, then ABDO_CLOUD_TOKEN_CAP, then the default — and the refusal tells the user where to raise it.
 */
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CLOUD_CAP_TOKENS, cloudBudgetVerdict, configuredCloudTokenCap, useCloudCapSetting } from "../src/token-budget"

const envBefore = process.env.ABDO_CLOUD_TOKEN_CAP
afterEach(() => {
  useCloudCapSetting(() => undefined)
  if (envBefore === undefined) delete process.env.ABDO_CLOUD_TOKEN_CAP
  else process.env.ABDO_CLOUD_TOKEN_CAP = envBefore
})

test("precedence: the setting, then ABDO_CLOUD_TOKEN_CAP, then the default; an invalid setting falls through", () => {
  delete process.env.ABDO_CLOUD_TOKEN_CAP
  expect(configuredCloudTokenCap()).toBe(DEFAULT_CLOUD_CAP_TOKENS)
  process.env.ABDO_CLOUD_TOKEN_CAP = "100000000"
  expect(configuredCloudTokenCap()).toBe(100_000_000)
  useCloudCapSetting(() => 600_000_000)
  expect(configuredCloudTokenCap()).toBe(600_000_000)
  useCloudCapSetting(() => -5)
  expect(configuredCloudTokenCap()).toBe(100_000_000)
})

test("the budget verdict follows the setting, and the refusal names where to raise it", () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-cloudcap-"))
  try {
    const ledger = join(dir, "ledger.json")
    writeFileSync(ledger, JSON.stringify({ capTokens: 1, entries: [{ at: new Date().toISOString(), provider: "nvidia", model: "m", inputTokens: 3_000_000, outputTokens: 0 }] }))
    useCloudCapSetting(() => 2_000_000)
    const refused = cloudBudgetVerdict(10_000, ledger)
    expect(refused.allowed).toBe(false)
    expect(refused.message).toContain("السقف 2000000")
    expect(refused.message).toContain("«سقف أمان السحابة»")
    // the twin: raising the setting lets the same call through, no restart, no environment variable
    useCloudCapSetting(() => 5_000_000)
    expect(cloudBudgetVerdict(10_000, ledger).allowed).toBe(true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("wiring: the engine reads the setting, validates it (no 0 = off), and the local settings panel offers the field", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
  expect(cli).toContain("useCloudCapSetting(() => loadSettings().cloudTokenCap)")
  expect(cli).toContain('"turnTokenCap", "cloudTokenCap",')
  expect(cli).toContain("value.cloudTokenCap < 1_000_000")
  const ui = readFileSync(join(import.meta.dir, "..", "..", "desktop", "ui", "native-local-settings.js"), "utf8")
  expect(ui).toContain("api.applyRuntimeSettings({cloudTokenCap:v})")
  expect(ui).toContain("سقف أمان السحابة (توكن)")
})
