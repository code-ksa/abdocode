/**
 * نهاياتُ الأسطر: **سطرٌ واحدٌ بنهايةٍ خاطئة = فرقٌ بحجم الملفّ**.
 *
 * شجرتُنا مختلطةٌ بالضرورة (`core.autocrlf=true` يكتب CRLF، وأدواتُ التحرير وbun وgit-bash
 * تكتب LF): مقيسٌ 2026-09-24 أنّ 82 ملفّاً نقيَّ LF تجاور ملفّاتٍ نقيّةَ CRLF في المستودع
 * نفسِه. والعيبُ الذي كلّفنا مراراً ليس اختيارَ النهاية بل **خلطَها في ملفٍّ واحد**:
 *
 * · فرقُ Git يصير بحجم الملفّ فلا تُقرأ المراجعةُ، وتضيع الكوميتاتُ في تعارضٍ كامل.
 * · ومسمارٌ يُرسي على `"\r\n  }\r\n"` يفشل قصُّه فيمتدّ إلى كودِ غيره **فيمرّ أخضرَ كاذباً**.
 * · وقِس في المختبر جولةٍ حيّة: أُدخل سطرٌ واحدٌ بنهايةٍ خاطئة في ملفٍّ نقيِّ CRLF. وقعت المرّةَ
 *   نفسَها في هذا المستودع — أربعةُ أسطر CRLF في ملفٍّ نقيِّ LF.
 *
 * فالقاعدة: **الملفُّ يبقى على نهايته**. والحكمُ يقارن ما كان بما صار، فلا يفرض اصطلاحاً
 * على ملفٍّ جديدٍ ولا يمنع تحويلاً مقصوداً للملفّ كلِّه — يمنع **الخلط** وحده.
 *
 * الوحدةُ نقيّة: النصّانِ يصلان مدخلاً، ولا قرصَ هنا.
 */

export type EolStyle = "crlf" | "lf" | "mixed" | "none"

export interface EolReading {
  readonly style: EolStyle
  readonly crlf: number
  /** أسطرٌ تنتهي بـLF وحدها (بلا CR قبلها). */
  readonly lone: number
}

/** يعدّ نهاياتَ الأسطر بالبايتات — لا بالتقسيم الذي يُخفي الفرق. */
export function readEol(text: string): EolReading {
  let crlf = 0, lone = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 10) continue
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf += 1
    else lone += 1
  }
  const style: EolStyle = crlf > 0 && lone > 0 ? "mixed" : crlf > 0 ? "crlf" : lone > 0 ? "lf" : "none"
  return { style, crlf, lone }
}

/**
 * سببٌ مسمّى إن أَدخلت الكتابةُ خلطاً، وإلّا `undefined`.
 *
 * `before === undefined` يعني ملفّاً جديداً: لا اصطلاحَ يُخالَف، فيُمنع الخلطُ في نفسِه
 * فقط. وملفٌّ كان نقيّاً وصار مختلطاً يُقال بالأرقام كي يُصلَح بسطرٍ واحدٍ لا بإعادة ترميز.
 */
