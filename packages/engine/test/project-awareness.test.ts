import { describe, expect, test } from "bun:test"
import {
  AWARENESS_FILE,
  AWARENESS_MAX_CHARS,
  AWARENESS_NOTE_MARK,
  AWARENESS_READ_CAP,
  AWARENESS_SECTIONS,
  AWARENESS_SECTION_CAP,
  AWARENESS_TITLE,
  awarenessRefused,
  awarenessUpdateFrom,
  mergeProjectAwareness,
  parseAwareness,
  projectAwarenessBrief,
  type AwarenessMerge,
} from "../src/project-awareness"
import { REDACTED, redactSecretValues, sweepResidualSecrets } from "../src/secret-command-guard"
import {
  EMPTY_SESSION_SUMMARY,
  mergeSessionSummary,
  verifySummary,
  type SummaryDraft,
  type ToolReceipt,
} from "@abdo/engine-host"

/** الحاجبُ الحيّ الذي يمرّره `cli.ts` — التركيب نفسه بايتاً. */
const redactSummaryLine = (text: string): string => sweepResidualSecrets(redactSecretValues(text).text).text

const merged = (existing: string, update: Parameters<typeof mergeProjectAwareness>[1]): AwarenessMerge => {
  const result = mergeProjectAwareness(existing, update)
  if (awarenessRefused(result)) throw new Error(`unexpected refusal: ${result.refused}`)
  return result
}

describe("S13.2 — ترتيبُ الأقسام وشكلُ الملفّ", () => {
  test("الترتيب حتميّ ومُعلَن، وقرارات المالك ليست قسماً آلياً", () => {
    expect(AWARENESS_SECTIONS.map((s) => s.key)).toEqual(["facts", "owner", "decisions", "traps", "sprints"])
    expect(AWARENESS_SECTIONS.find((s) => s.key === "owner")!.automatic).toBe(false)
    expect(AWARENESS_SECTIONS.filter((s) => s.automatic).map((s) => s.key)).toEqual(["facts", "decisions", "traps", "sprints"])
  })

  test("ملفٌّ جديد يُرسم بالعنوان ثم الأقسام الخمسة بترتيبها", () => {
    const { text } = merged("", { facts: ["a.ts كُتب"] })
    expect(text.startsWith(`${AWARENESS_TITLE}\n`)).toBe(true)
    const positions = AWARENESS_SECTIONS.map((s) => text.indexOf(s.heading))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(text).toContain("- a.ts كُتب")
  })

  test("الرسمُ ثابت: دمجٌ بلا جديد لا يغيّر بايتاً (changed=false)", () => {
    const first = merged("", { facts: ["a.ts كُتب"] })
    const again = merged(first.text, { facts: ["a.ts كُتب"] })
    expect(again.text).toBe(first.text)
    expect(again.changed).toBe(false)
  })
})

