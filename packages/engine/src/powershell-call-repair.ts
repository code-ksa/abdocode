/**
 * م11 — إصلاحٌ حتميّ معلَن لعادة النماذج (omni ثمّ super-120b، 2026-09-14): أمرٌ يبدأ بمسارٍ مقتبس ينتهي بـ.exe يفشل في PowerShell
 * بـ«Unexpected token» لأنّ المسارَ المقتبس تعبيرٌ لا نداء — يحتاج عامل النداء `&`. القواعدُ الثلاث للإصلاح الآليّ (سبرنت 47):
 * ميكانيكيّ (نمطٌ واحد)، محدود (لا يمسّ أمراً يحمل & أو . أو Start-Process أو cmd /c في صدره)، معلَن (يعود بملاحظةٍ تُبثّ للمشغّل).
 * الوحدة نقيّة.
 */

export interface CallRepair { readonly command: string; readonly note: string }

const QUOTED_EXE_HEAD = /^\s*(["'])(?:[A-Za-z]:\\|\\\\|\.{0,2}[\\/])[^"'\r\n]*\.(?:exe|cmd|bat|com)\1(?=\s|$)/iu

/** يعيد الأمرَ بعد إضافة `&` حين يبدأ بمسارٍ مقتبس قابلٍ للتنفيذ؛ وإلا undefined (لا إصلاح). */
export function powershellCallOperatorRepair(command: string): CallRepair | undefined {
  const head = command.trimStart()
  if (!QUOTED_EXE_HEAD.test(head)) return undefined
  return {
    command: `& ${head}`,
    note: "أُصلح الأمر آليّاً: أُضيف عاملُ النداء & قبل المسار المقتبس (PowerShell يعدّ المسارَ المقتبس تعبيراً لا نداءً).",
  }
}
