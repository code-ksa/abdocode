import { describe, expect, test } from "bun:test"
import {
  EMPTY_SESSION_SUMMARY,
  SUMMARY_HEAD,
  SUMMARY_INSTRUCTION,
  SUMMARY_LABELS,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_LINES,
  SUMMARY_MEASURED_HEADING,
  SUMMARY_NOTE_HEADING,
  SUMMARY_SECTIONS,
  SUMMARY_SECTION_CAP,
  mergeSessionSummary,
  parseStoredSummary,
  renderSessionSummary,
  splitSummary,
  summaryEventLine,
  verifySummary,
  type SessionSummary,
  type SummaryDraft,
  type SummarySection,
  type ToolReceipt,
} from "../src"

const block = (lines: readonly string[]): string => [SUMMARY_HEAD, ...lines].join("\n")

const ok = (command: string, output = "انتهى الأمر برمز 0"): ToolReceipt => ({ command, output })
const failed = (command: string, output = "فشل التنفيذ: انتهى الأمر برمز 1"): ToolReceipt => ({ command, output })

/** حاجبٌ محايد: وحدةُ الخلاصة تُختبر هنا نقيّة، والحجبُ الحقيقيّ مقيسٌ في حزمة المحرّك. */
const keep = (text: string): string => text
const texts = (summary: SessionSummary, section: SummarySection): string[] =>
  summary.sections[section].map((line) => line.text)

const draftOf = (text: string): SummaryDraft => {
  const split = splitSummary(text)
  if (split.summary === undefined) throw new Error("expected a summary block")
  return split.summary
}

describe("S13.1 — رفعُ الكتلة عن الردّ (قبل تحليل الأمر)", () => {
  test("كتلة تامّة النحو في الذيل تُرفع، والجسد يعود بلا نصّها", () => {
    const reply = `أنجزت الخطوة الأولى.\n${block([
      `${SUMMARY_LABELS.done}: كتبت app/page.tsx`,
      `${SUMMARY_LABELS.understood}: المشروع next.js بموجّه التطبيق`,
      `${SUMMARY_LABELS.decided}: أبدأ بالصفحة الرئيسية`,
      `${SUMMARY_LABELS.blocked}: لا مانع`,
    ])}`
    const split = splitSummary(reply)
    expect(split.body).toBe("أنجزت الخطوة الأولى.")
    expect(split.summary).toEqual({
      done: ["كتبت app/page.tsx"],
      understood: ["المشروع next.js بموجّه التطبيق"],
      decided: ["أبدأ بالصفحة الرئيسية"],
      blocked: ["لا مانع"],
    })
    // النصّ الأصليّ لا يُعاد إلى النموذج: الجسد وحده.
    expect(split.body).not.toContain(SUMMARY_HEAD)
  })

  test("الغياب ليس فشلاً: ردٌّ بلا كتلة يعود بايتاً (بعد تصفية المقيس وحدها)", () => {
    const reply = "نفّذ: read app/page.tsx"
    const split = splitSummary(reply)
    expect(split.summary).toBeUndefined()
    expect(split.body).toBe(reply)
  })

  test("سطرٌ واحد خارج النحو في الذيل ⇒ ليست كتلة، والحمولة لا تُشقّ", () => {
    // حمولة `write` تحوي رأس الكتلة ثم شيفرة — سطرُ الشيفرة يبطل النحو،
    // فيبقى النصّ كلّه بايتاً ولا يُبتر ملفّ المستخدم.
    const payload = `نفّذ: write a.ts <<<\n${SUMMARY_HEAD}\nexport const x = 1\n`
    const split = splitSummary(payload)
    expect(split.summary).toBeUndefined()
    expect(split.body).toBe(payload.trim())
  })

  test("رأسٌ بلا سطرٍ موسوم بعده ليس كتلة", () => {
    const reply = `تمام.\n${SUMMARY_HEAD}\n`
    expect(splitSummary(reply).summary).toBeUndefined()
  })

  test("عنوانٌ مجهول داخل الذيل يبطل الكتلة كلَّها — لا التقاط جزئيّ", () => {
    const reply = `تمام.\n${block([`${SUMMARY_LABELS.done}: كتبت a.ts`, "الميزانية: ألف"])}`
    expect(splitSummary(reply).summary).toBeUndefined()
  })

  test("التشكيل زينةُ رسم: «فعل» تُقبل كما «فُعل»", () => {
    const split = splitSummary(`x\n${block(["فعل: كتبت a.ts"])}`)
    expect(split.summary?.done).toEqual(["كتبت a.ts"])
  })

  test("آخرُ رأسٍ هو الرأس — كتلةٌ مذكورةٌ في المتن لا تسرق الذيل", () => {
    const reply = `شرحتُ أن ${SUMMARY_HEAD} تُكتب هكذا.\n${block([`${SUMMARY_LABELS.done}: كتبت a.ts`])}`
    const split = splitSummary(reply)
    expect(split.summary?.done).toEqual(["كتبت a.ts"])
    expect(split.body).toContain("شرحتُ أن")
  })

  test("سقفُ الأسطر: ما بعد الخامس والعشرين يُسقَط", () => {
    const lines = Array.from({ length: SUMMARY_MAX_LINES + 7 }, (_, i) => `${SUMMARY_LABELS.done}: كتبت f${i}.ts`)
    const draft = draftOf(`x\n${block(lines)}`)
    expect(draft.done).toHaveLength(SUMMARY_MAX_LINES)
    expect(draft.done[0]).toBe("كتبت f0.ts")
  })

  test("سقفُ السطر ومحارف التحكّم: السطر يمرّ بمُنقّي النيّة نفسه", () => {
    const long = "ا".repeat(400)
    const draft = draftOf(`x\n${block([`${SUMMARY_LABELS.done}: ${long}`])}`)
    expect(draft.done[0]!.length).toBe(200)
  })
})

