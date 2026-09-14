import { describe, expect, test } from "bun:test"
import { READ_NEEDS_FILE, READ_RANGE_USAGE, parseReadRange, planRead, sliceReadRange, splitReadTail } from "../src/read-range"

describe("parseReadRange — read <ملف> [من] [إلى]", () => {
  test("a bare file is a whole-file read", () => {
    expect(parseReadRange(["src/a.ts"])).toEqual({ file: "src/a.ts" })
  })

  test("a missing file keeps the historical refusal text", () => {
    expect(parseReadRange([])).toEqual({ error: READ_NEEDS_FILE })
    expect(READ_NEEDS_FILE).toBe("read يحتاج ملفاً")
  })

  test("from alone, and from+to, parse as 1-based integers", () => {
    expect(parseReadRange(["a.ts", "10"])).toEqual({ file: "a.ts", from: 10 })
    expect(parseReadRange(["a.ts", "10", "20"])).toEqual({ file: "a.ts", from: 10, to: 20 })
    expect(parseReadRange(["a.ts", "7", "7"])).toEqual({ file: "a.ts", from: 7, to: 7 })
  })

  test("non-digits, from > to and extra tokens are usage errors (zero became 1 under م11 — read-range-lenient.test.ts)", () => {
    expect(parseReadRange(["a.ts", "x"])).toEqual({ error: READ_RANGE_USAGE })
    expect(parseReadRange(["a.ts", "10", "2b"])).toEqual({ error: READ_RANGE_USAGE })
    expect(parseReadRange(["a.ts", "0"])).toEqual({ file: "a.ts", from: 1 })
    expect(parseReadRange(["a.ts", "-3", "5"])).toEqual({ error: READ_RANGE_USAGE })
    expect(parseReadRange(["a.ts", "20", "10"])).toEqual({ error: READ_RANGE_USAGE })
    expect(parseReadRange(["a.ts", "1", "2", "3"])).toEqual({ error: READ_RANGE_USAGE })
    expect(READ_RANGE_USAGE).toBe("الصيغة: read <ملف> [من] [إلى] — أرقام أسطر تبدأ من 1")
  })
})

describe("planRead — the parsed tail becomes the exact range the kernel read receives", () => {
  test("a bare file plans a whole-file read with no range key at all", () => {
    expect(planRead(["f"])).toEqual({ file: "f" })
    expect("range" in planRead(["f"])).toBe(false)
  })

  test("from+to and from-only plan the matching range object", () => {
    expect(planRead(["f", "3", "5"])).toEqual({ file: "f", range: { from: 3, to: 5 } })
    expect(planRead(["f", "3"])).toEqual({ file: "f", range: { from: 3 } })
  })

  test("errors pass through unchanged", () => {
    expect(planRead([])).toEqual({ error: READ_NEEDS_FILE })
    expect(planRead(["f", "5", "3"])).toEqual({ error: READ_RANGE_USAGE })
  })
})

describe("splitReadTail — the REPL keeps every path it accepted before ranges existed", () => {
  test("a spaced path with no numeric tail is a single file, not a usage error", () => {
    expect(splitReadTail("docs/my notes.md")).toEqual(["docs/my notes.md"])
    expect(planRead(splitReadTail("docs/my notes.md"))).toEqual({ file: "docs/my notes.md" })
    expect(splitReadTail("  docs/my notes.md  ")).toEqual(["docs/my notes.md"])
  })

  test("an all-digits tail is a range", () => {
    expect(splitReadTail("src/a.ts 10 20")).toEqual(["src/a.ts", "10", "20"])
    expect(splitReadTail("src/a.ts 10")).toEqual(["src/a.ts", "10"])
    expect(planRead(splitReadTail("src/a.ts 10 20"))).toEqual({ file: "src/a.ts", range: { from: 10, to: 20 } })
  })

  test("a mixed tail stays one path exactly as HEAD treated it", () => {
    expect(splitReadTail("src/a.ts 10 abc")).toEqual(["src/a.ts 10 abc"])
    expect(splitReadTail("")).toEqual([])
    expect(planRead(splitReadTail("   "))).toEqual({ error: READ_NEEDS_FILE })
  })
})

