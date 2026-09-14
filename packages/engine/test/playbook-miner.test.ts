import { describe, expect, test } from "bun:test"
import type { ToolVerdict } from "@abdo/engine-host"
import { PlaybookMiner } from "../src/playbook-miner"

describe("playbook miner — absorbed from Anton ACC (deterministic, zero model cost)", () => {
  test("an unknown failure repeated three times becomes one candidate, once", () => {
    const miner = new PlaybookMiner()
    const weird = "zlint: chromatic phase mismatch in sector 7\nانتهى الأمر برمز 1"
    expect(miner.observe(weird)).toBeUndefined()
    expect(miner.observe(weird)).toBeUndefined()
    const candidate = miner.observe(weird)
    expect(candidate?.hits).toBe(3)
    expect(candidate?.sample).toContain("chromatic phase mismatch")
    expect(miner.observe(weird)).toBeUndefined()
  })

  test("near-twin failures fold to one signature (paths, numbers, quotes normalized)", () => {
    const miner = new PlaybookMiner()
    expect(miner.observe("zlint: bad flux at C:\\a\\one line 12\nانتهى الأمر برمز 1")).toBeUndefined()
    expect(miner.observe("zlint: bad flux at C:\\b\\two line 99\nانتهى الأمر برمز 1")).toBeUndefined()
    expect(miner.observe("zlint: bad flux at /srv/three line 4\nانتهى الأمر برمز 1")?.hits).toBe(3)
  })

  test("a failure the playbook registry already knows is never a candidate", () => {
    const miner = new PlaybookMiner()
    const known = "error: database is locked (SQLITE_BUSY)\nانتهى الأمر برمز 1"
    for (let i = 0; i < 5; i++) expect(miner.observe(known)).toBeUndefined()
  })

  test("successful receipts are ignored", () => {
    const miner = new PlaybookMiner()
    for (let i = 0; i < 5; i++) expect(miner.observe("تم بنجاح\nانتهى الأمر برمز 0")).toBeUndefined()
  })
})

describe("playbook miner — explicit verdicts", () => {
  const silent = "zlint: chromatic phase mismatch in sector 7"

  test("a markerless, keywordless failure counts only through a failing verdict — three hits make one candidate", () => {
    const legacy = new PlaybookMiner()
    for (let i = 0; i < 3; i++) expect(legacy.observe(silent)).toBeUndefined()
    const miner = new PlaybookMiner()
    const failed: ToolVerdict = { ok: false, reason: "tool_failed", denied: false }
    expect(miner.observe(silent, failed)).toBeUndefined()
    expect(miner.observe(silent, failed)).toBeUndefined()
    const candidate = miner.observe(silent, failed)
    expect(candidate?.hits).toBe(3)
    expect(candidate?.sample).toContain("chromatic phase mismatch")
  })

  test("a policy denial never becomes a candidate however often it repeats, even with a non-zero marker in the text", () => {
    const miner = new PlaybookMiner()
    const denied: ToolVerdict = { ok: false, reason: "policy_denied", denied: true }
    for (let i = 0; i < 5; i++) expect(miner.observe(`${silent}\nانتهى الأمر برمز 1`, denied)).toBeUndefined()
  })
})
