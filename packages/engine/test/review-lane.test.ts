/**
 * م9ح — حارةُ المراجعة (نقيّة): الفرقُ المسقوف، عقدُ السطر لكلّ عيب، «عيبٌ بلا سيناريو ملاحظةٌ لا عيب»، والحكمُ الجامع.
 */
import { describe, expect, test } from "bun:test"
import { buildReviewPrompt, changeDiff, judgeReview, parseReviewFindings, renderReviewReport, REVIEW_LENSES, REVIEW_SYSTEM, reviewDiffText } from "../src/review-lane"

describe("review lane — pure", () => {
  test("three lenses ask three different questions and the system contract names the line format", () => {
    expect(REVIEW_LENSES.map((l) => l.key)).toEqual(["correctness", "safety", "tests"])
    expect(new Set(REVIEW_LENSES.map((l) => l.question)).size).toBe(3)
    expect(REVIEW_SYSTEM).toContain("- [حرج|متوسط|منخفض]")
    expect(REVIEW_SYSTEM).toContain("لا عيب")
    const prompt = buildReviewPrompt("أضف صفحة", "--- a\n+++ a\n+ x", REVIEW_LENSES[1]!)
    expect(prompt).toContain("هدفُ الدور:\nأضف صفحة")
    expect(prompt).toContain("عدستُك: الأمان")
    expect(buildReviewPrompt("", "d", REVIEW_LENSES[0]!)).toContain("غير مسمّى")
  })

  test("changeDiff shows created, deleted and edited files; reviewDiffText counts lines and truncates honestly", () => {
    expect(changeDiff({ path: "n.txt", after: "a\nb" })).toBe("--- n.txt (لم يكن موجوداً)\n+++ n.txt\n+ a\n+ b")
    expect(changeDiff({ path: "d.txt", before: "old" })).toBe("--- d.txt\n+++ d.txt (حُذف)\n- old")
    expect(changeDiff({ path: "e.txt", before: "1\n2\n3", after: "1\nX\n3" })).toBe("--- e.txt\n+++ e.txt\n- 2\n+ X")
    expect(changeDiff({ path: "g.ts", patch: "diff --git a/g.ts\n+ y" })).toBe("diff --git a/g.ts\n+ y")
    const diff = reviewDiffText([{ path: "e.txt", before: "1\n2", after: "1\nX" }, { path: "big.txt", after: "z".repeat(5000) }], 200)
    expect(diff.files).toBe(2)
    expect(diff.lines).toBe(3)
    expect(diff.truncated).toBe(true)
    expect(diff.text).toContain("⋯ big.txt (قُصّ: تجاوز السقف)")
  })

  test("parseReviewFindings reads the contract, keeps notes without a scenario, and ignores prose and «لا عيب»", () => {
    const text = [
      "بعض النثر الذي لا يُعدّ",
      "- [حرج] src/a.ts:12 — يقرأ الملفّ قبل التحقّق من وجوده — كيف يفشل: مسارٌ غيرُ موجود يرمي ENOENT",
      "- [متوسط] src/b.ts:3 — الاسمُ لا يُطبَّع | مدخلٌ بحروفٍ كبيرة على ويندوز يُنشئ ملفّين",
      "* منخفض src/c.ts — تعليقٌ قديم",
      "- [high] src/d.ts:1 - separated by hyphen only stays unparsed",
      "لا عيب",
    ].join("\n")
    const rows = parseReviewFindings("correctness", text)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ severity: "high", where: "src/a.ts:12", scenario: "مسارٌ غيرُ موجود يرمي ENOENT" })
    expect(rows[1]).toMatchObject({ severity: "medium", where: "src/b.ts:3", scenario: "مدخلٌ بحروفٍ كبيرة على ويندوز يُنشئ ملفّين" })
    expect(rows[2]).toMatchObject({ severity: "low", where: "src/c.ts", claim: "تعليقٌ قديم", scenario: "" })
    expect(parseReviewFindings("safety", "لا عيب")).toEqual([])
    expect(parseReviewFindings("safety", "")).toEqual([])
  })

  test("judgeReview: one high with a scenario or two mediums → fix; notes alone → notes; nothing → clean", () => {
    const high = parseReviewFindings("safety", "- [حرج] a:1 — سرٌّ نصّاً — كيف يفشل: أيُّ قارئٍ للمستودع يراه")
    expect(judgeReview(high).verdict).toBe("fix")
    const mediums = parseReviewFindings("correctness", "- [متوسط] a:1 — x — m1\n- [متوسط] a:2 — y — m2")
    expect(judgeReview(mediums).verdict).toBe("fix")
    const oneMedium = parseReviewFindings("correctness", "- [متوسط] a:1 — x — m1")
    expect(judgeReview(oneMedium).verdict).toBe("notes")
    // حرجٌ بلا سيناريو ملاحظةٌ — لا يوقف
    const highNoScenario = parseReviewFindings("tests", "- [حرج] a:1 — لا اختبار")
    const judged = judgeReview(highNoScenario)
    expect(judged.verdict).toBe("notes")
    expect(judged.counted).toHaveLength(0)
    expect(judged.notes).toHaveLength(1)
    expect(judged.line).toContain("1 ملاحظة بلا سيناريو")
    expect(judgeReview([]).verdict).toBe("clean")
    expect(judgeReview([]).line).toContain("نظيف")
    expect(judgeReview(high).line).toContain("الأمان: 1")
  })

  test("renderReviewReport leads with the verdict, orders by severity, separates notes, and never claims a fix", () => {
    const findings = [
      ...parseReviewFindings("correctness", "- [منخفض] a:9 — طفيف — كيف يفشل: قيمةٌ فارغة"),
      ...parseReviewFindings("safety", "- [حرج] a:1 — سرٌّ نصّاً — كيف يفشل: قارئُ المستودع"),
      ...parseReviewFindings("tests", "- [متوسط] t:1 — اختبارٌ بلا عضّ"),
    ]
    const report = renderReviewReport(judgeReview(findings), { text: "", files: 2, lines: 7, truncated: false })
    expect(report.startsWith("🔍 حكمُ المراجعة: يحتاج إصلاحاً")).toBe(true)
    expect(report).toContain("المراجَع: 2 ملفّاً، 7 سطر فرق")
    expect(report.indexOf("[حرج · الأمان] a:1")).toBeLessThan(report.indexOf("[منخفض · الصحّة] a:9"))
    expect(report).toContain("ملاحظاتٌ بلا سيناريو فشل (لا تُحتسب):\n◦ [عضُّ الاختبارات] t:1")
    expect(report).toContain("لم يُصلَح شيءٌ تلقائيّاً")
    expect(renderReviewReport(judgeReview([]), { text: "", files: 1, lines: 1, truncated: true })).toContain("(قُصّ بعضُه)")
  })
})
