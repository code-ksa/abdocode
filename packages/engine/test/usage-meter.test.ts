import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { meterSummary, readMeter, recordMeterEntry, renderMeterLine } from "../src/usage-meter"

// ذ5 — العدّادُ المحلي: سطرٌ لكلّ نداء بما أُعلن وما حوسب وزمنه؛ الغيابُ لا يُكتب صفراً؛ المشوَّه يُعدّ لا يُصلَّح.

const base = { provider: "fixture", model: "m", local: true, chargedInputTokens: 10, chargedOutputTokens: 5 }

describe("الكتابةُ والقراءة", () => {
  test("إلحاقٌ سطراً سطراً؛ المبلَّغُ يُكتب حين وُجد رقماً صالحاً ويُترك حين غاب — لا صفرٌ مخترَع", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-meter-"))
    const path = join(dir, "nested", "usage-meter.jsonl")
    try {
      recordMeterEntry({ ...base, ms: 12.6, reportedInputTokens: 11, reportedOutputTokens: 4, note: "router.gate" }, path)
      recordMeterEntry({ ...base, ms: -3, reportedInputTokens: Number.NaN, reportedOutputTokens: undefined }, path)
      const lines = readFileSync(path, "utf8").trim().split("\n")
      expect(lines).toHaveLength(2)
      const first = JSON.parse(lines[0]!), second = JSON.parse(lines[1]!)
      expect(first).toMatchObject({ provider: "fixture", model: "m", local: true, note: "router.gate", ms: 13, reportedInputTokens: 11, reportedOutputTokens: 4, chargedInputTokens: 10, chargedOutputTokens: 5 })
      expect(typeof first.at).toBe("string")
      expect(second.ms).toBe(0)
      expect("reportedInputTokens" in second).toBe(false)
      expect("reportedOutputTokens" in second).toBe(false)
      expect("note" in second).toBe(false)
      const read = readMeter(path)
      expect(read).not.toBe("absent")
      expect((read as Exclude<typeof read, "absent">).entries).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("الملفُّ الغائب «absent» لا فارغ؛ والسطرُ المشوَّه يُعدّ ولا يُسقط جيرانه", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-meter-"))
    const path = join(dir, "usage-meter.jsonl")
    try {
      expect(readMeter(path)).toBe("absent")
      recordMeterEntry({ ...base, ms: 1 }, path)
      writeFileSync(path, readFileSync(path, "utf8") + "{not json\n" + JSON.stringify({ at: "x", provider: "p" }) + "\n", "utf8")
      recordMeterEntry({ ...base, ms: 2 }, path)
      const read = readMeter(path) as Exclude<ReturnType<typeof readMeter>, "absent">
      expect(read.entries).toHaveLength(2)
      expect(read.malformed).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("الخلاصة", () => {
  test("المحلّيُّ والسحابيُّ يُعدّان، والمبلَّغُ يُجمع من النداءات التي أعلنت وحدها، والزمنُ يُجمع", () => {
    const s = meterSummary([
      { at: "a", provider: "ollama", model: "q", local: true, ms: 100, chargedInputTokens: 50, chargedOutputTokens: 20, reportedInputTokens: 50, reportedOutputTokens: 20 },
      { at: "b", provider: "dashscope", model: "qwen-max", local: false, ms: 900, chargedInputTokens: 400, chargedOutputTokens: 256 },
      { at: "c", provider: "dashscope", model: "qwen-max", local: false, ms: 300, chargedInputTokens: 100, chargedOutputTokens: 30, reportedInputTokens: 90, reportedOutputTokens: 30 },
    ])
    expect(s).toMatchObject({ calls: 3, localCalls: 1, cloudCalls: 2, ms: 1300, reported: { calls: 2, inputTokens: 140, outputTokens: 50 }, charged: { inputTokens: 550, outputTokens: 306 } })
    expect(s.byModel["dashscope/qwen-max"]).toEqual({ calls: 2, ms: 1200, chargedInputTokens: 500, chargedOutputTokens: 286 })
    const line = renderMeterLine(s)
    expect(line.startsWith("⏲ العدّاد المحلي: 3 نداء")).toBe(true)
    expect(line).toContain("محلي 1 · سحابي 2")
    expect(line).toContain("1300ms")
    // لا اسمَ مزوّدٍ في السطر — الأسماءُ في الملفّ على القرص لا في سطرٍ يُنسخ.
    expect(line).not.toContain("dashscope")
    expect(meterSummary([])).toMatchObject({ calls: 0, ms: 0, reported: { calls: 0 } })
  })
})
