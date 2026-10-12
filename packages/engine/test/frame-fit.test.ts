import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_MAX_FRAME_BYTES, encodeLocalJsonFrame } from "@abdo/transport-contracts"
import { ARCHIVE_DISPLAY_BUDGET, fitFrame } from "../src/frame-fit"

// 10-10 (مقيس على المثبَّت 4.0.127): أرشيفُ جلسة n8n بلغ 1,093,846 بايت فرمى encodeLocalJsonFrame داخل emit وسقط المحرّكُ عند كلّ إقلاع.
const LIMIT = DEFAULT_MAX_FRAME_BYTES - 64
const bigArchive = () => ({ kind: "archive", session: "s-n8n", conversationMode: "code", turns: Array.from({ length: 30 }, (_, i) => ({
  id: `t-${i}`, body: `turn ${i}`, attachments: [], lines: Array.from({ length: 120 }, (_, j) => `⚙ read file-${j}.tsx\n${"x".repeat(j === 0 ? 9000 : 300)}`),
})) })

test("an archive over the channel cap is trimmed to fit, keeps the newest turn, says what it cut — and the real encoder accepts it", () => {
  const raw = bigArchive()
  expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(DEFAULT_MAX_FRAME_BYTES)
  expect(() => encodeLocalJsonFrame(raw)).toThrow(/exceeds maximum/u) // the crash, reproduced
  const fitted = fitFrame(raw, LIMIT) as { kind: string; turns: { id: string; lines: string[] }[]; truncated: { droppedTurns: number; clippedLines: number; originalBytes: number } }
  expect(fitted.kind).toBe("archive")
  expect(fitted.turns.at(-1)!.id).toBe("t-29")
  expect(fitted.truncated.originalBytes).toBeGreaterThan(DEFAULT_MAX_FRAME_BYTES)
  expect(fitted.truncated.clippedLines + fitted.truncated.droppedTurns).toBeGreaterThan(0)
  expect(() => encodeLocalJsonFrame(fitted)).not.toThrow()
})

test("the twin: a frame that fits is returned as the same object; a non-archive over the cap becomes a named refusal", () => {
  const small = { kind: "event", turnId: "t", payload: "ok" }
  expect(fitFrame(small, LIMIT)).toBe(small)
  const huge = fitFrame({ kind: "tool-result", output: "y".repeat(DEFAULT_MAX_FRAME_BYTES) }, LIMIT) as { kind: string; why: string }
  expect(huge.kind).toBe("refused")
  expect(huge.why).toContain("«tool-result»")
  expect(() => encodeLocalJsonFrame(huge)).not.toThrow()
})

test("emit fits every frame before encoding and never throws", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
  const at = cli.indexOf("const emit = (raw: object) => {")
  expect(at).toBeGreaterThan(0)
  const body = cli.slice(at, at + 900)
  expect(body.indexOf("fitFrame(raw as Record<string, unknown>, DEFAULT_MAX_FRAME_BYTES - 64)")).toBeLessThan(body.indexOf("encodeLocalJsonFrame(frame)"))
  expect(body).toContain("try { process.stdout.write(encodeLocalJsonFrame(frame)) }")
})

test("an archive is held to the display budget (≈300KB), well under the channel cap — the newest turn kept", () => {
  const fitted = fitFrame(bigArchive(), LIMIT) as { kind: string; turns: { id: string }[] }
  expect(fitted.kind).toBe("archive")
  expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(ARCHIVE_DISPLAY_BUDGET)
  expect(fitted.turns.at(-1)!.id).toBe("t-29")
  // the twin: a small archive is untouched
  const small = { kind: "archive", session: "s", turns: [{ id: "t", body: "hi", lines: ["ok"] }] }
  expect(fitFrame(small, LIMIT)).toBe(small)
})