describe("S13.1 — المراجعة ضد الإيصالات: الادّعاء لا يصير حقيقةً بكتابته", () => {
  const receipts: readonly ToolReceipt[] = [
    ok("write app/page.tsx <<<\n...", "✍ كُتب app/page.tsx"),
    ok("run npm run build", "Compiled successfully\nانتهى الأمر برمز 0"),
    failed("run npm test", "فشل: 3 tests failed"),
  ]

  test("ادّعاءٌ مختلَق بلا إيصال يُسقَط ولا يُخزَّن", () => {
    const draft = draftOf(`x\n${block([
      `${SUMMARY_LABELS.done}: كتبت app/page.tsx`,
      `${SUMMARY_LABELS.done}: أنشأت لوحة التحكم في dashboard/admin.tsx`,
    ])}`)
    const verdict = verifySummary(draft, receipts)
    expect(verdict.claims.map((c) => c.text)).toEqual(["كتبت app/page.tsx"])
    expect(verdict.claims[0]!.status).toBe("measured")
    expect(verdict.dropped).toEqual([
      { section: "done", text: "أنشأت لوحة التحكم في dashboard/admin.tsx", why: "no-receipt" },
    ])
    // الحكم لا يعبر إلى التخزين إلا عبر المطالبات — والمُسقَط ليس منها.
    const stored = mergeSessionSummary(undefined, verdict, 1, keep)
    expect(texts(stored, "done")).toEqual(["كتبت app/page.tsx"])
    expect(JSON.stringify(stored)).not.toContain("dashboard/admin.tsx")
  })

  test("ادّعاءُ أثرٍ بفعلٍ عارٍ بلا مسارٍ ولا أمر يُسقَط — لا شيء يمكن مطابقته", () => {
    const draft = draftOf(`x\n${block([`${SUMMARY_LABELS.done}: أنجزت كل المطلوب`])}`)
    const verdict = verifySummary(draft, receipts)
    expect(verdict.claims).toHaveLength(0)
    expect(verdict.dropped[0]!.why).toBe("no-receipt")
  })

  test("فهمٌ أو قرارٌ لا يدّعي أثراً يُحفظ ملاحظةً لا قياساً", () => {
    const draft = draftOf(`x\n${block([
      `${SUMMARY_LABELS.understood}: المستخدم يريد واجهة عربية`,
      `${SUMMARY_LABELS.decided}: أبدأ بالواجهة قبل القاعدة`,
    ])}`)
    const verdict = verifySummary(draft, receipts)
    expect(verdict.dropped).toHaveLength(0)
    expect(verdict.claims.every((c) => c.status === "note")).toBe(true)
  })

  test("إيصالٌ فاشل لا يشهد لأثرٍ وقع، لكنه يشهد للمانع", () => {
    const draft = draftOf(`x\n${block([
      `${SUMMARY_LABELS.done}: نجح npm test`,
      `${SUMMARY_LABELS.blocked}: npm test يسقط بثلاثة اختبارات`,
    ])}`)
    const verdict = verifySummary(draft, receipts)
    // «npm»/«test» تظهران أيضاً في إيصالٍ ناجح (npm run build) — فالسندُ يقع
    // على الرمز لا على الجملة؛ ما يهمّ هنا أن المانع لا يُسقَط بفشل إيصاله.
    expect(verdict.claims.some((c) => c.section === "blocked" && c.status === "measured")).toBe(true)
    const onlyFailing = verifySummary(
      draftOf(`x\n${block([`${SUMMARY_LABELS.done}: صحّحت components/Header.tsx`])}`),
      [failed("write components/Header.tsx <<<\nx", "⛔ رُفض: الحارس منع الكتابة")],
    )
    expect(onlyFailing.claims).toHaveLength(0)
    expect(onlyFailing.dropped).toHaveLength(1)
  })

  test("الحكمُ الصريح يغلب نصَّ الإيصال — مفردةٌ واحدة لا اثنتان", () => {
    const denied: ToolReceipt = {
      command: "write secrets/key.txt <<<\nx",
      output: "تمّت الكتابة",
      verdict: { ok: false, reason: "policy_denied", denied: true },
    }
    const draft = draftOf(`x\n${block([`${SUMMARY_LABELS.done}: كتبت secrets/key.txt`])}`)
    expect(verifySummary(draft, [denied]).claims).toHaveLength(0)
    expect(verifySummary(draft, [{ ...denied, verdict: { ok: true } }]).claims).toHaveLength(1)
  })
})

