import { describe, expect, test } from "bun:test"
import {
  EMPTY_GENERAL_STORE,
  GENERAL_CLASSES,
  GENERAL_LESSON_FIELDS,
  GENERAL_LESSON_MAX_CHARS,
  GENERAL_STORE_CAP,
  GENERAL_STORE_FILE,
  GENERAL_HEADING,
  PROMOTION_RULE,
  foldText,
  generalAwarenessBrief,
  inspectGeneralStore,
  parseGeneralStore,
  projectIdentifyingTokens,
  projectTokensOf,
  promoteLesson,
  promoteLessons,
  qualifiedPlaybookCandidates,
  serialiseGeneralStore,
  type GeneralStore,
} from "../src/general-awareness"
import { PLAYBOOKS } from "../src/error-playbooks"
import { REDACTED, residualSecretMatches, sweepResidualSecrets } from "../src/secret-command-guard"

// مشروعان مختلفان — كلّ ما يلي مبنيّ عليهما، فالقضيب العابر يُقاس لا يُدّعى.
const PROJECT_A = "C:/work/acme-shop"
const PROJECT_B = "C:/work/globex-portal"
const TOKENS_A = projectTokensOf(PROJECT_A)
const TOKENS_B = projectTokensOf(PROJECT_B)

const ctxA = { projectTokens: TOKENS_A, now: 1_000 }
const ctxB = { projectTokens: TOKENS_B, now: 2_000 }

/** درسٌ عامٌّ حقيقيّ من كتالوج المنتج — بلا مسارٍ ولا اسمِ مشروع. */
const GENERIC = "«sqlite-locked»: SQLite مقفولة من عملية أخرى. فعّل WAL وbusy_timeout، واجعل الكتابة من مسارٍ واحد."

const promote = (store: GeneralStore, text: string, cls = "playbook", ctx = ctxA) =>
  promoteLesson(store, { cls, text }, ctx)

