import { describe, expect, test } from "bun:test"
import { MemoryEventStore } from "@abdo/event-store"
import { appendManifest, buildManifest, manifestEntry, readManifests, MANIFEST_EVENT } from "../src/index"

const ids = {
  requestId: "req_1",
  sessionId: "ses_1",
  runId: "run_1",
  attemptId: "att_1",
  contextEpochId: "epoch_1",
  providerId: "minimax",
  modelId: "MiniMax-Text-01",
}

describe("ContextManifest", () => {
  test("an included entry records tokens/bytes/hash; an excluded entry records only the hash + reason", () => {
    const inc = manifestEntry("sys", "system_safety", "SAFETY", { priority: 1, included: true, reason: "protected" })
    const exc = manifestEntry("old", "old_detail", "some old text", { priority: 11, included: false, reason: "evicted-tokens" })
    expect(inc.includedBytes).toBeGreaterThan(0)
    expect(inc.estimatedTokens).toBeGreaterThan(0)
    expect(inc.contentHash).toMatch(/^[0-9a-f]{8}$/)
    expect(exc.includedBytes).toBe(0)
    expect(exc.estimatedTokens).toBe(0)
    expect(exc.contentHash).toMatch(/^[0-9a-f]{8}$/) // still hashed for diffing
    expect(exc.reason).toBe("evicted-tokens")
  })

  test("totals count only included entries", () => {
    const entries = [
      manifestEntry("u", "current_user_message", "aaaa", { priority: 3, included: true, reason: "protected" }),
      manifestEntry("t", "recent_tail", "bbbb", { priority: 8, included: true, reason: "fits-budget" }),
      manifestEntry("x", "old_detail", "cccccccc", { priority: 11, included: false, reason: "evicted-tokens" }),
    ]
    const m = buildManifest(ids, entries, 200)
    expect(m.serializedBytes).toBe(8) // 4 + 4, excluded not counted
    expect(m.reservedOutputTokens).toBe(200)
    expect(m.entries).toHaveLength(3)
  })

  test("the manifest never stores content or secrets — only hashes", () => {
    const secret = "sk-supersecret-value-1234567890"
    const entry = manifestEntry("tool", "historical_tool_output", `token is ${secret}`, { priority: 10, included: true, reason: "fits-budget" })
    const m = buildManifest(ids, [entry], 100)
    const serialized = JSON.stringify(m)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("token is")
  })

  test("persisted to the event log and read back (survives restart)", async () => {
    const store = new MemoryEventStore()
    const m = buildManifest(ids, [manifestEntry("u", "current_user_message", "hello", { priority: 3, included: true, reason: "protected" })], 100)
    await appendManifest(store, m)

    const types = (await store.readAll()).map((e) => e.type)
    expect(types).toContain(MANIFEST_EVENT)

    const read = await readManifests(store, "ses_1")
    expect(read).toHaveLength(1)
    expect(read[0]?.requestId).toBe("req_1")
    expect(read[0]?.modelId).toBe("MiniMax-Text-01")
  })
})
