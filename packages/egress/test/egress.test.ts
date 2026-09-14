import { afterEach, describe, expect, test } from "bun:test"
import * as Egress from "../src/egress"

/**
 * These tests pin the product's promise to its user: it contacts only
 * destinations it has declared, and it refuses the rest.
 *
 * Each one is written so that it FAILS if the guarantee is weakened — that is
 * the only kind of security test worth having. The 2026-08-20 audit found a
 * leak that had a green test guarding it (`expect(baseUrl).toBe(upstream)`),
 * so the shape to avoid is a test that pins the behaviour rather than the
 * property.
 */
describe("egress guard", () => {
  afterEach(() => Egress.reset())

  test("refuses a destination that was never declared", async () => {
    Egress.install()
    expect(Egress.isInstalled()).toBe(true)
    await expect(fetch("https://someone-elses-server.example/collect")).rejects.toThrow(/egress refused/)
  })

  test("names the host and the reason when it refuses", async () => {
    Egress.install()
    try {
      await fetch("https://telemetry.example/beacon")
      throw new Error("the guard let it through")
    } catch (error) {
      expect(String(error)).toContain("telemetry.example")
      expect(String(error)).toContain("never declared")
    }
  })

  test("permits declared local destinations", () => {
    expect(Egress.decide("127.0.0.1").decision).toBe("allowed")
    expect(Egress.decide("localhost").decision).toBe("allowed")
  })

  test("permits a provider only once the user's catalogue declares it", () => {
    expect(Egress.decide("api.acme-models.example").decision).toBe("denied")
    Egress.allowProviderHosts({
      acme: { api: "https://api.acme-models.example/v1", name: "Acme" },
    })
    const after = Egress.decide("api.acme-models.example")
    expect(after.decision).toBe("allowed")
    expect(after.reason).toContain("Acme")
  })

  test("the upstream project can never be re-allowed", () => {
    // The whole point. Even an explicit allow must not reopen a severed
    // connection, because the way these come back is somebody widening a rule
    // for an unrelated reason.
    for (const host of ["opncd.ai", "api.opencode.ai", "social-cards.sst.dev", "models.dev", "anoma.ly"]) {
      Egress.allow(host, "deliberately trying to permit it")
      const decision = Egress.decide(host)
      expect(decision.decision).toBe("denied")
      expect(decision.reason).toContain("forbidden")
    }
  })

  test("subdomains of a forbidden host are forbidden too", () => {
    expect(Egress.decide("anything.opencode.ai").decision).toBe("denied")
    expect(Egress.decide("cdn.sst.dev").decision).toBe("denied")
    // التوأمُ الإيجابيّ: مزوّدٌ يختاره العميل يُسمح حين يُعلَن — الحارسُ يفرّق النَّسَبَ الموروث عن المزوّد
    expect(Egress.decide("api.deepseek.com").decision).toBe("denied")
    Egress.allow("api.deepseek.com", "model provider DeepSeek")
    expect(Egress.decide("api.deepseek.com").decision).toBe("allowed")
  })

  test("records every attempt, allowed and refused alike", async () => {
    Egress.install()
    await fetch("https://blocked.example/x").catch(() => undefined)
    const entries = Egress.ledger()
    expect(entries.length).toBeGreaterThan(0)
    const blocked = entries.find((e) => e.host === "blocked.example")
    expect(blocked?.decision).toBe("denied")
  })

  test("installing twice does not wrap twice", async () => {
    Egress.install()
    const wrapped = globalThis.fetch
    Egress.install()
    expect(globalThis.fetch).toBe(wrapped)
    await fetch("https://blocked.example/x").catch(() => undefined)
    // A double wrap would record the same attempt twice.
    expect(Egress.ledger().filter((e) => e.host === "blocked.example").length).toBe(1)
  })

  test("uninstall restores the original fetch", () => {
    const before = globalThis.fetch
    Egress.install()
    expect(globalThis.fetch).not.toBe(before)
    Egress.uninstall()
    expect(globalThis.fetch).toBe(before)
  })

  test("states what it cannot see", () => {
    const coverage = Egress.describeCoverage()
    expect(coverage.join(" ")).toContain("child processes")
    expect(coverage.join(" ")).toContain("WebSocket")
  })

  test("the declared list carries a reason for every entry", () => {
    for (const rule of Egress.declared()) {
      expect(rule.why.length).toBeGreaterThan(0)
    }
  })
})