describe("S13.1 — الدمج والتخزين والحقن", () => {
  const receipts = [ok("write a.ts <<<\nx", "✍ كُتب a.ts"), ok("write b.ts <<<\nx", "✍ كُتب b.ts")]
  const verdict = verifySummary(
    draftOf(`x\n${block([`${SUMMARY_LABELS.done}: كتبت a.ts`, `${SUMMARY_LABELS.decided}: ثم b.ts عبر write`])}`),
    receipts,
  )

  test("متساوي القوى: دمجُ الحكم نفسه بالحقبة نفسها مرّتين لا يغيّر شيئاً", () => {
    const once = mergeSessionSummary(undefined, verdict, 3, keep)
    const twice = mergeSessionSummary(once, verdict, 3, keep)
    expect(twice).toEqual(once)
    expect(once.epochs).toEqual([3])
  })

  test("التراكم عبر الحقب: الأسطر تُضاف والحقب تُسجَّل مرتَّبةً", () => {
    const first = mergeSessionSummary(EMPTY_SESSION_SUMMARY, verdict, 1, keep)
    const second = mergeSessionSummary(
      first,
      verifySummary(draftOf(`x\n${block([`${SUMMARY_LABELS.done}: كتبت b.ts`])}`), receipts),
      2,
      keep,
    )
    expect(texts(second, "done")).toEqual(["كتبت a.ts", "كتبت b.ts"])
    expect(second.epochs).toEqual([1, 2])
  })

  test("سقفُ القسم وسقفُ الأسطر: الأقدم يسقط والأحدث يبقى", () => {
    let summary = EMPTY_SESSION_SUMMARY
    for (let i = 0; i < SUMMARY_SECTION_CAP + 5; i += 1) {
      summary = mergeSessionSummary(
        summary,
        verifySummary(
          draftOf(`x\n${block([`${SUMMARY_LABELS.done}: كتبت f${i}.ts`])}`),
          [ok(`write f${i}.ts <<<\nx`, `✍ كُتب f${i}.ts`)],
        ),
        i + 1,
        keep,
      )
    }
    expect(summary.sections.done).toHaveLength(SUMMARY_SECTION_CAP)
    expect(texts(summary, "done").at(-1)).toBe(`كتبت f${SUMMARY_SECTION_CAP + 4}.ts`)
    expect(texts(summary, "done")).not.toContain("كتبت f0.ts")
    const total = SUMMARY_SECTIONS.reduce((n, s) => n + summary.sections[s].length, 0)
    expect(total).toBeLessThanOrEqual(SUMMARY_MAX_LINES)
  })

  test("الحقن مسقوفٌ ولا يحمل نصّ الردّ الأصليّ", () => {
    const summary = mergeSessionSummary(undefined, verdict, 1, keep)
    const brief = renderSessionSummary(summary)
    expect(brief).toContain(SUMMARY_LABELS.done)
    expect(brief).toContain("كتبت a.ts")
    expect(brief.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS + 2)
    expect(renderSessionSummary(EMPTY_SESSION_SUMMARY)).toBe("")
  })

  test("قراءةُ المخزَّن فشلٌ مُغلق: شكلٌ منحرف يعود undefined لا خلاصةً نصفَ مبنيّة", () => {
    const summary = mergeSessionSummary(undefined, verdict, 1, keep)
    expect(parseStoredSummary(JSON.parse(JSON.stringify(summary)))).toEqual(summary)
    expect(parseStoredSummary(undefined)).toBeUndefined()
    expect(parseStoredSummary("خلاصة")).toBeUndefined()
    expect(parseStoredSummary({ sections: { done: "كتبت a.ts" } })).toBeUndefined()
    expect(parseStoredSummary({ sections: { done: [7] } })).toBeUndefined()
    expect(parseStoredSummary({ sections: {} })).toEqual(EMPTY_SESSION_SUMMARY)
    // الحالةُ جزءٌ من الشكل: سطرٌ عارٍ (شكلُ ما قبل هذا الإصلاح) يُرفض كلُّه،
    // فلا يعود مخزَّنٌ قديم بأسطرٍ لا تُعرف حالتُها ثم تُعرض كأنها مقيسة.
    expect(parseStoredSummary({ sections: { done: ["كتبت a.ts"] } })).toBeUndefined()
    expect(parseStoredSummary({ sections: { done: [{ text: "كتبت a.ts" }] } })).toBeUndefined()
    expect(parseStoredSummary({ sections: { done: [{ text: "كتبت a.ts", status: "مقيس" }] } })).toBeUndefined()
  })

  test("سطرُ المشغّل يفصل المقيس عن الملاحظة عن المُسقَط", () => {
    const line = summaryEventLine(4, verifySummary(
      draftOf(`x\n${block([
        `${SUMMARY_LABELS.done}: كتبت a.ts`,
        `${SUMMARY_LABELS.done}: كتبت zzz.ts`,
        `${SUMMARY_LABELS.understood}: المشروع صغير`,
      ])}`),
      receipts,
    ))
    expect(line).toBe("🧠 خلاصة الحقبة 4: مقيس=1 · ملاحظات=1 · أُسقط بلا إيصال=1")
  })
})

