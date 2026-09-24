/**
 * س0 من خطّة الحلقات — **جردٌ بمسامير توصيف** لآلة الرسم البيانيّ النائمة.
 *
 * المقيس قبل هذا الملفّ: `mind/planner.ts` و`cognitive-frame.ts` و`flow.ts` ثمانمئةٍ
 * وخمسةٌ وأربعون سطراً **لا يستوردها ملفُّ اختبارٍ واحد**، ولا تعرفها حلقةُ الحِقَب
 * الحيّة. وبناءُ طبقةٍ فوق ما لا دليلَ أنّه يعمل هو أكبرُ خطرٍ في تلك الخطّة.
 *
 * فهذه **مساميرُ توصيف** لا مساميرُ تصميم: تصف ما تفعله الوحدةُ اليوم بالضبط — بما
 * في ذلك ما قد لا يعجبنا — كي يصير أيُّ تغييرٍ لاحقٍ مرئيّاً. ولا يُغيَّر سطرٌ من
 * المصدر في هذا الملفّ: الجردُ يقرأ ولا يُصلح.
 */
import { describe, expect, test } from "bun:test"
import { blocked, ready, replan, validate, type Step, type StepInput } from "../src/mind/planner"

const step = (id: string, dependsOn: string[] = [], action = `do ${id}`): StepInput => ({ id, action, dependsOn })
const at = (id: string, state: Step["state"], dependsOn: string[] = []): Step => ({ id, action: `do ${id}`, dependsOn, state })

describe("س0 · planner.validate — ما يرفضه وما يقبله", () => {
  test("الخطّةُ السليمة تُقبل (التوأمُ الإيجابيّ: الحارسُ لا يرفض كلَّ شيء)", () => {
    expect(validate([step("a"), step("b", ["a"]), step("c", ["a", "b"])]).ok).toBe(true)
    expect(validate([step("solo")]).ok).toBe(true)
  })

  test("والفارغةُ تُرفض عمداً: «خطّةٌ فارغة ليست خطّة» — توقّعتُها مقبولةً فصحّحني المصدر", () => {
    const empty = validate([])
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.why).toContain("empty plan")
    // وخطوةٌ بلا فعلٍ أو بلا معرّفٍ تُرفض كذلك — الفراغُ ليس خطوة.
    expect(validate([{ id: "", action: "x", dependsOn: [] }]).ok).toBe(false)
    expect(validate([{ id: "a", action: "", dependsOn: [] }]).ok).toBe(false)
  })

  test("الدورةُ تُرفض **بمسارها** لا بكلمة «غير صالحة»", () => {
    const v = validate([step("a", ["c"]), step("b", ["a"]), step("c", ["b"])])
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.why).toContain("->")
      // المسارُ يسمّي الحلقةَ كي يُقصّ الضلعُ لا كي تُقرأ الخطّةُ كلُّها.
      for (const id of ["a", "b", "c"]) expect(v.why).toContain(id)
    }
  })

  test("الدورةُ على النفس تُرفض، والمعرّفُ المكرّر يُرفض، والاعتمادُ المجهول يُرفض", () => {
    expect(validate([step("a", ["a"])]).ok).toBe(false)
    expect(validate([step("a"), step("a")]).ok).toBe(false)
    const missing = validate([step("a", ["ghost"])])
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.why).toContain("ghost")
  })
})

describe("س0 · planner.ready — الحتميّةُ هي الميزة", () => {
  test("الجاهزُ = معلَّقٌ كلُّ اعتماداته منتهية", () => {
    const plan = [at("a", "done"), at("b", "pending", ["a"]), at("c", "pending", ["b"])]
    expect(ready(plan).map((s) => s.id)).toEqual(["b"])
  })

  test("🔑 الترتيبُ بالمعرّف لا بالموضع — بناءان للخطّة نفسِها يعطيان الخطوةَ نفسَها", () => {
    const forward = [at("c", "pending"), at("a", "pending"), at("b", "pending")]
    const reversed = [...forward].reverse()
    expect(ready(forward).map((s) => s.id)).toEqual(["a", "b", "c"])
    expect(ready(reversed).map((s) => s.id)).toEqual(ready(forward).map((s) => s.id))
  })

  test("الجارية والمنتهية والفاشلة ليست «جاهزة»", () => {
    const plan = [at("a", "running"), at("b", "done"), at("c", "failed"), at("d", "pending")]
    expect(ready(plan).map((s) => s.id)).toEqual(["d"])
  })
})

describe("س0 · planner.blocked — المحجوبُ متعدٍّ لا مباشرٌ فقط", () => {
  test("بلا فشلٍ لا محجوب (التوأمُ الإيجابيّ)", () => {
    expect(blocked([at("a", "done"), at("b", "pending", ["a"])])).toEqual([])
  })

  test("الحجبُ يسري عبر السلسلة كلِّها — لا على التابع المباشر وحده", () => {
    const plan = [at("a", "failed"), at("b", "pending", ["a"]), at("c", "pending", ["b"]), at("d", "pending")]
    const ids = blocked(plan).map((s) => s.id).toSorted()
    expect(ids).toEqual(["b", "c"])
    expect(ids).not.toContain("d")
  })
})

describe("س0 · planner.replan — دمجٌ لا استبدال", () => {
  test("الخطوةُ الباقيةُ تحتفظ بحالتها — وإلّا أُعيد العملُ المنتهي", () => {
    const previous = [at("a", "done"), at("b", "running"), at("c", "pending")]
    const result = replan(previous, [step("a"), step("b"), step("c"), step("d", ["c"])])
    expect(result.ok).toBe(true)
    if (result.ok) {
      const byId = new Map(result.plan.map((s) => [s.id, s.state]))
      expect(byId.get("a")).toBe("done")
      expect(byId.get("b")).toBe("running")
      expect(byId.get("d")).toBe("pending")   // الجديدةُ تبدأ معلَّقة
    }
  })

  test("🔑 إسقاطُ خطوةٍ تحمل دليلاً يُرفض — الدليلُ يبقى ويشير إلى لا شيء", () => {
    const previous = [at("a", "done"), at("b", "done")]
    const refused = replan(previous, [step("a")], ["b"])
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.why).toContain("b")
    // التوأمُ الإيجابيّ: إسقاطُ خطوةٍ **بلا** دليلٍ مسموح — الحارسُ لا يجمّد الخطّة.
    expect(replan(previous, [step("a")], []).ok).toBe(true)
  })

  test("الخطّةُ الجديدةُ الفاسدة تُرفض قبل الدمج", () => {
    expect(replan([at("a", "done")], [step("a", ["zzz"])]).ok).toBe(false)
  })
})
