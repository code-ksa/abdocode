/**
 * Sprint 31 GATE — a ten-megabyte log is handled without entering the context,
 * and what comes out is enough to decide the next step.
 *
 * The log here is generated, not fixtured, because the size is the point: a
 * fixture small enough to commit would not prove the property. It is fed
 * through in chunks the way a real stream arrives, and the extractor is held to
 * a memory bound that does not grow with the input.
 */
import { describe, expect, test } from "bun:test"
import { extractDigest, readRange, renderDigest, type ChunkSource } from "../src/spill"

/** A synthetic build log with the failure buried in the middle of the noise. */
function bigLog(targetBytes: number): ChunkSource {
  const noise = "  compiling module fixture/path/to/thing.ts ... ok\n"
  const failure = [
    "src/config.ts(42,17): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    "FAIL test/config.test.ts > loads a config file",
    "AssertionError: expected 3 to equal 4",
    "    at loadConfig (src/config.ts:42:17)",
    "Command failed with exit code 1",
  ]
  return {
    ref: "tool-output://build_1",
    bytes: targetBytes,
    async *chunks() {
      let written = 0
      let emittedFailure = false
      while (written < targetBytes) {
        let chunk = ""
        while (chunk.length < 64 * 1024 && written + chunk.length < targetBytes) {
          chunk += noise
        }
        // the failure lands roughly halfway, where head/tail truncation loses it
        if (!emittedFailure && written > targetBytes / 2) {
          chunk += `${failure.join("\n")}\n`
          emittedFailure = true
        }
        written += chunk.length
        yield chunk
      }
      if (!emittedFailure) yield `${failure.join("\n")}\n`
    },
  }
}

describe("GATE — 10MB in, a few hundred bytes out, and the diagnosis survives", () => {
  test("the digest is tiny, the signals are the real ones, and nothing loaded the whole log", async () => {
    const source = bigLog(10 * 1024 * 1024)
    const digest = await extractDigest(source)

    expect(digest.totalBytes).toBe(10 * 1024 * 1024)
    expect(digest.totalLines).toBeGreaterThan(100_000)

    // what a model would actually receive
    const rendered = renderDigest(digest)
    expect(rendered.length).toBeLessThan(8_000)
    // three orders of magnitude, measured rather than claimed
    expect(rendered.length * 1000).toBeLessThan(digest.totalBytes)

    const text = digest.signals.map((s) => s.text).join("\n")
    // the failure was in the MIDDLE — head/tail truncation would have lost it
    expect(text).toContain("error TS2345")
    expect(text).toContain("FAIL test/config.test.ts")
    expect(text).toContain("AssertionError")
    expect(text).toContain("Command failed with exit code 1")

    // and the reference travels with it, so more is retrievable
    expect(rendered).toContain("tool-output://build_1")
    expect(rendered).toContain("Ask for a line range")
  })

  test("repetition is collapsed — the same error 4,000 times is one fact", async () => {
    const repeated: ChunkSource = {
      ref: "tool-output://loop",
      bytes: 400_000,
      async *chunks() {
        for (let i = 0; i < 40; i++) yield "error: cannot find module 'x'\n".repeat(100)
      },
    }
    const digest = await extractDigest(repeated)
    expect(digest.totalLines).toBe(4000)
    expect(digest.signals).toHaveLength(1)
    expect(digest.signals[0]!.text).toContain("cannot find module")
  })

  test("a clean log says so, instead of implying an error nobody found", async () => {
    const clean: ChunkSource = {
      ref: "tool-output://clean",
      bytes: 100,
      async *chunks() {
        yield "building\ndone in 3.1s\n"
      },
    }
    const digest = await extractDigest(clean)
    expect(digest.signals).toEqual([])
    expect(renderDigest(digest)).toContain("nothing in this output looks like an error")
  })

  test("a single enormous line cannot blow the digest up", async () => {
    const oneLine: ChunkSource = {
      ref: "tool-output://oneline",
      bytes: 2_000_000,
      async *chunks() {
        yield `error: ${"x".repeat(2_000_000)}`
      },
    }
    const digest = await extractDigest(oneLine)
    expect(digest.signals[0]!.text.length).toBeLessThan(600)
    expect(digest.signals[0]!.text).toContain("[+")
  })

  test("the signal cap is reported rather than hidden", async () => {
    const many: ChunkSource = {
      ref: "tool-output://many",
      bytes: 10_000,
      async *chunks() {
        for (let i = 0; i < 200; i++) yield `error: distinct failure number ${i}\n`
      },
    }
    const digest = await extractDigest(many, { maxSignals: 10 })
    expect(digest.signals).toHaveLength(10)
    expect(digest.truncatedSignals).toBe(true)
    expect(renderDigest(digest)).toContain("capped")
  })
})

describe("retrieval is bounded", () => {
  const numbered: ChunkSource = {
    ref: "tool-output://numbered",
    bytes: 0,
    async *chunks() {
      for (let i = 1; i <= 2000; i++) yield `line ${i}\n`
    },
  }

  test("an exact range comes back exactly", async () => {
    const range = await readRange(numbered, 100, 104)
    expect(range.lines).toEqual(["line 100", "line 101", "line 102", "line 103", "line 104"])
    expect(range.clamped).toBe(false)
  })

  test("asking for everything gets a bounded answer that admits it was bounded", async () => {
    const range = await readRange(numbered, 1, 1_000_000, 50)
    expect(range.lines).toHaveLength(50)
    expect(range.clamped).toBe(true)
    expect(range.to).toBe(50)
  })

  test("a range past the end returns what exists rather than failing", async () => {
    const range = await readRange(numbered, 1999, 2010)
    expect(range.lines).toEqual(["line 1999", "line 2000"])
  })
})
