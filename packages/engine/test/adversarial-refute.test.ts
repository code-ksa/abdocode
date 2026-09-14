import { describe, expect, test } from "bun:test"
import { buildRefutePrompt, judgeRefutations, parseRefutation, REFUTE_LENSES, REFUTE_SYSTEM } from "../src/adversarial-refute"

describe("هـ3 — التفنيدُ العدائيّ لوضع «أقصى»", () => {
  test("ثلاثُ عدساتٍ تسأل أسئلةً مختلفة حقّاً، وكلٌّ تُسمّى في الإيصال", () => {
    expect(REFUTE_LENSES).toHaveLength(3)
    expect(new Set(REFUTE_LENSES.map((l) => l.key)).size).toBe(3)
    expect(new Set(REFUTE_LENSES.map((l) => l.question)).size).toBe(3)
    for (const lens of REFUTE_LENSES) expect(lens.label.length).toBeGreaterThan(4)
    // العقدُ في نصّ النظام: بلا أدوات، وسطران، ودحضٌ بمدخلٍ مسمّى
    expect(REFUTE_SYSTEM).toContain("لا أدواتِ لك")
    expect(REFUTE_SYSTEM).toContain("REFUTED")
    expect(REFUTE_SYSTEM).toContain("مدخلاً أو حالةً مسمّاة")
  })

  test("المدخلُ يحمل الهدفَ والجوابَ والإيصالات مسقوفةً وسؤالَ العدسة وحدها", () => {
    const receipts = Array.from({ length: 20 }, (_, i) => ({ command: `run test-${i}`, output: `ok ${i}` }))
    const prompt = buildRefutePrompt("ابنِ صفحةَ من نحن", "أنجزتُ الصفحة والاختبارات خضراء", receipts, REFUTE_LENSES[0]!)
    expect(prompt).toContain("ابنِ صفحةَ من نحن")
    expect(prompt).toContain("أنجزتُ الصفحة")
    expect(prompt).toContain("الإيصالات المنفَّذة (20)")
    expect(prompt).toContain("run test-19") // آخرُ اثني عشر
    expect(prompt).not.toContain("run test-0 ") // والأقدمُ يُسقط بالسقف
    expect(prompt).toContain(REFUTE_LENSES[0]!.question)
    expect(prompt).not.toContain(REFUTE_LENSES[1]!.question)
    // بلا إيصالاتٍ يُقال ذلك صراحةً لا يُترك فراغاً
    expect(buildRefutePrompt("هدف", "جواب", [], REFUTE_LENSES[1]!)).toContain("لا إيصالات")
  })

  test("القراءة: دحضٌ بسببٍ يُقبل، ودحضٌ بلا سببٍ لا يُقبل، والغموضُ «قائم»", () => {
    expect(parseRefutation("evidence", "الحكم: REFUTED\nالسبب: البناءُ نجح ولا اختبارَ يمسّ الصفحة الجديدة")).toMatchObject({ refuted: true })
    expect(parseRefutation("evidence", "الحكم: REFUTED\nالسبب: BUILD ok\n").why).toContain("BUILD ok")
    // دحضٌ بلا سطر سبب: العقدُ سطران، ومن لم يكتب السبب لم يدحض
    expect(parseRefutation("evidence", "الحكم: REFUTED").refuted).toBe(false)
    expect(parseRefutation("evidence", "الحكم: STANDS\nالسبب: الإيصالات تغطّي الهدف").refuted).toBe(false)
    // نصٌّ لا يحمل حكماً أصلاً — غيابُ الحكم لا يوقف تسليماً صحيحاً
    expect(parseRefutation("breaks", "لا أدري، ربّما ينقص شيء").refuted).toBe(false)
    // ولا يُخدع بكلمة REFUTED في نثرٍ بلا عقد
    expect(parseRefutation("breaks", "قد يقول قائلٌ REFUTED لكنّي لا أرى مشكلة").refuted).toBe(false)
  })

  test("الحكمُ الجامع: اثنان من ثلاثةٍ يوقفان، وواحدٌ رأيٌ يُقال ولا يوقف، والعدُّ يُكتب كما هو", () => {
    const r = (lens: string, refuted: boolean, why = "سبب") => ({ lens, refuted, why })
    const one = judgeRefutations([r("evidence", true, "لا اختبار"), r("unproven", false), r("breaks", false)])
    expect(one.refuted).toBe(false)
    expect(one.tally).toContain("1/3")
    expect(one.problem).toBeUndefined()
    const two = judgeRefutations([r("evidence", true, "لا اختبار"), r("unproven", true, "ادّعاءُ نشرٍ بلا إيصال"), r("breaks", false)])
    expect(two.refuted).toBe(true)
    expect(two.tally).toContain("2/3")
    expect(two.problem).toContain("[evidence] لا اختبار")
    expect(two.problem).toContain("[unproven] ادّعاءُ نشرٍ بلا إيصال")
    // الصفرُ يمرّ، والعدُّ يذكر كلَّ عدسةٍ بحالها
    const none = judgeRefutations([r("evidence", false), r("unproven", false), r("breaks", false)])
    expect(none.refuted).toBe(false)
    expect(none.tally).toContain("0/3")
    for (const lens of ["evidence", "unproven", "breaks"]) expect(none.tally).toContain(`${lens}: قائم`)
  })
})
