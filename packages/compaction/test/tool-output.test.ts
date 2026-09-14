import { describe, expect, test } from "bun:test"
import { MemoryArtifactStore, classifyToolOutput, externalize } from "../src/index"

const info = (over: Partial<Parameters<typeof classifyToolOutput>[0]> = {}) => ({
  executionId: "tex_1",
  bytes: 100,
  ageTurns: 0,
  neededNextTurn: false,
  pending: false,
  ...over,
})

describe("classifyToolOutput", () => {
  test("a pending or next-turn-needed output is protected", () => {
    expect(classifyToolOutput(info({ pending: true }))).toBe("protected")
    expect(classifyToolOutput(info({ neededNextTurn: true, ageTurns: 99 }))).toBe("protected")
  })
  test("a recent output is kept verbatim", () => {
    expect(classifyToolOutput(info({ ageTurns: 1 }))).toBe("recent")
  })
  test("a large older output is externalized", () => {
    expect(classifyToolOutput(info({ ageTurns: 5, bytes: 20000 }))).toBe("externalized")
  })
  test("a small old output is discardable", () => {
    expect(classifyToolOutput(info({ ageTurns: 30, bytes: 100 }))).toBe("discardable")
  })
  test("a small mid-age output is summarizable", () => {
    expect(classifyToolOutput(info({ ageTurns: 5, bytes: 100 }))).toBe("summarizable")
  })
})

describe("externalize", () => {
  test("stores the full output and returns a compact tool-output:// stub", async () => {
    const store = new MemoryArtifactStore()
    const full = "Command failed with 17 TypeScript errors.\n" + "x".repeat(5000)
    const { ref, stub } = await externalize(store, {
      executionId: "tex_123",
      output: full,
      status: "Command failed with 17 TypeScript errors.",
      excerpt: "src/a.ts(3,1): error TS2322",
    })
    expect(ref.ref).toBe("tool-output://tex_123")
    expect(ref.bytes).toBe(Buffer.byteLength(full, "utf8"))
    expect(stub.length).toBeLessThan(full.length)
    expect(stub).toContain("tool-output://tex_123")
    expect(stub).toContain("TS2322")
    // the full output is retrievable by ref
    expect(await store.get(ref.ref)).toBe(full)
  })
})
