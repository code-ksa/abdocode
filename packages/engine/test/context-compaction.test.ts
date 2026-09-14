import { describe, expect, test } from "bun:test"
import { COMPACT_MARK, compactConversation, compactionEventLine, contextLeftOf, shouldCompact } from "../src/context-compaction"

const tokens = (m: { content: string }) => Math.ceil(m.content.length / 4)
const msg = (role: "user" | "assistant", content: string) => ({ role, content })

describe("context left is a real ratio, never the constant 1", () => {
  test("clamped between 0 and 1 and derived from estimate/window", () => {
    expect(contextLeftOf(0, 65_536)).toBe(1)
    expect(contextLeftOf(32_768, 65_536)).toBe(0.5)
    expect(contextLeftOf(70_000, 65_536)).toBe(0)
    expect(contextLeftOf(100, 0)).toBe(1)
  })
})

describe("auto-compact folds the oldest exchanges into a verified summary and keeps the recent tail intact", () => {
  const history = Array.from({ length: 16 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `رسالة ${i} `.repeat(40)))
  test("triggers on message count or on the token ratio, not before", () => {
    expect(shouldCompact(history, tokens, 1_000_000)).toBe(true) // 16 > 12
    expect(shouldCompact(history.slice(0, 6), tokens, 1_000_000)).toBe(false)
    expect(shouldCompact(history.slice(0, 6), tokens, 100)).toBe(true) // ratio
    expect(shouldCompact(history.slice(0, 4), tokens, 1)).toBe(false) // nothing to fold beyond keepRecent
  })
  test("folded shape: mark + summary + last 4, alternation preserved, tokens shrink, count reported", () => {
    const r = compactConversation(history, "تمّ: كُتب index.html\nفهمت: المشروع فيت", 4, tokens)
    expect(r.dropped).toBe(12)
    expect(r.messages).toHaveLength(6)
    expect(r.messages[0]).toEqual({ role: "user", content: COMPACT_MARK })
    expect(r.messages[1]!.role).toBe("assistant")
    expect(r.messages[1]!.content).toContain("كُتب index.html")
    expect(r.messages.slice(2)).toEqual(history.slice(-4))
    expect(r.afterTokens).toBeLessThan(r.beforeTokens)
    expect(compactionEventLine(r, 4)).toContain("12 رسائل قديمة")
  })
  test("twin: an empty summary still tells the truth about what was dropped; a short history is returned unchanged", () => {
    const r = compactConversation(history, "   ", 4, tokens)
    expect(r.messages[1]!.content).toContain("حُذفت 12 رسائل أقدم")
    const same = compactConversation(history.slice(0, 4), "x", 4, tokens)
    expect(same.dropped).toBe(0)
    expect(same.messages).toEqual(history.slice(0, 4))
  })
  test("odd keepRecent is rounded down to keep user/assistant alternation", () => {
    expect(compactConversation(history, "s", 5, tokens).messages).toHaveLength(6)
  })
})