describe("S13.1 — الدليلُ مربوطٌ بالأثر لا بحرفٍ تصادف", () => {
  const doneOf = (line: string, receipts: readonly ToolReceipt[]) =>
    verifySummary(draftOf(`x\n${block([`${SUMMARY_LABELS.done}: ${line}`])}`), receipts)

  test("إيصالُ قراءةٍ ناجح لا يشهد لبناءٍ ولا لاختبارٍ ولا لكتابة", () => {
    // القياس الحيّ: «بنيت المشروع … و978/978 اختباراً» مع إيصال `read` واحد
    // كان يُخزَّن «مقيساً» لأن «packages/engine» ظهرت في نصّ أمر القراءة.
    const read = [ok("read packages/engine/src/cli.ts", "…محتوى…")]
    const fabricated = doneOf(
      "بنيت المشروع ونجح البناء، وشغّلت كل الاختبارات في packages/engine فمرّت 978/978",
      read,
    )
    expect(fabricated.claims).toHaveLength(0)
    expect(fabricated.dropped[0]!.why).toBe("no-receipt")
    // وكذلك ادّعاءُ كتابةٍ يشهد له `read` للملفّ نفسه.
    const written = doneOf("كتبت الملف src/app.ts وأصلحت العطل ونشرته", [ok("read src/app.ts", "…")])
    expect(written.claims).toHaveLength(0)
  })

  test("إيصالُ كتابةٍ ناجح لا يشهد لبناءٍ ولا لنشر", () => {
    // «بنيت ونشرت المشروع كله في src/a.ts» من كتابةِ ملفٍّ واحد.
    const verdict = doneOf("بنيت ونشرت المشروع كله في src/a.ts", [ok("write src/a.ts <<<\nhello", "✍ كُتب src/a.ts")])
    expect(verdict.claims).toHaveLength(0)
    expect(verdict.dropped[0]!.why).toBe("no-receipt")
    // الكتابةُ المعلنة بصدقها تمرّ على الإيصال نفسه.
    expect(doneOf("كتبت src/a.ts", [ok("write src/a.ts <<<\nhello", "✍ كُتب src/a.ts")]).claims).toHaveLength(1)
  })

  test("الرمزُ العاري لا يسند: «test» و«run» و«build» بلا مسارٍ ولا أداة", () => {
    expect(doneOf("نجحت كل اختبارات المشروع test", [ok("read test/a.spec.ts", "…")]).claims).toHaveLength(0)
    expect(doneOf("أنجزت كل الهدف run", [ok("run npm ci", "انتهى الأمر برمز 0")]).claims).toHaveLength(0)
    expect(doneOf("اكتمل build", [ok("run npm run build", "انتهى الأمر برمز 0")]).claims).toHaveLength(0)
  })

  test("لا احتواءَ نصّيّاً: «test» لا تُسنَد من داخل latest.json", () => {
    const verdict = doneOf("أضفت اختبارات test جديدة ونجحت", [ok("read docs/latest.json", "{}")])
    expect(verdict.claims).toHaveLength(0)
    expect(verdict.dropped).toHaveLength(1)
  })

  test("كلُّ رمزٍ قويّ مطالَبٌ بشاهد — لا يكفي أن يُسند أحدها", () => {
    const receipts = [ok("write src/a.ts <<<\nx", "✍ كُتب src/a.ts")]
    expect(doneOf("كتبت src/a.ts", receipts).claims).toHaveLength(1)
    expect(doneOf("كتبت src/a.ts وsrc/b.ts", receipts).claims).toHaveLength(0)
  })

  test("رمزان من إيصالين لا يجتمعان: المطابقةُ لكلِّ إيصالٍ على حدة", () => {
    // «write src/a.ts» و«run npm test» إيصالان ناجحان؛ ادّعاءُ كتابةٍ يسمّي
    // الاثنين لا يجد إيصالَ كتابةٍ واحداً يحمل «npm».
    const receipts = [ok("write src/a.ts <<<\nx", "✍"), ok("run npm test", "انتهى الأمر برمز 0")]
    expect(doneOf("كتبت src/a.ts بأمر npm", receipts).claims).toHaveLength(0)
  })
})

