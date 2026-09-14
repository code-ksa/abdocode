import { describe, expect, test } from "bun:test"
import {
  AWARENESS_LAYERS,
  LAYER_LABEL,
  RECALL_MAX_CHARS,
  RECALL_NOTHING,
  RECALL_UNREAD,
  buildAwarenessIndex,
  entriesFromFacts,
  entriesFromGeneral,
  entriesFromProjectAwareness,
  entriesFromSummary,
  recallSearch,
  recallTerms,
  renderAwarenessIndex,
  type AwarenessEntry,
} from "../src/awareness-index"
import { EMPTY_GENERAL_STORE, promoteLessons, projectTokensOf, serialiseGeneralStore, parseGeneralStore } from "../src/general-awareness"
import { mergeProjectAwareness } from "../src/project-awareness"
import type { SessionSummary } from "@abdo/engine-host"

const A = "C:/work/acme-shop"
const B = "C:/work/globex-portal"

const summaryOf = (done: readonly string[], blocked: readonly string[] = []): SessionSummary =>
  ({
    sections: {
      done: done.map((text) => ({ text, status: "measured" as const })),
      understood: [],
      decided: [],
      blocked: blocked.map((text) => ({ text, status: "unreceipted" as const })),
    },
    epochs: [1],
  }) as unknown as SessionSummary

// ---------------------------------------------------------------------------

describe("S13.4 — بناء الطبقات الأربع", () => {
  test("خلاصةُ الجلسة ليست حقيقةَ دور: مفتاح session:<id>:summary لا يدخل الطبقة الأولى", () => {
    const facts = entriesFromFacts(
      [
        { key: "build:passing", value: "npm run build ينجح" },
        { key: "session:s-1:summary", value: { sections: {} } },
      ],
      A,
    )
    expect(facts).toHaveLength(1)
    expect(facts[0]!.key).toBe("build:passing")
    expect(facts[0]!.layer).toBe("turn")
    expect(facts[0]!.projectId).toBe(A)
  })

  test("سطرُ الخلاصة يحمل جلسته وحالته في نسبه", () => {
    const entries = entriesFromSummary(summaryOf(["كُتب المكوّن الرئيس"], ["الاعتماد غائب"]), A, "s-1")
    expect(entries).toHaveLength(2)
    expect(entries[0]!.sessionId).toBe("s-1")
    expect(entries[0]!.provenance).toContain("s-1")
    expect(entries[1]!.provenance).toContain("غير مقيس")
  })

  test("وعيُ المشروع يُقرأ سطراً سطراً، والنائبُ لا يُعدّ محتوى", () => {
    const merged = mergeProjectAwareness("", { facts: ["البناء ينجح بلا أخطاء"], traps: [] })
    if ("refused" in merged) throw new Error(merged.refused)
    const entries = entriesFromProjectAwareness(merged.text, A)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.layer).toBe("project")
    expect(entries[0]!.text).toBe("البناء ينجح بلا أخطاء")
    expect(entriesFromProjectAwareness("", A)).toEqual([])
  })

  test("الطبقةُ العامّة بلا projectId — بنيوياً، فلا تُنسب إلى مشروعٍ أبداً", () => {
    const run = promoteLessons(EMPTY_GENERAL_STORE, [{ cls: "playbook", text: "«sqlite-locked»: فعّل WAL وbusy_timeout واجعل الكتابة من مسارٍ واحد." }], { projectTokens: projectTokensOf(A), now: 1 })
    const entries = entriesFromGeneral(run.store)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.projectId).toBeUndefined()
    expect(entries[0]!.provenance).toContain("ليست قياساً عن هذا المشروع")
  })
})

// ---------------------------------------------------------------------------