describe("S13.2 — الدمجُ لا الدهس: ما كتبه إنسان يبقى", () => {
  const human = [
    AWARENESS_TITLE,
    "",
    "هذا المشروع يخدم عميلاً واحداً — اقرأ العقد قبل أي تغيير.",
    "",
    "## قرارات المالك لهذا المشروع",
    "- لا نشر يوم الجمعة.",
    "",
    "## ملاحظات المطوّر",
    "- المنفذ 4471 محجوز لبيئة العرض.",
    "- لا تلمس مجلد legacy/.",
    "",
    "## حقائق مقيسة",
    "- build:passing (كتبته بيدي)",
    "",
  ].join("\n")

  test("الديباجة والقسم الغريب وقرارات المالك وسطرُ الإنسان داخل قسمٍ آليّ — كلُّها تنجو", () => {
    const { text } = merged(human, { facts: ["كتبت app/page.tsx"], traps: ["المنفذ 4471 مشغول"] })
    expect(text).toContain("هذا المشروع يخدم عميلاً واحداً — اقرأ العقد قبل أي تغيير.")
    expect(text).toContain("## ملاحظات المطوّر")
    expect(text).toContain("- المنفذ 4471 محجوز لبيئة العرض.")
    expect(text).toContain("- لا تلمس مجلد legacy/.")
    expect(text).toContain("- لا نشر يوم الجمعة.")
    expect(text).toContain("- build:passing (كتبته بيدي)")
    expect(text).toContain("- كتبت app/page.tsx")
    // القسم الغريب يُلحق بعد أقسامنا، لا يُدسّ بينها.
    expect(text.indexOf("## ملاحظات المطوّر")).toBeGreaterThan(text.indexOf("## حالة السبرنتات"))
  })

  test("قرارات المالك لا تُملأ آلياً أبداً — ما فيها من المالك وحده", () => {
    const summary = mergeSessionSummary(
      EMPTY_SESSION_SUMMARY,
      verifySummary({ done: [], understood: [], decided: ["أبدأ بالواجهة"], blocked: [] } as SummaryDraft, []),
      1,
      redactSummaryLine,
    )
    const update = awarenessUpdateFrom(summary, "الدور t1: هدف — مكتمل")
    expect(update).not.toHaveProperty("owner")
    const { text } = merged(human, update)
    const ownerBody = text.slice(text.indexOf("## قرارات المالك لهذا المشروع"), text.indexOf("## قرارات الجلسات"))
    expect(ownerBody).toContain("- لا نشر يوم الجمعة.")
    expect(ownerBody).not.toContain("أبدأ بالواجهة")
    // قرار النموذج له قسمه المسمّى باسمه — وموسوماً، فهو قولُه لا قياس.
    expect(text).toContain(`- ${AWARENESS_NOTE_MARK}أبدأ بالواجهة`)
  })

  test("التكرار لا يتراكم: السطر نفسه بصيغةٍ أخرى في الفراغات لا يُضاف مرتين", () => {
    const once = merged("", { facts: ["كتبت app/page.tsx"] })
    const twice = merged(once.text, { facts: ["كتبت   app/page.tsx"] })
    expect(twice.text.match(/كتبت +app\/page\.tsx/gu)).toHaveLength(1)
    expect(twice.changed).toBe(false)
  })

  test("«فُهم» لا يعبر إلى الملفّ — الفهرسُ مقيسٌ لا انطباعات", () => {
    const summary = mergeSessionSummary(
      undefined,
      verifySummary({ done: [], understood: ["المشروع يبدو صغيراً"], decided: [], blocked: [] } as SummaryDraft, []),
      1,
      redactSummaryLine,
    )
    const { text } = merged("", awarenessUpdateFrom(summary))
    expect(text).not.toContain("المشروع يبدو صغيراً")
  })

  test("«حقائق مقيسة» لا تقبل غيرَ المقيس، والمانعُ غيرُ المقيس يدخل موسوماً", () => {
    // مسوّدةٌ بلا إيصالٍ واحد: كلُّ ما فيها قولُ النموذج.
    const summary = mergeSessionSummary(
      undefined,
      verifySummary(
        { done: [], understood: [], decided: ["نعيد المعمارية"], blocked: ["لا صلاحية لدينا"] } as SummaryDraft,
        [],
      ),
      1,
      redactSummaryLine,
    )
    const { text } = merged("", awarenessUpdateFrom(summary))
    const factsBody = text.slice(text.indexOf("## حقائق مقيسة"), text.indexOf("## قرارات المالك لهذا المشروع"))
    expect(factsBody).toContain("- (لا شيء مقيس بعد)")
    expect(text).toContain(`- ${AWARENESS_NOTE_MARK}نعيد المعمارية`)
    expect(text).toContain(`- ${AWARENESS_NOTE_MARK}لا صلاحية لدينا`)
    // ولا سطرَ ملاحظةٍ عارٍ يستقرّ كأنه قياس.
    expect(text).not.toContain("- نعيد المعمارية")
    expect(text).not.toContain("- لا صلاحية لدينا")
  })

  test("حقيقةٌ مقيسة تعبر بلا وسم — الوسمُ لغير المقيس وحده", () => {
    const receipts: readonly ToolReceipt[] = [{ command: "write app/page.tsx <<<\nx", output: "✍ كُتب app/page.tsx" }]
    const summary = mergeSessionSummary(
      undefined,
      verifySummary({ done: ["كتبت app/page.tsx"], understood: [], decided: [], blocked: [] } as SummaryDraft, receipts),
      1,
      redactSummaryLine,
    )
    const { text } = merged("", awarenessUpdateFrom(summary))
    expect(text).toContain("- كتبت app/page.tsx")
    expect(text).not.toContain(AWARENESS_NOTE_MARK)
  })
})

