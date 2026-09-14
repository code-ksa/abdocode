/**
 * م11 — أرقامُ الأسطر بعادة النماذج: «0» تُقرأ 1، و«-1» في موضع «إلى» = إلى النهاية (مقيس 09-14: omni ثمّ super-120b أهدرا جولةً بالرفض).
 * غيرُ المفهوم يبقى مرفوضاً (فشلٌ مغلق).
 */
import { describe, expect, test } from "bun:test"
import { parseReadRange, READ_RANGE_USAGE } from "../src/read-range"

describe("read range — model habits", () => {
  test("zero-based start becomes 1; -1 as end means to the end of file", () => {
    expect(parseReadRange(["f.py", "0", "2000"])).toEqual({ file: "f.py", from: 1, to: 2000 })
    expect(parseReadRange(["f.py", "1", "-1"])).toEqual({ file: "f.py", from: 1 })
    expect(parseReadRange(["f.py", "0"])).toEqual({ file: "f.py", from: 1 })
  })
  test("garbage and inverted ranges are still refused (negative twin)", () => {
    expect(parseReadRange(["f.py", "abc"])).toEqual({ error: READ_RANGE_USAGE })
    expect(parseReadRange(["f.py", "10", "5"])).toEqual({ error: READ_RANGE_USAGE })
    expect(parseReadRange(["f.py", "-5", "10"])).toEqual({ error: READ_RANGE_USAGE })
    expect(parseReadRange(["f.py", "1", "-2"])).toEqual({ error: READ_RANGE_USAGE })
  })
})