describe("S13.3 — قاعدة الترقية معلَنةٌ ومنفَّذة", () => {
  test("القاعدة مكتوبةٌ نصّاً بثمانية بنود، وكلّ رقمٍ فيها مشتقٌّ من الثابت لا مكرَّر بيدٍ", () => {
    expect(PROMOTION_RULE).toHaveLength(8)
    expect(PROMOTION_RULE.join("\n")).toContain(String(GENERAL_STORE_CAP))
    expect(PROMOTION_RULE.join("\n")).toContain(String(GENERAL_LESSON_MAX_CHARS))
    for (const cls of GENERAL_CLASSES) expect(PROMOTION_RULE.join("\n")).toContain(cls)
  })

  test("المخزن في دليل التثبيت لا في جذر مشروع", () => {
    expect(GENERAL_STORE_FILE).toBe("abdo-general-awareness.json")
    expect(GENERAL_STORE_FILE).not.toContain("/")
    expect(GENERAL_STORE_FILE).not.toContain("\\")
  })

  test("(البند 1) صنفٌ غير معتمَد يُرفض بالاسم — ولا نصَّ حرّاً", () => {
    const refused = promote(EMPTY_GENERAL_STORE, GENERIC, "insight")
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error("unreachable")
    expect(refused.reason).toBe("class")
    expect(refused.refused).toContain("insight")
  })

  test("(البند 4) الشكل مسقوف من الطرفين", () => {
    const short = promote(EMPTY_GENERAL_STORE, "قصير")
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.reason).toBe("shape")
    const long = promote(EMPTY_GENERAL_STORE, "ط".repeat(GENERAL_LESSON_MAX_CHARS + 1))
    expect(long.ok).toBe(false)
    if (!long.ok) expect(long.reason).toBe("shape")
  })

  test("(البند 5) حقيقةٌ تحمل اسم المشروع تُرفض بالاسم — الطفرة (أ)", () => {
    const refused = promote(EMPTY_GENERAL_STORE, "درسٌ عامّ تماماً بلا أيّ رمزٍ آخر يخصّ acme-shop في هذا النصّ")
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error("unreachable")
    expect(refused.reason).toBe("project-token")
    expect(refused.refused).toContain("acme-shop")
  })

  test("(البند 5) المسارات والمضيفات والمنافذ والمعرّفات تُرفض كلّها، بأسمائها", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["الدرس: راجع C:\\work\\acme\\next.config.js قبل البناء دائماً", "مسار مطلق"],
      ["الدرس: ملفّ app/page.tsx يحتاج use client قبل استعمال الحالة", "مسار"],
      ["الدرس: الواجهة على https://example.test تحتاج ترويسةً واحدة", "رابط"],
      ["الدرس: خادم البريد على mail.example.com يرفض الاتّصال بلا TLS", "مضيف"],
      ["الدرس: القاعدة على 192.168.10.20 ترفض الاتّصال من خارج الشبكة", "عنوان IP"],
      ["الدرس: الخادم المُدار يستمع على المنفذ :4310 ولا يقبل غيره", "منفذ"],
      ["الدرس: التنبيهات تذهب إلى ops@example.com ولا أحد يقرؤها", "بريد"],
      ["الدرس: راجع الحقيقة fct_0042 قبل إعادة القياس في الجلسة", "معرّف جلسة"],
      ["الدرس: الجلسة s-1756800000000 حملت الهدف الأصليّ كاملاً بلا نقص", "معرّف جلسة"],
    ]
    for (const [text, label] of cases) {
      const refused = promote(EMPTY_GENERAL_STORE, text)
      expect(refused.ok, `يجب رفض: ${text}`).toBe(false)
      if (refused.ok) continue
      expect(refused.reason).toBe("project-token")
      expect(refused.refused).toContain(label)
    }
  })

  test("(البند 5) الاسمُ متنكّراً يُرفض كما يُرفض عارياً — كلُّ ناقلٍ بمفرده", () => {
    // كلّ سطرٍ هنا هو **الحقيقة المعرِّفة نفسها** مغسولةً بحيلةٍ واحدة. مرورُ
    // أيٍّ منها يسلّم اسم عميلٍ إلى مشروع عميلٍ آخر — فالقياس فرداً فرداً لا
    // «شكلاً» واحداً بتهجئةٍ لاتينيّة كما كان.
    const NAME = "درسٌ عامّ بلا أيّ رمزٍ آخر يخصّ %s في هذا النصّ"
    const vectors: readonly (readonly [string, string])[] = [
      ["محرف صفريّ ZWSP", NAME.replace("%s", "acme\u200B-shop")],
      ["محرف صفريّ ZWNJ", NAME.replace("%s", "acme\u200C-shop")],
      ["واصل صفريّ ZWJ", NAME.replace("%s", "acme\u200D-shop")],
      ["علامة اتّجاه RLM", NAME.replace("%s", "acme\u200F-shop")],
      ["شرطة لينة", NAME.replace("%s", "acme\u00AD-shop")],
      ["متشابه سيريليّ", NAME.replace("%s", "\u0430cme-shop")],
      ["متشابهان سيريليّان", NAME.replace("%s", "\u0430\u0441me-shop")],
      ["سيريليّ خارج الجدول", NAME.replace("%s", "\u0431acme-shop")],
      ["IP بأرقام هنديّة", "الدرس: القاعدة على \u0661\u0662\u0667.\u0660.\u0660.\u0661 ترفض الاتّصال من خارج الشبكة أبداً"],
      ["IP بأرقام عريضة", "الدرس: القاعدة على \uFF11\uFF12\uFF17.\uFF10.\uFF10.\uFF11 ترفض الاتّصال من خارج الشبكة"],
      ["منفذ بأرقام هنديّة", "الدرس: الخادم المُدار يستمع على المنفذ :\u0664\u0663\u0661\u0660 ولا يقبل غيره"],
      ["مسار عربيّ", "الدرس: راجع مجلّد/العميل قبل أيّ بناءٍ في هذا المشروع دائماً"],
      ["مضيف خارج قائمة النطاقات", "الدرس: القاعدة على db.acme-internal.example تحتاج شهادةً صالحة"],
      ["شرطة مائلة عريضة", "الدرس: الملفّ app\uFF0Fpage.tsx يحتاج use client قبل استعمال الحالة"],
    ]
    for (const [why, text] of vectors) {
      const refused = promote(EMPTY_GENERAL_STORE, text)
      expect(refused.ok, `عبر التنكّر «${why}»`).toBe(false)
      if (refused.ok) continue
      expect(refused.reason).toBe("project-token")
    }
    // وبايتاتُ المخزن بعد الدفعة كلّها خاليةٌ من كلّ علامةٍ منها.
    const run = promoteLessons(EMPTY_GENERAL_STORE, vectors.map(([, text]) => ({ cls: "playbook" as const, text })), ctxA)
    expect(run.store.lessons).toHaveLength(0)
    const bytes = serialiseGeneralStore(run.store)
    for (const marker of ["acme", "shop", "127", "١٢٧", "\u0664\u0663\u0661\u0660", "internal", "page.tsx", "العميل"]) {
      expect(bytes, `تسرّبت العلامة «${marker}»`).not.toContain(marker)
    }
  })

  test("(البند 5) الطيّ مفردةُ المنتج نفسها — لا نسخةَ ثانية أضعف", () => {
    // الطيّ يردّ ما تردّه `normalizeArabic`: الصفريّات والأرقام الهنديّة
    // والمتشابهات. لو افترق عنها عادت كلُّ نواقل التنكّر أعلاه.
    expect(foldText("acme\u200C-shop")).toBe("acme-shop")
    expect(foldText("acme\u00AD-shop")).toBe("acme-shop")
    expect(foldText("\u0430\u0441me-shop")).toBe("acme-shop")
    expect(foldText("\u0664\u0663\u0661\u0660")).toBe("4310")
    expect(foldText("\uFF11\uFF12\uFF17.\uFF10.\uFF10.\uFF11")).toBe("127.0.0.1")
    expect(foldText("الإعدادُ")).toBe(foldText("الاعداد"))
  })

  test("درسٌ عامّ نظيف يُقبل — والرفض ليس رفضاً لكلّ شيء", () => {
    const accepted = promote(EMPTY_GENERAL_STORE, GENERIC)
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error("unreachable")
    expect(accepted.added).toBe(true)
    expect(accepted.store.lessons).toHaveLength(1)
    expect(accepted.store.lessons[0]!.text).toBe(GENERIC)
    expect(accepted.store.lessons[0]!.cls).toBe("playbook")
    expect(accepted.store.lessons[0]!.seen).toBe(1)
  })

  test("(البند 3) الحجب يسبق الكتابة: لا بايتَ من السرّ يصل السجلّ", () => {
    const secret = "«tls-cert-invalid»: صحّح الشهادة ولا تمرّر الترويسة Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345 كما هي"
    const accepted = promote(EMPTY_GENERAL_STORE, secret)
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error("unreachable")
    expect(accepted.redactions).toBeGreaterThan(0)
    const stored = accepted.store.lessons[0]!.text
    expect(stored).toContain(REDACTED)
    expect(stored).not.toContain("abcdefghijklmnopqrstuvwxyz012345")
    // وما يبقى شبيهاً بسرٍّ بعد الحجب لا يُكتب أصلاً.
    expect(serialiseGeneralStore(accepted.store)).not.toContain("abcdefghijklmnopqrstuvwxyz012345")
  })

  test("(البند 3) الكنس يستبدل البقيّة — والفحص بعده قضيبٌ مغلق، وقاعدةُ المشغّل تقول ذلك", () => {
    // نصُّ القاعدة يُطبع للمشغّل، فلا يجوز أن يَعِد برفضٍ لا يقع: الكنس
    // يستبدل عينَ ما يبلّغ عنه الفحص، فالفرع الذي بعده لا يُبلَغ اليوم.
    const residue = "درسٌ عامّ يحمل بقيّةً طويلة abcdefghijklmnopqrstuvwxyz0123456789abcdefghij بعد الحجب"
    const swept = sweepResidualSecrets(residue)
    expect(swept.redactions).toBeGreaterThan(0)
    expect(residualSecretMatches(swept.text)).toEqual([])
    const accepted = promote(EMPTY_GENERAL_STORE, residue)
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error("unreachable")
    expect(accepted.redactions).toBeGreaterThan(0)
    expect(accepted.store.lessons[0]!.text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789abcdefghij")
    expect(accepted.store.lessons[0]!.text).toContain(REDACTED)
    // والقاعدةُ المعروضة تصف ما يجري: كنسٌ يستبدل، لا رفضٌ يقع.
    expect(PROMOTION_RULE[2]).toContain("الكنس")
    expect(PROMOTION_RULE[2]).toContain("قضيبٌ مغلق")
  })

  test("(البند 7) فاعلٌ واحد: التكرار يزيد العدّاد ولا يكرّر سطراً ولا يبدّل نصّاً", () => {
    const once = promote(EMPTY_GENERAL_STORE, GENERIC)
    if (!once.ok) throw new Error("unreachable")
    const twice = promote(once.store, GENERIC)
    if (!twice.ok) throw new Error("unreachable")
    expect(twice.added).toBe(false)
    expect(twice.store.lessons).toHaveLength(1)
    expect(twice.store.lessons[0]!.seen).toBe(2)
    expect(twice.store.lessons[0]!.text).toBe(GENERIC)
    expect(twice.store.lessons[0]!.firstSeen).toBe(once.store.lessons[0]!.firstSeen)
    // ورسمُ الملفّ حتميّ: النصّ نفسه من الحالة نفسها.
    expect(serialiseGeneralStore(twice.store)).toBe(serialiseGeneralStore(parseGeneralStore(serialiseGeneralStore(twice.store))))
  })

  test("(البند 6) السقف والطرد حتميّان: الأقلّ ترقيةً أولاً", () => {
    const line = (i: number) => `درسٌ عامّ رقم ${i} لا يحمل أيّ رمزٍ يعرّف مشروعاً على الإطلاق`
    let store: GeneralStore = EMPTY_GENERAL_STORE
    for (let i = 0; i < GENERAL_STORE_CAP; i++) {
      const result = promoteLesson(store, { cls: "playbook", text: line(i) }, { projectTokens: TOKENS_A, now: 1_000 + i })
      if (!result.ok) throw new Error(`refused: ${result.refused}`)
      store = result.store
    }
    expect(store.lessons).toHaveLength(GENERAL_STORE_CAP)
    // درسٌ رُقّي مرّتين لا يُطرد قبل درسٍ رُقّي مرّة — والأقدم يُطرد قبل الأحدث.
    const bumped = promoteLesson(store, { cls: "playbook", text: line(0) }, { projectTokens: TOKENS_A, now: 9_000 })
    if (!bumped.ok) throw new Error("unreachable")
    const overflow = promoteLesson(bumped.store, { cls: "playbook", text: GENERIC }, { projectTokens: TOKENS_A, now: 9_001 })
    if (!overflow.ok) throw new Error("unreachable")
    expect(overflow.store.lessons).toHaveLength(GENERAL_STORE_CAP)
    expect(overflow.evicted).toEqual([foldText(line(1))])
    expect(overflow.store.lessons.some((l) => l.text === line(0))).toBe(true)
    expect(overflow.store.lessons.some((l) => l.text === GENERIC)).toBe(true)
    // والطرد حتميّ: النداء نفسه على الحالة نفسها يطرد الضحيّة نفسها.
    const again = promoteLesson(bumped.store, { cls: "playbook", text: GENERIC }, { projectTokens: TOKENS_A, now: 9_001 })
    if (!again.ok) throw new Error("unreachable")
    expect(again.evicted).toEqual(overflow.evicted)
  })

  test("(البند 8) شكلُ السجلّ لا يسع هويّةَ مشروع — القضيب في الشكل لا في الفحص", () => {
    const accepted = promote(EMPTY_GENERAL_STORE, GENERIC)
    if (!accepted.ok) throw new Error("unreachable")
    expect(Object.keys(accepted.store.lessons[0]!).sort()).toEqual([...GENERAL_LESSON_FIELDS].sort())
    for (const field of GENERAL_LESSON_FIELDS) {
      expect(["project", "path", "dir", "session", "origin", "source", "id"].some((banned) => field.toLowerCase() === banned)).toBe(false)
    }
  })
})

