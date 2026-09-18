/**
 * م11 — كاشفُ الخرج المختلَق بالسيناريو الحرفيّ (omni 09-14): «drwxr-xr-x 5 someone staff 4096 Oct 15 10:00 .» في نصّ النموذج
 * بلا إيصال ⇦ يُسمّى؛ السطرُ نفسُه حين يكون في إيصالٍ ⇦ لا شيء (التوأمُ السلبيّ)؛ سطرُ الأمر «نفّذ: ls -la» لا يُحتسب.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fabricatedOutputSignals, fabricationCorrection, fabricationNoticeLine } from "../src/fabricated-output-guard"

const reply = [
  "سأتحقّق من الملفّات:",
  "نفّذ: ls -la",
  "drwxr-xr-x 5 someone staff 4096 Oct 15 10:00 .",
  "-rw-r--r-- 1 someone staff 5523 Oct 15 10:00 build_scene.py",
  "Tests: 4 passed, 0 failed",
  "إذن الملفّ موجود.",
].join("\n")

describe("fabricated output guard", () => {
  test("output-shaped lines without a receipt are named (max three, no duplicates)", () => {
    const lines = fabricatedOutputSignals(reply, ["📁 C:\\proj\nbuild_scene.py"])
    expect(lines).toEqual([
      "drwxr-xr-x 5 someone staff 4096 Oct 15 10:00 .",
      "-rw-r--r-- 1 someone staff 5523 Oct 15 10:00 build_scene.py",
      "Tests: 4 passed, 0 failed",
    ])
    expect(fabricationNoticeLine(lines)).toContain("سرد خرجَ أمرٍ لم تُنفّذه أداة")
    expect(fabricationCorrection(lines)).toContain("[تصحيحٌ من النظام]")
  })
  test("the same lines backed by a real receipt are not flagged; command lines and prose never are (negative twin)", () => {
    const receipt = "total 8\ndrwxr-xr-x 5 someone staff 4096 Oct 15 10:00 .\n-rw-r--r-- 1 someone staff 5523 Oct 15 10:00 build_scene.py\nTests: 4 passed, 0 failed"
    expect(fabricatedOutputSignals(reply, [receipt])).toEqual([])
    expect(fabricatedOutputSignals("نفّذ: run ls -la\nسأقرأ الملفّ ثمّ أعدّل السطر.", [])).toEqual([])
    expect(fabricatedOutputSignals("", [])).toEqual([])
  })
  // 09-16 — لوحة القياس b3 (nemotron): الردُّ كان «⚙ open https://example.com ⏎ ⚙ back» بلا أداةٍ ومرّ مكتملاً بصفر أدوات.
  test("engine receipt markers in the model's own text are fabrication; the same lines inside a real receipt are not", () => {
    const text = "⚙ open https://example.com\n⚙ back\n↻ حقبة 1 · shot ⏎ ✕ Failed to capture tab\nإذن تمّ."
    expect(fabricatedOutputSignals(text, [])).toEqual(["⚙ open https://example.com", "⚙ back", "↻ حقبة 1 · shot ⏎ ✕ Failed to capture tab"])
    expect(fabricatedOutputSignals(text, ["⚙ open https://example.com\n⚙ back\n↻ حقبة 1 · shot ⏎ ✕ Failed to capture tab"])).toEqual([])
    // الإنجازُ لا يُقبل على إيصالاتٍ مختلَقة: الحلقةُ تعيد النداءَ بتصحيحٍ مرّتين ثمّ تقف «acceptance-pending» لا «complete».
    // 4.0.44 (nemotron): «تم تنفيذ desk click 285 385 وإيصاله: نقرتُ عند الإحداثيّات (285, 385)…» مع أداةٍ أخرى نُفّذت — إيصالُ فعلٍ لم يقع.
    const claim = "تم تنفيذ desk click 285 385 وإيصاله:\nنقرتُ عند الإحداثيّات (285, 385) في النافذة المركّزة — génération 8، والمراجعُ القديمة بطلت."
    expect(fabricatedOutputSignals(claim, ["قرأت النواةُ الملفَّ وتحقّقت منه — README.md"])).toEqual(["تم تنفيذ desk click 285 385 وإيصاله:", "نقرتُ عند الإحداثيّات (285, 385) في النافذة المركّزة — génération 8، والمراجعُ القديمة بطلت."])
    // إعادةُ صياغة إيصالٍ حقيقيّ (بدايتُه ٢٤ حرفاً داخل إيصال) ليست اختلاقاً — التوأمُ السلبيّ
    expect(fabricatedOutputSignals("نقرتُ عند الإحداثيّات (285, 385) في النافذة المركّزة.", ["نقرتُ عند الإحداثيّات (285, 385) في النافذة المركّزة — الجيل 8، والمراجعُ القديمة بطلت."])).toEqual([])
    const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
    expect(cli).toContain("const invented = fabricatedOutputSignals(loop.answer, receipts.map((receipt) => receipt.output))")
    // الحكمُ لا يشترط صفرَ أدوات: الاكتمالُ على إيصالٍ مختلَق يُردّ ولو نُفّذت أدواتٌ أخرى
    expect(cli).toContain('if (loop.stopReason === "complete") {\r\n          const invented')
    expect(cli).toContain("if (invented.length > 0 && fabricatedStalls < 2) {")
    expect(cli.indexOf("if (invented.length > 0 && fabricatedStalls < 2) {")).toBeLessThan(cli.indexOf("lastStop = loop.stopReason"))
  })
  test("PowerShell dir tables and jest summaries are recognised shapes", () => {
    const ps = "Mode                LastWriteTime         Length Name\nd-----         9/14/2026   1:18 PM                renders"
    expect(fabricatedOutputSignals(ps, []).length).toBe(2)
    expect(fabricatedOutputSignals("PASS src/app.test.ts", [])).toEqual(["PASS src/app.test.ts"])
  })
  test("09-16: tick-style runner lines, git --stat and TAP are shapes; a prose tick is not (no steering on honest summaries)", () => {
    const text = "✓ src/app.test.ts (3 tests) 12ms\n3 files changed, 10 insertions(+)\nok 1 - parses\n✓ 12 tests passed"
    expect(fabricatedOutputSignals(text, [])).toEqual(["✓ src/app.test.ts (3 tests) 12ms", "3 files changed, 10 insertions(+)", "ok 1 - parses"])
    expect(fabricatedOutputSignals("✓ تم إنشاء الملف كما طلبت\n✔ الخطوة الثانية جاهزة", [])).toEqual([])
  })
  test("09-16: coverage is by whole-line digest, not an 80-char prefix — and whitespace/case do not break it", () => {
    const real = `-rw-r--r-- 1 someone staff 5523 Oct 15 10:00 ${"x".repeat(60)}-real.py`
    const forged = real.replace("-real.py", "-fake.py")
    expect(forged.slice(0, 80)).toBe(real.slice(0, 80)) // البادئةُ متطابقة — كان الحارسُ يمرّرها
    expect(fabricatedOutputSignals(forged, [real])).toEqual([forged.slice(0, 120)])
    expect(fabricatedOutputSignals("Tests:   4 Passed,  0 failed", ["Tests: 4 passed, 0 failed"])).toEqual([])
    // إيصالٌ مقصوصٌ بعلامة قصّ يغطّي سطراً يبدأ به — القصُّ من الإيصال لا من النموذج.
    expect(fabricatedOutputSignals(real, [`${real.slice(0, 50)}…`])).toEqual([])
  })
})
