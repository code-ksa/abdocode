/**
 * رمزُ خروجٍ بلا كلمةٍ يوقف التشخيص عند حدّه.
 *
 * مقيس 2026-09-26 في جولةِ قياسٍ حيّة: ‏`tool_worker_refused: exit 66` — ولا شيءَ
 * غيرُه. العاملُ مات صامتاً (stderr فارغ)، فالرقمُ وحده لا يقول أين يُبحث، والرسالةُ
 * تُقرأ «رفضٌ من العامل» وهي في الحقيقة **عجزٌ عن قراءة طلبِه**.
 *
 * فالرقمُ يُترجم بمعانيه المتعارَفة (sysexits) ويُقال صريحاً أنّ العاملَ لم يكتب
 * سبباً — فالصمتُ نفسُه معلومة. ولا يُخترع معنًى لرقمٍ لا نعرفه: يُقال «رمزٌ غيرُ
 * معروف» ويبقى الرقم.
 */

/** المعاني المتعارَفة (sysexits.h) — وما يخصّ عاملَنا مشروحٌ بلغته. */
const EXIT_MEANINGS: Readonly<Record<number, string>> = Object.freeze({
  1: "فشلٌ عامّ",
  2: "خطأٌ في الاستخدام",
  64: "خطأٌ في سطر الأمر (EX_USAGE)",
  65: "شكلُ البيانات مرفوض (EX_DATAERR) — الإطارُ وصل وفُهم خطأً",
  66: "لم يستطع قراءةَ طلبِه (EX_NOINPUT) — الإطارُ لم يصل stdin أو انقطع قبل تمامه",
  69: "خدمةٌ يحتاجها غيرُ متاحة (EX_UNAVAILABLE)",
  70: "خطأٌ داخليٌّ في العامل (EX_SOFTWARE)",
  71: "خطأُ نظامِ تشغيل (EX_OSERR)",
  74: "خطأُ إدخالٍ/إخراج (EX_IOERR)",
  75: "فشلٌ مؤقّت (EX_TEMPFAIL) — الإعادةُ قد تنجح",
  77: "صلاحيّةٌ مرفوضة (EX_NOPERM)",
  78: "خطأٌ في الإعداد (EX_CONFIG)",
})

/**
 * سببُ فشلِ العامل بكلماته إن نطق، وبمعنى رمزِه إن صمت.
 *
 * `exitCode === null` يعني أنّه قُتل (مهلةٌ أو إشارة) — وهذا يُقال أيضاً بدل رقمٍ غائب.
 */
export const workerExitReason = (exitCode: number | null | undefined, stderr: string): string => {
  const said = stderr.trim()
  if (said.length > 0) return said.slice(0, 512)
  if (exitCode === null || exitCode === undefined) return "أُنهي العاملُ بإشارةٍ أو مهلةٍ ولم يكتب سبباً"
  const meaning = EXIT_MEANINGS[exitCode]
  return meaning === undefined
    ? `خرج برمز ${exitCode} (رمزٌ غيرُ معروف) ولم يكتب سبباً على stderr`
    : `خرج برمز ${exitCode}: ${meaning} — ولم يكتب سبباً على stderr`
}
