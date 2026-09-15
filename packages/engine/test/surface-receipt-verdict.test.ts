import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { surfaceVerdict } from "../src/surface-receipt-verdict"
import { browserProofVerdict } from "../src/closure-gate"
import { receiptSucceeded } from "../src/failure-tiering"

// ن3 — إيصالاتُ السطح تحمل حكماً: بلا ذلك لم يكن لبوّابة الإقفال أن ترى open ناجحاً قطّ (مقيس حيّاً 09-15: طالبت بـopen بعد open).

test("success receipts are ok; refusals are policy denials; named failures are failures", () => {
  expect(surfaceVerdict("فُتحت الواجهة واتصل متصفح الوكيل — http://127.0.0.1:3017/. استعمل page").ok).toBe(true)
  expect(surfaceVerdict("اخترتُ «Jeddah» (القيمة «JED»، 3/4) في «City»").ok).toBe(true)
  expect(surfaceVerdict("جيل 2 — 8 عنصراً:\n[r1] heading").ok).toBe(true)
  expect(surfaceVerdict("العقد رفض: مرجعٌ من جيلٍ 1")).toEqual({ ok: false, reason: "policy_denied", denied: true, detail: "العقد رفض: مرجعٌ من جيلٍ 1" })
  expect(surfaceVerdict("رُفضت النقرة — نمط read-only يحتاج موافقةً").ok).toBe(false)
  expect(surfaceVerdict("مرجعٌ غير معروف «r9» — اقرأ الصفحة بـpage أوّلاً")).toEqual({ ok: false, reason: "invalid_input", denied: false, detail: "مرجعٌ غير معروف «r9» — اقرأ الصفحة بـpage أوّلاً" })
  expect(surfaceVerdict("لا خيارَ يطابق «Mecca» في «City». الخياراتُ: Riyadh").ok).toBe(false)
  expect(surfaceVerdict("الصيغة: select <مرجع> <نصّ الخيار>").ok).toBe(false)
  expect(surfaceVerdict("«Resume» ليس قائمةً منسدلةً أصليّة (input)").ok).toBe(false)
  expect(surfaceVerdict("لم أنقر: «Sign up» لم يعد ظاهراً").ok).toBe(false)
})

test("with the verdict, the browser-proof gate sees a successful open; without it, it never could (the measured defect)", () => {
  const goal = "افتح http://127.0.0.1:3017/ في متصفّح الوكيل واقرأ الصفحة"
  const output = "فُتحت الواجهة واتصل متصفح الوكيل — http://127.0.0.1:3017/."
  expect(receiptSucceeded(output, undefined)).toBe(false)
  expect(browserProofVerdict(goal, [{ command: "open http://127.0.0.1:3017/", output }])).toContain("open <الرابط>")
  expect(browserProofVerdict(goal, [{ command: "open http://127.0.0.1:3017/", output, verdict: surfaceVerdict(output) }])).toBeUndefined()
})

test("cli.ts wraps every surface return with the verdict instead of plain", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
  expect(cli).toContain('import { surfaceVerdict } from "./surface-receipt-verdict"')
  expect(cli).toContain("const surfaced = (output: string): DispatchResultV => ({ output, verdict: surfaceVerdict(output) })")
  const start = cli.indexOf('case "surface": {')
  const end = cli.indexOf('case "delegate": {', start)
  const body = cli.slice(start, end)
  expect(body).not.toContain("return plain(")
  expect(body).toContain("return surfaced(out)")
  expect(body).toContain('return surfaced(await runSurfaceTool("ui", rest, turnId))')
})
