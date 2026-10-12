import { expect, test } from "bun:test"
import { isSettingsAside, pickPriorGoal } from "../src/resume-intent"

// 10-10 (مقيس في مهمّة n8n): «اكمل» استأنف «خلي النموذج ديبسيك 4.1 فلاش» هدفاً أصليّاً بدل مهمّة الموقع.
test("a short settings/model request is an aside, not the work goal «اكمل» resumes", () => {
  for (const t of ["خلي النموذج ديبسيك 4.1 فلاش و ليس 4 فقط", "غيّر الثيم إلى الداكن", "switch the model to gpt-5", "فعّل وضع الوصول الكامل"]) expect(isSettingsAside(t)).toBe(true)
  // the twin: real work goals, even ones that mention a model, are goals
  for (const t of ["مهمة فل ستاك: ابنِ موقعاً مثل n8n.io بجميع خصائصه", "أصلح صفحة pricing", "ابنِ نموذج تسجيل الدخول بجوجل في الموقع ثم اختبره على الجوّال وارفعه للمراجعة مع كل الشاشات المطلوبة في الخطة وصفحة الإعدادات للمستخدم"]) expect(isSettingsAside(t)).toBe(false)
  const facts = [
    { key: "turn:t1", value: { goal: "مهمة فل ستاك: ابنِ موقعاً مثل n8n.io بجميع خصائصه", status: "incomplete" } },
    { key: "turn:t2", value: { goal: "خلي النموذج ديبسيك 4.1 فلاش و ليس 4 فقط", status: "incomplete" } },
    { key: "turn:t3", value: { goal: "اكمل", status: "incomplete" } },
  ]
  expect(pickPriorGoal(facts)?.goal).toContain("n8n.io")
})
