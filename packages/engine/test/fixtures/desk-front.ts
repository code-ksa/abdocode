/**
 * نافذةٌ غريبةٌ تسرق المقدّمةَ وسطَ اختبارٍ حيٍّ ليست عطلاً في المنتَج — بل **دليلُ
 * أنّ الحارسَ يعمل**: القناةُ ترفض الحقنَ حين لا تكون النافذةُ المربوطةُ متصدّرة.
 * لكنّ الاختبارَ الذي يقيس المسارَ السعيد يحمرّ حينها ويُقرأ عطلاً في المنتَج.
 *
 * مقيس 2026-09-26 في ثلاث سويتاتٍ متتالية: مرّةً سرقتها `Terminal` (أمرُ wsl.exe
 * في بوّابةِ جاهزيّةٍ فتحت نافذةً)، ومرّةً `powershell.exe` من جلسةٍ تعمل على
 * الجهاز نفسِه. والفشلُ يتنقّل بين `desk-uia-live` و`desk-window-live` حسب مَن
 * صادف — «أحمرٌ يتنقّل» علامةُ حالةٍ مشتركة لا علامةُ عيب.
 *
 * فالقاعدة: **يُعاد الربطُ ويُعاد الفعلُ مرّتين على الأكثر، ويُعلَن ذلك على
 * stderr.** الإعلانُ شرطٌ لا زينة — تخطٍّ صامتٌ أو إعادةٌ صامتةٌ تُحوّل جهازاً
 * يسرق المقدّمةَ دائماً إلى «أخضرَ» لا يقيس شيئاً.
 *
 * وحدودُ الإعادة صارمة كي لا تستر عيباً:
 * - لا تُعاد إلا رفضاتُ **المقدّمة** بنصّها (`focus moved` / «could not bring…»).
 *   أيُّ رفضٍ آخر (مرجعٌ مجهول، نافذةٌ ذهبت، سكربتٌ فشل) يعود كما هو فيحمرّ.
 * - التوأمُ السلبيُّ الذي **يقصد** سرقةَ المقدّمة (نافذةٌ ثانيةٌ يفتحها الاختبارُ
 *   نفسُه) ينادي `runDesktop` مباشرةً ولا يمرّ من هنا — وإلّا صار الحارسُ
 *   المقيسُ يُعاد حتى «ينجح»، وهو عكسُ ما يُقاس.
 */
import { runDesktop, type DesktopBound, type DesktopResult } from "../../src/desktop-control"

/** رفضاتُ المقدّمة بنصّها كما يكتبها سكربتا ويندوز ولينكس. */
export const FRONT_STOLEN = /focus moved|could not bring the window to the front|no window manager on this display/u

export const MAX_FRONT_RETRIES = 2

/**
 * ينفّذ فعلاً على النافذة المربوطة، ويعيد الربطَ والفعلَ إن سُرقت المقدّمة.
 * `refocus` يعيد الربطَ ويُرجع الحدودَ الجديدة — النافذةُ قد تنتقل، فحدودٌ قديمةٌ
 * بعد إعادة ربطٍ تجعل النقرَ يصيب مكاناً آخر.
 */
export const deskSteady = async (
  action: Parameters<typeof runDesktop>[0],
  options: Parameters<typeof runDesktop>[1],
  refocus: () => Promise<DesktopBound | undefined>,
  label = action.kind,
): Promise<DesktopResult> => {
  let opts = options
  let result = await runDesktop(action, opts)
  for (let n = 1; n <= MAX_FRONT_RETRIES && !result.ok && FRONT_STOLEN.test(result.text); n += 1) {
    process.stderr.write(`⚠ «${label}»: سُرقت المقدّمة (${result.text.slice(0, 120)}) — إعادةُ ربطٍ ومحاولةٌ ${n}/${MAX_FRONT_RETRIES}\n`)
    const rebound = await refocus()
    opts = rebound === undefined ? opts : { ...opts, bound: rebound }
    result = await runDesktop(action, opts)
  }
  return result
}
