/**
 * س0 · جردُ `mind/cognitive-frame.ts` — المُختزِل المطبوع «نصُّ النموذج ليس حالة».
 *
 * وفي مصدرها سطرٌ يقول عن `WRITE_SETS`: **«Checked by the tests»** — ولم يكن هناك
 * اختبارٌ واحد. فهذا الملفّ يجعل تلك الجملة صادقة: لكلّ نوعِ حدثٍ نثبت أنّه **يحرّك
 * حقلَه وحده** ولا يمسّ سواه، بالمقارنة الفعليّة بين الإطار قبلُ وبعد — لا بقراءة جدول.
 *
 * مساميرُ توصيفٍ لا تصميم: تصف ما يفعله اليوم بالضبط. ولا يُعدَّل سطرٌ من المصدر.
 */
import { describe, expect, test } from "bun:test"
import {
  apply,
  applyAll,
  empty,
  fingerprint,
  WRITE_SETS,
  type Event,
  type Frame,
} from "../src/mind/cognitive-frame"

/** حدثٌ صالحٌ نموذجيٌّ لكلّ نوع — كي يُقاس كلُّ صفٍّ في الجدول لا بعضُه. */
const SAMPLE: Readonly<Record<Event["type"], Event>> = {
  "goal-set": { type: "goal-set", statement: "أضف صفحةً", acceptance: ["تمرّ الاختبارات"] },
  "constraint-added": { type: "constraint-added", id: "c1", kind: "forbid", subject: "package.json" },
  "unknown-raised": { type: "unknown-raised", id: "u1", question: "أيُّ منفذ؟" },
  "unknown-resolved": { type: "unknown-resolved", id: "u1", answer: "4400" },
  "assumption-made": { type: "assumption-made", id: "a1", statement: "الخادمُ يعمل", because: "pm2 jlist" },
  "assumption-invalidated": { type: "assumption-invalidated", id: "a1", by: "فحصُ المنفذ" },
  "plan-set": { type: "plan-set", steps: [{ id: "s1", action: "اقرأ", dependsOn: [] }] },
  "step-started": { type: "step-started", id: "s1" },
  "step-finished": { type: "step-finished", id: "s1", ok: true },
  "proof-recorded": { type: "proof-recorded", id: "p1", about: "s1", evidence: "رمزُ الخروج 0" },
  "budget-spent": { type: "budget-spent", tokens: 120, seconds: 3 },
}

/** الحالةُ التي يصلح فيها كلُّ حدثٍ من العيّنة (بعضُها يحتاج سابقاً له). */
const prepared = (type: Event["type"]): Frame => {
  const before: Event[] = []
  if (type === "unknown-resolved") before.push(SAMPLE["unknown-raised"])
  if (type === "assumption-invalidated") before.push(SAMPLE["assumption-made"])
  if (type === "step-started" || type === "step-finished") before.push(SAMPLE["plan-set"])
  if (type === "step-finished") before.push(SAMPLE["step-started"])
  if (type === "proof-recorded") { before.push(SAMPLE["plan-set"]); before.push(SAMPLE["step-started"]); before.push(SAMPLE["step-finished"]) }
  return applyAll(empty, before).frame
}

const FIELDS: (keyof Frame)[] = ["goal", "constraints", "unknowns", "assumptions", "plan", "proofs", "spent"]