describe("S13.1 — التناقض: إيصالٌ فشل يكذّب السطر ولا ينقذه شقيقٌ نجح", () => {
  test("«مرّت الاختبارات خضراء» بينما bun test فشل في الحقبة نفسها", () => {
    const receipts: readonly ToolReceipt[] = [
      { command: "run bun test", output: "12 pass, 3 fail\nانتهى الأمر برمز 1", verdict: { ok: false, reason: "tool_failed", denied: false } },
      { command: "run bun run typecheck", output: "انتهى الأمر برمز 0", verdict: { ok: true } },
    ]
    const verdict = verifySummary(
      draftOf(`x\n${block([`${SUMMARY_LABELS.done}: شغّلت bun test فمرّت كل الاختبارات خضراء 100% بلا فشل واحد`])}`),
      receipts,
    )
    expect(verdict.claims).toHaveLength(0)
    expect(verdict.dropped[0]!.why).toBe("contradicted")
    // ولا يُخزَّن شيء: المُسقَط لا يعبر إلى المخزَّن أبداً.
    expect(texts(mergeSessionSummary(undefined, verdict, 1, keep), "done")).toEqual([])
  })

  test("«المانع» مستثنى: الفشلُ نفسه شهادتُه", () => {
    const receipts = [failed("run npm test", "فشل: 3 tests failed")]
    const verdict = verifySummary(
      draftOf(`x\n${block([`${SUMMARY_LABELS.blocked}: npm test يسقط بثلاثة اختبارات`])}`),
      receipts,
    )
    expect(verdict.claims.map((c) => c.status)).toEqual(["measured"])
  })
})