describe("S13.4 — الفهرس الرابط: وصلةٌ لا تُدّعى إلا بطرفَيها", () => {
  const facts = entriesFromFacts([{ key: "build:passing", value: "npm run build ينجح" }], A)
  const summary = entriesFromSummary(summaryOf(["كُتب المكوّن الرئيس"]), A, "s-1")

  test("الوصلات الأربع تنشأ حين توجد أطرافها", () => {
    const index = buildAwarenessIndex({ projectId: A, entries: [...facts, ...summary] })
    const relations = index.links.map((link) => link.relation)
    expect(relations).toContain("project→session")
    expect(relations).toContain("session→summary")
    expect(relations).toContain("project→fact")
    expect(index.counts.turn).toBe(1)
    expect(index.counts.session).toBe(1)
  })

  test("الطفرة (د): جلسةٌ بلا خلاصةٍ محفوظة لا تُدّعى لها وصلةُ خلاصة", () => {
    // الجلسة حاضرةٌ في حقيقةِ دورٍ مقيّدةٍ بها، ولا سطرَ خلاصةٍ لها البتّة.
    const sessionScopedFact = entriesFromFacts([{ key: "wrote:x", value: "كُتب", sessionId: "s-2" }], A)
    const index = buildAwarenessIndex({ projectId: A, entries: sessionScopedFact })
    expect(index.links.map((l) => l.relation)).toContain("project→session")
    expect(index.links.some((l) => l.relation === "session→summary")).toBe(false)
    expect(index.nodes).not.toContain("summary:s-2")
    // ولا وصلةَ إلى عقدةٍ لا وجود لها في العقد المبنيّة.
    for (const link of index.links) expect(link.from === "install" || index.nodes.includes(link.from)).toBe(true)
    for (const link of index.links) expect(index.nodes).toContain(link.to)
  })

  test("لا وصلةَ إلى الوعي العامّ إن كان المخزن فارغاً", () => {
    const empty = buildAwarenessIndex({ projectId: A, entries: [...facts, ...entriesFromGeneral(EMPTY_GENERAL_STORE)] })
    expect(empty.links.some((l) => l.relation === "install→general")).toBe(false)
    const run = promoteLessons(EMPTY_GENERAL_STORE, [{ cls: "env_trap", text: "المهلة القصيرة تُسقط التنصيب على شبكةٍ بطيئة — ارفعها ولا تكرّر النداء." }], { projectTokens: [], now: 1 })
    const filled = buildAwarenessIndex({ projectId: A, entries: [...facts, ...entriesFromGeneral(run.store)] })
    expect(filled.links.some((l) => l.relation === "install→general")).toBe(true)
  })

  test("فهرسٌ بلا مُدخلاتٍ يقول «لا شيء مقيس» ولا يخترع وصلةً", () => {
    const index = buildAwarenessIndex({ projectId: A, entries: [] })
    expect(index.links).toEqual([])
    expect(index.nodes).toEqual([])
    expect(renderAwarenessIndex(index)).toContain(RECALL_NOTHING)
  })

  test("العرض يسمّي الطبقات الأربع وعدد كلٍّ منها", () => {
    const rendered = renderAwarenessIndex(buildAwarenessIndex({ projectId: A, entries: [...facts, ...summary] }))
    for (const layer of AWARENESS_LAYERS) expect(rendered).toContain(LAYER_LABEL[layer])
    expect(rendered).toContain(A)
  })
})

// ---------------------------------------------------------------------------