describe("S13.3 — برهان العبور: مشروعان لا يتسرّب أحدهما إلى الآخر", () => {
  // حقائقُ مشروعٍ حقيقيّةُ الشكل: أسماء وملفّات ومنافذ ومضيفات.
  const A_FACTS: readonly string[] = Object.freeze([
    "wrote:app/(dashboard)/acme-shop/page.tsx أُنشئ في هذا المشروع",
    "الخادم المُدار لمشروع acme-shop يعمل على http://127.0.0.1:4310",
    "قاعدة acme-shop على db.acme-internal.local تحتاج شهادة",
    "«sqlite-locked»: SQLite مقفولة من عملية أخرى. فعّل WAL وbusy_timeout، واجعل الكتابة من مسارٍ واحد.",
  ])

  test("لا شيء من مشروع أ يعبر — والمقبول وحده هو الدرس المملوك للمنتج", () => {
    const run = promoteLessons(EMPTY_GENERAL_STORE, A_FACTS.map((text) => ({ cls: "playbook" as const, text })), ctxA)
    expect(run.promoted).toHaveLength(1)
    expect(run.refusals).toHaveLength(3)
    expect(run.store.lessons).toHaveLength(1)
    expect(run.store.lessons[0]!.text).toBe(A_FACTS[3])
  })

  test("بايتاتُ الملفّ نفسُها خاليةٌ من كلّ رمزٍ يخصّ مشروع أ", () => {
    const run = promoteLessons(EMPTY_GENERAL_STORE, A_FACTS.map((text) => ({ cls: "playbook" as const, text })), ctxA)
    const bytes = serialiseGeneralStore(run.store)
    for (const marker of ["acme-shop", "acme-internal", "127.0.0.1", "4310", "page.tsx", "app/"]) {
      expect(bytes, `تسرّب «${marker}» إلى المخزن العامّ`).not.toContain(marker)
    }
    // ولا اسمَ حقلٍ يحمل مشروعاً: التسلسل كلّه من الحقول الستّة.
    const parsed = JSON.parse(bytes) as { lessons: Record<string, unknown>[] }
    for (const lesson of parsed.lessons) expect(Object.keys(lesson).sort()).toEqual([...GENERAL_LESSON_FIELDS].sort())
  })

  test("ما استقرّ من مشروع أ يُقرأ في مشروع ب ولا يحمل شيئاً منه", () => {
    const run = promoteLessons(EMPTY_GENERAL_STORE, A_FACTS.map((text) => ({ cls: "playbook" as const, text })), ctxA)
    const readInB = parseGeneralStore(serialiseGeneralStore(run.store))
    expect(readInB.lessons).toHaveLength(1)
    for (const lesson of readInB.lessons) {
      // لا رمزَ من أ، ولا رمزَ من ب — الدرس لا مشروعَ له أصلاً.
      expect(projectIdentifyingTokens(lesson.text, TOKENS_A)).toEqual([])
      expect(projectIdentifyingTokens(lesson.text, TOKENS_B)).toEqual([])
    }
    // والموجز يقول نسبه: معرفةٌ عامّة، لا قياسٌ عن مشروع ب.
    const brief = generalAwarenessBrief(readInB)
    expect(brief).toContain(GENERAL_HEADING)
    expect(brief).toContain("ليست قياساً عن هذا المشروع")
    expect(brief).not.toContain("acme")
  })

  test("رموزُ المشروع تُشتقّ من مساره كلّه، والمقطع القصير لا يُلتقط إلا اسماً أخيراً", () => {
    expect(TOKENS_A).toContain("acme-shop")
    expect(TOKENS_A).toContain("work")
    expect(TOKENS_A).not.toContain("c:")
    expect(projectTokensOf("D:/x/ab")).toEqual(["ab"])
  })

  test("قاعدةُ الترقية مقيسةٌ على كتالوج المنتج كلّه: ما مرّ نظيفٌ، وما رُدّ مسمّى", () => {
    const run = promoteLessons(
      EMPTY_GENERAL_STORE,
      PLAYBOOKS.map((playbook) => ({ cls: "playbook" as const, text: `«${playbook.id}»: ${playbook.hint}` })),
      ctxA,
    )
    // القياس (2026-09-03، بعد تبنيَة كاشف المضيف): 56 كتيّباً ⇒ 23 مُرقّى
    // و33 مردوداً. الفرق عن القياس السابق (38/18) ثمنٌ مقصود: القائمة
    // المغلقة للنطاقات العليا كانت تفوّت `db.<عميل>-internal.example`،
    // والبنيويّ يرفض معها `package.json` و`Decimal.TryParse` — شكلٌ واحد لا
    // يفرّقه فحص. خسارةُ درسٍ عامّ أرخص من تسريب اسم عميل.
    // 2026-09-06: +1 كتيّب «cli-flag-not-registered» (علمٌ لا تعرفه الأداة الحيّة — سجلُّ المالك).
    expect(PLAYBOOKS).toHaveLength(57)
    expect(run.promoted).toHaveLength(23)
    // 2026-09-06: الكتيّبُ الجديد (cli-flag-not-registered) رُدّ عن الترقية — نصُّه يحمل أسماءَ أدواتٍ ومساراتٍ، والرفضُ الزائد هو الاتّجاه الآمن.
    expect(run.refusals).toHaveLength(34)
    for (const refusal of run.refusals) expect(refusal).toContain("رُفضت الترقية:")
    // ولا سطرٍ مُرقّى يحمل فاصلَ مسارٍ ولا مضيفاً — الرفضُ الزائد هو الاتّجاه الآمن.
    for (const lesson of run.store.lessons) {
      expect(lesson.text).not.toMatch(/[A-Za-z0-9_.@~-]+[\\/][A-Za-z0-9_.@~-]+/u)
      expect(projectIdentifyingTokens(lesson.text, TOKENS_B)).toEqual([])
    }
  })
})