describe("S13.2 — السقوف: تُقصّ أقسامُنا وحدها ومن أقدمها", () => {
  test("سقفُ القسم يُبقي الأحدث", () => {
    let text = ""
    for (let i = 0; i < AWARENESS_SECTION_CAP + 5; i += 1) text = merged(text, { facts: [`حقيقة ${i}`] }).text
    const factsBody = text.slice(text.indexOf("## حقائق مقيسة"), text.indexOf("## قرارات المالك لهذا المشروع"))
    expect(factsBody.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(AWARENESS_SECTION_CAP)
    expect(factsBody).toContain(`- حقيقة ${AWARENESS_SECTION_CAP + 4}`)
    expect(factsBody).not.toContain("- حقيقة 0\n")
  })

  test("سقفُ الملفّ يُقصّ من أقسامنا، ولا يمسّ قسماً بشرياً ولو تجاوز به السقف", () => {
    const foreign = `## دفتر العميل\n${Array.from({ length: 400 }, (_, i) => `- سطر عميل رقم ${i} لا يجوز حذفه أبداً مهما طال الملف`).join("\n")}`
    const existing = `${AWARENESS_TITLE}\n\n${foreign}\n`
    const { text } = merged(existing, { facts: Array.from({ length: 60 }, (_, i) => `حقيقة طويلة رقم ${i}`) })
    expect(text.length).toBeGreaterThan(AWARENESS_MAX_CHARS)
    expect(text.match(/- سطر عميل رقم \d+/gu)).toHaveLength(400)
    // أقسامُنا قُصّت حتى الحدّ الأدنى بدل محو سطرٍ بشريّ.
    const factsBody = text.slice(text.indexOf("## حقائق مقيسة"), text.indexOf("## قرارات المالك لهذا المشروع"))
    expect(factsBody.split("\n").filter((l) => l.startsWith("- حقيقة"))).toHaveLength(0)
  })
})

describe("S13.2 — الحجب: ملفٌّ في جذر المشروع هو موضعُ التسريب", () => {
  test("اعتمادٌ في سطرٍ يُحجب قبل الكتابة بمفردات الحارس نفسها", () => {
    const { text, redactions } = merged("", { facts: ['شغّلت curl -H "Authorization: Bearer sk-live-abcdefghijklmnop1234567890"'] })
    expect(redactions).toBeGreaterThan(0)
    expect(text).toContain(REDACTED)
    expect(text).not.toContain("sk-live-abcdefghijklmnop1234567890")
  })

  test("كلمةُ مرورٍ في رابط اتصالٍ داخل نصّ بشريّ قائم تُحجب هي أيضاً", () => {
    const existing = `${AWARENESS_TITLE}\n\n## ملاحظات\n- الاتصال: postgres://admin:S3cretPassw0rd@db.internal:5432/app\n`
    const { text } = merged(existing, {})
    expect(text).not.toContain("S3cretPassw0rd")
    expect(text).toContain(REDACTED)
  })

  test("الكتابة متساوية القوى بعد الحجب: تمريرةٌ ثانية لا تغيّر شيئاً", () => {
    const first = merged("", { facts: ['التوكن Bearer sk-live-abcdefghijklmnop1234567890'] })
    const second = merged(first.text, {})
    expect(second.text).toBe(first.text)
    expect(second.changed).toBe(false)
  })
})

describe("S13.2 — الحجب لا يمحو نثرَ إنسان", () => {
  const human = [
    "## ملاحظات المهندس",
    "- المسار الحرج: packages/engine-host/test/session-summary-loop",
    "- معرّف البناء: build_2026_09_03_release_candidate_final_x86",
    "- انظر https://example.com/docs/getting-started-with-the-platform",
    "",
  ].join("\n")

  test("أربعون محرفاً من محارف المسارات ليست سرّاً: سطرُ الإنسان يبقى بايتاً", () => {
    const { text, redactions } = merged(human, {})
    expect(redactions).toBe(0)
    for (const line of [
      "- المسار الحرج: packages/engine-host/test/session-summary-loop",
      "- معرّف البناء: build_2026_09_03_release_candidate_final_x86",
      "- انظر https://example.com/docs/getting-started-with-the-platform",
    ]) expect(text).toContain(line)
    expect(text).not.toContain(REDACTED)
  })

  test("ولا يُرفض الملفّ كلُّه بسبب بقيّةٍ كانت فيه قبلنا", () => {
    expect(awarenessRefused(mergeProjectAwareness(human, { facts: ["كتبت app/page.tsx"] }))).toBe(false)
  })

  test("متساوي القوى مع سطرٍ يُحجب: لا يتكرّر كلَّ دور ولا يطرد محتوىً", () => {
    // الفخّ المدفوع: المفتاح كان يُحسب قبل الحجب والمخزَّنُ بعده، فلا يلتقيان
    // أبداً — فيتكرّر السطرُ نفسه في كل دور حتى يبتلع سقفَ القسم.
    const fact = "نُفّذ bun test في packages/engine-host/test/session-summary-loop.test.ts ونجح"
    const first = merged("", { facts: [fact] })
    expect(first.changed).toBe(true)
    const second = merged(first.text, { facts: [fact] })
    expect(second.changed).toBe(false)
    const third = merged(second.text, { facts: [fact] })
    expect(third.changed).toBe(false)
    const factsBody = third.text.slice(
      third.text.indexOf("## حقائق مقيسة"),
      third.text.indexOf("## قرارات المالك لهذا المشروع"),
    )
    expect(factsBody.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1)
  })
})

describe("S13.2 — قسمُ المالك بشريّ: لا يقصّه سقفٌ ولا سقف", () => {
  const ownerSection = (count: number, filler = ""): string =>
    [AWARENESS_TITLE, "", "## قرارات المالك لهذا المشروع",
      ...Array.from({ length: count }, (_, i) => `- قرار المالك رقم ${i}: لا تلمس مجلد legacy${filler}`), ""].join("\n")

  test("خمسةٌ وأربعون قراراً تنجو من سقف القسم كاملةً", () => {
    const { text } = merged(ownerSection(45), { facts: ["كتبت app/page.tsx"] })
    expect(text.match(/- قرار المالك رقم \d+/gu)).toHaveLength(45)
    expect(text).toContain("- قرار المالك رقم 0:")
  })

  test("قسمُ مالكٍ يتجاوز سقفَ الملفّ لا يُقصّ منه سطر", () => {
    const existing = ownerSection(40, ` — ${"تفصيلٌ طويل ".repeat(20)}`)
    expect(existing.length).toBeGreaterThan(AWARENESS_MAX_CHARS)
    const { text } = merged(existing, { facts: ["كتبت app/page.tsx"] })
    expect(text.match(/- قرار المالك رقم \d+/gu)).toHaveLength(40)
  })

  test("والقصّ لا يدور إلى الأبد حين لا يبقى إلا البشريّ", () => {
    const existing = ownerSection(40, ` — ${"تفصيلٌ طويل ".repeat(20)}`)
    const { text } = merged(existing, { facts: Array.from({ length: 60 }, (_, i) => `حقيقة طويلة رقم ${i}`) })
    const factsBody = text.slice(text.indexOf("## حقائق مقيسة"), text.indexOf("## قرارات المالك لهذا المشروع"))
    expect(factsBody.split("\n").filter((l) => l.startsWith("- حقيقة"))).toHaveLength(0)
    expect(text.match(/- قرار المالك رقم \d+/gu)).toHaveLength(40)
  })
})

describe("S13.2 — ملفٌّ أكبر من سقف القراءة لا يُبتر", () => {
  test("كلُّ سطرٍ بشريّ ينجو في نصّ الدمج ولو تجاوز الملفّ 64KiB", () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `- ملاحظة العميل رقم ${i} لا يجوز حذفها أبداً مهما طال الملف`)
    const existing = `${AWARENESS_TITLE}\n\n## دفتر العميل\n${lines.join("\n")}\n`
    expect(existing.length).toBeGreaterThan(AWARENESS_READ_CAP)
    const { text } = merged(existing, { facts: ["كتبت app/page.tsx"] })
    expect(text.match(/- ملاحظة العميل رقم \d+/gu)).toHaveLength(3000)
    expect(text).toContain("- ملاحظة العميل رقم 2999")
  })
})

