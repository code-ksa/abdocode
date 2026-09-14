import { describe, expect, test } from "bun:test"
import { ledgerFor, quotaVerdict, renderLedgerLine, type ModelPrice, type ModelUsage, type SubscriberPlan } from "../src/commerce-ledger"

// ذ6 — بوّابةُ القبول من البرنامج بنصّها: «مشتركٌ يستهلك ١٠٠ ألف توكن على نموذجين ⇦ الأربعة بالهللات؛ وعند السقف
// **رسالةٌ لا خطأ** ولا يضيع دورٌ نصف منفَّذ»، و«أسقط سعر الشراء ⇦ **يمتنع البيع** (fail-closed) لا أن يُقدَّر».

const PRICES: readonly ModelPrice[] = [
  // أسعارٌ **مُختبَريّة** لا مأخوذةٌ من مزوّد: الوحدةُ لا تعرف أسعاراً، والمالكُ يضعها في الإعدادات.
  { ref: "cloud/big", buyInPerMillion: 300, buyOutPerMillion: 1500 },
  { ref: "cloud/small", buyInPerMillion: 100, buyOutPerMillion: 400, buyCachedInPerMillion: 10 },
]
const PLAN: SubscriberPlan = { id: "pro", sellPerMillion: 2000, quotaHalalas: 5000 }

describe("ذ6 — الدفترُ التجاريّ", () => {
  test("مئةُ ألف توكن على نموذجين: الأربعةُ بالهللات، والحسابُ صحيحٌ عنصراً عنصراً", () => {
    // الحساب: big دخل 40k×300/1e6=12 هللة، خرج 20k×1500/1e6=30 ⇒ 42.
    //          small دخل غير المخبَّأ 25k×100/1e6=2.5⇦3 (تقريبٌ نصفيّ لأعلى)، المخبَّأ 5k×10/1e6=0.05⇦0، خرج 10k×400/1e6=4 ⇒ 7.
    //          الشراء 49 هللة. التوكينات 40k+20k+30k+10k = 100k. البيع 100k×2000/1e6 = 200 هللة. الهامش 151.
    const usage: readonly ModelUsage[] = [
      { ref: "cloud/big", inputTokens: 40_000, outputTokens: 20_000 },
      { ref: "cloud/small", inputTokens: 30_000, outputTokens: 10_000, cachedInputTokens: 5_000 },
    ]
    const result = ledgerFor(usage, PRICES, PLAN)
    expect(result.kind).toBe("ok")
    if (result.kind !== "ok") return
    expect(result.tokens).toBe(100_000)
    expect(result.buyHalalas).toBe(49)
    expect(result.sellHalalas).toBe(200)
    expect(result.marginHalalas).toBe(151)
    expect(result.perModel.map((m) => `${m.ref}:${m.buyHalalas}`)).toEqual(["cloud/big:42", "cloud/small:7"])
    expect(renderLedgerLine(result)).toContain("شراؤنا 0.49 ريال")
    expect(renderLedgerLine(result)).toContain("الهامش 1.51 ريال")
  })

  test("سعرُ شراءٍ ناقصٌ لنموذجٍ استُعمل ⇒ يمتنع البيع بالاسم، ولا رقمَ يُعرض", () => {
    const usage: readonly ModelUsage[] = [
      { ref: "cloud/big", inputTokens: 10_000, outputTokens: 5_000 },
      { ref: "cloud/unpriced", inputTokens: 1_000, outputTokens: 1_000 },
    ]
    const result = ledgerFor(usage, PRICES, PLAN)
    expect(result.kind).toBe("unavailable")
    if (result.kind !== "unavailable") return
    expect(result.missing).toEqual(["cloud/unpriced"])
    expect(result.why).toContain("cloud/unpriced")
    expect(renderLedgerLine(result)).not.toMatch(/\d+\.\d{2} ريال/u) // لا مبلغَ يُطبع أصلاً
  })

  test("نموذجٌ بلا سعرٍ لكنّه لم يُستعمل لا يمنع شيئاً — الغيابُ يمنع ما يُبنى عليه وحده", () => {
    const result = ledgerFor([{ ref: "cloud/unpriced", inputTokens: 0, outputTokens: 0 }, { ref: "cloud/big", inputTokens: 1_000_000, outputTokens: 0 }], PRICES, PLAN)
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.buyHalalas).toBe(300)
  })

  test("تبديلُ المزوّد يضبط تكلفتَنا وحدها: البيعُ لا يتغيّر بتغيّر النموذج الذي خدم", () => {
    const onBig = ledgerFor([{ ref: "cloud/big", inputTokens: 500_000, outputTokens: 500_000 }], PRICES, PLAN)
    const onSmall = ledgerFor([{ ref: "cloud/small", inputTokens: 500_000, outputTokens: 500_000 }], PRICES, PLAN)
    expect(onBig.kind === "ok" && onSmall.kind === "ok").toBe(true)
    if (onBig.kind !== "ok" || onSmall.kind !== "ok") return
    expect(onBig.sellHalalas).toBe(onSmall.sellHalalas) // البيعُ من الخطّة
    expect(onBig.buyHalalas).toBeGreaterThan(onSmall.buyHalalas) // والشراءُ من النموذج
    expect(onBig.marginHalalas).toBeLessThan(onSmall.marginHalalas)
  })

  test("الحصّة: دون السقف مفتوحةٌ بباقٍ معلوم، وعنده **رسالةٌ لا خطأ** تقول إنّ الدورَ الجاري يكتمل", () => {
    expect(quotaVerdict(4_999, PLAN)).toMatchObject({ kind: "open", remainingHalalas: 1 })
    const hit = quotaVerdict(5_000, PLAN)
    expect(hit.kind).toBe("ceiling")
    if (hit.kind !== "ceiling") return
    expect(hit.message).toContain("50.00 ريال")
    expect(hit.message).toContain("الدورُ الجاري يكتمل")
    expect(hit.message).toContain("لا شيءَ ضاع")
    // وبلا سقفٍ في الخطّة لا حصّةَ تُخترع
    expect(quotaVerdict(9_999_999, { id: "free", sellPerMillion: 0 }).kind).toBe("open")
  })
})
