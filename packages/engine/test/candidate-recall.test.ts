import { describe, expect, test } from "bun:test"
import { normalizeForRecall, rankByRelevance, tokenize } from "../src/candidate-recall"

/**
 * 🔴 المرشّحون كانوا يُختارون بالحداثة لا بالصلة: `slice(-128)` مهما كان السؤال.
 * وقِيس على متنِ ذاكرةٍ حقيقيٍّ (325 مدخلاً) أنّ **61% منه خارج النافذة** — فلا
 * يراه المرتّبُ أبداً. والترشيحُ الحتميُّ بالصلة أعطى 51.4% استرجاع@5، يطابق
 * FTS5 (51.7%) على المتن نفسِه — فالخوارزميّةُ هي القيمة لا المحرّك.
 */
describe("candidates are picked by relevance, and absence stays absent", () => {
  const corpus = [
    { id: 0, text: "pm2 يحقن بيئته فوق env-file فيتجاهل القيم الجديدة" },
    { id: 1, text: "الحارسُ العربيُّ بلا تطبيعٍ ثغرة: طبّع التشكيل والتطويل والهمزات" },
    { id: 2, text: "heredoc يأكل الخطوط المائلة فيكسر التعبير النمطيّ بصمت" },
    { id: 3, text: "نسخةُ Next standalone تلتقط قائمة public عند الإقلاع" },
  ]

  test("the right entry wins even when it is the oldest — recency no longer decides", () => {
    // «الحارسُ العربيّ» هو الأقدمُ في الترتيب لو كان الاختيارُ بالحداثة (id=1 وسطَ المتن)،
    // ويفوز هنا لأنّ الصلةَ هي الحَكَم.
    expect(rankByRelevance(corpus, "تطبيع الهمزات في الحارس العربي", 2)[0]).toBe(1)
    expect(rankByRelevance(corpus, "pm2 والبيئة", 2)[0]).toBe(0)
    expect(rankByRelevance(corpus, "heredoc والخطوط المائلة", 2)[0]).toBe(2)
  })

  test("ARABIC IS MATCHED BY ITS SHAPE, not its ornament", () => {
    // مشكّلٌ ومطوَّلٌ وبهمزةٍ مختلفة — ومع ذلك يطابق.
    expect(rankByRelevance(corpus, "الحَـارِسُ العَرَبيُّ والتطويــل", 1)[0]).toBe(1)
    expect(normalizeForRecall("الحَارِسُ")).toBe(normalizeForRecall("الحارس"))
    expect(normalizeForRecall("إسلام")).toBe(normalizeForRecall("اسلام"))
    expect(tokenize("من في على الحارس")).toEqual(["الحارس"])   // كلماتُ الوقف تُسقط
  })

  test("NO MATCH IS EMPTY, never an invented order (the negative twin)", () => {
    // لا شيءَ يطابق ⇦ فارغ، فيتراجع المُنادي إلى الحداثة بدل ترتيبٍ بلا سبب.
    expect(rankByRelevance(corpus, "زرافة برتقالية تسبح", 3)).toEqual([])
    expect(rankByRelevance(corpus, "", 3)).toEqual([])
    expect(rankByRelevance(corpus, "من في على", 3)).toEqual([])   // كلماتُ وقفٍ فقط
    expect(rankByRelevance([], "pm2", 3)).toEqual([])
    expect(rankByRelevance(corpus, "pm2", 0)).toEqual([])
  })

  test("the order is stable: the same question twice gives the same answer", () => {
    const once = rankByRelevance(corpus, "الحارس العربي والتطبيع", 4)
    const twice = rankByRelevance(corpus, "الحارس العربي والتطبيع", 4)
    expect(once).toEqual(twice)
    expect(once.length).toBeLessThanOrEqual(4)
  })
})
