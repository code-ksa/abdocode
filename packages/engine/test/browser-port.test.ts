/**
 * 10-08 — two engines (two projects) shared CDP port 9333, so one drove the other's browser and stalled.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BROWSER_PORT_BASE, browserPortFor } from "../src/browser-port"

test("the port is stable for one state dir, differs across the measured engines, and stays in range", () => {
  const site = "C:/Users/dev/.abdocode-runs/site-a/state"
  const siteB = "C:/Users/dev/.abdocode-runs/site-b/state"
  expect(browserPortFor(site)).toBe(browserPortFor(site))
  expect(browserPortFor(site)).toBe(browserPortFor("C:\\Users\\dev\\.abdocode-runs\\site-a\\state"))
  expect(browserPortFor(site)).not.toBe(browserPortFor(siteB))
  for (const p of [browserPortFor(site), browserPortFor(siteB)]) { expect(p).toBeGreaterThanOrEqual(BROWSER_PORT_BASE); expect(p).toBeLessThan(BROWSER_PORT_BASE + 400) }
})

test("the managed browser launch uses the derived port", () => {
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
  expect(cli).toContain("const port = browserPortFor(STATE_ROOT)")
  expect(cli).not.toMatch(/const port = 9333\b/u)
})
