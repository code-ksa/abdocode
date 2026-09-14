import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// م11 — ضغطُ حمولةِ الكتابة موصولٌ في cli.ts خلف مفتاح plugins.trailCompaction نفسِه، بسطرٍ مستقلّ لا يمسّ
// مسمارَي ضغط القراءة والتنفيذ؛ وسطرُ نقطة الحفظ يذكر عددَ تمريراته بعد الحقول المثبَّتة.
const source = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")

describe("م11 — write-payload compaction wiring", () => {
  test("WRITE_COMPACTION is declared once and spread behind plugins.trailCompaction", () => {
    expect(source.match(/const WRITE_COMPACTION = \{ keepRecent: 1, overChars: 20_000 \} as const/gu)).toHaveLength(1)
    expect(source).toContain('...(plugins.read("trailCompaction", "epoch", epoch) ? { writeCompaction: WRITE_COMPACTION } : {}),')
    expect(source.match(/writeCompaction: WRITE_COMPACTION/gu)).toHaveLength(1)
    // المسماران القديمان بحالهما — سطرٌ مستقلّ لا تعديلٌ عليهما.
    expect(source).toContain('...(plugins.read("trailCompaction", "epoch", epoch) ? { trailCompaction: TRAIL_COMPACTION } : {}),')
    expect(source).toContain('...(plugins.read("readCompaction", "epoch", epoch) ? { readCompaction: READ_COMPACTION } : {}),')
  })
  test("the epoch checkpoint line appends the write pass count after the pinned fields", () => {
    expect(source).toContain("ضغط القراءة=${loop.readCompactions} · ضغط التنفيذ=${loop.execCompactions} · أثر الحقبة=${loop.trailChars} · ضغط الكتابة=${loop.writeCompactions}")
  })
})