describe("S13.1 — الحالةُ تعبر حدَّ التخزين: الملاحظة ليست قياساً", () => {
  const noReceipts: readonly ToolReceipt[] = []
  const verdict = verifySummary(
    draftOf(`x\n${block([
      `${SUMMARY_LABELS.understood}: هذا المشروع لا يستعمل أي اختبارات آلية`,
      `${SUMMARY_LABELS.decided}: نتخلّى عن هذه البنية ونعيد كتابتها من الصفر`,
    ])}`),
    noReceipts,
  )

  test("سطرُ الملاحظة يُخزَّن بحالته، ولا يصير بايتاً كالمقيس", () => {
    expect(verdict.claims.every((claim) => claim.status === "note")).toBe(true)
    const stored = mergeSessionSummary(undefined, verdict, 1, keep)
    expect(stored.sections.understood).toEqual([
      { text: "هذا المشروع لا يستعمل أي اختبارات آلية", status: "note" },
    ])
    expect(stored.sections.decided[0]!.status).toBe("note")
  })

  test("الحقنُ لا يعرض ملاحظةً تحت عنوان «مراجَعة ضد الإيصالات»", () => {
    const brief = renderSessionSummary(mergeSessionSummary(undefined, verdict, 1, keep))
    expect(brief).toContain(SUMMARY_NOTE_HEADING)
    expect(brief).not.toContain(SUMMARY_MEASURED_HEADING)
    // ما تحت عنوان الملاحظة هو نصُّ الملاحظة، لا سطرٌ يُقدَّم قياساً.
    expect(brief.slice(brief.indexOf(SUMMARY_NOTE_HEADING))).toContain("نتخلّى عن هذه البنية")
  })

  test("المقيسُ والملاحظة يجتمعان في نصٍّ واحد تحت عنوانين لا واحد", () => {
    const measured = verifySummary(
      draftOf(`x\n${block([`${SUMMARY_LABELS.done}: كتبت a.ts`])}`),
      [ok("write a.ts <<<\nx", "✍ كُتب a.ts")],
    )
    const stored = mergeSessionSummary(mergeSessionSummary(undefined, measured, 1, keep), verdict, 2, keep)
    const brief = renderSessionSummary(stored)
    expect(brief.indexOf(SUMMARY_MEASURED_HEADING)).toBe(0)
    expect(brief.indexOf(SUMMARY_NOTE_HEADING)).toBeGreaterThan(0)
    // «كتبت a.ts» فوق عنوان الملاحظة، والملاحظتان تحته.
    expect(brief.indexOf("كتبت a.ts")).toBeLessThan(brief.indexOf(SUMMARY_NOTE_HEADING))
  })
})

describe("S13.1 — الحجب يمرّ بالوحدة نفسها فيرثه كلُّ نداء", () => {
  test("الحاجبُ المحقون يُطبَّق قبل التخزين وقبل الحقن", () => {
    const redact = (text: string): string => text.replace(/sk-[A-Za-z0-9-]{8,}/gu, "«مُحجَّب»")
    const verdict = verifySummary(
      draftOf(`x\n${block([`${SUMMARY_LABELS.done}: عدّلت src/config.ts ووضعت المفتاح sk-live-AbCdEf0123456789XYZ`])}`),
      [ok("write src/config.ts <<<\nx", "✍ كُتب src/config.ts")],
    )
    expect(verdict.claims).toHaveLength(1)
    const stored = mergeSessionSummary(undefined, verdict, 1, redact)
    expect(JSON.stringify(stored)).not.toContain("sk-live-AbCdEf0123456789XYZ")
    expect(texts(stored, "done")[0]).toContain("«مُحجَّب»")
    expect(renderSessionSummary(stored)).not.toContain("sk-live-")
  })

  test("الحجبُ يسبق مفتاح التكرار: سطرٌ حُجب لا يتكرّر في الحقبة التالية", () => {
    const redact = (text: string): string => text.replace(/sk-[A-Za-z0-9-]{8,}/gu, "«مُحجَّب»")
    const verdict = verifySummary(
      draftOf(`x\n${block([`${SUMMARY_LABELS.done}: عدّلت src/config.ts بالمفتاح sk-live-AbCdEf0123456789XYZ`])}`),
      [ok("write src/config.ts <<<\nx", "✍")],
    )
    const once = mergeSessionSummary(undefined, verdict, 1, redact)
    const twice = mergeSessionSummary(once, verdict, 2, redact)
    expect(twice.sections.done).toHaveLength(1)
  })
})

describe("S13.1 — كلفةُ الجملة الموجِّهة", () => {
  test("الجملة قصيرةٌ عمداً: تُدفع في كل حقبة", () => {
    expect(SUMMARY_INSTRUCTION.length).toBeLessThan(400)
    expect(SUMMARY_INSTRUCTION).toContain(SUMMARY_HEAD)
    // تشترط الردّ الخاتم لا الردّ الحامل للاستدعاء — الجمعُ بينهما مرفوض.
    expect(SUMMARY_INSTRUCTION).toContain("نفّذ:")
  })
})