describe("sliceReadRange — 1-based inclusive line slices", () => {
  const lf = "one\ntwo\nthree\nfour\nfive\n"
  const crlf = "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n"

  test("from only runs to the end of the file", () => {
    expect(sliceReadRange(lf, 4)).toEqual({ slice: "four\nfive", total: 5, from: 4, to: 5 })
  })

  test("from 1 to total covers the whole file without an extra empty trailing line", () => {
    expect(sliceReadRange(lf, 1, 5)).toEqual({ slice: "one\ntwo\nthree\nfour\nfive", total: 5, from: 1, to: 5 })
    // ملفٌ بلا فاصلٍ ختاميّ يعدّ سطره الأخير كذلك
    expect(sliceReadRange("a\nb", 1)).toEqual({ slice: "a\nb", total: 2, from: 1, to: 2 })
  })

  test("to beyond the total clamps to the total", () => {
    expect(sliceReadRange(lf, 3, 99)).toEqual({ slice: "three\nfour\nfive", total: 5, from: 3, to: 5 })
  })

  test("from beyond the total is an explicit error, not an empty slice", () => {
    const out = sliceReadRange(lf, 6)
    expect("error" in out).toBe(true)
    if ("error" in out) expect(out.error).toContain("السطر 6 من 5 سطراً")
  })

  test("from > to and from < 1 are usage errors", () => {
    expect(sliceReadRange(lf, 3, 2)).toEqual({ error: READ_RANGE_USAGE })
    expect(sliceReadRange(lf, 0, 2)).toEqual({ error: READ_RANGE_USAGE })
  })

  test("CRLF text keeps its CRLF separators and counts lines identically", () => {
    expect(sliceReadRange(crlf, 2, 3)).toEqual({ slice: "two\r\nthree", total: 5, from: 2, to: 3 })
    expect(sliceReadRange(crlf, 1)).toEqual({ slice: "one\r\ntwo\r\nthree\r\nfour\r\nfive", total: 5, from: 1, to: 5 })
  })

  // المقطع بايتاتُ المصدر نفسها: old_text منسوخٌ منه يطابق الملفّ حرفاً.
  test("a mixed-EOL file returns each line with its own separator, byte-identical to the source", () => {
    const mixed = "a\r\nb\nc\r\nd"
    expect(sliceReadRange(mixed, 2, 3)).toEqual({ slice: "b\nc", total: 4, from: 2, to: 3 })
    expect(sliceReadRange(mixed, 1, 2)).toEqual({ slice: "a\r\nb", total: 4, from: 1, to: 2 })
    expect(sliceReadRange(mixed, 3)).toEqual({ slice: "c\r\nd", total: 4, from: 3, to: 4 })
    expect(sliceReadRange("a\r\nb\nc\n", 2, 3)).toEqual({ slice: "b\nc", total: 3, from: 2, to: 3 })
    // لا يسقط الفاصل الأخير إلا من السطر الأخير في المقطع — والداخلية كما هي
    const head = sliceReadRange(mixed, 1, 2)
    expect("slice" in head && mixed.startsWith(head.slice)).toBe(true)
  })

  test("lone-CR files are lines too, not one giant line", () => {
    expect(sliceReadRange("a\rb\rc", 1, 2)).toEqual({ slice: "a\rb", total: 3, from: 1, to: 2 })
    expect(sliceReadRange("a\rb\rc\r", 3)).toEqual({ slice: "c", total: 3, from: 3, to: 3 })
  })

  test("blank lines are counted, not collapsed", () => {
    expect(sliceReadRange("a\n\nc\n", 2, 2)).toEqual({ slice: "", total: 3, from: 2, to: 2 })
    expect(sliceReadRange("\n\n", 1)).toEqual({ slice: "\n", total: 2, from: 1, to: 2 })
  })

  test("a single line slice returns exactly that line", () => {
    expect(sliceReadRange(lf, 2, 2)).toEqual({ slice: "two", total: 5, from: 2, to: 2 })
  })

  test("an empty file has zero lines, so any range starts past its end", () => {
    const out = sliceReadRange("", 1)
    expect("error" in out).toBe(true)
    if ("error" in out) expect(out.error).toContain("السطر 1 من 0 سطراً")
  })
})