describe("S13.4 — الاسترجاع بالبحث بدل المقطع الثابت", () => {
  const entries: readonly AwarenessEntry[] = [
    ...entriesFromFacts(
      [
        { key: "build:passing", value: "npm run build ينجح ويصرّف بلا أخطاء" },
        { key: "tests:passing", value: "npm test ينجح (42)" },
      ],
      A,
    ),
    ...entriesFromSummary(summaryOf(["أُصلح انهيار البحث في صفحة النتائج"]), A, "s-1"),
    ...entriesFromGeneral(
      promoteLessons(EMPTY_GENERAL_STORE, [{ cls: "playbook", text: "«sqlite-locked»: القاعدة مقفولة من عملية أخرى — فعّل WAL وbusy_timeout." }], { projectTokens: [], now: 1 }).store,
    ),
  ]

  test("الترتيب بالنسبة: أكثر الكلمات مطابقةً أولاً، والنسب معه", () => {
    const answer = recallSearch("هل ينجح البناء؟", entries)
    expect(answer.measured).toBe(true)
    expect(answer.matches[0]!.key).toBe("build:passing")
    expect(answer.matches[0]!.layer).toBe("turn")
    expect(answer.text).toContain(LAYER_LABEL.turn)
    expect(answer.text).toContain("build:passing")
  })

  test("التساوي يُحسم بالطبقة: المقيسُ عن المشروع قبل المعرفة العامّة", () => {
    const measured: AwarenessEntry = { layer: "turn", key: "k1", text: "القاعدة مقفولة من عملية أخرى", projectId: A, provenance: "قياس" }
    const general: AwarenessEntry = { layer: "general", key: "k2", text: "القاعدة مقفولة من عملية أخرى", provenance: "عامّ" }
    const answer = recallSearch("القاعدة مقفولة", [general, measured])
    expect(answer.matches.map((m) => m.layer)).toEqual(["turn", "general"])
  })

  test("الطفرة (ب): الغياب يُقال ولا يُملأ — «لا شيء مقيس»", () => {
    const empty = recallSearch("ما حالة بوابة الدفع؟", [])
    expect(empty.measured).toBe(false)
    expect(empty.matches).toEqual([])
    expect(empty.text).toContain(RECALL_NOTHING)
    expect(empty.searched).toBe(0)
    // ومع مُدخلاتٍ لا تطابق: الجواب هو الغياب نفسه لا أقربُ سطرٍ موجود.
    const noHit = recallSearch("كوبرنيكوس والمريخ", entries)
    expect(noHit.measured).toBe(false)
    expect(noHit.text).toContain(RECALL_NOTHING)
    for (const entry of entries) expect(noHit.text).not.toContain(entry.text)
  })

  test("لا اختلاق: كلّ سطرٍ يعود نصُّ مُدخلٍ بعينه", () => {
    const answer = recallSearch("build والقاعدة والبحث", entries)
    expect(answer.matches.length).toBeGreaterThan(1)
    const texts = new Set(entries.map((entry) => entry.text))
    for (const match of answer.matches) {
      expect(texts.has(match.text)).toBe(true)
      expect(answer.text).toContain(match.text)
    }
  })

  test("الخرج مسقوفٌ عدداً ومحارف", () => {
    const many: AwarenessEntry[] = Array.from({ length: 40 }, (_, i) => ({
      layer: "turn" as const,
      key: `k${i}`,
      text: `البناء ينجح في الوحدة رقم ${i} بلا أخطاء على الإطلاق أبداً`,
      projectId: A,
      provenance: "قياس",
    }))
    const answer = recallSearch("البناء", many, { maxMatches: 3, maxChars: 300 })
    expect(answer.matches).toHaveLength(3)
    expect(answer.text.length).toBeLessThanOrEqual(300)
    // والحتميّة: النداء نفسه يعطي النصّ نفسه.
    expect(recallSearch("البناء", many, { maxMatches: 3, maxChars: 300 }).text).toBe(answer.text)
  })

  test("الطفرة (ب): كلمةُ الوظيفة لا تصنع جواباً — سؤالٌ عن غير المقيس يعود غياباً", () => {
    // قيس حيّاً (2026-09-03) قبل الإصلاح: مخزنٌ سطرُه الوحيد عن «القاعدة»
    // ردَّ على «ما هو المنفذ في الخادم» بذلك السطر بنسبةٍ كاملة [3] — لأن
    // «في» وحدها طابقت. أي أن الطبقةَ التي وُضعت لتقول «لا شيء مقيس» صارت
    // تجيب عن غير المقيس بأقرب سطرٍ موجود.
    const corpus: readonly AwarenessEntry[] = entriesFromFacts(
      [{ key: "secret:one", value: "سرُّ العميل يعيش في القاعدة والقفل مفتوح" }],
      A,
    )
    for (const question of ["ما هو المنفذ في الخادم", "كم عدد المستخدمين في لوحة التحكم", "في", "هل هذا هو ما كان"]) {
      const answer = recallSearch(question, corpus)
      expect(answer.measured, `أجاب عن «${question}» من كلمة وظيفة`).toBe(false)
      expect(answer.text).toContain(RECALL_NOTHING)
      expect(answer.text).not.toContain("سرُّ العميل")
    }
    // والكلماتُ الوظيفيّة لا تدخل حدود البحث أصلاً.
    expect(recallTerms("ما هو المنفذ في الخادم")).toEqual(["المنفذ", "الخادم"])
    expect(recallTerms("في من عن هل")).toEqual([])
    // وكلمةٌ حقيقيّةٌ في السؤال نفسه ما زالت تجيب — الرفض ليس رفضاً لكلّ شيء.
    expect(recallSearch("أين تعيش القاعدة", corpus).measured).toBe(true)
  })

  test("النسبُ لا يُقصّ: مطابقةٌ طويلةٌ تعود مقصوصةً بعلامة ونسبُها كاملٌ خلفها", () => {
    // العطل: السقفُ كان يُطبَّق على النصّ المجموع فيبتر آخر سطرٍ في منتصفه —
    // فتعود مطابقةٌ بلا «↳ من أين»، أو بنسبٍ مقطوعٍ في منتصف كلمة.
    const long: AwarenessEntry = {
      layer: "general",
      key: "general:playbook:long",
      // درسٌ عند سقف المخزن نفسه (700) — أي حالةٌ حقيقيّةٌ لا مفتعلة.
      text: `درسٌ عامٌّ مؤهَّلٌ عن القاعدة المقفولة ${"وتفصيلٌ إضافيّ ".repeat(44)}`.trim(),
      provenance: `${LAYER_LABEL.general} · كتيّب معتمَد (رُقّي 3×)`,
    }
    expect(long.text.length).toBeGreaterThan(650)
    expect(long.text.length).toBeLessThanOrEqual(700)
    const answer = recallSearch("ما الذي نعرفه عن القاعدة المقفولة وعن التفصيل الإضافيّ في الدرس العامّ المؤهَّل تماماً", [long])
    expect(answer.measured).toBe(true)
    expect(answer.matches).toHaveLength(1)
    expect(answer.text).toContain("↳")
    // النسبُ كاملٌ حرفاً بحرف — لا مقطوعاً في منتصف الوصف ولا غائباً.
    expect(answer.text).toContain(long.provenance)
    expect(answer.text.trimEnd().endsWith(long.provenance)).toBe(true)
    // والقصُّ معلَنٌ بعلامةٍ في متن المطابقة لا في ذيل النصّ.
    expect(answer.text).toContain("…")
    expect(answer.text.length).toBeLessThanOrEqual(RECALL_MAX_CHARS)
  })

  test("«لم تُقرأ» ليست «لا شيء مقيس» — الطبقة غير المفتوحة تُسمّى بسببها", () => {
    const why = "الذاكرة الدائمة غير مفتوحة"
    const nothing = recallSearch("هل ينجح البناء", [], { unread: [why] })
    expect(nothing.measured).toBe(false)
    expect(nothing.unread).toEqual([why])
    expect(nothing.text).toContain(RECALL_UNREAD)
    expect(nothing.text).toContain(why)
    // وحتى مع مطابقاتٍ من طبقةٍ أخرى: الاعتراف يبقى معروضاً.
    const found = recallSearch("هل ينجح البناء", entries, { unread: [why] })
    expect(found.measured).toBe(true)
    expect(found.text).toContain(RECALL_UNREAD)
    // والعرضُ يقول ذلك أيضاً بدل طبع صفرٍ كاذب.
    const rendered = renderAwarenessIndex(buildAwarenessIndex({ projectId: A, entries: [] }), 4000, { turn: why, session: why })
    expect(rendered).toContain(RECALL_UNREAD)
    expect(rendered).toContain("لم تُقرأ")
    expect(rendered).toContain(`${LAYER_LABEL.project}=0`)
  })

  test("الطيّ والسوابق المتّصلة: «والقاعدة» تلقى «القاعدة»، والهمزة لا تفصل", () => {
    expect(recallTerms("الإعداد أعداد")).toContain("الاعداد")
    // بلا نزع السوابق يعود هذا السؤال بصفر مطابقات — وهو عيبٌ قيس هنا لا افتُرض.
    const clitic = recallSearch("ما شأن والقاعدة المقفولة؟", entries)
    expect(clitic.measured).toBe(true)
    expect(clitic.matches[0]!.layer).toBe("general")
    // والهمزة المطوية: «أُصلح» في المُدخل تلقى «اصلح» في السؤال.
    const hamza = recallSearch("اصلح البحث", entries)
    expect(hamza.measured).toBe(true)
    expect(hamza.matches[0]!.text).toContain("انهيار البحث")
  })
})

