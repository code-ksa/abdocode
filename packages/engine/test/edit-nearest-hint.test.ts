/**
 * تلميحُ «أقربُ الأسطر» عند رفض التحرير — السيناريو المقيس 09-14 حرفيّاً: الملفّ ينتهي بـ`print("Scene built and renders saved."`
 * بلا قوس، والنموذج يرسل old_text بالقوس فيُرفض ثلاث مرّات بلا تلميح. الآن الرفضُ يسمّي السطرَ الموجود فعلاً؛ وبلا شبيهٍ لا يُخترع.
 */
import { describe, expect, test } from "bun:test"
import { applyEdit, nearestHint, nearestLines } from "../src/edit-match"

const file = 'import bpy\n\nfor i in range(4):\n    bpy.ops.render.render(write_still=True, filepath=render_path)\n\nprint("Scene built and renders saved."\n'

describe("edit refusal names the nearest existing line", () => {
  test("a closing-paren mismatch is refused with the real line quoted", () => {
    const verdict = applyEdit(file, { oldText: 'print("Scene built and renders saved.")', newText: "x", all: false })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.why).toContain("أقربُ الأسطر الموجودة فعلاً")
      expect(verdict.why).toContain('«print("Scene built and renders saved."»')
      expect(verdict.why).toContain("انسخ السطرَ حرفيّاً")
    }
  })
  test("nearestLines ranks by similarity and caps the list; nothing similar → nothing invented (negative twin)", () => {
    expect(nearestLines(file, 'bpy.ops.render.render(write_still=True, filepath=render_pth)')).toEqual(["bpy.ops.render.render(write_still=True, filepath=render_path)"])
    expect(nearestLines(file, "def totally_unrelated_function_name(): pass")).toEqual([])
    expect(nearestHint(file, "def totally_unrelated_function_name(): pass")).toBe("")
    expect(nearestLines(file, "")).toEqual([])
    // النصُّ متعدّد الأسطر يُقاس بأوّل سطرٍ غير فارغ
    expect(nearestLines(file, "\n\nprint(\"Scene built and renders\nmore")).toEqual(['print("Scene built and renders saved."'])
  })
  test("a matching old_text still applies — the hint never blocks a correct edit", () => {
    const verdict = applyEdit(file, { oldText: 'print("Scene built and renders saved."', newText: 'print("Scene built and renders saved.")', all: false })
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.after.endsWith('print("Scene built and renders saved.")\n')).toBe(true)
  })
})