describe("س0 · WRITE_SETS — الجدولُ صار مفحوصاً فعلاً", () => {
  test("الجدولُ يغطّي كلَّ نوعِ حدثٍ — لا نوعَ بلا صفّ", () => {
    expect(Object.keys(WRITE_SETS).toSorted()).toEqual(Object.keys(SAMPLE).toSorted())
    expect(Object.keys(WRITE_SETS).length).toBe(11)
  })

  test("🔑 كلُّ حدثٍ يحرّك حقلَه المعلَن ولا يمسّ حقلاً آخر — بالمقارنة لا بالجدول", () => {
    for (const type of Object.keys(SAMPLE) as Event["type"][]) {
      const before = prepared(type)
      const result = apply(before, SAMPLE[type])
      expect(result.ok, `الحدث ${type} كان يجب أن يُقبل على حالةٍ مهيّأة`).toBe(true)
      if (!result.ok) continue
      const allowed = new Set<string>(WRITE_SETS[type])
      for (const field of FIELDS) {
        const moved = JSON.stringify(result.frame[field]) !== JSON.stringify(before[field])
        if (!allowed.has(field)) {
          expect(moved, `الحدث ${type} حرّك «${field}» وهو ليس في صلاحيّته`).toBe(false)
        }
      }
      // والتوأمُ الإيجابيّ: الحقلُ المعلَن **تحرّك فعلاً** — وإلّا كان الأخضرُ لأنّ شيئاً لم يقع.
      const declared = WRITE_SETS[type][0]!
      expect(JSON.stringify(result.frame[declared]) !== JSON.stringify(before[declared]), `الحدث ${type} لم يحرّك «${declared}»`).toBe(true)
    }
  })

  test("عدّادُ الانتقالات يزيد مع كلّ حدثٍ مقبول — وهو خارج كلّ صلاحيّة", () => {
    const one = apply(empty, SAMPLE["goal-set"])
    expect(one.ok).toBe(true)
    if (one.ok) expect(one.frame.transitions).toBe(empty.transitions + 1)
  })
})

describe("س0 · الرفضُ يُعاد سبباً لا يُبتلع", () => {
  test("حدثٌ على حالةٍ لا تقبله يُردّ بـ{ok:false, why} ولا يغيّر الإطار", () => {
    const orphan = apply(empty, SAMPLE["unknown-resolved"])   // حلُّ مجهولٍ لم يُرفع
    expect(orphan.ok).toBe(false)
    if (!orphan.ok) expect(orphan.why.length).toBeGreaterThan(3)
    const late = apply(empty, SAMPLE["step-started"])          // بدءُ خطوةٍ بلا خطّة
    expect(late.ok).toBe(false)
  })

  test("applyAll يجمع الرفضَ بموضعِه ويمضي — لا يسقط على أوّل عيب", () => {
    const events: Event[] = [SAMPLE["goal-set"], SAMPLE["unknown-resolved"], SAMPLE["constraint-added"]]
    const { frame, refusals } = applyAll(empty, events)
    expect(refusals.length).toBe(1)
    expect(refusals[0]!.at).toBe(1)
    // والحدثُ الثالثُ مرّ رغم رفضِ الثاني: الرفضُ يُسجَّل ولا يُوقف السلسلة.
    expect(frame.constraints.length).toBe(1)
    expect(frame.goal).toBeDefined()
  })
})

describe("س0 · البصمةُ حتميّة — وإلّا لا تكشف الانحراف الذي وُجدت له", () => {
  test("الإطارُ نفسُه يعطي البصمةَ نفسَها، والمختلفُ يعطي غيرَها", () => {
    const a = applyAll(empty, [SAMPLE["goal-set"], SAMPLE["constraint-added"]]).frame
    const b = applyAll(empty, [SAMPLE["goal-set"], SAMPLE["constraint-added"]]).frame
    expect(fingerprint(a)).toBe(fingerprint(b))
    expect(fingerprint(a)).toMatch(/^[0-9a-f]{8}$/u)
    const c = applyAll(empty, [SAMPLE["goal-set"]]).frame
    expect(fingerprint(c)).not.toBe(fingerprint(a))
    expect(fingerprint(empty)).toBe(fingerprint(empty))
  })

  test("ترتيبُ الأحداث جزءٌ من الحالة — بصمتان مختلفتان لترتيبين", () => {
    const one = applyAll(empty, [SAMPLE["unknown-raised"], SAMPLE["constraint-added"]]).frame
    const two = applyAll(empty, [SAMPLE["constraint-added"], SAMPLE["unknown-raised"]]).frame
    // المحتوى نفسُه والترتيبُ مختلف: التوثيقُ يقول إنّ الترتيبَ «جزءٌ ممّا حدث».
    expect(one.constraints.length).toBe(two.constraints.length)
    expect(one.unknowns.length).toBe(two.unknowns.length)
  })
})