export function lineEndingViolation(file: string, after: string, before?: string): string | undefined {
  const now = readEol(after)
  if (now.style !== "mixed") {
    // تحويلُ الملفّ كلِّه من نهايةٍ إلى أخرى ليس خلطاً — يُقال ولا يُمنع.
    if (before === undefined) return undefined
    const was = readEol(before)
    if (was.style === "none" || now.style === "none" || was.style === now.style) return undefined
    return `ℹ «${file}»: نهاياتُ الأسطر تحوّلت من ${label(was.style)} إلى ${label(now.style)} في الملفّ كلِّه (${was.crlf + was.lone} سطراً). إن لم يكن هذا مقصوداً فأعِدها — فرقُ Git يصير بحجم الملفّ.`
  }
  const was = before === undefined ? undefined : readEol(before)
  const majority = now.crlf >= now.lone ? "crlf" : "lf"
  const stray = majority === "crlf" ? now.lone : now.crlf
  const strayLabel = majority === "crlf" ? "LF عارية" : "CRLF"
  const origin = was === undefined || was.style === "mixed" || was.style === "none"
    ? ""
    : ` وكان الملفُّ **نقيَّ ${label(was.style)}** قبل كتابتك.`
  // 🔴 والنهيُ عن إعادة الترميز جزءٌ من الرسالة، لا زينةٌ فيها: قِيس حيّاً (09-24) أنّ
  // النموذجَ قرأ «أصلِح سطراً واحداً» ثمّ **حوّل الملفَّ كلَّه** إلى النهاية الأخرى —
  // وذلك يجعل الفرقَ بحجم الملفّ أيضاً، أي يستبدل العيبَ بعيبٍ مثله.
  const target = label(majority)
  return `⚠ «${file}»: نهاياتُ الأسطر **مختلطة** — ${now.crlf} CRLF و${now.lone} LF عارية.${origin} أصلِح ${stray} ${strayLabel} **وحدها** لتوافق ${target}، ولا تُعِد ترميزَ الملفّ كلِّه إلى ${majority === "crlf" ? "LF" : "CRLF"}: كلاهما يجعل فرقَ Git بحجم الملفّ ويكسر كلَّ مسمارٍ يُرسي على نهاية سطر. والتحقّقُ بعد الإصلاح بالعدّ: يجب أن يصير ${now.crlf + now.lone} ${target} و0 من غيرها.`
}

const label = (style: EolStyle): string => (style === "crlf" ? "CRLF" : style === "lf" ? "LF" : style === "mixed" ? "مختلطة" : "بلا أسطر")

/**
 * **الملفُّ يبقى على نهايته — بالفعل لا بالقول** (مقيس حيّاً 2026-09-27، مختبر م8 على نموذجٍ محلّيّ 9B):
 * `write` استبدل ملفّاً نقيَّ CRLF — والمهمّةُ تقول بنصّها «هذا الملفُّ CRLF، يبقى كذلك» — بمحتوى LF، ست مرّات،
 * ولم يقل أحدٌ شيئاً: التحذيرُ أعلاه كان يُنادى بـ`before` الفارغ لـ`write` فيحسبه ملفّاً جديداً. ونموذجٌ صغير لا
 * يملك التحكّمَ في `\r` داخل نصّه أصلاً. فالمضيفُ يحفظها: ملفٌّ قائمٌ **نقيّ** النهاية تُحوَّل كتابتُه إليها ويُقال كم.
 * الملفُّ الجديد والمختلطُ لا يُمسّان (لا اصطلاحَ يُحفظ)، والتحويلُ المقصودُ للملفّ كلِّه له أداتُه الصريحة.
 */
export function keepLineEndings(before: string | undefined, after: string): { readonly text: string; readonly converted: number; readonly style?: "crlf" | "lf" } {
  if (before === undefined) return { text: after, converted: 0 }
  // والسطرُ الأخيرُ كذلك: بروتوكولُ النصّ يقصّ ما بعد المحتوى (`body.trim()`) فكان كلُّ استبدالٍ يُسقط سطرَ النهاية
  // («No newline at end of file» في كلّ فرق). ملفٌّ قائمٌ انتهى بسطرٍ يبقى كذلك، بنهايته هو.
  if (after.length > 0 && !after.endsWith("\n") && before.endsWith("\n")) after += before.endsWith("\r\n") ? "\r\n" : "\n"
  const was = readEol(before)
  if (was.style === "crlf") {
    const lone = readEol(after).lone
    return lone === 0 ? { text: after, converted: 0 } : { text: after.replace(/\r?\n/gu, "\r\n"), converted: lone, style: "crlf" }
  }
  if (was.style === "lf") {
    const crlf = readEol(after).crlf
    return crlf === 0 ? { text: after, converted: 0 } : { text: after.replace(/\r\n/gu, "\n"), converted: crlf, style: "lf" }
  }
  return { text: after, converted: 0 }
}

export const keptLineEndingsLine = (file: string, style: "crlf" | "lf", converted: number): string =>
  `ℹ «${file}»: الملفُّ نقيُّ ${label(style)} فبقي كذلك — حُوّل ${converted} سطراً من محتوى كتابتك إلى ${label(style)}. لتحويل الملفّ كلِّه عمداً استعمل أداةً صريحة.`