// ---------------------------------------------------------------------------

describe("S13.4 — برهان العبور عند القراءة: مشروعٌ لا يقرأ طبقة مشروعٍ آخر", () => {
  const aEntries: readonly AwarenessEntry[] = [
    ...entriesFromFacts(
      [
        { key: "server:url", value: "الخادم المُدار لمشروع acme-shop يعمل على http://127.0.0.1:4310" },
        { key: "wrote:app/page.tsx", value: "app/page.tsx أُنشئ في هذا المشروع" },
      ],
      A,
    ),
    ...entriesFromSummary(summaryOf(["رُبطت قاعدة acme-shop بلوحة الإدارة"]), A, "s-a"),
  ]
  const bEntries = entriesFromFacts([{ key: "build:passing", value: "npm run build ينجح ويصرّف بلا أخطاء" }], B)
  const general = entriesFromGeneral(
    parseGeneralStore(serialiseGeneralStore(
      promoteLessons(
        EMPTY_GENERAL_STORE,
        [
          { cls: "playbook", text: "«sqlite-locked»: القاعدة مقفولة من عملية أخرى — فعّل WAL وbusy_timeout." },
          ...aEntries.map((entry) => ({ cls: "playbook" as const, text: entry.text })),
        ],
        { projectTokens: projectTokensOf(A), now: 1 },
      ).store,
    )),
  )

  test("فهرسُ ب يُسقط كلّ مُدخلٍ من أ ويعدّه", () => {
    const index = buildAwarenessIndex({ projectId: B, entries: [...aEntries, ...bEntries, ...general] })
    expect(index.foreignDropped).toBe(aEntries.length)
    for (const entry of index.entries) expect(entry.projectId === undefined || entry.projectId === B).toBe(true)
    expect(index.counts.general).toBe(general.length)
  })

  test("لا سطرَ من أ يظهر في استرجاعٍ داخل ب — ولا رمزَ من رموزه", () => {
    const index = buildAwarenessIndex({ projectId: B, entries: [...aEntries, ...bEntries, ...general] })
    for (const question of ["الخادم المُدار والمنفذ", "acme-shop", "app/page.tsx", "قاعدة لوحة الإدارة", "القاعدة مقفولة"]) {
      const answer = recallSearch(question, index.entries)
      // سطح التسريب هو ما **يُعاد** لا صدى السؤال: النصّ والنسب والمفتاح.
      const returned = answer.matches.map((match) => `${match.key}\n${match.text}\n${match.provenance}`).join("\n")
      for (const marker of ["acme-shop", "127.0.0.1", "4310", "page.tsx"]) {
        expect(returned, `تسرّب «${marker}» في جواب «${question}»`).not.toContain(marker)
      }
      for (const match of answer.matches) expect(["turn", "session", "project", "general"]).toContain(match.layer)
    }
    // وسؤالٌ عن مشروع أ بعينه لا يجد شيئاً في ب: الغياب يُقال.
    const asked = recallSearch("acme-shop", index.entries)
    expect(asked.measured).toBe(false)
    expect(asked.text).toContain(RECALL_NOTHING)
  })

  test("ما عبر إلى الطبقة العامّة هو الدرس المملوك للمنتج وحده", () => {
    expect(general).toHaveLength(1)
    expect(general[0]!.text).toContain("sqlite-locked")
  })
})
