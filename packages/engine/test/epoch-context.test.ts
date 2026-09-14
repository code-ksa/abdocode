import { describe, expect, test } from "bun:test"
import { trimEpochHistory } from "../src/epoch-context"

const msg = (role: string, content: string) => ({ role, content })

describe("epoch context — S5 budget trim", () => {
  test("keeps everything under budget untouched", () => {
    const h = [msg("user", "a"), msg("assistant", "b")]
    const r = trimEpochHistory(h, 1024)
    expect(r.dropped).toBe(0)
    expect(r.kept.length).toBe(2)
  })

  test("trims oldest to a byte budget while protecting the most recent", () => {
    const big = "x".repeat(4000)
    const h = Array.from({ length: 20 }, (_, i) => msg(i % 2 ? "assistant" : "user", `${big}-${i}`))
    const r = trimEpochHistory(h, 20 * 1024, 4)
    expect(r.dropped).toBeGreaterThan(0)
    // آخر أربع رسائل محفوظة دائماً.
    expect(r.kept.some((m) => m.content.endsWith("-19"))).toBe(true)
    expect(r.kept.some((m) => m.content.endsWith("-18"))).toBe(true)
    expect(r.note).toContain("قُصّت")
  })

  test("protects acceptance receipts wherever they sit in history", () => {
    const big = "y".repeat(6000)
    const h = [
      msg("assistant", "↻ run npm run build\nCompiled successfully in 200ms"), // إيصال قبول قديم
      ...Array.from({ length: 15 }, (_, i) => msg("user", `${big}-${i}`)),
    ]
    const r = trimEpochHistory(h, 16 * 1024, 3)
    expect(r.dropped).toBeGreaterThan(0)
    expect(r.kept.some((m) => m.content.includes("Compiled successfully"))).toBe(true)
  })
})
