/**
 * م11 — تنبيهُ الميزانية عند ٧٥٪ من سقف الدور (مقيس 09-14: دورٌ استهلك ٣٧٣ ألفاً من ٤٠٠ في ٣٦ نداءً ومات بـturn_budget قبل README).
 * العدّادُ يُحاسب النداءاتِ السحابيّةَ وحدها (المحلّيُّ مجّانيّ) فلا يُستحثّ بمزوّدٍ وهميّ محلّيّ — لذا الإثباتُ هنا: سطرُ التنبيه نقيّاً،
 * ومسامير الأسلاك: يُحسب قبل بناء المدخل، يُبثّ حدثاً، ويُقال مرّةً واحدة (`budgetWarned`)، ويسبق تصحيحَ الخرج المختلَق في المدخل.
 */
import { describe, expect, test } from "bun:test"
import { BUDGET_NOTICE_RATIO, budgetNoticeLine } from "../src/turn-budget"

const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

describe("budget notice", () => {
  test("the line names the percentage and the numbers and asks for economy, not a stop", () => {
    const line = budgetNoticeLine(300_000, 400_000)
    expect(line.startsWith("[تنبيه الميزانية] استُهلك 75٪ من سقف الدور (300000/400000 توكيناً فعّالاً)")).toBe(true)
    expect(line).toContain("لا تُعِد قراءةَ ملفٍّ قرأته")
    expect(line).toContain("اختم بالإيصالات")
    expect(BUDGET_NOTICE_RATIO).toBe(0.75)
    expect(budgetNoticeLine(372_945, 400_000)).toContain("93٪")
  })
  test("wiring: computed from the meter snapshot before the prompt is built, emitted once, and ordered before the fabrication correction", () => {
    const snap = source.indexOf("const budgetSnap = turnMeter?.snapshot()")
    const notice = source.indexOf("budgetSnap.spent >= budgetSnap.cap * BUDGET_NOTICE_RATIO ? budgetNoticeLine(budgetSnap.spent, budgetSnap.cap) : \"\"", snap)
    const once = source.indexOf("if (budgetNotice.length > 0) { budgetWarned = true; await emitEvent(turn.id, `⏱ ${budgetNotice}`) }", notice)
    const prompt = source.indexOf("const notices = [budgetNotice, fabricationNotice].filter((n) => n.length > 0)", once)
    const ask = source.indexOf("const askPrompt = notices.length > 0 ? `${notices.join(\"\\n\")}\\n\\n${prompt}` : prompt", prompt)
    expect(snap).toBeGreaterThan(0); expect(notice).toBeGreaterThan(snap); expect(once).toBeGreaterThan(notice); expect(prompt).toBeGreaterThan(once); expect(ask).toBeGreaterThan(prompt)
    expect(source).toContain("let budgetWarned = false")
    expect(source.match(/budgetWarned = true/gu) ?? []).toHaveLength(1)
    // الشرطُ يحرس السقفَ غيرَ الصالح (cap "invalid") والصفرَ
    expect(source).toContain("typeof budgetSnap.cap === \"number\" && budgetSnap.cap > 0 && !budgetWarned")
  })
})