describe("S13.3 — المصدر المقنَّن والقرص", () => {
  test("الكتيّب لا يُرقّى إلا بعد تأهيله بجولةٍ اكتملت", () => {
    expect(qualifiedPlaybookCandidates(["sqlite-locked"], false)).toEqual([])
    const qualified = qualifiedPlaybookCandidates(["sqlite-locked", "sqlite-locked", "لا-وجود-له"], true)
    expect(qualified).toHaveLength(1)
    expect(qualified[0]!.cls).toBe("playbook")
    expect(qualified[0]!.text).toContain("«sqlite-locked»")
  })

  test("ملفٌّ مشوَّه أو بنسخةٍ مجهولة يُقرأ فارغاً — فشلٌ مُغلق لا تمريرٌ على أمل البراءة", () => {
    expect(parseGeneralStore("{ليس json")).toEqual(EMPTY_GENERAL_STORE)
    expect(parseGeneralStore(JSON.stringify({ version: 99, lessons: [{ key: "k", cls: "playbook", text: GENERIC, seen: 1, firstSeen: 0, lastSeen: 0 }] }))).toEqual(EMPTY_GENERAL_STORE)
    expect(parseGeneralStore("")).toEqual(EMPTY_GENERAL_STORE)
    // سطرٌ لا يطابق الشكل يسقط وحده، والباقي يمرّ.
    const mixed = parseGeneralStore(JSON.stringify({
      version: 1,
      lessons: [
        { key: "bad", cls: "not-a-class", text: GENERIC, seen: 1, firstSeen: 0, lastSeen: 0 },
        { key: foldText(GENERIC), cls: "playbook", text: GENERIC, seen: 3, firstSeen: 1, lastSeen: 2 },
      ],
    }))
    expect(mixed.lessons).toHaveLength(1)
    expect(mixed.lessons[0]!.seen).toBe(3)
  })

  test("«غائب» ليس «غيرَ مقروء»: نسخةٌ مجهولة أو ملفٌّ مشوَّه يمنعان الكتابة ولا يُقرآن فارغين", () => {
    // العطل الذي يمنعه هذا: مخزنٌ كتبته نسخةٌ أحدث يُقرأ فارغاً، ثمّ يُدهس
    // بنسخة 1 فيها الدرسُ الجديد وحده — محوُ متنٍ عابرٍ للمشاريع بلا حدث.
    const newer = JSON.stringify({ version: 2, lessons: [{ key: "k", cls: "playbook", text: GENERIC, seen: 40, firstSeen: 0, lastSeen: 0 }] })
    const read = inspectGeneralStore(newer)
    expect(read.ok).toBe(false)
    if (read.ok) throw new Error("unreachable")
    expect(read.why).toContain("نسخة")
    expect(inspectGeneralStore("{ليس json").ok).toBe(false)
    expect(inspectGeneralStore("[1,2,3]").ok).toBe(false)
    // والغياب الحقيقيّ يمرّ: ملفٌّ لا وجود له = مخزنٌ فارغ، لا رفض.
    const absent = inspectGeneralStore("")
    expect(absent.ok).toBe(true)
    if (!absent.ok) throw new Error("unreachable")
    expect(absent.store).toEqual(EMPTY_GENERAL_STORE)
    // والقارئ المتساهل يبقى متساهلاً للقراءة وحدها.
    expect(parseGeneralStore(newer)).toEqual(EMPTY_GENERAL_STORE)
  })

  test("موجزٌ لا يُسكته درسٌ طويل: الرأس يُقصّ، وما بعده يملأ ما بقي", () => {
    // درسٌ واحدٌ طويل (قانونيّ: دون السقف 700) على رأس الترتيب كان يعيد ""،
    // فتختفي الطبقةُ كلُّها من المدخل بينما يعرضها `awareness` عامرة.
    const long = `درسٌ عامّ طويلٌ جدّاً لا يحمل رمزاً معرِّفاً البتّة ${"طويل ".repeat(80)}`.trim()
    expect(long.length).toBeLessThanOrEqual(GENERAL_LESSON_MAX_CHARS)
    const short = "درسٌ عامّ قصيرٌ لا يحمل رمزاً معرِّفاً البتّة"
    let store: GeneralStore = EMPTY_GENERAL_STORE
    for (const text of [long, long, short]) {
      const result = promote(store, text)
      if (!result.ok) throw new Error(`refused: ${result.refused}`)
      store = result.store
    }
    expect(store.lessons).toHaveLength(2)
    expect(store.lessons.find((l) => l.text === long)!.seen).toBe(2)
    const brief = generalAwarenessBrief(store)
    expect(brief.length).toBeGreaterThan(0)
    expect(brief).toContain(GENERAL_HEADING)
    // الرأسُ مقصوصٌ بعلامةٍ ظاهرة، والقصيرُ خلفه لم يسقط بسقوطه.
    expect(brief).toContain("…")
    expect(brief).toContain(short)
    expect(brief.length).toBeLessThanOrEqual(500)
  })

  test("الموجز مسقوفٌ ومرتّبٌ بالأكثر ترقيةً، والفارغ لا يضيف حرفاً", () => {
    expect(generalAwarenessBrief(EMPTY_GENERAL_STORE)).toBe("")
    expect(generalAwarenessBrief(undefined)).toBe("")
    let store: GeneralStore = EMPTY_GENERAL_STORE
    for (const text of ["درسٌ عامّ أوّل لا يحمل رمزاً معرِّفاً البتّة", "درسٌ عامّ ثانٍ لا يحمل رمزاً معرِّفاً البتّة"]) {
      const result = promote(store, text)
      if (!result.ok) throw new Error("unreachable")
      store = result.store
    }
    const bumped = promote(store, "درسٌ عامّ ثانٍ لا يحمل رمزاً معرِّفاً البتّة")
    if (!bumped.ok) throw new Error("unreachable")
    const brief = generalAwarenessBrief(bumped.store, 400)
    expect(brief.length).toBeLessThanOrEqual(400)
    expect(brief.indexOf("ثانٍ")).toBeLessThan(brief.indexOf("أوّل"))
  })
})
