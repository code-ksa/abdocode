import { describe, expect, test } from "bun:test"
import { judge } from "../src/mind/surface"

// ب1 — حارسُ الحقول المحظورة كان مسجَّلاً بلا اختبار: كلمةُ المرور والبطاقةُ وOTP والكابتشا لا تُملأ آلياً أبداً،
// لا بموافقةٍ ولا بنمطٍ كامل — والبريدُ والاسمُ يمرّان (التوأمُ الإيجابيّ). المطابقةُ على اسم الحقل ودوره ومرجعه.

const state = { generation: 3 }

describe("Surface.judge — الحقولُ المحظورة", () => {
  test("كلمةُ المرور تُرفض بالاسم العربيّ والإنجليزيّ وبالدور textbox:password", () => {
    for (const field of ["password textbox", "كلمة المرور textbox", "كلمة السر textbox", "Confirm textbox:password"]) {
      const verdict = judge(state, { kind: "type", ref: "r2", generation: 3, text: "hunter2", field })
      expect(verdict.ok, field).toBe(false)
      if (!verdict.ok) expect(verdict.why).toContain("حقلٌ محظورٌ")
    }
  })

  test("البطاقةُ وOTP والكابتشا تُرفض كذلك", () => {
    for (const field of ["Card number textbox", "cvv textbox", "رقم البطاقة textbox", "Verification code textbox", "رمز التحقق textbox", "captcha textbox"]) {
      expect(judge(state, { kind: "type", ref: "r5", generation: 3, text: "1234", field }).ok, field).toBe(false)
    }
  })

  test("التوأمُ الإيجابيّ: البريدُ والاسمُ والبحثُ تمرّ — الحارسُ لا يحجب كلَّ شيء", () => {
    for (const field of ["Email textbox", "البريد الإلكتروني textbox", "Full name textbox", "Search searchbox", "الاسم الكامل textbox"]) {
      expect(judge(state, { kind: "type", ref: "r1", generation: 3, text: "user@example.com", field }).ok, field).toBe(true)
    }
  })

  test("مرجعٌ من جيلٍ قديم يُرفض قبل النظر في الحقل", () => {
    const verdict = judge(state, { kind: "type", ref: "r1", generation: 2, text: "x", field: "Email textbox" })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.why).toContain("جيل")
  })
})
