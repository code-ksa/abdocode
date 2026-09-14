import { describe, expect, test } from "bun:test"
import { INFER_LABELS, buildInferSystem, condenseForInfer, interpretInferTurn, semanticFrame } from "../src/index"

/** المفسِّرُ الصارم: يقبل الشكلَ الحرفيّ وحده، ويرفض كلَّ ما عداه — الغيابُ معلَن والحدسُ ممنوع. */

const GOOD = [
  `${INFER_LABELS.meaning}: يريد الوصول إلى مجلّد الفواتير في مشروعه`,
  `${INFER_LABELS.motive}: يعمل على الفواتير الآن ولا يعرف مكان المجلّد`,
  `${INFER_LABELS.request}: افتح مجلّد الفواتير في المشروع الحاليّ`,
  `${INFER_LABELS.confidence}: 0.86`,
].join("\n")

describe("الموجّه والتكثيف", () => {
  test("النظامُ يطلب أربعةَ أسطرٍ حرفية ويمنع الادّعاء", () => {
    const s = buildInferSystem()
    for (const label of Object.values(INFER_LABELS)) expect(s).toContain(`${label}:`)
    expect(s).toContain("لا تنفّذ")
  })
  test("التكثيفُ يحمل النصَّ كما قيل والإطارَ الحتميّ سياقاً", () => {
    const c = condenseForInfer(semanticFrame("وين مجلد الفواتير؟"))
    expect(c).toContain("الطلب: وين مجلد الفواتير؟")
    expect(c).toContain("لهجة=gulf")
    expect(c).toContain("فعل=find")
    expect(c).toContain("هدف=«الفواتير»")
  })
})

describe("التفسير الصارم", () => {
  test("الشكلُ الحرفيّ يُقبل بحقوله الأربعة وموقّعِه", () => {
    const r = interpretInferTurn({ kind: "final", text: GOOD }, "ollama/qwen9b")
    expect(r).toMatchObject({ meaning: "يريد الوصول إلى مجلّد الفواتير في مشروعه", confidence: 0.86, by: "ollama/qwen9b" })
    expect(r?.request).toBe("افتح مجلّد الفواتير في المشروع الحاليّ")
  })
  test("كتلةُ التفكير تُنزع قبل التفسير، والأرقامُ الهندية تُقبل ثقةً", () => {
    const r = interpretInferTurn({ kind: "final", text: `<think>...</think>\n${GOOD.replace("0.86", "٠٫٩")}` }, "x")
    expect(r?.confidence).toBe(0.9)
  })
  test("سطرٌ ناقص = لا استنتاج", () => {
    expect(interpretInferTurn({ kind: "final", text: GOOD.split("\n").slice(0, 3).join("\n") }, "x")).toBeUndefined()
  })
  test("ثقةٌ غيرُ رقمية أو خارج [0,1] = لا استنتاج", () => {
    expect(interpretInferTurn({ kind: "final", text: GOOD.replace("0.86", "عالية") }, "x")).toBeUndefined()
    expect(interpretInferTurn({ kind: "final", text: GOOD.replace("0.86", "1.5") }, "x")).toBeUndefined()
  })
  test("ادّعاءُ تنفيذٍ = لا استنتاج — المحلّلُ لا ينفّذ", () => {
    expect(interpretInferTurn({ kind: "final", text: GOOD.replace("افتح مجلّد", "تم فتح مجلّد") }, "x")).toBeUndefined()
  })
  test("نداءُ أداةٍ أو قطعٌ = لا استنتاج", () => {
    expect(interpretInferTurn({ kind: "tools", text: GOOD }, "x")).toBeUndefined()
    expect(interpretInferTurn({ kind: "final", text: GOOD, truncated: true }, "x")).toBeUndefined()
  })
  test("نثرٌ حرّ = لا استنتاج، لا استنتاجٌ مصلَّح", () => {
    expect(interpretInferTurn({ kind: "final", text: "يبدو أن المستخدم يريد فتح مجلد الفواتير." }, "x")).toBeUndefined()
  })
})
