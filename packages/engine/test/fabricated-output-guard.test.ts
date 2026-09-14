/**
 * م11 — كاشفُ الخرج المختلَق بالسيناريو الحرفيّ (omni 09-14): «drwxr-xr-x 5 abdelrahman staff 4096 Oct 15 10:00 .» في نصّ النموذج
 * بلا إيصال ⇦ يُسمّى؛ السطرُ نفسُه حين يكون في إيصالٍ ⇦ لا شيء (التوأمُ السلبيّ)؛ سطرُ الأمر «نفّذ: ls -la» لا يُحتسب.
 */
import { describe, expect, test } from "bun:test"
import { fabricatedOutputSignals, fabricationCorrection, fabricationNoticeLine } from "../src/fabricated-output-guard"

const reply = [
  "سأتحقّق من الملفّات:",
  "نفّذ: ls -la",
  "drwxr-xr-x 5 abdelrahman staff 4096 Oct 15 10:00 .",
  "-rw-r--r-- 1 abdelrahman staff 5523 Oct 15 10:00 build_scene.py",
  "Tests: 4 passed, 0 failed",
  "إذن الملفّ موجود.",
].join("\n")

describe("fabricated output guard", () => {
  test("output-shaped lines without a receipt are named (max three, no duplicates)", () => {
    const lines = fabricatedOutputSignals(reply, ["📁 C:\\proj\nbuild_scene.py"])
    expect(lines).toEqual([
      "drwxr-xr-x 5 abdelrahman staff 4096 Oct 15 10:00 .",
      "-rw-r--r-- 1 abdelrahman staff 5523 Oct 15 10:00 build_scene.py",
      "Tests: 4 passed, 0 failed",
    ])
    expect(fabricationNoticeLine(lines)).toContain("سرد خرجَ أمرٍ لم تُنفّذه أداة")
    expect(fabricationCorrection(lines)).toContain("[تصحيحٌ من النظام]")
  })
  test("the same lines backed by a real receipt are not flagged; command lines and prose never are (negative twin)", () => {
    const receipt = "total 8\ndrwxr-xr-x 5 abdelrahman staff 4096 Oct 15 10:00 .\n-rw-r--r-- 1 abdelrahman staff 5523 Oct 15 10:00 build_scene.py\nTests: 4 passed, 0 failed"
    expect(fabricatedOutputSignals(reply, [receipt])).toEqual([])
    expect(fabricatedOutputSignals("نفّذ: run ls -la\nسأقرأ الملفّ ثمّ أعدّل السطر.", [])).toEqual([])
    expect(fabricatedOutputSignals("", [])).toEqual([])
  })
  test("PowerShell dir tables and jest summaries are recognised shapes", () => {
    const ps = "Mode                LastWriteTime         Length Name\nd-----         9/14/2026   1:18 PM                renders"
    expect(fabricatedOutputSignals(ps, []).length).toBe(2)
    expect(fabricatedOutputSignals("PASS src/app.test.ts", [])).toEqual(["PASS src/app.test.ts"])
  })
})