describe("S13.2 — نهايةُ السطر والبصمة تبقيان كما وجدناهما", () => {
  test("ملفُّ CRLF يبقى CRLF، ودمجٌ بلا جديد لا يغيّر بايتاً", () => {
    const existing = "# ملاحظات\r\n\r\n- سطر إنسان\r\n"
    const first = merged(existing, {})
    expect(first.text).toContain("\r\n")
    expect(first.text.split("\n").every((l, i, all) => i === all.length - 1 || l.endsWith("\r"))).toBe(true)
    const again = merged(first.text, {})
    expect(again.changed).toBe(false)
  })

  test("بصمةُ الترتيب في الصدر تبقى", () => {
    const existing = "﻿# ملاحظات\n\n- سطر إنسان\n"
    const { text } = merged(existing, { facts: ["كتبت app/page.tsx"] })
    expect(text.startsWith("﻿")).toBe(true)
    expect(text).toContain("- سطر إنسان")
    expect(merged(text, {}).changed).toBe(false)
  })

  test("ملفُّ LF يبقى LF بلا CR واحد", () => {
    const { text } = merged("# ملاحظات\n\n- سطر إنسان\n", { facts: ["كتبت app/page.tsx"] })
    expect(text).not.toContain("\r")
  })
})

describe("S13.2 — القراءةُ الأولى في الدور", () => {
  test("الموجز يحمل أقسامنا مسقوفاً، وملفٌّ غائبٌ أو فارغ = فراغ", () => {
    const { text } = merged("", { facts: ["كتبت app/page.tsx"], traps: ["المنفذ 4471 مشغول"] })
    const brief = projectAwarenessBrief(text)
    expect(brief).toContain(AWARENESS_FILE)
    expect(brief).toContain("كتبت app/page.tsx")
    expect(brief).toContain("المنفذ 4471 مشغول")
    expect(brief.length).toBeLessThanOrEqual(902)
    expect(projectAwarenessBrief("")).toBe("")
    expect(projectAwarenessBrief("   ")).toBe("")
  })

  test("ملفٌّ بلا أيّ قسمٍ من أقسامنا لا يولّد موجزاً كاذباً", () => {
    expect(projectAwarenessBrief("# مشروعي\n\nنصٌّ حرّ بلا عناوين.\n")).toBe("")
  })

  test("التحليل يحفظ الديباجة والأقسام الغريبة كما هي", () => {
    const doc = parseAwareness("# غير عنواننا\n\nمقدمة\n\n## قسم غريب\n- سطر\n")
    expect(doc.preamble).toEqual(["# غير عنواننا", "", "مقدمة"])
    expect(doc.foreign.map((f) => f.heading)).toEqual(["## قسم غريب"])
    expect(doc.managed.facts).toEqual([])
  })
})
