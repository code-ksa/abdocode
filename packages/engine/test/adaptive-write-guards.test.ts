/**
 * م11 — القضبانُ التكيّفيّة: حارسُ الكتابة الماحية بحسب صرامة القضبان، وتصعيدُ رفض التحرير المتكرّر.
 * السيناريو الحرفيّ المقيس (omni، 09-14): سكربتُ 5523 حرفاً ⇦ سطرٌ واحد 33 حرفاً.
 */
import { describe, expect, test } from "bun:test"
import { EditRefusalTracker, SHRINK_FLAG, shrinkViolation } from "../src/adaptive-write-guards"

const script = "import bpy\n".repeat(500) // 5500 حرفاً
const oneLine = 'print("Scene built successfully")'

describe("shrink guard", () => {
  test("medium/strict rails refuse a write that leaves <25% of a ≥400-char file, naming the loss", () => {
    for (const tier of ["strict", "medium"] as const) {
      const v = shrinkViolation(script, oneLine, tier)
      expect(v?.refused).toBe(true)
      expect(v?.why).toContain("99٪")
      expect(v?.why).toContain(`${script.length} ⇦ ${oneLine.length}`)
      expect(v?.why).toContain(SHRINK_FLAG)
    }
  })
  test("thin rails only refuse the catastrophic case (≥2000 chars, <5% kept); a real simplification passes", () => {
    expect(shrinkViolation(script, oneLine, "thin")?.refused).toBe(true)
    expect(shrinkViolation(script, script.slice(0, 600), "thin")).toBeUndefined() // 11% kept — الرفيع يسمح
    expect(shrinkViolation(script, script.slice(0, 600), "medium")?.refused).toBe(true) // 11% — المتوسط يرفض
    expect(shrinkViolation("short file", "", "strict")).toBeUndefined() // أصغر من العتبة
  })
  test("explicit intent or a new file never trips the guard (negative twin)", () => {
    expect(shrinkViolation(script, oneLine, "strict", true)).toBeUndefined()
    expect(shrinkViolation(undefined, oneLine, "strict")).toBeUndefined()
    expect(shrinkViolation(script, script + "\nmore", "strict")).toBeUndefined()
  })
})

describe("edit refusal escalation", () => {
  test("weak-model rails escalate on the first refusal; thin rails on the second; success resets", () => {
    const t = new EditRefusalTracker()
    expect(t.refused("t1", "C:/p/a.py", "medium", 5523)).toContain("رقم 1")
    expect(t.refused("t1", "C:/p/a.py", "medium", 5523)).toContain("أعد كتابته كاملاً")
    expect(t.refused("t1", "C:/p/b.py", "thin", 5523)).toBe("")
    expect(t.refused("t1", "C:/P/B.PY", "thin", 5523)).toContain("رقم 2")
    t.succeeded("t1", "C:/p/b.py")
    expect(t.count("t1", "C:/p/b.py")).toBe(0)
    // ملفٌّ كبير: النصيحةُ القراءةُ لا إعادةُ الكتابة
    expect(t.refused("t2", "C:/p/big.ts", "strict", 40_000)).toContain("اقرأ المقطعَ")
  })
})
