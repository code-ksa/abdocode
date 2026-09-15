/**
 * ن3 (مقيس حيّاً 09-15 على 4.0.39): أدواتُ السطح (open/page/tap/fill/select/upload/drag…) كانت تعود بلا حكمٍ (`plain`)،
 * فـ`receiptSucceeded` يسقط إلى «آخرُ رمز خروج = 0» الذي لا يوجد في نصّ إيصالِ متصفّح ⇦ لا إيصالَ متصفّحٍ ناجح **أبداً** في عين
 * بوّابة الإقفال، فطالب «شرطُ دليل المتصفّح» بـopen بعد open ناجح وسقط الدور. الحكمُ يُشتقّ هنا من صدر الإيصال كما يكتبه السطح:
 * رفضُ عقدٍ أو سياسة ⇦ مرفوض (لا عطب)؛ تعذّرٌ أو صيغةٌ أو مرجعٌ ضائع ⇦ فشلٌ مسمّى؛ وإلّا نجاح.
 */
import type { ToolVerdict } from "@abdo/engine-host"

// `\b` حدٌّ لاتينيّ لا يعمل بعد حرفٍ عربيّ — الحدُّ هنا «لا حرفٌ بعده».
const POLICY = /^(?:العقد رفض|رُفض(?:ت)?(?!\p{L}))/u
const FAILURE = /^(?:✕|مرجعٌ غير معروف|مرجعُ الهدف غير معروف|تعذّر|لم أ|لا سطحَ|لا خيارَ يطابق|الصيغة:|مفتاحٌ غيرُ مدعوم|انقطع اتصالُ|أداةُ سطحٍ مجهولة|لم يظهر|«[^»]*» ليس (?:قائمةً|حقلَ))/u

export const surfaceVerdict = (output: string): ToolVerdict => {
  const head = output.trimStart()
  if (POLICY.test(head)) return { ok: false, reason: "policy_denied", denied: true, detail: head.slice(0, 160) }
  if (FAILURE.test(head)) return { ok: false, reason: "invalid_input", denied: false, detail: head.slice(0, 160) }
  return { ok: true }
}
