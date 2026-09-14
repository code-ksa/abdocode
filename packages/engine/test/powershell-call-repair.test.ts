/**
 * م11 — إصلاحُ عامل النداء في PowerShell بالسيناريو الحرفيّ (09-14): «"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b …»
 * يصير «& "…" -b …» بملاحظةٍ معلَنة؛ ما يحمل & أو Start-Process أو أمراً عاديّاً لا يُمسّ (التوأمُ السلبيّ).
 */
import { describe, expect, test } from "bun:test"
import { powershellCallOperatorRepair } from "../src/powershell-call-repair"

const blender = '"C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" -b --factory-startup --python build_scene.py'

describe("powershell call-operator repair", () => {
  test("a leading quoted .exe path gets & and a note", () => {
    const r = powershellCallOperatorRepair(blender)
    expect(r?.command).toBe(`& ${blender}`)
    expect(r?.note).toContain("أُصلح الأمر آليّاً")
    expect(powershellCallOperatorRepair("  'C:\\tools\\x.cmd' /q")?.command).toBe("& 'C:\\tools\\x.cmd' /q")
    expect(powershellCallOperatorRepair('".\\bin\\tool.exe"')?.command).toBe('& ".\\bin\\tool.exe"')
  })
  test("already-correct or unrelated commands are untouched (negative twin)", () => {
    expect(powershellCallOperatorRepair(`& ${blender}`)).toBeUndefined()
    expect(powershellCallOperatorRepair("Start-Process blender.exe")).toBeUndefined()
    expect(powershellCallOperatorRepair("python make_pdf.py")).toBeUndefined()
    expect(powershellCallOperatorRepair('git commit -m "C:\\x.exe"')).toBeUndefined()
    expect(powershellCallOperatorRepair('"not a path.exe"')).toBeUndefined()
    expect(powershellCallOperatorRepair('"C:\\a.txt" -b')).toBeUndefined()
  })
})
