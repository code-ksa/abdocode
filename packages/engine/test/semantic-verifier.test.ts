import { describe, expect, test } from "bun:test"
import { buildVerifierPrompt, clipKeepCause, parseVerdict } from "../src/semantic-verifier"

describe("semantic verifier — absorbed from Anton session verifier (ideas, not fork)", () => {
  test("clipKeepCause keeps the tail and announces the elision", () => {
    const text = "a".repeat(500) + "\nlibodbc.so.2: cannot open shared object file"
    const clipped = clipKeepCause(text, 60)
    expect(clipped).toContain("cannot open shared object file")
    expect(clipped).toContain("حُذف")
    expect(clipKeepCause("قصير", 60)).toBe("قصير")
  })

  // مقيس 2026-09-17: قصٌّ ذيليٌّ محض أخفى أوّل نتائج أداةِ بحثٍ عن المحكّم فحجب الاكتمال. الرأسُ ربعُ الميزانية والذيلُ باقيها.
  test("clipKeepCause keeps the head of a result list as well as the tail", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `hit-${i}: item number ${i} of the listing`)
    const text = lines.join("\n")
    const clipped = clipKeepCause(text, 200)
    expect(clipped.startsWith("hit-0:")).toBe(true)
    expect(clipped).toContain("hit-11:")
    expect(clipped).toContain("حُذف")
    expect(clipped.length).toBeLessThanOrEqual(200 + 60)
    // الميزانيةُ تُحترم بالضبط: رأسٌ ٥٠ + ذيلٌ ١٥٠ + سطرُ الإعلان.
    const [head, , ...rest] = clipped.split("\n[... ")
    expect(head).toBe(text.slice(0, 50))
    expect(rest).toEqual([])
    expect(clipped.endsWith(text.slice(text.length - 150))).toBe(true)
  })

  test("prompt carries goal, claim, and receipts under separate budgets", () => {
    const prompt = buildVerifierPrompt(
      "ابنِ صفحة تواصل",
      "تم كل شيء",
      [{ command: "run npm run build", output: "انتهى الأمر برمز 0" }],
    )
    expect(prompt).toContain("ابنِ صفحة تواصل")
    expect(prompt).toContain("تم كل شيء")
    expect(prompt).toContain("npm run build")
    expect(prompt).toContain("COMPLETE أو INCOMPLETE أو WAITING أو STUCK")
  })

  test("a noisy receipt flood cannot evict the user's goal (two budgets)", () => {
    const receipts = Array.from({ length: 40 }, (_, i) => ({ command: `run step${i}`, output: "x".repeat(2000) }))
    const prompt = buildVerifierPrompt("الهدف الحقيقي المطلوب", "تم", receipts)
    expect(prompt).toContain("الهدف الحقيقي المطلوب")
    expect(prompt).toContain("أقدم حُذف")
  })

  test("parses each of the four states from the first verdict line", () => {
    expect(parseVerdict("COMPLETE\nكل العناصر لها دليل")?.status).toBe("COMPLETE")
    expect(parseVerdict("INCOMPLETE\nلا دليل على إرسال البريد")).toEqual({ status: "INCOMPLETE", reason: "لا دليل على إرسال البريد" })
    expect(parseVerdict("**WAITING**\nسأل عن اسم النطاق")?.status).toBe("WAITING")
    expect(parseVerdict("STUCK\nADMIN_PASSWORD_HASH غائب من البيئة")?.status).toBe("STUCK")
  })

  test("an unusable reply is undefined — never silently COMPLETE (no fail-open)", () => {
    expect(parseVerdict("أعتقد أن العمل جيد إجمالاً")).toBeUndefined()
    expect(parseVerdict("")).toBeUndefined()
    expect(parseVerdict("the task is complete i think")).toBeUndefined()
  })

  test("a verdict buried after a short preamble is still found within four lines", () => {
    expect(parseVerdict("حسناً.\nINCOMPLETE\nفلتر الشهر لم يُختبر")?.status).toBe("INCOMPLETE")
  })

  test("lowercase and same-line verdicts from a small model still parse", () => {
    expect(parseVerdict("incomplete: لا دليل على الاختبارات")).toEqual({ status: "INCOMPLETE", reason: "لا دليل على الاختبارات" })
    expect(parseVerdict("Stuck — ADMIN_PASSWORD_HASH غائب")?.status).toBe("STUCK")
  })

  test("an echoed option menu is not a verdict (two+ other statuses on the line)", () => {
    expect(parseVerdict("COMPLETE أو INCOMPLETE أو WAITING أو STUCK\nثم السبب")).toBeUndefined()
  })

  test("a reason mentioning one other status word does not disqualify the verdict", () => {
    expect(parseVerdict("INCOMPLETE — the work is not complete yet")?.status).toBe("INCOMPLETE")
  })
})
